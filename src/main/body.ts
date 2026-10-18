import { BrowserWindow, screen } from 'electron'
import type { Hands, Rect } from './hands'
import type { Anchors, BodyState } from '../shared/types'

/**
 * Her body on the desktop: she walks (her window glides along the bottom of the screen while the renderer animates
 * the steps), points at things (standing beside them, with a ring around the spot), sits on the top edge of a window
 * and rides along when it moves, sleeps, and wanders when she is bored. The renderer does the poses; this decides where
 * her window goes and what she is doing.
 */

export interface BodyDeps {
  win(): BrowserWindow | null
  hands: Hands
  /** bundle ids of her own app, so she never sits on herself */
  selfIds: string[]
  log(line: string): void
}

const SPEED = 520 // px per second
const SIT_POLL_MS = 250

export class Body {
  private state: BodyState = { mode: 'idle' }
  private anchors: Anchors | null = null
  private home: { x: number; y: number } | null = null
  private walking: { cancel: () => void } | null = null
  private sitting: { windowId: number; dx: number; lastX: number; lastY: number; timer: NodeJS.Timeout } | null = null
  private wanderTimer: NodeJS.Timeout | null = null
  private highlights = new Set<BrowserWindow>()

  constructor(private readonly deps: BodyDeps) {}

  get mode(): BodyState['mode'] {
    return this.state.mode
  }

  get wandering(): boolean {
    return this.wanderTimer !== null
  }

  setAnchors(a: Anchors): void {
    this.anchors = a
  }

  /** Where she lives when she is not off doing something: the spot she was first put, or last dragged to. */
  rememberHome(): void {
    const win = this.deps.win()
    if (!win) return
    const [x, y] = win.getPosition()
    this.home = { x, y }
  }

  private send(state: BodyState): void {
    this.state = state
    this.deps.win()?.webContents.send('avatar:body', state)
  }

  /** Moves her window to (x, y), animating the walk (or a hop when it is mostly vertical). Resolves on arrival. */
  walkTo(x: number, y: number): Promise<void> {
    const win = this.deps.win()
    if (!win) return Promise.resolve()
    this.walking?.cancel()
    const [x0, y0] = win.getPosition()
    const dx = x - x0
    const dy = y - y0
    const dist = Math.hypot(dx, dy)
    if (dist < 4) return Promise.resolve()
    const duration = Math.max(0.35, dist / SPEED) * 1000
    const facing: -1 | 1 = dx < 0 ? -1 : 1
    if (Math.abs(dx) > 20) this.send({ mode: 'walk', facing })
    return new Promise((resolve) => {
      const started = Date.now()
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearInterval(timer)
        this.walking = null
        resolve()
      }
      const timer = setInterval(() => {
        if (win.isDestroyed()) return finish()
        const k = Math.min(1, (Date.now() - started) / duration)
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2 // ease in-out
        win.setPosition(Math.round(x0 + dx * e), Math.round(y0 + dy * e))
        if (k >= 1) finish()
      }, 16)
      this.walking = { cancel: finish }
    })
  }

  /** Back to standing, wherever she is. */
  stand(): void {
    this.stopSitting()
    this.send({ mode: 'idle' })
  }

  async goHome(): Promise<void> {
    this.stopSitting()
    if (this.home) await this.walkTo(this.home.x, this.home.y)
    this.send({ mode: 'idle' })
  }

  /** "Come here": walk along the bottom of the screen to below the pointer. */
  async comeToCursor(): Promise<void> {
    const win = this.deps.win()
    if (!win) return
    this.stopSitting()
    const p = screen.getCursorScreenPoint()
    const { workArea } = screen.getDisplayNearestPoint(p)
    const [w, h] = win.getSize()
    const x = clamp(p.x - w / 2, workArea.x - w * 0.25, workArea.x + workArea.width - w * 0.75)
    const y = workArea.y + workArea.height - h + 8
    await this.walkTo(x, y)
    this.send({ mode: 'idle' })
  }

  /**
   * Walks beside a spot on screen and points at it, with a pulsing ring around it so it is plain what she means.
   * She stays on the bottom of the screen and points up or across; a ring alone covers what she cannot reach.
   */
  async pointAt(rect: Rect, opts: { ms?: number } = {}): Promise<void> {
    const win = this.deps.win()
    if (!win) return
    this.stopSitting()
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) })
    const [w, h] = win.getSize()
    // Stand on the side of the target that has more room, about her own width away from it.
    const rightSide = cx < workArea.x + workArea.width / 2
    const standX = rightSide ? Math.min(rect.x + rect.w, cx + 260) + 40 : Math.max(rect.x, cx - 260) - 40
    const x = clamp(standX - w / 2, workArea.x - w * 0.25, workArea.x + workArea.width - w * 0.75)
    const y = workArea.y + workArea.height - h + 8
    this.highlight(rect, opts.ms ?? 5000)
    await this.walkTo(x, y)
    const [wx, wy] = win.getPosition()
    this.send({ mode: 'point', facing: rightSide ? -1 : 1, target: { x: cx - wx, y: cy - wy } })
    setTimeout(() => {
      if (this.state.mode === 'point') this.send({ mode: 'idle' })
    }, opts.ms ?? 5000).unref()
  }

  /** A ring pulsing around a spot on screen for a few seconds; clicks pass through it. */
  highlight(rect: Rect, ms = 4000): void {
    const pad = 10
    const ring = new BrowserWindow({
      x: Math.round(rect.x - pad),
      y: Math.round(rect.y - pad),
      width: Math.max(24, Math.round(rect.w + pad * 2)),
      height: Math.max(24, Math.round(rect.h + pad * 2)),
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false
    })
    ring.setIgnoreMouseEvents(true)
    ring.setAlwaysOnTop(true, 'screen-saver')
    ring.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
      html,body{margin:0;height:100%;background:transparent;overflow:hidden}
      div{position:absolute;inset:4px;border:3px solid #b38cff;border-radius:12px;box-shadow:0 0 18px #b38cff,inset 0 0 12px rgba(179,140,255,.5);animation:p 1s ease-in-out infinite}
      @keyframes p{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.98)}}
    </style></head><body><div></div></body></html>`
    void ring.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    ring.once('ready-to-show', () => ring.showInactive())
    this.highlights.add(ring)
    setTimeout(() => {
      this.highlights.delete(ring)
      if (!ring.isDestroyed()) ring.destroy()
    }, ms).unref()
  }

  /**
   * Sits on the top edge of the front-most window that is not hers, and rides along when it moves. Null when there is
   * no window; 'too_high' when its top edge is so close to the top of the screen that her head would be off it.
   */
  async sitOnTopWindow(): Promise<string | 'too_high' | null> {
    const top = await this.deps.hands.topWindow(this.deps.selfIds).catch(() => null)
    if (!top) return null
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(top.frame.x + top.frame.w / 2), y: Math.round(top.frame.y) })
    const above = (this.anchors?.hips.y ?? 380) - (this.anchors?.head.y ?? 60) + 60
    if (top.frame.y - above < workArea.y) return 'too_high'
    await this.sitOn(top.windowId, top.frame)
    return top.app
  }

  private async sitOn(windowId: number, frame: Rect): Promise<void> {
    const win = this.deps.win()
    if (!win) return
    this.stopSitting()
    const [w] = win.getSize()
    const hipsY = this.anchors?.hips.y ?? win.getSize()[1] * 0.5
    const hipsX = this.anchors?.hips.x ?? w / 2
    // Toward the right of the edge, clear of the window's own buttons on the left.
    const seatX = frame.x + frame.w * 0.72
    const x = Math.round(seatX - hipsX)
    const y = Math.round(frame.y - hipsY + 6)
    const [x0] = win.getPosition()
    // Walk under the spot, then hop up onto it.
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(seatX), y: Math.round(frame.y) })
    if (Math.abs(x - x0) > 30) await this.walkTo(x, workArea.y + workArea.height - win.getSize()[1] + 8)
    await this.walkTo(x, y)
    this.send({ mode: 'sit' })
    const timer = setInterval(() => void this.followSeat(), SIT_POLL_MS)
    this.sitting = { windowId, dx: x - frame.x, lastX: frame.x, lastY: frame.y, timer }
    this.deps.log(`sitting on window ${windowId}`)
  }

  /** Rides along with the window she sits on; when it closes, minimises or leaves the Space, she goes home. */
  private async followSeat(): Promise<void> {
    const seat = this.sitting
    const win = this.deps.win()
    if (!seat || !win) return
    const frame = await this.deps.hands.windowById(seat.windowId).catch(() => null)
    if (this.sitting !== seat) return
    if (!frame) {
      this.deps.log('the window she sat on is gone; going home')
      void this.goHome()
      return
    }
    if (frame.x !== seat.lastX || frame.y !== seat.lastY) {
      const hipsY = this.anchors?.hips.y ?? win.getSize()[1] * 0.5
      win.setPosition(Math.round(frame.x + seat.dx), Math.round(frame.y - hipsY + 6))
      seat.lastX = frame.x
      seat.lastY = frame.y
    }
  }

  private stopSitting(): void {
    if (!this.sitting) return
    clearInterval(this.sitting.timer)
    this.sitting = null
  }

  sleep(): void {
    if (this.state.mode === 'sleep') return
    this.walking?.cancel()
    this.send({ mode: 'sleep' })
  }

  /** Awake again: back on her seat if she fell asleep sitting, else standing. */
  wake(): void {
    if (this.state.mode !== 'sleep') return
    this.send({ mode: this.sitting ? 'sit' : 'idle' })
  }

  /** The user dragged her somewhere: that is her new place, and she is no longer sitting on anything. */
  userMoved(): void {
    this.walking?.cancel()
    if (this.sitting) this.stand()
    if (this.state.mode === 'sleep') this.send({ mode: 'idle' })
    this.rememberHome()
  }

  /** Every so often, stroll a little way along the bottom of the screen and back toward home. */
  wander(on: boolean, canMove: () => boolean): void {
    if (this.wanderTimer) clearTimeout(this.wanderTimer)
    this.wanderTimer = null
    if (!on) return
    const next = (): void => {
      this.wanderTimer = setTimeout(
        async () => {
          const win = this.deps.win()
          if (win && canMove() && this.state.mode === 'idle' && !this.sitting) {
            const [x, y] = win.getPosition()
            const [w] = win.getSize()
            const { workArea } = screen.getDisplayNearestPoint({ x: x + w / 2, y })
            const home = this.home ?? { x, y }
            // Mostly near home, sometimes further; never off the screen.
            const span = Math.min(600, workArea.width * 0.4)
            const target = clamp(home.x + (Math.random() * 2 - 1) * span, workArea.x - w * 0.2, workArea.x + workArea.width - w * 0.8)
            await this.walkTo(target, y)
            if (this.mode === 'walk') this.send({ mode: 'idle' })
          }
          if (this.wanderTimer) next()
        },
        20_000 + Math.random() * 40_000
      )
      this.wanderTimer.unref()
    }
    next()
  }

  destroy(): void {
    this.walking?.cancel()
    this.stopSitting()
    if (this.wanderTimer) clearTimeout(this.wanderTimer)
    for (const h of this.highlights) if (!h.isDestroyed()) h.destroy()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
