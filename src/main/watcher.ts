import { watch, type FSWatcher } from 'chokidar'
import { relative } from 'node:path'

/** Collects project file events ("gotta watch those project files") into a short buffer the brain can read. */
export class ProjectWatcher {
  private watcher: FSWatcher | null = null
  private events: string[] = []

  constructor(private readonly dir: string) {}

  start(): void {
    if (this.watcher) return
    this.watcher = watch(this.dir, {
      ignored: (p: string) => /(^|[\\/])(node_modules|\.git|dist|out|build|\.next|target)([\\/]|$)/.test(p),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    })
    for (const ev of ['add', 'change', 'unlink'] as const) {
      this.watcher.on(ev, (path: string) => {
        this.events.push(`${ev} ${relative(this.dir, path)}`)
        if (this.events.length > 60) this.events.shift()
      })
    }
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
  }

  /** Returns and clears the buffered events. */
  drain(): string[] {
    const out = this.events
    this.events = []
    return out
  }
}
