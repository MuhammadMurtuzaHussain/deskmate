// The first-run tour's permission step and Kokoro install progress (main/onboarding.ts). Pure: no macOS calls.
// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { permissionRows, permState, permSummary, settingsUrl, setupError, setupProgress, tryExamples, type PermProbe } from '../src/main/onboarding.ts'

const fresh: PermProbe = {
  accessibility: false,
  screen: 'not-determined',
  microphone: 'not-determined',
  messages: 'notDetermined',
  spotify: 'notInstalled',
  calendars: 'notDetermined',
  fullDisk: false
}
const row = (p: PermProbe, id: string) => permissionRows(p).find((r) => r.id === id)!

test('a fresh Mac: everything askable is "ask", Full Disk Access only has System Settings', () => {
  const rows = permissionRows(fresh)
  assert.deepEqual(rows.map((r) => r.id), ['accessibility', 'screen', 'microphone', 'automation-messages', 'automation-spotify', 'calendars', 'full-disk'])
  assert.equal(row(fresh, 'accessibility').action, 'ask')
  assert.equal(row(fresh, 'microphone').action, 'ask')
  assert.equal(row(fresh, 'calendars').action, 'ask')
  assert.equal(row(fresh, 'automation-messages').action, 'ask')
  assert.equal(row(fresh, 'full-disk').state, 'denied')
  assert.equal(row(fresh, 'full-disk').action, 'settings')
  assert.deepEqual(permSummary(rows), { granted: 0, needed: 3, done: false })
})

test('after a no only System Settings helps; Screen Recording keeps "Allow" (a capture puts the app on the list)', () => {
  const p: PermProbe = { ...fresh, microphone: 'denied', calendars: 'denied', messages: 'denied', screen: 'denied' }
  assert.equal(row(p, 'microphone').action, 'settings')
  assert.equal(row(p, 'calendars').action, 'settings')
  assert.equal(row(p, 'automation-messages').action, 'settings')
  assert.equal(row(p, 'screen').state, 'denied')
  assert.equal(row(p, 'screen').action, 'ask')
  assert.equal(permState('microphone', { ...fresh, microphone: 'restricted' }), 'denied')
})

test('granted rows have no button; the summary counts only the three needed ones', () => {
  const p: PermProbe = { ...fresh, accessibility: true, screen: 'granted', microphone: 'granted', calendars: 'fullAccess', fullDisk: true }
  const rows = permissionRows(p)
  for (const id of ['accessibility', 'screen', 'microphone', 'calendars', 'full-disk']) assert.equal(row(p, id).action, null, id)
  assert.deepEqual(permSummary(rows), { granted: 3, needed: 3, done: true })
  assert.equal(permSummary(permissionRows({ ...p, microphone: 'denied' })).done, false)
  assert.equal(permState('calendars', { ...fresh, calendars: 'authorized' }), 'granted', 'macOS 13 says authorized')
  assert.equal(permState('calendars', { ...fresh, calendars: 'writeOnly' }), 'denied', 'write-only cannot read events')
})

test('Automation: an app that is not open is launched first; not installed has nothing to do; a timeout is asked', () => {
  const p: PermProbe = { ...fresh, messages: 'notRunning', spotify: 'notInstalled' }
  assert.equal(row(p, 'automation-messages').state, 'not-running')
  assert.equal(row(p, 'automation-messages').action, 'launch')
  assert.equal(row(p, 'automation-spotify').state, 'not-installed')
  assert.equal(row(p, 'automation-spotify').action, null)
  const t = { ...fresh, spotify: 'timeout' }
  assert.equal(row(t, 'automation-spotify').state, 'unknown')
  assert.equal(row(t, 'automation-spotify').action, 'ask')
  assert.equal(row({ ...fresh, spotify: 'granted' }, 'automation-spotify').action, null)
})

test('no helper: Accessibility is unknown and points at System Settings', () => {
  const p = { ...fresh, accessibility: null }
  assert.equal(row(p, 'accessibility').state, 'unknown')
  assert.equal(row(p, 'accessibility').action, 'settings')
})

test('each row opens its own System Settings pane', () => {
  assert.equal(settingsUrl('accessibility'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  assert.equal(settingsUrl('screen'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  assert.equal(settingsUrl('automation-spotify'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation')
  assert.equal(settingsUrl('full-disk'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
  for (const r of permissionRows(fresh)) assert.equal(r.pane, settingsUrl(r.id))
})

test('setup.sh progress lines and errors', () => {
  assert.deepEqual(setupProgress('setup.sh: [2/4] creating /x/.venv with Python 3.12.7'), { step: 2, of: 4 })
  assert.equal(setupProgress('Collecting kokoro>=0.9'), null)
  assert.match(setupError(['setup.sh: [1/4] looking for Python 3.10–3.12', 'setup.sh: need Python 3.10–3.12 on PATH (brew install python@3.12)']), /brew install python@3\.12/)
  assert.match(setupError(['ERROR: Could not find a version that satisfies the requirement torch']), /download failed/)
  assert.match(setupError(['OSError: [Errno 28] No space left on device']), /disk is full/)
  assert.equal(setupError(['boom', '']), 'The install stopped: boom')
  assert.equal(setupError([]), 'The install stopped.')
})

test('try me: three examples, the screen one only on a Mac', () => {
  assert.equal(tryExamples('darwin').length, 3)
  assert.ok(tryExamples('darwin').some((e) => /screen/.test(e)))
  assert.ok(!tryExamples('win32').some((e) => /screen/.test(e)))
})
