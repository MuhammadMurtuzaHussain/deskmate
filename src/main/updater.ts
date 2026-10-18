// Updates. Where the app can replace itself (a Developer ID signed Mac build, the Windows installer, the AppImage),
// electron-updater downloads a new release from GitHub in the background and installs it when she quits; the tray
// offers "Restart to update". Everywhere else (an unsigned Mac build, which Squirrel.Mac refuses to install over;
// the portable Windows exe; a .deb; a checkout) it falls back to updates.ts: one status line and a tray item that opens
// the release page. DESKMATE_UPDATE_CHECK=0 turns both off; DESKMATE_UPDATE_AUTO=0 keeps the check but never downloads.

import { execFile } from 'node:child_process'
import type { Release } from './updates'

export type UpdateMode = 'auto' | 'notify' | 'off'

export interface Signature {
  kind: 'developer-id' | 'adhoc' | 'unsigned' | 'unknown'
  team?: string
}

export interface ModeInput {
  enabled: boolean
  packaged: boolean
  platform: NodeJS.Platform
  /** the running .app's code signature (macOS only) */
  signature?: Signature | null
  env: Record<string, string | undefined>
}

/** Whether this copy can update itself, only tell, or not look at all; `why` is for the log and Setup. */
export function updateMode(i: ModeInput): { mode: UpdateMode; why: string } {
  if (!i.enabled) return { mode: 'off', why: 'DESKMATE_UPDATE_CHECK=0' }
  if (!i.packaged) return { mode: 'notify', why: 'running from a checkout: git pull to update' }
  if (/^(0|false|no|off)$/i.test(i.env.DESKMATE_UPDATE_AUTO?.trim() || '')) return { mode: 'notify', why: 'DESKMATE_UPDATE_AUTO=0' }
  if (i.platform === 'darwin') {
    if (i.signature?.kind === 'developer-id') return { mode: 'auto', why: `signed by ${i.signature.team ?? 'a Developer ID'}` }
    return { mode: 'notify', why: `${i.signature?.kind === 'adhoc' ? 'ad-hoc signed' : 'not signed'} build: macOS only installs updates signed with a Developer ID` }
  }
  if (i.platform === 'win32') {
    if (i.env.PORTABLE_EXECUTABLE_DIR) return { mode: 'notify', why: 'the portable exe cannot update itself' }
    return { mode: 'auto', why: 'installed with the Windows installer' }
  }
  if (i.platform === 'linux') {
    if (i.env.APPIMAGE) return { mode: 'auto', why: 'AppImage' }
    return { mode: 'notify', why: 'installed from a package: update it the same way' }
  }
  return { mode: 'notify', why: i.platform }
}

/** Reads `codesign -dv` output: ad-hoc, a Team ID (Developer ID), or no signature. */
export function parseCodesign(out: string): Signature {
  if (/code object is not signed/i.test(out)) return { kind: 'unsigned' }
  if (/Signature=adhoc/.test(out)) return { kind: 'adhoc' }
  const team = /TeamIdentifier=(\S+)/.exec(out)?.[1]
  if (team && team !== 'not set') return { kind: 'developer-id', team }
  return { kind: 'unknown' }
}

/** The signature of the .app that contains `exePath` (process.execPath). */
export function macSignature(exePath: string): Promise<Signature> {
  const app = /^(.*?\.app)(\/|$)/.exec(exePath)?.[1]
  if (!app) return Promise.resolve({ kind: 'unknown' })
  return new Promise((resolve) => {
    execFile('codesign', ['-dv', '--verbose=2', app], { timeout: 10_000 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`
      resolve(out ? parseCodesign(out) : { kind: err ? 'unknown' : 'unsigned' })
    })
  })
}

/** The part of electron-updater's autoUpdater this uses (a fake in tests). */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateState {
  mode: UpdateMode
  /** idle · checking · downloading (auto) · ready (auto: installs on quit) · available (notify: open the page) */
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'available'
  version?: string
  /** the release page, for "available" */
  url?: string
  percent?: number
  /** why it is in this mode, or the last error that made it fall back */
  why: string
}

export interface UpdatesDeps {
  version: string
  mode: { mode: UpdateMode; why: string }
  /** electron-updater's autoUpdater, loaded only in auto mode */
  loadUpdater: () => Promise<AutoUpdaterLike>
  newerRelease: (current: string) => Promise<Release | null>
  onChange: (state: UpdateState) => void
  log: (line: string) => void
}

/** One update check at a time; auto mode drops to notify for the rest of the session after an error. */
export class Updates {
  private updater: AutoUpdaterLike | null = null
  private busy = false
  private deps: UpdatesDeps
  state: UpdateState

  constructor(deps: UpdatesDeps) {
    this.deps = deps
    this.state = { mode: deps.mode.mode, phase: 'idle', why: deps.mode.why }
  }

  private set(patch: Partial<UpdateState>): void {
    const before = JSON.stringify(this.state)
    this.state = { ...this.state, ...patch }
    if (JSON.stringify(this.state) !== before) this.deps.onChange(this.state)
  }

  /** Auto mode could not do its job (no app-update.yml, a signature Squirrel refuses, offline…): tell instead. */
  private fallBack(why: string): void {
    if (this.state.mode !== 'auto') return
    this.deps.log(`[update] cannot install updates here (${why}); will point at the release page instead`)
    this.set({ mode: 'notify', why, ...(this.state.phase === 'ready' ? {} : { phase: 'idle', percent: undefined }) })
  }

  private async autoUpdater(): Promise<AutoUpdaterLike | null> {
    if (this.updater) return this.updater
    try {
      const u = await this.deps.loadUpdater()
      u.autoDownload = true
      u.autoInstallOnAppQuit = true
      u.on('checking-for-update', () => this.set({ phase: this.state.phase === 'ready' ? 'ready' : 'checking' }))
      u.on('update-not-available', () => this.set({ phase: this.state.phase === 'ready' ? 'ready' : 'idle' }))
      u.on('update-available', (info: { version?: string }) => this.set({ phase: 'downloading', version: info?.version, percent: 0 }))
      u.on('download-progress', (p: { percent?: number }) => this.set({ phase: 'downloading', percent: Math.round(p?.percent ?? 0) }))
      u.on('update-downloaded', (info: { version?: string }) => this.set({ phase: 'ready', version: info?.version ?? this.state.version, percent: 100 }))
      u.on('error', (err: Error) => {
        this.deps.log(`[update] ${String(err?.message ?? err).split('\n')[0]}`)
        this.fallBack(String(err?.message ?? err).split('\n')[0].slice(0, 160))
        // a download that failed after the check: look for the release page now rather than in six hours
        if (!this.busy) void this.check()
      })
      this.updater = u
      return u
    } catch (err) {
      this.fallBack(`electron-updater did not load: ${(err as Error).message}`)
      return null
    }
  }

  async check(): Promise<void> {
    if (this.state.mode === 'off' || this.busy || this.state.phase === 'ready') return
    this.busy = true
    try {
      if (this.state.mode === 'auto') {
        const u = await this.autoUpdater()
        if (u && this.state.mode === 'auto') {
          try {
            await u.checkForUpdates()
          } catch (err) {
            this.fallBack((err as Error).message.split('\n')[0].slice(0, 160))
          }
        }
        if (this.state.mode === 'auto') return
      }
      const found = await this.deps.newerRelease(this.deps.version)
      if (found) this.set({ phase: 'available', version: found.version, url: found.url })
    } finally {
      this.busy = false
    }
  }

  /** "Restart to update": quits and installs the downloaded release, then opens the new one. */
  restart(): boolean {
    if (this.state.phase !== 'ready' || !this.updater) return false
    this.updater.quitAndInstall(false, true)
    return true
  }
}
