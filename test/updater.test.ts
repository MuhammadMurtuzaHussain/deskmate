// Updater: which copies may install updates themselves, and the fall back to "open the release page". No network,
// no electron-updater: a fake autoUpdater. Run with `npm test`.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { parseCodesign, updateMode, Updates, type AutoUpdaterLike, type UpdateState } from '../src/main/updater.ts'

const mac = (kind: 'developer-id' | 'adhoc' | 'unsigned' | 'unknown', env: Record<string, string> = {}) =>
  updateMode({ enabled: true, packaged: true, platform: 'darwin', signature: { kind, team: kind === 'developer-id' ? 'ABCDE12345' : undefined }, env })

test('only a Developer ID Mac build installs updates; ad-hoc and unsigned ones point at the page', () => {
  assert.equal(mac('developer-id').mode, 'auto')
  assert.match(mac('developer-id').why, /ABCDE12345/)
  assert.equal(mac('adhoc').mode, 'notify')
  assert.match(mac('adhoc').why, /Developer ID/)
  assert.equal(mac('unsigned').mode, 'notify')
  assert.equal(mac('unknown').mode, 'notify')
  assert.equal(updateMode({ enabled: true, packaged: true, platform: 'darwin', signature: null, env: {} }).mode, 'notify')
})

test('DESKMATE_UPDATE_CHECK=0 is off everywhere; DESKMATE_UPDATE_AUTO=0 only tells; a checkout only tells', () => {
  assert.equal(updateMode({ enabled: false, packaged: true, platform: 'darwin', signature: { kind: 'developer-id' }, env: {} }).mode, 'off')
  assert.equal(mac('developer-id', { DESKMATE_UPDATE_AUTO: '0' }).mode, 'notify')
  assert.equal(updateMode({ enabled: true, packaged: false, platform: 'darwin', signature: null, env: {} }).mode, 'notify')
})

test('Windows installer and AppImage update themselves; the portable exe and a .deb do not', () => {
  assert.equal(updateMode({ enabled: true, packaged: true, platform: 'win32', env: {} }).mode, 'auto')
  assert.equal(updateMode({ enabled: true, packaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\\\x' } }).mode, 'notify')
  assert.equal(updateMode({ enabled: true, packaged: true, platform: 'linux', env: { APPIMAGE: '/tmp/D.AppImage' } }).mode, 'auto')
  assert.equal(updateMode({ enabled: true, packaged: true, platform: 'linux', env: {} }).mode, 'notify')
})

test('codesign output: ad-hoc, Developer ID, not signed', () => {
  assert.deepEqual(parseCodesign('Executable=/A.app/Contents/MacOS/A\nCodeDirectory v=20400 flags=0x20002(adhoc,linker-signed)\nSignature=adhoc\nTeamIdentifier=not set\n'), { kind: 'adhoc' })
  assert.deepEqual(parseCodesign('Authority=Developer ID Application: Someone (ABCDE12345)\nTeamIdentifier=ABCDE12345\n'), { kind: 'developer-id', team: 'ABCDE12345' })
  assert.deepEqual(parseCodesign('/A.app: code object is not signed at all\n'), { kind: 'unsigned' })
  assert.deepEqual(parseCodesign('something else'), { kind: 'unknown' })
})

class FakeUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  checks = 0
  installs = 0
  private onCheck: (u: FakeUpdater) => void | Promise<void>
  constructor(onCheck: (u: FakeUpdater) => void | Promise<void>) {
    super()
    this.onCheck = onCheck
  }
  async checkForUpdates(): Promise<unknown> {
    this.checks++
    await this.onCheck(this)
    return null
  }
  quitAndInstall(): void {
    this.installs++
  }
}

function harness(mode: 'auto' | 'notify', updater: FakeUpdater, release: { version: string; url: string } | null = null) {
  const states: UpdateState[] = []
  let pageChecks = 0
  const u = new Updates({
    version: '1.0.0-rc.1',
    mode: { mode, why: 'test' },
    loadUpdater: async () => updater,
    newerRelease: async () => {
      pageChecks++
      return release
    },
    onChange: (s) => states.push({ ...s }),
    log: () => undefined
  })
  return { u, states, pageChecks: () => pageChecks }
}

test('auto: downloads in the background, then Restart to update installs it', async () => {
  const fake = new FakeUpdater((f) => {
    f.emit('checking-for-update')
    f.emit('update-available', { version: '1.0.0' })
    f.emit('download-progress', { percent: 41.6 })
    f.emit('update-downloaded', { version: '1.0.0' })
  })
  const h = harness('auto', fake)
  assert.equal(h.u.restart(), false, 'nothing to install yet')
  await h.u.check()
  assert.equal(fake.autoDownload, true)
  assert.equal(fake.autoInstallOnAppQuit, true)
  assert.ok(h.states.some((s) => s.phase === 'downloading' && s.percent === 42))
  assert.equal(h.u.state.phase, 'ready')
  assert.equal(h.u.state.version, '1.0.0')
  assert.equal(h.pageChecks(), 0, 'auto mode never asks for the release page')
  await h.u.check()
  assert.equal(fake.checks, 1, 'no new check once an update waits')
  assert.equal(h.u.restart(), true)
  assert.equal(fake.installs, 1)
})

test('auto falls back to the release page when the updater fails (e.g. a signature Squirrel refuses)', async () => {
  const fake = new FakeUpdater(() => {
    throw new Error('Could not get code signature for running application\nstack…')
  })
  const h = harness('auto', fake, { version: '1.0.0', url: 'https://github.com/MuhammadMurtuzaHussain/deskmate/releases/tag/v1.0.0' })
  await h.u.check()
  assert.equal(h.u.state.mode, 'notify')
  assert.match(h.u.state.why, /code signature/)
  assert.equal(h.u.state.phase, 'available')
  assert.equal(h.u.state.url, 'https://github.com/MuhammadMurtuzaHussain/deskmate/releases/tag/v1.0.0')
  await h.u.check()
  assert.equal(fake.checks, 1, 'electron-updater is not tried again this session')
  assert.equal(h.u.restart(), false)
})

test('an error event after the check (a failed download) also falls back, and looks for the page right away', async () => {
  const fake = new FakeUpdater((f) => {
    f.emit('update-available', { version: '1.0.0' })
  })
  const h = harness('auto', fake, { version: '1.0.0', url: 'https://github.com/x' })
  await h.u.check()
  assert.equal(h.u.state.phase, 'downloading')
  fake.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
  await new Promise((r) => setImmediate(r))
  assert.equal(h.u.state.mode, 'notify')
  assert.equal(h.pageChecks(), 1)
  assert.equal(h.u.state.phase, 'available')
})

test('electron-updater failing to load falls back too', async () => {
  const states: UpdateState[] = []
  const u = new Updates({
    version: '1.0.0-rc.1',
    mode: { mode: 'auto', why: 'test' },
    loadUpdater: async () => {
      throw new Error('Cannot find module')
    },
    newerRelease: async () => null,
    onChange: (s) => states.push(s),
    log: () => undefined
  })
  await u.check()
  assert.equal(u.state.mode, 'notify')
  assert.equal(u.state.phase, 'idle')
})

test('notify mode never loads electron-updater; off mode does nothing', async () => {
  let loaded = 0
  const make = (mode: 'notify' | 'off') =>
    new Updates({
      version: '0.6.0',
      mode: { mode, why: 'test' },
      loadUpdater: async () => {
        loaded++
        return new FakeUpdater(() => undefined)
      },
      newerRelease: async () => ({ version: '1.0.0', url: 'https://github.com/x' }),
      onChange: () => undefined,
      log: () => undefined
    })
  const n = make('notify')
  await n.check()
  assert.equal(n.state.phase, 'available')
  const off = make('off')
  await off.check()
  assert.equal(off.state.phase, 'idle')
  assert.equal(loaded, 0)
})
