// Packaging smoke test: looks inside what electron-builder made (release/) and fails when something the app needs at
// runtime did not make it in: the hands helper (universal on a universal build), the shipped characters and nothing
// else, the skills, the Kokoro scripts (without a venv), the tray icons, the updater's app-update.yml, the pages in
// app.asar, and the macOS usage texts. `npm run dist:mac` runs it last; `node scripts/smoke-package.cjs [app or
// resources dir]` checks one by hand. Nothing is launched.
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join, basename } = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const SHIPPED_CHARACTERS = ['mika', 'shino', 'victoria', 'vita', 'vivi']
const PAGES = ['index', 'setup', 'bar', 'plan', 'activity']
const TTS_SCRIPTS = ['setup.sh', 'run.sh', 'server.py', 'requirements.txt']
const USAGE_KEYS = ['NSMicrophoneUsageDescription', 'NSAppleEventsUsageDescription', 'NSCalendarsFullAccessUsageDescription', 'NSScreenCaptureDescription']

/**
 * Checks one Resources folder. `asarList` is the file list of app.asar (null to skip those checks), `opts.mac` adds the
 * helper, and `opts.universal` wants both architectures in it. Returns the problems found (empty: all good).
 * @param {string} res
 * @param {{ mac?: boolean, universal?: boolean, asarList?: string[] | null, archs?: (file: string) => string[] }} opts
 */
function checkResources(res, opts = {}) {
  const problems = []
  const need = (rel, what) => {
    if (!existsSync(join(res, rel))) problems.push(`missing ${what ?? rel}`)
  }
  need('app.asar')
  need('app-update.yml', 'app-update.yml (the auto-updater reads it)')
  for (const icon of opts.mac ? ['trayTemplate.png', 'trayTemplate@2x.png'] : ['tray.png']) need(join('build', icon))

  const chars = join(res, 'character')
  if (!existsSync(chars)) problems.push('missing character/')
  else {
    for (const id of SHIPPED_CHARACTERS) {
      need(join('character', id, 'character.json'))
      need(join('character', id, 'persona.md'))
    }
    const extra = readdirSync(chars).filter((d) => !d.startsWith('.') && !SHIPPED_CHARACTERS.includes(d))
    if (extra.length) problems.push(`characters that are not shipped got in: ${extra.join(', ')}`)
    for (const id of SHIPPED_CHARACTERS) if (existsSync(join(chars, id, 'local.json'))) problems.push(`character/${id}/local.json got in (private tweaks)`)
  }

  const skills = join(res, 'skills')
  if (!existsSync(skills)) problems.push('missing skills/')
  else {
    const list = readdirSync(skills).filter((d) => statSync(join(skills, d)).isDirectory())
    if (!list.length) problems.push('skills/ is empty')
    for (const s of list) if (!existsSync(join(skills, s, 'SKILL.md')) && !existsSync(join(skills, s, 'skill.json'))) problems.push(`skills/${s} has no SKILL.md or skill.json`)
  }

  for (const f of TTS_SCRIPTS) need(join('tts-local', f))
  if (existsSync(join(res, 'tts-local', '.venv'))) problems.push('tts-local/.venv got in (a developer venv, hundreds of MB)')
  for (const f of ['setup.sh', 'run.sh']) {
    const p = join(res, 'tts-local', f)
    if (existsSync(p) && process.platform !== 'win32' && !(statSync(p).mode & 0o111)) problems.push(`tts-local/${f} is not executable`)
  }

  if (opts.mac) {
    const helper = join(res, 'bin', 'deskmate-hands')
    if (!existsSync(helper)) problems.push('missing bin/deskmate-hands (app control, banners, calendar)')
    else {
      if (!(statSync(helper).mode & 0o111)) problems.push('bin/deskmate-hands is not executable')
      const archs = (opts.archs ?? lipoArchs)(helper)
      if (opts.universal && !(archs.includes('arm64') && archs.includes('x86_64'))) problems.push(`bin/deskmate-hands is not universal (${archs.join(', ') || 'unknown'})`)
    }
  }

  if (opts.asarList) {
    const have = new Set(opts.asarList.map((p) => p.replace(/\\/g, '/').replace(/^\//, '')))
    for (const f of ['package.json', 'out/main/index.js', 'out/preload/index.js', ...PAGES.map((p) => `out/renderer/${p}.html`)]) {
      if (!have.has(f)) problems.push(`app.asar has no ${f}`)
    }
    if (![...have].some((p) => p.startsWith('node_modules/electron-updater/'))) problems.push('app.asar has no node_modules/electron-updater')
    const leaks = [...have].filter((p) => /(^|\/)\.env(\.|$)|(^|\/)local\.json$|^out\/renderer\/models\/(ani|jian|nicole)\//.test(p))
    if (leaks.length) problems.push(`app.asar has private files: ${leaks.slice(0, 5).join(', ')}`)
  }
  return problems
}

function lipoArchs(file) {
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/)
  } catch {
    return []
  }
}

function asarList(file) {
  try {
    return require('@electron/asar').listPackage(file, { isPack: false })
  } catch (err) {
    console.warn(`[smoke] could not list ${file}: ${err.message}`)
    return null
  }
}

/** Info.plist of a .app: the usage texts macOS shows, LSUIElement (menu-bar app), the version. */
function checkInfoPlist(app) {
  const problems = []
  let info
  try {
    info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }))
  } catch (err) {
    return [`could not read Info.plist: ${err.message}`]
  }
  for (const k of USAGE_KEYS) if (!info[k]) problems.push(`Info.plist has no ${k}`)
  if (info.LSUIElement !== true && info.LSUIElement !== '1') problems.push('Info.plist: LSUIElement is not set (she would get a Dock icon)')
  const version = require('../package.json').version
  if (info.CFBundleShortVersionString !== version) problems.push(`Info.plist version ${info.CFBundleShortVersionString} is not package.json's ${version}`)
  return problems
}

/** How the .app is signed: "Developer ID (TEAMID)", "ad-hoc", or "unsigned"; and whether the signature verifies. */
function signature(app) {
  // codesign writes its report to stderr
  const r = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const team = /TeamIdentifier=(\S+)/.exec(out)?.[1]
  const kind = /Signature=adhoc/.test(out) ? 'ad-hoc' : team && team !== 'not set' ? `Developer ID (${team})` : /code object is not signed/.test(out) ? 'unsigned' : 'unknown'
  let verifies = true
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' })
  } catch {
    verifies = false
  }
  return { kind, verifies }
}

function findTargets(arg) {
  if (arg) {
    if (arg.endsWith('.app')) return [{ name: basename(arg), app: arg, res: join(arg, 'Contents', 'Resources'), mac: true }]
    return [{ name: arg, app: null, res: arg, mac: existsSync(join(arg, 'bin', 'deskmate-hands')) }]
  }
  const release = join(__dirname, '..', 'release')
  if (!existsSync(release)) return []
  const out = []
  for (const d of readdirSync(release)) {
    const app = join(release, d, 'Deskmate.app')
    if (d.startsWith('mac') && existsSync(app)) out.push({ name: d, app, res: join(app, 'Contents', 'Resources'), mac: true, universal: d === 'mac-universal' })
    for (const r of ['resources']) {
      const res = join(release, d, r)
      if (/-unpacked$/.test(d) && existsSync(res)) out.push({ name: d, app: null, res, mac: false })
    }
  }
  return out
}

function main() {
  const targets = findTargets(process.argv[2])
  if (!targets.length) {
    console.error('[smoke] nothing to check: build first (npm run dist:mac or npm run pack)')
    process.exit(1)
  }
  let failed = false
  for (const t of targets) {
    const problems = checkResources(t.res, { mac: t.mac, universal: t.universal, asarList: asarList(join(t.res, 'app.asar')) })
    if (t.app) problems.push(...checkInfoPlist(t.app))
    let sig = ''
    if (t.app && process.platform === 'darwin') {
      const s = signature(t.app)
      sig = ` · ${s.kind}${s.verifies ? '' : ', signature does NOT verify'}`
      if (!s.verifies || s.kind === 'unsigned') problems.push(`the app is ${s.kind}${s.verifies ? '' : ' and its signature does not verify'}: Apple silicon Macs call it damaged`)
    }
    if (problems.length) {
      failed = true
      console.error(`[smoke] ${t.name}: ${problems.length} problem(s)${sig}`)
      for (const p of problems) console.error(`  - ${p}`)
    } else console.log(`[smoke] ${t.name}: ok${sig}`)
  }
  process.exit(failed ? 1 : 0)
}

if (require.main === module) main()

module.exports = { checkResources, SHIPPED_CHARACTERS, TTS_SCRIPTS, PAGES }
