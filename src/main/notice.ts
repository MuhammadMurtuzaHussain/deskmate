import type { NoticePrefs } from '../shared/types'

/**
 * Notices: things she comes to tell you about on her own (a Claude job finished, Sam messaged you on Discord, standup
 * in ten minutes, your stretch reminder). Each one becomes one short line in her voice; she wakes up for it, and for the
 * important ones walks over to your pointer. Repeats are dropped, messages that arrive together are said together, and
 * there is a cap per hour. In quiet hours and under do-not-disturb she keeps them to herself and says what she held
 * back in one line afterwards; reminders you set ring anyway, like an alarm clock. Everything goes into the daily log.
 * No Electron in here, so it can be tested on its own.
 */

export type NoticeKind = 'job' | 'plan' | 'message' | 'calendar' | 'reminder'

export interface Notice {
  kind: NoticeKind
  /** the plain line: what she says unless `speak` says it better, and what the log, the phone and the digest get */
  text: string
  /** repeats of the same key within the dedupe window are dropped (default: kind + text) */
  key?: string
  /** she walks over to the pointer for it */
  important?: boolean
  /** said even in quiet hours or under do-not-disturb (a reminder or timer you set) */
  urgent?: boolean
  /** her own way of saying it (the brain's report of a job, say); the default is the plain line */
  speak?: () => Promise<void>
  /** a few words for the "while I was quiet" line (default: the text) */
  brief?: string
  /** false when the caller already wrote it to the daily log */
  log?: boolean
}

export interface NoticeDeps {
  prefs(): NoticePrefs
  /** says it: notice.speak when it has one, else the plain line (through the phone too, when the phone remote is on) */
  say(notice: Notice): Promise<void>
  /** the same line in her status row, when she does not say it */
  show(text: string): void
  wake(): void
  approach(): void
  log(kind: string, text: string): void
  /** she is talking, listening, or waiting on a yes: a notice waits its turn */
  busy(): boolean
  now?(): number
  /** pause between two spoken notices (messages; the rest wait only for the one before to finish) */
  gapMs?: number
  /** spoken message notices per hour before she stops reading them out (the log still gets them) */
  messagesPerHour?: number
  dedupeMs?: number
  /** longest a notice waits for her to stop being busy before she says it anyway */
  maxWaitMs?: number
}

export const DEFAULT_NOTICE_PREFS: NoticePrefs = {
  jobs: true,
  messages: true,
  readMessages: false,
  calendar: true,
  calendarLead: 10,
  reminders: true,
  quietHours: '',
  dnd: false,
  allowApps: [],
  denyApps: []
}

/** Saved choices over the defaults; DESKMATE_QUIET_HOURS fills quiet hours until some are set in Setup. */
export function noticePrefs(saved: Partial<NoticePrefs> | undefined, envQuiet = process.env.DESKMATE_QUIET_HOURS): NoticePrefs {
  const p = { ...DEFAULT_NOTICE_PREFS, ...(saved ?? {}) }
  if (saved?.quietHours === undefined && envQuiet?.trim()) p.quietHours = envQuiet.trim()
  p.calendarLead = Math.min(120, Math.max(1, Math.round(Number(p.calendarLead) || DEFAULT_NOTICE_PREFS.calendarLead)))
  p.allowApps = cleanList(p.allowApps)
  p.denyApps = cleanList(p.denyApps)
  return p
}

function cleanList(list: unknown): string[] {
  const items = Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : []
  return [...new Set(items.map((s) => String(s).trim()).filter(Boolean))]
}

// ---- quiet hours

export interface QuietHours {
  /** minutes after midnight */
  start: number
  end: number
}

/** "23-8", "23:30-7", "22:00–06:30", "11pm-7am", "off". Null for none or something it cannot read. */
export function parseQuietHours(raw: string | undefined | null): QuietHours | null {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s || /^(?:off|none|no|0|false)$/.test(s)) return null
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(s)
  if (!m) return null
  const clock = (h: string, min: string | undefined, ap: string | undefined): number | null => {
    let hour = Number(h)
    const minute = Number(min ?? 0)
    if (minute > 59) return null
    if (ap) {
      if (hour < 1 || hour > 12) return null
      hour = (hour % 12) + (ap === 'pm' ? 12 : 0)
    } else if (hour > 24) return null
    return (hour % 24) * 60 + minute
  }
  const start = clock(m[1], m[2], m[3])
  const end = clock(m[4], m[5], m[6])
  if (start === null || end === null || start === end) return null
  return { start, end }
}

/** Inside quiet hours at this time? A span past midnight ("23-8") wraps. */
export function inQuietHours(at: Date, q: QuietHours | null): boolean {
  if (!q) return false
  const m = at.getHours() * 60 + at.getMinutes()
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end
}

// ---- the notice center

export type PostResult = 'queued' | 'held' | 'off' | 'duplicate'

export class NoticeCenter {
  private readonly queue: Notice[] = []
  private readonly held: Notice[] = []
  private readonly recent = new Map<string, number>()
  private readonly spokenMessages: number[] = []
  private pumping: Promise<void> | null = null
  private lastSpokeAt = 0
  private wasQuiet = false
  private readonly deps: NoticeDeps

  constructor(deps: NoticeDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Quiet hours or do-not-disturb, right now. */
  quiet(): boolean {
    const p = this.deps.prefs()
    return p.dnd || inQuietHours(new Date(this.now()), parseQuietHours(p.quietHours))
  }

  private enabled(kind: NoticeKind): boolean {
    const p = this.deps.prefs()
    switch (kind) {
      case 'job':
      case 'plan':
        return p.jobs
      case 'message':
        return p.messages
      case 'calendar':
        return p.calendar
      case 'reminder':
        return p.reminders
    }
  }

  post(notice: Notice): PostResult {
    const now = this.now()
    const key = notice.key ?? `${notice.kind}:${notice.text.toLowerCase()}`
    for (const [k, at] of this.recent) if (now - at > (this.deps.dedupeMs ?? 10 * 60_000)) this.recent.delete(k)
    if (this.recent.has(key)) return 'duplicate'
    this.recent.set(key, now)
    if (notice.log !== false) this.deps.log(notice.kind, notice.text)
    if (!this.enabled(notice.kind)) {
      // Switched off in Setup: it shows in her status row and the log, and she stays put.
      this.deps.show(notice.text)
      return 'off'
    }
    if (!notice.urgent && this.quiet()) {
      this.wasQuiet = true
      this.held.push(notice)
      this.deps.show(`(quiet) ${notice.text}`)
      return 'held'
    }
    this.queue.push(notice)
    void this.pump()
    return 'queued'
  }

  /** Call now and then (and when do-not-disturb goes off): once quiet time is over, one line about what she held back. */
  tick(): void {
    if (this.quiet() || !this.wasQuiet) return
    this.wasQuiet = false
    const line = digestLine(this.held.splice(0))
    if (!line) return
    this.queue.push({ kind: 'job', text: line, log: false })
    void this.pump()
  }

  /** Notices held back during quiet time, for the tray or tests. */
  get heldCount(): number {
    return this.held.length
  }

  /** Resolves when everything queued has been said. */
  drain(): Promise<void> {
    return this.pumping ?? Promise.resolve()
  }

  private pump(): Promise<void> {
    if (!this.pumping) {
      this.pumping = this.run().finally(() => {
        this.pumping = null
      })
    }
    return this.pumping
  }

  private async run(): Promise<void> {
    const gap = this.deps.gapMs ?? 12_000
    while (this.queue.length) {
      // Not over her own voice, not while she listens to you, not in the middle of a yes-or-no.
      const waitFrom = this.now()
      while (this.deps.busy() && this.now() - waitFrom < (this.deps.maxWaitMs ?? 20_000) && !this.queue[0].urgent) await sleep(400)
      if (this.queue[0].kind === 'message') {
        const since = this.now() - this.lastSpokeAt
        if (since < gap) await sleep(gap - since)
      }
      let next = this.queue.shift() as Notice
      if (next.kind === 'message') {
        // Messages that piled up while she waited are said together.
        const more = this.queue.filter((n) => n.kind === 'message')
        if (more.length) {
          for (const n of more) this.queue.splice(this.queue.indexOf(n), 1)
          next = { kind: 'message', text: messagesTogether([next, ...more]), log: false }
        }
        const hour = this.now() - 3_600_000
        while (this.spokenMessages.length && this.spokenMessages[0] < hour) this.spokenMessages.shift()
        if (this.spokenMessages.length >= (this.deps.messagesPerHour ?? 20)) {
          this.deps.show(next.text)
          continue
        }
        this.spokenMessages.push(this.now())
      }
      this.deps.wake()
      if (next.important) this.deps.approach()
      try {
        await this.deps.say(next)
      } catch (err) {
        console.warn('[notice]', (err as Error).message)
      }
      this.lastSpokeAt = this.now()
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Two or more message notices as one line: "Three messages: Sam on Discord, Ana on Slack and Mum on Messages." */
export function messagesTogether(list: Notice[]): string {
  const briefs = list.map((n) => n.brief ?? n.text.replace(/[.!]+$/, ''))
  const count = list.length
  const shown = briefs.slice(0, 3)
  const rest = count - shown.length
  const words = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']
  const head = `${words[count] ?? count} messages`
  return `${head}: ${rest > 0 ? `${shown.join(', ')} and ${rest} more` : joinList(shown)}.`
}

/** After quiet time: "While I was quiet: Claude finished the dark mode, and Sam messaged you on Discord." */
export function digestLine(held: Notice[]): string {
  // Calendar nudges are about a moment that has passed; the log has them.
  const keep = held.filter((n) => n.kind !== 'calendar')
  if (!keep.length) return ''
  const messages = keep.filter((n) => n.kind === 'message')
  const others = keep.filter((n) => n.kind !== 'message').map((n) => (n.brief ?? n.text).replace(/[.!]+$/, ''))
  const parts = [...others.slice(0, 3)]
  if (others.length > 3) parts.push(`${others.length - 3} more updates`)
  if (messages.length === 1) parts.push((messages[0].brief ?? messages[0].text).replace(/[.!]+$/, ''))
  else if (messages.length > 1) {
    const apps = [...new Set(messages.map((m) => m.brief?.split(' on ').at(-1)).filter(Boolean))] as string[]
    parts.push(`${messages.length} messages${apps.length ? ` (${joinList(apps.slice(0, 3))})` : ''}`)
  }
  return `While I was quiet: ${joinList(parts)}.`
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
