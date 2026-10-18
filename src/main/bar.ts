import { BrowserWindow, screen } from 'electron'

const WIDTH = 640
const HEIGHT = 132

/**
 * The command bar: a hotkey pops a small bar wherever you are, you type what you want ("tell sam on discord I'm
 * late", "open github", "ask claude to fix the build"), Enter, and it goes through the same path as her chat box.
 * It shows what she says back underneath and stays while she waits on a yes; Escape or clicking away closes it.
 * Works with her hidden.
 */
export class CommandBar {
  private win: BrowserWindow | null = null

  constructor(
    private readonly preload: string,
    private readonly loadPage: (win: BrowserWindow, page: string) => void
  ) {}

  get visible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible())
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // macOS: a non-activating panel takes the keyboard without pulling the app forward, and shows over full-screen apps.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: { preload: this.preload, sandbox: false }
    })
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.on('blur', () => this.hide())
    this.loadPage(win, 'bar')
    return win
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create()
    // On the screen the pointer is on, a fifth of the way down, like Spotlight.
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    this.win.setBounds({
      x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
      y: Math.round(workArea.y + workArea.height * 0.2),
      width: WIDTH,
      height: HEIGHT
    })
    this.win.show()
    this.win.focus()
    this.win.webContents.send('bar:open')
  }

  hide(): void {
    if (this.visible) this.win?.hide()
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  /** A line she said; shown under the input while the bar is open. */
  line(say: string): void {
    if (this.visible) this.win?.webContents.send('bar:line', say)
  }

  status(text: string): void {
    if (this.visible) this.win?.webContents.send('status', text)
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
