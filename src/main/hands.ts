import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { CalendarEvent } from './calendar'
import type { Banner } from './inbox'

/** A failure the helper reported ("not_installed", "focus_changed: …", "blocked_combo: …"). */
export class HandsError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

export interface FocusedElement {
  role?: string
  subrole?: string
  title?: string
  description?: string
  placeholder?: string
  value?: string
}

/** Screen rectangle in points, top-left origin (the same space as Electron's screen coordinates on macOS). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Snapshot {
  app: string
  bundleId: string
  title: string | null
  /** "[3] Button "Send"", numbered for act() */
  elements: string[]
  text: string
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

/**
 * Talks to native/bin/deskmate-hands, the Swift helper that launches apps, presses keys, pastes text and reads window
 * titles and menus on macOS. One long-lived process, JSON lines both ways, started on first use and again after a
 * crash. Requests run in order on the helper's side.
 */
export class Hands {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly waiting = new Map<number, Pending>()

  constructor(private readonly binary: string) {}

  /** Where the helper lives: next to the app's resources when packaged, under native/bin in a checkout. */
  static locate(resources: string, root: string): string {
    const packaged = join(resources, 'bin', 'deskmate-hands')
    return existsSync(packaged) ? packaged : join(root, 'native', 'bin', 'deskmate-hands')
  }

  get available(): boolean {
    return process.platform === 'darwin' && existsSync(this.binary)
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc
    const proc = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      const p = this.waiting.get(Number(msg.id))
      if (!p) return
      this.waiting.delete(Number(msg.id))
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg)
      else {
        const error = String(msg.error ?? 'unknown')
        p.reject(new HandsError(error, error.split(':')[0]))
      }
    })
    proc.stderr.on('data', (d: Buffer) => console.warn(`[hands] ${d.toString().trim()}`))
    const gone = (why: string): void => {
      if (this.proc !== proc) return
      this.proc = null
      for (const [id, p] of this.waiting) {
        clearTimeout(p.timer)
        p.reject(new HandsError(`helper ${why}`, 'helper_gone'))
        this.waiting.delete(id)
      }
    }
    proc.on('exit', (code) => gone(`exited (${code})`))
    proc.on('error', (err) => gone(err.message))
    return proc
  }

  call(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (!this.available) return Promise.reject(new HandsError('app control needs macOS and native/bin/deskmate-hands', 'unavailable'))
    const proc = this.start()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new HandsError(`${cmd} timed out`, 'timeout'))
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`)
    })
  }

  /** keys: macOS lets her post key presses (the Accessibility switch for the app running her); the one that matters. */
  async permissions(): Promise<{ keys: boolean; accessibility: boolean; screen: boolean }> {
    const r = await this.call('permissions')
    return { keys: Boolean(r.keys), accessibility: Boolean(r.accessibility), screen: Boolean(r.screen) }
  }

  async installed(bundleId: string): Promise<boolean> {
    return Boolean((await this.call('installed', { bundleId })).installed)
  }

  /** Opens or brings the app to the front and waits for a window; works when it is closed or hidden in the tray. */
  async launch(bundleId: string, timeoutMs = 25_000): Promise<{ pid: number; wasRunning: boolean; ms: number }> {
    const r = await this.call('launch', { bundleId, timeoutMs }, timeoutMs + 5000)
    return { pid: Number(r.pid), wasRunning: Boolean(r.wasRunning), ms: Number(r.ms) }
  }

  async frontmost(): Promise<{ bundleId: string; name: string; title?: string }> {
    const r = await this.call('frontmost')
    return { bundleId: String(r.bundleId ?? ''), name: String(r.name ?? ''), title: r.title ? String(r.title) : undefined }
  }

  async windowTitle(bundleId: string): Promise<string | null> {
    const r = await this.call('windowTitle', { bundleId })
    return r.title ? String(r.title) : null
  }

  async focused(bundleId: string): Promise<FocusedElement | null> {
    const r = await this.call('focused', { bundleId })
    return (r.element as FocusedElement | null) ?? null
  }

  /** Focuses the text box whose label mentions `hint` (e.g. "message"); with `expect`, only while that app is in front. */
  async focusInput(bundleId: string, hint: string, expect?: string): Promise<FocusedElement> {
    const r = await this.call('focusInput', { bundleId, hint, expect })
    return r.element as FocusedElement
  }

  /** A chord such as "cmd+k" or "escape"; with `expect`, refused unless that app is still in front. */
  async key(combo: string, expect?: string): Promise<void> {
    await this.call('key', { combo, expect })
  }

  async type(text: string, expect?: string): Promise<void> {
    await this.call('type', { text, expect }, 15_000 + text.length * 30)
  }

  /** Pastes through the clipboard and restores what was on it. */
  async paste(text: string, expect?: string): Promise<void> {
    await this.call('paste', { text, expect })
  }

  async menuItems(bundleId: string): Promise<{ path: string[]; shortcut?: string; enabled: boolean }[]> {
    const r = await this.call('menu', { bundleId })
    return (r.items as { path: string[]; shortcut?: string; enabled: boolean }[]) ?? []
  }

  /** Presses a menu item by its title, matched from the end of its path: ["New Chat"] or ["File", "New Chat"]. */
  async pressMenu(bundleId: string, path: string[], expect?: string): Promise<string[]> {
    const r = await this.call('menu', { bundleId, press: path, expect })
    return (r.pressed as string[]) ?? []
  }

  /** An installed app by name ("spotify" → com.spotify.client). */
  async resolve(name: string): Promise<{ bundleId: string; name: string }> {
    const r = await this.call('resolve', { name })
    return { bundleId: String(r.bundleId), name: String(r.name) }
  }

  /** The front window as the agent sees it: numbered things to act on, and its visible text. */
  async snapshot(bundleId?: string, limits: { maxElements?: number; maxText?: number } = {}): Promise<Snapshot> {
    const r = await this.call('snapshot', { bundleId, ...limits }, 25_000)
    return {
      app: String(r.app ?? ''),
      bundleId: String(r.bundleId ?? ''),
      title: r.title ? String(r.title) : null,
      elements: (r.elements as string[]) ?? [],
      text: String(r.text ?? '')
    }
  }

  /** press (default), focus or click element n of the last snapshot; with `expect`, only while that app is in front. */
  async act(index: number, action: 'press' | 'focus' | 'click', expect?: string): Promise<{ element: FocusedElement; via?: string }> {
    const r = await this.call('act', { index, action, expect })
    return { element: r.element as FocusedElement, via: r.via ? String(r.via) : undefined }
  }

  /** The front window's text read with OCR, as numbered items for clickText(); for apps accessibility cannot read. */
  async ocr(bundleId?: string): Promise<{ app: string; bundleId: string; items: string[] }> {
    const r = await this.call('ocr', { bundleId }, 30_000)
    return { app: String(r.app ?? ''), bundleId: String(r.bundleId ?? ''), items: (r.items as string[]) ?? [] }
  }

  /** Clicks the middle of text item n from the last ocr(); with `expect`, only while that app is in front. */
  async clickText(index: number, expect?: string): Promise<void> {
    await this.call('clickText', { index, expect })
  }

  /** The front-most real window that is not one of `exclude` (her own app), for sitting on. */
  async topWindow(exclude: string[]): Promise<{ windowId: number; bundleId: string; app: string; frame: Rect } | null> {
    const r = await this.call('topWindow', { exclude })
    return r.windowId === null || r.windowId === undefined ? null : { windowId: Number(r.windowId), bundleId: String(r.bundleId), app: String(r.app), frame: r.frame as Rect }
  }

  /** A window's bounds now; null once it is closed, minimised or on another Space. */
  async windowById(windowId: number): Promise<Rect | null> {
    const r = await this.call('windowById', { windowId })
    return (r.frame as Rect | null) ?? null
  }

  /** Bounds of element n from the last snapshot, or text item n from the last OCR. */
  async elementFrame(index: number): Promise<Rect> {
    return (await this.call('frame', { index })).frame as Rect
  }

  async textFrame(index: number): Promise<Rect> {
    return (await this.call('textFrame', { index })).frame as Rect
  }

  /** An element in the app's front window whose name or value matches the text (a file in Finder, a button). */
  async locate(bundleId: string, text: string): Promise<Rect | null> {
    const r = await this.call('locate', { bundleId, text }, 20_000)
    return (r.frame as Rect | null) ?? null
  }

  /** The notification banners on screen now, and the list when Notification Center is open (needs Accessibility). */
  async banners(): Promise<Banner[]> {
    const r = await this.call('banners', {}, 5000)
    return (r.banners as Banner[]) ?? []
  }

  /**
   * Calendar calls run in their own short-lived helper process: the access question can sit on screen for a while
   * (the long-lived helper would hold every other request behind it), and macOS stops a process that asks wrongly,
   * which must not be the one doing her other work. Packaged, Deskmate is the app macOS asks about; in development
   * (`calendarDisclaim`) the helper asks for itself, since the app that started the dev server may not be allowed to.
   */
  calendarDisclaim = false

  private calendarCall(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.available) return Promise.reject(new HandsError('calendar needs macOS and native/bin/deskmate-hands', 'unavailable'))
    return new Promise((resolve, reject) => {
      const req = JSON.stringify({ cmd, ...args, ...(this.calendarDisclaim ? { disclaim: true } : {}) })
      execFile(this.binary, [req], { timeout: timeoutMs }, (err, stdout) => {
        let r: Record<string, unknown>
        try {
          r = JSON.parse(String(stdout).trim().split('\n').at(-1) ?? '') as Record<string, unknown>
        } catch {
          reject(new HandsError(err ? err.message : 'no answer from the helper', 'helper_gone'))
          return
        }
        if (r.ok) resolve(r)
        else {
          const error = String(r.error ?? 'unknown')
          reject(new HandsError(error, error.split(':')[0]))
        }
      })
    })
  }

  /** notDetermined / denied / restricted / fullAccess / writeOnly: what macOS lets her read of the calendars. */
  async calendarStatus(): Promise<string> {
    return String((await this.calendarCall('calendarStatus', {}, 10_000)).status ?? 'unknown')
  }

  /** Calendar events from `pastMinutes` ago to `minutes` from now, earliest first (needs fullAccess). */
  async calendarEvents(minutes: number, pastMinutes = 0): Promise<CalendarEvent[]> {
    const r = await this.calendarCall('calendar', { minutes: Math.round(minutes), pastMinutes: Math.round(pastMinutes) }, 15_000)
    return (r.events as CalendarEvent[]) ?? []
  }

  /** Asks macOS for read access to the calendars (a prompt the first time; System Settings after a no). */
  async requestCalendarAccess(timeoutMs = 120_000): Promise<{ granted: boolean; status: string; error?: string }> {
    try {
      const r = await this.calendarCall('calendarAccess', { timeoutMs }, timeoutMs + 5000)
      return { granted: Boolean(r.granted), status: String(r.status ?? 'unknown'), ...(r.error ? { error: String(r.error) } : {}) }
    } catch (err) {
      return { granted: false, status: 'unknown', error: (err as Error).message }
    }
  }

  stop(): void {
    this.proc?.stdin.end()
    this.proc = null
  }
}
