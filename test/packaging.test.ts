// The packaging smoke test's checks (scripts/smoke-package.cjs) and the signing decision (scripts/signing.cjs),
// against made-up folders and environments: no build needed. `npm run dist:mac` runs the real thing on release/.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const require = createRequire(import.meta.url)
process.env.DESKMATE_QUIET_SIGNING = '1'
const { checkResources, SHIPPED_CHARACTERS, TTS_SCRIPTS, PAGES } = require('../scripts/smoke-package.cjs')
const { signingPlan } = require('../scripts/signing.cjs')
const config = require('../electron-builder.config.cjs')

const dirs: string[] = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function file(root: string, rel: string, mode = 0o644): void {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), 'x')
  chmodSync(join(root, rel), mode)
}

/** A Resources folder with everything a Mac build needs. */
function goodResources(): string {
  const res = mkdtempSync(join(tmpdir(), 'deskmate-res-'))
  dirs.push(res)
  for (const f of ['app.asar', 'app-update.yml', 'build/trayTemplate.png', 'build/trayTemplate@2x.png', 'build/tray.png']) file(res, f)
  for (const id of SHIPPED_CHARACTERS) for (const f of ['character.json', 'persona.md']) file(res, `character/${id}/${f}`)
  file(res, 'skills/notes-new-note/SKILL.md')
  file(res, 'skills/whatsapp-message/skill.json')
  for (const f of TTS_SCRIPTS) file(res, `tts-local/${f}`, f.endsWith('.sh') ? 0o755 : 0o644)
  file(res, 'bin/deskmate-hands', 0o755)
  return res
}
const asar = ['/package.json', '/out/main/index.js', '/out/preload/index.js', ...PAGES.map((p: string) => `/out/renderer/${p}.html`), '/node_modules/electron-updater/package.json']
const universal = () => ['x86_64', 'arm64']

test('a complete Mac build passes', () => {
  assert.deepEqual(checkResources(goodResources(), { mac: true, universal: true, asarList: asar, archs: universal }), [])
})

test('a missing helper, character, skill file or tts script is caught', () => {
  const res = goodResources()
  rmSync(join(res, 'bin', 'deskmate-hands'))
  rmSync(join(res, 'character', 'vivi'), { recursive: true })
  rmSync(join(res, 'tts-local', 'setup.sh'))
  rmSync(join(res, 'skills', 'notes-new-note', 'SKILL.md'))
  rmSync(join(res, 'app-update.yml'))
  const problems = checkResources(res, { mac: true, asarList: asar }).join('\n')
  assert.match(problems, /deskmate-hands/)
  assert.match(problems, /character\/vivi\/character\.json/)
  assert.match(problems, /tts-local\/setup\.sh/)
  assert.match(problems, /skills\/notes-new-note has no SKILL\.md/)
  assert.match(problems, /app-update\.yml/)
})

test('a one-arch helper in a universal build, a non-executable script, a dev venv and private characters are caught', { skip: process.platform === 'win32' && 'no exec bits on Windows' }, () => {
  const res = goodResources()
  chmodSync(join(res, 'tts-local', 'run.sh'), 0o644)
  file(res, 'tts-local/.venv/bin/python', 0o755)
  file(res, 'character/serena/character.json')
  file(res, 'character/mika/local.json')
  const problems = checkResources(res, { mac: true, universal: true, asarList: asar, archs: () => ['arm64'] }).join('\n')
  assert.match(problems, /not universal \(arm64\)/)
  assert.match(problems, /run\.sh is not executable/)
  assert.match(problems, /\.venv got in/)
  assert.match(problems, /not shipped got in: serena/)
  assert.match(problems, /mika\/local\.json/)
})

test('app.asar without the pages or electron-updater, or with a .env, is caught', () => {
  const problems = checkResources(goodResources(), { mac: true, asarList: ['/package.json', '/out/main/index.js', '/.env', '/out/renderer/models/ani/x.vrm'], archs: universal }).join('\n')
  assert.match(problems, /out\/renderer\/setup\.html/)
  assert.match(problems, /electron-updater/)
  assert.match(problems, /private files: \.env, out\/renderer\/models\/ani\/x\.vrm/)
})

test('Windows/Linux resources need no helper', () => {
  const res = goodResources()
  rmSync(join(res, 'bin'), { recursive: true })
  assert.deepEqual(checkResources(res, { mac: false, asarList: asar }), [])
})

test('the build config ships exactly the five characters, the scripts and the helper', () => {
  const chars = config.extraResources.find((r: { from: string }) => r.from === 'character')
  assert.deepEqual(chars.filter, SHIPPED_CHARACTERS.flatMap((id: string) => [`${id}/character.json`, `${id}/persona.md`]))
  const tts = config.extraResources.find((r: { from: string }) => r.from === 'tts-local')
  assert.deepEqual([...tts.filter].sort(), [...TTS_SCRIPTS].sort())
  assert.deepEqual(config.mac.extraResources, [{ from: 'native/bin', to: 'bin', filter: ['deskmate-hands'] }])
  assert.deepEqual(config.mac.target.map((t: { arch: string[] }) => t.arch), [['universal'], ['universal']])
  assert.equal(config.publish.releaseType, 'draft')
})

test('signing: ad-hoc without a certificate; Developer ID with one; notarized only with a full set of Apple credentials', () => {
  // made-up values, not real credentials
  assert.deepEqual(signingPlan({}), { developerId: false, notarize: false, why: 'no Developer ID certificate (CSC_LINK / CSC_NAME): ad-hoc signed' })
  assert.equal(signingPlan({ CSC_LINK: '' }).developerId, false, 'an unset GitHub secret is an empty string')
  assert.equal(signingPlan({ CSC_LINK: 'cert.p12' }).developerId, true)
  assert.equal(signingPlan({ CSC_LINK: 'cert.p12' }).notarize, false)
  assert.equal(signingPlan({ CSC_NAME: 'Developer ID Application: Someone (ABCDE12345)' }).developerId, true)
  assert.equal(signingPlan({ DESKMATE_SIGN: '1' }).developerId, true)
  const appleId = { CSC_LINK: 'cert.p12', APPLE_ID: 'me@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'made-up', APPLE_TEAM_ID: 'ABCDE12345' }
  assert.equal(signingPlan(appleId).notarize, true)
  assert.equal(signingPlan({ ...appleId, APPLE_TEAM_ID: '' }).notarize, false, 'a partial set does not notarize')
  assert.equal(signingPlan({ CSC_LINK: 'cert.p12', APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'issuer' }).notarize, true)
  assert.equal(signingPlan({ APPLE_ID: 'me@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'made-up', APPLE_TEAM_ID: 'ABCDE12345' }).notarize, false, 'no certificate, no notarization')
})
