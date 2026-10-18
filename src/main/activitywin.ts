import { BrowserWindow, screen } from 'electron'
import type { ActivityView } from '../shared/types'

/**
 * The Activity window: a small page listing what she did today (each tool call, from where, who said yes, why), with
 * Undo where it is honest and "can't undo" where it is not. Opened from the tray or by asking her; it updates while
 * open.
 */
export class ActivityWindow {
  private win: BrowserWindow | null = null

  constructor(
    private readonly preload: string,
    private readonly loadPage: (win: BrowserWindow, page: string) => void,
    private readonly view: () => ActivityView
  ) {}

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show()
      this.win.focus()
      this.refresh()
      return
    }
    const { workArea } = screen.getPrimaryDisplay()
    const win = new BrowserWindow({
      width: 460,
      height: 600,
      x: workArea.x + Math.round((workArea.width - 460) / 2),
      y: workArea.y + 80,
      title: 'What she did',
      minWidth: 360,
      minHeight: 300,
      fullscreenable: false,
      webPreferences: { preload: this.preload, sandbox: false }
    })
    this.win = win
    this.loadPage(win, 'activity')
    win.webContents.once('did-finish-load', () => this.refresh())
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
  }

  get open(): boolean {
    return Boolean(this.win && !this.win.isDestroyed())
  }

  refresh(): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('activity:update', this.view())
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
  }
}
