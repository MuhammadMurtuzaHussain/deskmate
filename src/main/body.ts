import { BrowserWindow, screen } from 'electron'
import type { Hands, Rect } from './hands'
import type { Anchors, BodyState, Gesture } from '../shared/types'
import { HoverSwat, nearHead } from './hover'

/**
 * Her body on the desktop: she walks (her window glides along the bottom of the screen while the renderer animates
 * the steps), points at things (standing beside them, with a ring around the spot), sits or lies on the top edge of a
 * window and rides along when it moves (and gets up again after a few minutes), peeks in from behind the edge of the
 * screen, sleeps, wanders when she is bored, swats at the pointer when it hovers by her head, and now and then
 * stretches, yawns or glances at the pointer. The renderer does the poses; this decides where her window goes and what
 * she is doing.
 */

export interface BodyDeps {
  win(): BrowserWindow | null
  hands: Hands
  /** bundle ids of her own app, so she never sits on herself */
  selfIds: string[]
  log(line: string): void
  /** true while she is doing something for the user (talking, listening, working): no getting up or fidgeting then */
  busy?(): boolean
  /** she just swatted at the pointer (for an occasional line about it) */
  onSwat?(): void
}

/** How she rests on a window's top edge. */
export type Seat = 'sit' | 'lie'

const SPEED = 520 // px per second
const SIT_POLL_MS = 250
/** how long each gesture plays in the renderer */
const GESTURE_MS: Record<Gesture['kind'], number> = { stretch: 2600, yawn: 2800, glance: 1800, swat: 1500, sigh: 2600 }
const CURSOR_POLL_MS = 200

/** Minutes she stays on a window before getting up: DESKMATE_SIT_MINUTES, or 3 to 6 at random; null = until told. */
function sitMinutes(): number | null {
  const raw = process.env.DESKMATE_SIT_MINUTES?.trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n
  }
  return 3 + Math.random() * 3
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref())

export class Body {
  private state: BodyState = { mode: 'idle' }
  private anchors: Anchors | null = null
  private home: { x: number; y: number } | null = null
  private walking: { cancel: () => void } | null = null
  private sitting: { windowId: number; seat: Seat; dx: number; lastX: number; lastY: number; timer: NodeJS.Timeout; getUpAt: number } | null = null
  private wanderTimer: NodeJS.Timeout | null = null
  private touchTimer: NodeJS.Timeout | null = null
  private cursorTimer: NodeJS.Timeout | null = null
  /** the pointer hovering by her head for a couple of seconds; a swat at most every 40 s */
  private hover = new HoverSwat(2000, 40_000)
  /** peeking in from a screen edge: until when (Infinity = until called), and the epoch that put her there */
  private peeking: { until: number; epoch: number; timer: NodeJS.Timeout } | null = null
  /** a Claude Code job has run long enough that she is bored with it */
  private bored = false
  private legs = 330
  /** bumped by anything that takes over her body, so a getting-up sequence in progress stops where it is */
  private epoch = 0
  /** the epoch of a getting-up sequence in progress; it counts only while nothing has taken over since */
  private downEpoch = -1
  private highlights = new Set<BrowserWindow>()

  constructor(private readonly deps: BodyDeps) {}

  get mode(): BodyState['mode'] {
    return this.state.mode
  }

  private get gettingUp(): boolean {
    return this.downEpoch === this.epoch
  }

  get wandering(): boolean {
    return this.wanderTimer !== null
  }

  /** The window she sits or lies on, if any. */
  get seat(): Seat | null {
    return this.sitting?.seat ?? null
  }

  get isBored(): boolean {
    return this.bored
  }

  setAnchors(a: Anchors): void {
    this.anchors = a
    // Her leg length standing, for where she lies on a window (lying, the feet are up in the air).
    if (this.state.mode === 'idle' && a.feet.y > a.hips.y) this.legs = a.feet.y - a.hips.y
  }

  /** Where she lives when she is not off doing something: the spot she was first put, or last dragged to. */
  rememberHome(): void {
    const win = this.deps.win()
    if (!win) return
    const [x, y] = win.getPosition()
    this.home = { x, y }
  }

  private send(state: BodyState): void {
    this.state = this.bored ? { ...state, bored: true } : state
    if (state.mode !== 'peek') this.stopPeeking()
    this.deps.win()?.webContents.send('avatar:body', this.state)
  }

  /** Bored (a long Claude Code job) or not: she slumps and sighs on top of whatever she is doing. */
  setBored(on: boolean): void {
    if (this.bored === on) return
    this.bored = on
    const { bored: _, ...rest } = this.state
    this.send(rest)
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

  /** Back to standing: off the window she sits on (down to the bottom of the screen), else where she is. */
  stand(): void {
    if (this.sitting) {
      void this.getDown({ stretch: false, home: false })
      return
    }
    this.epoch++
    if (this.state.mode === 'peek') {
      void this.goHome()
      return
    }
    this.send({ mode: 'idle' })
  }

  async goHome(): Promise<void> {
    this.epoch++
    this.stopSitting()
    if (this.home) await this.walkTo(this.home.x, this.home.y)
    this.send({ mode: 'idle' })
  }

  /** "Come here": walk along the bottom of the screen to below the pointer. */
  async comeToCursor(): Promise<void> {
    const win = this.deps.win()
    if (!win) return
    this.epoch++
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
    this.epoch++
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
  async sitOnTopWindow(opts: { seat?: Seat; only?: (top: { bundleId: string; app: string }) => boolean } = {}): Promise<string | 'too_high' | null> {
    const top = await this.deps.hands.topWindow(this.deps.selfIds).catch(() => null)
    if (!top || (opts.only && !opts.only(top))) return null
    const seat = opts.seat ?? 'sit'
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(top.frame.x + top.frame.w / 2), y: Math.round(top.frame.y) })
    // Lying, her head is about level with her hips and her feet kick up behind: half the room sitting needs.
    const torso = (this.anchors?.hips.y ?? 380) - (this.anchors?.head.y ?? 60)
    const above = (seat === 'lie' ? torso * 0.5 : torso) + 60
    if (top.frame.y - above < workArea.y) return 'too_high'
    await this.sitOn(top.windowId, top.frame, seat, top.app)
    return top.app
  }

  /** How far below the window's edge her hips go: sitting, the seat of her thighs; lying, the front of her body. */
  private seatDrop(seat: Seat): number {
    if (seat === 'sit') return 6
    // Lying, her front is a little below her hips joint; the skirt drapes over the edge.
    return Math.round(Math.max(6, this.legs * 0.06))
  }

  private async sitOn(windowId: number, frame: Rect, seat: Seat, app = 'a window'): Promise<void> {
    const win = this.deps.win()
    if (!win) return
    this.epoch++
    this.stopSitting()
    const [w] = win.getSize()
    const hipsY = this.anchors?.hips.y ?? win.getSize()[1] * 0.5
    const hipsX = this.anchors?.hips.x ?? w / 2
    // Toward the right of the edge, clear of the window's own buttons on the left.
    const seatX = frame.x + frame.w * (seat === 'lie' ? 0.62 : 0.72)
    const x = Math.round(seatX - hipsX)
    const y = Math.round(frame.y - hipsY + this.seatDrop(seat))
    const [x0] = win.getPosition()
    // Walk under the spot, then hop up onto it.
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(seatX), y: Math.round(frame.y) })
    if (Math.abs(x - x0) > 30) await this.walkTo(x, workArea.y + workArea.height - win.getSize()[1] + 8)
    await this.walkTo(x, y)
    this.send({ mode: seat })
    const timer = setInterval(() => void this.followSeat(), SIT_POLL_MS)
    const minutes = sitMinutes()
    const getUpAt = minutes === null ? Infinity : Date.now() + minutes * 60_000
    this.sitting = { windowId, seat, dx: x - frame.x, lastX: frame.x, lastY: frame.y, timer, getUpAt }
    this.deps.log(`${seat === 'lie' ? 'lying' : 'sitting'} on ${app} (window ${windowId}, ${frame.x},${frame.y} ${frame.w}x${frame.h})${minutes === null ? '' : ` for ${minutes.toFixed(1)} min`}`)
  }

  /**
   * Rides along with the window she sits on; when it closes, minimises or leaves the Space, she climbs down and goes
   * home. When her time is up (and she is awake and not busy) she stretches, hops down and walks home.
   */
  private async followSeat(): Promise<void> {
    const seat = this.sitting
    const win = this.deps.win()
    if (!seat || !win) return
    const frame = await this.deps.hands.windowById(seat.windowId).catch(() => null)
    if (this.sitting !== seat) return
    if (!frame) {
      this.deps.log('the window she sat on is gone; going home')
      void this.getDown({ stretch: false, home: true })
      return
    }
    if (Date.now() >= seat.getUpAt && this.state.mode === seat.seat && !this.deps.busy?.()) {
      this.deps.log('had enough of sitting; getting up')
      void this.getDown({ stretch: true, home: true })
      return
    }
    if (frame.x !== seat.lastX || frame.y !== seat.lastY) {
      const hipsY = this.anchors?.hips.y ?? win.getSize()[1] * 0.5
      win.setPosition(Math.round(frame.x + seat.dx), Math.round(frame.y - hipsY + this.seatDrop(seat.seat)))
      seat.lastX = frame.x
      seat.lastY = frame.y
    }
  }

  private stopSitting(): void {
    if (!this.sitting) return
    clearInterval(this.sitting.timer)
    this.sitting = null
  }

  /**
   * Off the window: optionally a stretch first, then a hop down to the bottom of the screen and, with `home`, a walk
   * back to her spot. Anything else that moves her (a drag, another command) stops it where it is.
   */
  private async getDown(opts: { stretch: boolean; home: boolean }): Promise<void> {
    const win = this.deps.win()
    this.stopSitting()
    const epoch = ++this.epoch
    const stale = (): boolean => epoch !== this.epoch || !win || win.isDestroyed()
    this.downEpoch = epoch
    try {
      if (!win) return
      if (opts.stretch) {
        // Lying, she sits up first; the stretch plays over sitting.
        if (this.state.mode === 'lie') this.send({ mode: 'sit' })
        this.gesture({ kind: 'stretch' })
        await delay(GESTURE_MS.stretch)
        if (stale()) return
      }
      this.send({ mode: 'idle' })
      const [x0, y] = win.getPosition()
      const [w, h] = win.getSize()
      const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(x0 + w / 2), y: Math.round(y + h / 2) })
      // A window that left with a Space switch slid off the screen first, and she rode along: land back on it.
      const x = clamp(x0, workArea.x - w * 0.25, workArea.x + workArea.width - w * 0.75)
      const floor = workArea.y + workArea.height - h + 8
      await this.walkTo(x, floor)
      if (stale() || !opts.home || !this.home) return
      await this.walkTo(this.home.x, floor)
      if (stale()) return
      await this.walkTo(this.home.x, this.home.y)
      if (stale()) return
      this.send({ mode: 'idle' })
    } finally {
      if (this.downEpoch === epoch) this.downEpoch = -1
    }
  }

  /** A one-off movement played over what she is doing (see GESTURE_MS for how long each lasts). */
  gesture(g: Gesture): void {
    this.deps.win()?.webContents.send('avatar:gesture', g)
  }

  sleep(): void {
    if (this.state.mode === 'sleep') return
    this.epoch++
    this.walking?.cancel()
    this.send({ mode: 'sleep' })
  }

  /** Awake again: back on her seat if she fell asleep sitting, else standing. */
  wake(): void {
    if (this.state.mode !== 'sleep') return
    // Just woken on her seat: not straight off it, even if her time is up.
    if (this.sitting) this.sitting.getUpAt = Math.max(this.sitting.getUpAt, Date.now() + 20_000)
    this.send({ mode: this.sitting?.seat ?? 'idle' })
  }

  /** The user dragged her somewhere: that is her new place, and she is no longer sitting on anything. */
  userMoved(): void {
    this.epoch++
    this.walking?.cancel()
    // (still 'sit' while she stretches before getting down)
    if (this.sitting || this.state.mode === 'sit' || this.state.mode === 'lie' || this.state.mode === 'peek') {
      this.stopSitting()
      this.send({ mode: 'idle' })
    }
    if (this.state.mode === 'sleep') this.send({ mode: 'idle' })
    this.hover.reset()
    this.rememberHome()
  }

  /**
   * Small signs of life while she stands or sits around: once every minute or two, a glance at the pointer, now and
   * then a yawn, rarely a stretch. Never while she is busy, walking, or asleep.
   */
  idleTouches(on: boolean): void {
    if (this.touchTimer) clearTimeout(this.touchTimer)
    this.touchTimer = null
    if (!on) return
    const next = (): void => {
      this.touchTimer = setTimeout(
        () => {
          this.idleTouch()
          if (this.touchTimer) next()
        },
        50_000 + Math.random() * 70_000
      )
      this.touchTimer.unref()
    }
    next()
  }

  private idleTouch(): void {
    const win = this.deps.win()
    if (!win || !win.isVisible() || this.walking || this.gettingUp || this.deps.busy?.()) return
    if (this.state.mode !== 'idle' && this.state.mode !== 'sit' && this.state.mode !== 'lie') return
    const r = Math.random()
    if (this.bored && r < 0.5) {
      this.gesture({ kind: 'sigh' })
      return
    }
    if (r < 0.55) {
      const p = screen.getCursorScreenPoint()
      const [x, y] = win.getPosition()
      this.gesture({ kind: 'glance', target: { x: p.x - x, y: p.y - y } })
    } else if (r < 0.85) this.gesture({ kind: 'yawn' })
    else this.gesture({ kind: 'stretch' })
  }

  /**
   * Peeks in from behind the left or right edge of the screen: she walks over, slides most of the way off it and leans
   * back in with her head tilted. `boo` first hides her all the way, then pops her back out. She stays `ms`
   * (Infinity: until called back), then walks home. Anything else she does ends it.
   */
  async peek(opts: { side?: -1 | 1; boo?: boolean; ms?: number } = {}): Promise<void> {
    const win = this.deps.win()
    if (!win) return
    const epoch = ++this.epoch
    this.stopSitting()
    const stale = (): boolean => epoch !== this.epoch || win.isDestroyed()
    const [x0, y0] = win.getPosition()
    const [w, h] = win.getSize()
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(x0 + w / 2), y: Math.round(y0 + h / 2) })
    const hipsX = this.anchors?.hips.x ?? w / 2
    const side = opts.side ?? (x0 + hipsX > workArea.x + workArea.width / 2 ? 1 : -1)
    const edge = side > 0 ? workArea.x + workArea.width : workArea.x
    const floor = workArea.y + workArea.height - h + 8
    // Her hips about on the edge, so most of her is past it; the lean brings her head and a shoulder in.
    const peekX = Math.round(edge - side * 10 - hipsX)
    const hiddenX = Math.round(edge + side * w * 0.55 - hipsX)
    await this.walkTo(clamp(peekX - side * 160, workArea.x - w * 0.25, workArea.x + workArea.width - w * 0.75), floor)
    if (stale()) return
    if (opts.boo) {
      await this.walkTo(hiddenX, floor)
      if (stale()) return
      this.send({ mode: 'idle' })
      await delay(1400)
      if (stale()) return
      this.send({ mode: 'peek', facing: side })
      await this.walkTo(peekX, floor)
    } else {
      this.send({ mode: 'peek', facing: side })
      await this.walkTo(peekX, floor)
    }
    if (stale()) return
    // walkTo announced a walk on the way in; she is peeking now
    this.send({ mode: 'peek', facing: side })
    const ms = opts.ms ?? Infinity
    const timer = setInterval(() => {
      const p = this.peeking
      if (!p || Date.now() < p.until || this.deps.busy?.()) return
      this.deps.log('done peeking; going home')
      void this.goHome()
    }, 1000)
    timer.unref()
    this.peeking = { until: Date.now() + ms, epoch, timer }
    this.deps.log(`peeking from the ${side > 0 ? 'right' : 'left'} edge${Number.isFinite(ms) ? ` for ${Math.round(ms / 1000)} s` : ''}`)
  }

  /** Something happened (a message, a poke): a peek she started on her own is over; a "hide" waits to be called. */
  noticed(): void {
    if (this.peeking && Number.isFinite(this.peeking.until)) this.peeking.until = 0
  }

  private stopPeeking(): void {
    if (!this.peeking) return
    clearInterval(this.peeking.timer)
    this.peeking = null
  }

  /**
   * Playing with the pointer: when it hovers by her head for a couple of seconds she reaches for it or swats at it,
   * at most once every 40 s, and never while she is busy, walking, asleep or being carried.
   */
  cursorPlay(on: boolean): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer)
    this.cursorTimer = null
    this.hover.reset()
    if (!on) return
    this.cursorTimer = setInterval(() => this.watchCursor(), CURSOR_POLL_MS)
    this.cursorTimer.unref()
  }

  private watchCursor(): void {
    const win = this.deps.win()
    const a = this.anchors
    const mode = this.state.mode
    const free = mode === 'idle' || mode === 'sit' || mode === 'lie' || mode === 'peek'
    if (!win || !a || !win.isVisible() || !free || this.walking || this.gettingUp || this.deps.busy?.()) {
      this.hover.reset()
      return
    }
    const p = screen.getCursorScreenPoint()
    const [x, y] = win.getPosition()
    // (lying, her hips anchor is beside her head: measured on her standing height instead)
    const hipsY = mode === 'lie' ? a.head.y + this.legs * 0.8 : a.hips.y
    if (!this.hover.update(nearHead({ x: p.x - x, y: p.y - y }, a.head, hipsY), Date.now())) return
    this.gesture({ kind: 'swat', target: { x: p.x - x, y: p.y - y } })
    this.deps.onSwat?.()
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
          if (win && canMove() && this.state.mode === 'idle' && !this.sitting && !this.gettingUp) {
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
    this.stopPeeking()
    if (this.wanderTimer) clearTimeout(this.wanderTimer)
    if (this.touchTimer) clearTimeout(this.touchTimer)
    if (this.cursorTimer) clearInterval(this.cursorTimer)
    for (const h of this.highlights) if (!h.isDestroyed()) h.destroy()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
