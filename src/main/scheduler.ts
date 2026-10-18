import type { CallRecord } from './core.ts'
import type { DueInfo, Job, ScheduleStore } from './schedule.ts'

/**
 * Running scheduled jobs: one at a time, each as its own agent turn with nothing of the conversation in it (or as a
 * plan on the card). Where the result goes depends on where the user is: said out loud when they are at the desk
 * (through the notices, so quiet hours hold it), sent to their chat app when they are away, otherwise kept and told
 * when they are back. It always goes into the day log. A risky step (send, delete, buy, run) asks them; when nobody
 * can answer, it waits in schedule.json for their yes instead of running. No Electron in here.
 */

export type Route = 'voice' | 'phone' | 'hold'

/** Where a result goes. In quiet hours nothing goes to the phone; at the desk the notices hold it until quiet ends. */
export function route(p: { present: boolean; phone: boolean; quiet: boolean }): Route {
  if (p.present) return 'voice'
  if (p.phone && !p.quiet) return 'phone'
  return 'hold'
}

export interface RunResult {
  ok: boolean
  say: string
  calls: CallRecord[]
}

export type Ask = (q: { question: string; name: string; input: Record<string, unknown>; what: string }) => Promise<boolean | 'later'>

export interface SchedulerDeps {
  store: ScheduleStore
  /** an agent core to run jobs with (a Claude brain) */
  canRun(): boolean
  /** everything was stopped (the kill switch): a job that comes round is skipped, not run */
  halted?(): boolean
  /** one job as an isolated agent turn; its risky steps ask through `ask` */
  runTurn(job: Job, ask: Ask, lateMs: number): Promise<RunResult>
  /** a plan for the job on the card, waiting for their go */
  makePlan(job: Job): Promise<{ ok: boolean; line: string }>
  /** a step that waited, once they said yes: run as it was */
  runTool(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; line: string }>
  /** at the desk: not locked, not asleep, touched the keyboard or mouse lately */
  present(): boolean
  /** a chat app is paired and on (channels/hub.ts) */
  phone(): boolean
  /** quiet hours or do-not-disturb */
  quiet(): boolean
  /** she is in the middle of something with the user */
  busy(): boolean
  /** said at the desk (through the notices) */
  say(line: string, job: Job | null): Promise<void>
  toPhone(line: string): Promise<void>
  /** a yes or no, at the desk or on the phone; null when no answer came in time */
  ask(question: string, where: 'here' | 'phone'): Promise<boolean | null>
  /** the day log */
  log(kind: string, text: string): void
  console?(line: string): void
  now?(): number
  sleep?(ms: number): Promise<void>
  /** how long a job waits for her to finish what she is doing with the user (default 10 minutes) */
  busyWaitMs?: number
}

export interface JobResult {
  jobId: string
  label: string
  line: string
  at: number
  route: Route
  /** a held result was told when they came back */
  told?: boolean
}

const DAY = 86_400_000

export class Scheduler {
  private readonly deps: SchedulerDeps
  private readonly queue: { job: Job; lateMs: number }[] = []
  private pumping: Promise<void> | null = null
  private runningJob: Job | null = null
  private backing = false
  /** the latest results, newest last (for "while you were away" and the morning brief) */
  readonly results: JobResult[] = []

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms))
  }

  /** The job running right now. */
  get current(): Job | null {
    return this.runningJob
  }

  /** A job came due (ScheduleStore's onDue). */
  due(job: Job, info: DueInfo): void {
    if (this.queue.some((q) => q.job.id === job.id) || this.runningJob?.id === job.id) return
    this.queue.push({ job, lateMs: info.lateMs })
    void this.pump()
  }

  /** "Run the slack summary now." */
  runNow(job: Job): void {
    this.due(job, { lateMs: 0 })
  }

  /** Resolves when the queue is empty. */
  idle(): Promise<void> {
    return this.pumping ?? Promise.resolve()
  }

  private pump(): Promise<void> {
    if (!this.pumping) {
      this.pumping = (async () => {
        for (let next = this.queue.shift(); next; next = this.queue.shift()) {
          this.runningJob = next.job
          try {
            await this.runOne(next.job, next.lateMs)
          } catch (err) {
            this.deps.console?.(`[schedule] ${next.job.label}: ${(err as Error).message}`)
          } finally {
            this.runningJob = null
          }
        }
      })().finally(() => {
        this.pumping = null
      })
    }
    return this.pumping
  }

  private async runOne(job: Job, lateMs: number): Promise<void> {
    const { store } = this.deps
    // The kill switch is on: nothing runs on its own until the user says resume.
    if (this.deps.halted?.()) {
      store.record(job.id, 'skipped', 'everything was stopped')
      this.deps.log('schedule', `skipped "${job.label}": everything was stopped`)
      return
    }
    // Jobs that tick every few minutes do not run in quiet hours (the user picked a clock time for the others).
    if (job.rule.kind === 'interval' && this.deps.quiet()) {
      store.record(job.id, 'skipped', 'quiet hours')
      this.deps.console?.(`[schedule] skipped "${job.label}": quiet hours`)
      return
    }
    // Not in the middle of something with the user: wait for her to be free.
    const limit = this.deps.busyWaitMs ?? 10 * 60_000
    for (let waited = 0; this.deps.busy() && waited < limit; waited += 3000) await this.sleep(3000)
    if (this.deps.busy()) {
      store.record(job.id, 'skipped', 'she was busy with you')
      this.deps.log('schedule', `skipped "${job.label}": busy`)
      return
    }
    this.deps.console?.(`[schedule] running "${job.label}"${lateMs > 60_000 ? ` (${Math.round(lateMs / 60_000)} min late)` : ''}`)
    if (job.mode === 'plan') {
      const r = await this.deps.makePlan(job)
      store.record(job.id, r.ok ? 'ok' : 'failed', r.line)
      await this.deliver(job, r.line)
      return
    }
    if (!this.deps.canRun()) {
      const line = `It's time for "${job.label}", but I need Claude as my brain to do it on my own.`
      store.record(job.id, 'failed', 'no Claude brain')
      await this.deliver(job, line)
      return
    }
    let result: RunResult
    try {
      result = await this.deps.runTurn(job, this.askFor(), lateMs)
    } catch (err) {
      const message = (err as Error).message || String(err)
      store.record(job.id, 'failed', message)
      await this.deliver(job, `Your scheduled "${job.label}" didn't run: ${message.slice(0, 160)}`)
      return
    }
    const waiting = result.calls.filter((c) => c.deferred)
    for (const c of waiting) store.addWaiting({ jobId: job.id, label: job.label, tool: c.name, input: c.input, what: c.what ?? `use ${c.name}` })
    store.record(job.id, waiting.length ? 'waiting' : result.ok ? 'ok' : 'failed', result.say)
    let line = result.say
    if (waiting.length && !/\bwait/i.test(line)) line = `${line} It's waiting for your yes to ${waiting.map((c) => c.what ?? c.name).join(' and ')}.`
    await this.deliver(job, line)
  }

  /** How a run's risky step asks: at the desk, else on the phone (not in quiet hours), else it waits for them. */
  private askFor(): Ask {
    return async (q) => {
      if (this.deps.present()) {
        const a = await this.deps.ask(q.question, 'here')
        return a === null ? 'later' : a
      }
      if (this.deps.phone() && !this.deps.quiet()) {
        const a = await this.deps.ask(q.question, 'phone')
        return a === null ? 'later' : a
      }
      return 'later'
    }
  }

  private async deliver(job: Job, raw: string): Promise<void> {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) return
    this.deps.log('schedule', `${job.label}: ${line}`)
    const where = route({ present: this.deps.present(), phone: this.deps.phone(), quiet: this.deps.quiet() })
    this.results.push({ jobId: job.id, label: job.label, line, at: this.now(), route: where })
    while (this.results.length > 40) this.results.shift()
    if (where === 'voice') await this.deps.say(line, job)
    else if (where === 'phone') await this.deps.toPhone(`${job.label}: ${line}`)
    else this.deps.console?.(`[schedule] kept for later: ${job.label}`)
  }

  /** Results since a moment (the morning brief), and marks the held ones told. */
  takeResults(since: number): JobResult[] {
    const list = this.results.filter((r) => r.at >= since)
    for (const r of list) r.told = true
    return list
  }

  /** They are back at the desk: what was kept for them, then each step waiting for their yes. */
  async userBack(): Promise<void> {
    if (this.backing || this.deps.busy()) return
    this.backing = true
    try {
      const kept = this.results.filter((r) => r.route === 'hold' && !r.told)
      if (kept.length) {
        for (const r of kept) r.told = true
        const items = kept.slice(-3).map((r) => `${r.label}: ${r.line.replace(/[.!]+$/, '')}`)
        const more = kept.length > 3 ? ` (and ${kept.length - 3} more in my log)` : ''
        await this.deps.say(`While you were away: ${items.join('. ')}${more}.`, null)
      }
      const { store } = this.deps
      for (const w of store.waiting()) {
        if (this.now() - w.at > DAY) {
          store.takeWaiting(w.id)
          this.deps.log('schedule', `dropped (no answer for a day): ${w.what}`)
          continue
        }
        if (!this.deps.present() || this.deps.busy()) break
        const yes = await this.deps.ask(`Your scheduled job "${w.label}" is waiting on you: ${w.what}. Go ahead?`, 'here')
        // No answer: it keeps waiting, and she asks again next time.
        if (yes === null) break
        store.takeWaiting(w.id)
        if (!yes) {
          this.deps.log('schedule', `not done (your no): ${w.what}`)
          await this.deps.say('Okay, dropped it.', null)
          continue
        }
        const r = await this.deps.runTool(w.tool, w.input)
        this.deps.log('schedule', `${r.ok ? 'done' : 'failed'} after your yes: ${w.what}`)
        if (r.line) await this.deps.say(r.line, null)
      }
    } finally {
      this.backing = false
    }
  }
}
