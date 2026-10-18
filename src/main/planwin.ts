import { BrowserWindow, screen } from 'electron'
import type { Plan } from '../shared/types'

const WIDTH = 330

/**
 * The plan card: a small floating card beside her with the steps, ticking off as they finish, and Go / Pause / Stop.
 * It follows her window around, sits on whichever side has room, and never takes the keyboard from the app in front.
 */
export class PlanCard {
  private win: BrowserWindow | null = null
  private plan: Plan | null = null
  private height = 220
  private hideTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly preload: string,
    private readonly loadPage: (win: BrowserWindow, page: string) => void,
    private readonly anchor: () => BrowserWindow | null
  ) {}

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: this.height,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      webPreferences: { preload: this.preload, sandbox: false }
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.loadPage(win, 'plan')
    win.webContents.once('did-finish-load', () => win.webContents.send('plan:update', this.plan))
    return win
  }

  /** Shows the plan (or updates it); a finished or stopped plan stays a few seconds, then the card goes. */
  show(plan: Plan): void {
    this.plan = plan
    if (!this.win || this.win.isDestroyed()) this.win = this.create()
    this.win.webContents.send('plan:update', plan)
    this.place()
    if (!this.win.isVisible()) this.win.showInactive()
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
    if (plan.status === 'done' || plan.status === 'stopped') {
      this.hideTimer = setTimeout(() => this.hide(), plan.status === 'done' ? 15_000 : 4000)
      this.hideTimer.unref()
    }
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide()
  }

  setHeight(px: number): void {
    this.height = Math.max(120, Math.min(560, Math.round(px)))
    if (this.win && !this.win.isDestroyed()) {
      this.win.setSize(WIDTH, this.height)
      this.place()
    }
  }

  /** Beside her window: on the left when there is room, else on the right; level with her head. */
  place(): void {
    const her = this.anchor()
    if (!this.win || this.win.isDestroyed() || !her) return
    const b = her.getBounds()
    const { workArea } = screen.getDisplayMatching(b)
    const left = b.x + 60 - WIDTH
    const x = left >= workArea.x ? left : Math.min(b.x + b.width - 60, workArea.x + workArea.width - WIDTH)
    const y = Math.min(Math.max(workArea.y + 8, b.y + 110), workArea.y + workArea.height - this.height - 8)
    this.win.setPosition(Math.round(x), Math.round(y))
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
  }
}
