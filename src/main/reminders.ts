import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Reminders and timers: "remind me in 20 minutes to stretch", "set a timer for 5 minutes", "remind me at 6pm to call
 * mum", "what reminders do I have", "cancel the stretch reminder". Parsed here without a model (her brain only helps
 * with the odd phrasing this does not know), kept in <user data>/reminders.json so they survive a restart, and fired
 * through notices. No Electron in here.
 */

export interface Reminder {
  id: string
  /** what to remind them of, in her words ("call your mum"); for a timer, its label or "5 minute timer" */
  text: string
  /** when, ms since 1970 */
  at: number
  createdAt: number
  timer: boolean
  /** a timer's length, for "your 5 minute timer is up" */
  ms?: number
}

export type ReminderIntent =
  | { kind: 'set'; at: number; text: string; timer: boolean; ms?: number }
  /** a reminder with no time in it ("remind me to stretch") */
  | { kind: 'needTime'; text: string; timer: boolean }
  | { kind: 'list' }
  | { kind: 'cancel'; query: string; all: boolean; timer: boolean }

// ---- numbers and durations

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 }
const NUM = `(?:\\d+(?:\\.\\d+)?|(?:twenty|thirty|forty|fifty)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|${[...ONES].reverse().join('|')}|sixty|ninety|a couple of|a couple|a few|an|a)`
const UNIT = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m|s)'
const TERM = `${NUM}(?: and a half)?\\s*${UNIT}\\b`
const SPECIAL = '(?:half an? hour|half hour|a half hour|(?:a )?quarter (?:of an )?hour|an? hour and a half)'
const COMPACT = '\\d+h\\s?\\d+m?\\b'
const DURATION = `(?:${COMPACT}|${SPECIAL}|${TERM})(?:(?:\\s*,\\s*|\\s+and\\s+|\\s+)(?:a half\\b|${COMPACT}|${TERM}))*`

function numberValue(word: string): number {
  const w = word.trim()
  if (/^\d/.test(w)) return Number(w)
  if (w === 'a' || w === 'an') return 1
  if (w.startsWith('a couple')) return 2
  if (w === 'a few') return 3
  const parts = w.split(/[ -]/)
  if (parts[0] in TENS) return TENS[parts[0]] + (parts[1] ? ONES.indexOf(parts[1]) : 0)
  return ONES.indexOf(w)
}

function unitMs(unit: string): number {
  if (/^h/.test(unit)) return 3_600_000
  if (/^m/.test(unit)) return 60_000
  return 1000
}

/** "20 minutes", "an hour and a half", "1h30", "two and a half hours", "90 seconds" → ms; null if none. */
export function durationMs(text: string): number | null {
  const s = text.toLowerCase()
  let total = 0
  let lastUnit = 0
  const re = new RegExp(`(\\d+)h\\s?(\\d+)m?\\b|half an? hour|half hour|a half hour|(?:a )?quarter (?:of an )?hour|an? hour and a half|(${NUM})( and a half)?\\s*(${UNIT})\\b|\\ba half\\b`, 'g')
  for (const m of s.matchAll(re)) {
    const all = m[0]
    if (m[1]) {
      total += Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000
      lastUnit = 60_000
    } else if (/^(?:half an? hour|half hour|a half hour)$/.test(all)) {
      total += 30 * 60_000
      lastUnit = 60_000
    } else if (/quarter/.test(all)) {
      total += 15 * 60_000
      lastUnit = 60_000
    } else if (/hour and a half/.test(all)) {
      total += 90 * 60_000
      lastUnit = 3_600_000
    } else if (m[3]) {
      const n = numberValue(m[3]) + (m[4] ? 0.5 : 0)
      if (!(n >= 0)) continue
      lastUnit = unitMs(m[5])
      total += n * lastUnit
    } else if (all === 'a half' && lastUnit) {
      total += lastUnit / 2
    }
  }
  return total > 0 ? Math.round(total) : null
}

/** "5 minute timer", "1 hour 30 minute timer". */
export function timerName(ms: number): string {
  return `${formatDuration(ms).replace(/(\d+ \w+?)s\b/g, '$1')} timer`
}

/** "5 minutes", "1 hour 30 minutes", "90 seconds". */
export function formatDuration(ms: number): string {
  const totalS = Math.round(ms / 1000)
  if (totalS < 120 && totalS % 60 !== 0) return `${totalS} seconds`
  const totalM = Math.round(totalS / 60)
  const h = Math.floor(totalM / 60)
  const m = totalM % 60
  const part = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`
  if (!h) return part(m, 'minute')
  return m ? `${part(h, 'hour')} ${part(m, 'minute')}` : part(h, 'hour')
}

// ---- times of day

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_WORDS = `(?:tomorrow|today|tonight|this (?:morning|afternoon|evening)|in the (?:morning|afternoon|evening)|(?:on |next |this )?(?:${DAYS.join('|')}))`
const CLOCK = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?'

interface When {
  at: number
  /** the part of the text it came from, to cut out of what they want reminding of */
  spans: string[]
}

function atClock(base: Date, hour: number, minute: number): Date {
  const d = new Date(base)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** "at 6pm", "at 18:30", "tomorrow at 9", "tonight at 8", "on friday at 3", "at noon", "tomorrow morning". */
export function timeOfDay(text: string, now: Date): When | null {
  const s = text.toLowerCase()
  const spans: string[] = []
  const dayM = new RegExp(`\\b${DAY_WORDS}\\b`).exec(s)
  const day = dayM?.[0] ?? null
  if (dayM) spans.push(dayM[0])
  let hour: number | null = null
  let minute = 0
  let ap: 'am' | 'pm' | null = null
  const named = /\b(?:at |by )?(noon|midday|midnight)\b/.exec(s)
  // "at 6", "at 6:30", "by 18:00", "for 7pm" ("for" only with am/pm or minutes, so "for 5" stays a length), or a bare "6pm".
  const lead = new RegExp(`\\b(at|by|for|around)\\s+${CLOCK}(?![a-z\\d:])(?!\\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\\b)`).exec(s)
  const bare = new RegExp(`\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?![a-z])`).exec(s)
  const clock = lead && (lead[1] !== 'for' || lead[3] || lead[4]) ? lead.slice(1) : bare ? [null, ...bare.slice(1)] : null
  const clockText = lead && clock?.[0] ? lead[0] : bare?.[0]
  if (named) {
    spans.push(named[0])
    hour = named[1] === 'midnight' ? 0 : 12
    ap = named[1] === 'midnight' ? 'am' : 'pm'
  } else if (clock && clockText) {
    // clock: [lead word or null, hour, minutes, am/pm]
    hour = Number(clock[1])
    minute = Number(clock[2] ?? 0)
    ap = clock[3] ? (clock[3][0] === 'p' ? 'pm' : 'am') : null
    if (hour > 24 || minute > 59 || (ap && (hour < 1 || hour > 12))) return null
    spans.push(clockText)
  }
  const part = day && /morning/.test(day) ? 'am' : day && /afternoon|evening|tonight/.test(day) ? 'pm' : null
  if (hour === null) {
    if (!day) return null
    // A day with no time: the morning, or the evening for "tonight".
    if (/tonight/.test(day)) hour = 20
    else if (/evening/.test(day)) hour = 18
    else if (/afternoon/.test(day)) hour = 15
    else if (/today/.test(day)) return null
    else hour = 9
    ap = hour >= 12 ? 'pm' : 'am'
  }
  // The day it is on.
  let base = new Date(now)
  let futureDay = false
  if (day && /tomorrow/.test(day)) {
    base.setDate(base.getDate() + 1)
    futureDay = true
  } else if (day) {
    const wd = DAYS.findIndex((d) => day.includes(d))
    if (wd >= 0) {
      let ahead = (wd - now.getDay() + 7) % 7
      if (ahead === 0 && /next/.test(day)) ahead = 7
      base.setDate(base.getDate() + ahead)
      futureDay = ahead > 0
    }
  }
  let candidates: number[]
  if (ap) candidates = [(hour % 12) + (ap === 'pm' ? 12 : 0)]
  else if (hour === 0 || hour > 12) candidates = [hour % 24]
  else if (part) candidates = [(hour % 12) + (part === 'pm' ? 12 : 0)]
  else if (futureDay) candidates = [hour >= 7 && hour <= 11 ? hour : (hour % 12) + 12]
  else candidates = [hour % 12, (hour % 12) + 12]
  for (const h of candidates) {
    const d = atClock(base, h, minute)
    if (d.getTime() > now.getTime()) return { at: d.getTime(), spans }
  }
  // Already past today: the same time tomorrow (or next week for a weekday said today).
  const first = atClock(base, candidates[0], minute)
  if (day && DAYS.some((d) => day.includes(d))) first.setDate(first.getDate() + 7)
  else first.setDate(first.getDate() + 1)
  return { at: first.getTime(), spans }
}

/** Just a time, for the answer to "when should I remind you?": "in 10 minutes", "at 6", "tomorrow morning". */
export function parseWhen(raw: string, now = new Date()): { at: number; ms?: number } | null {
  const s = raw.toLowerCase().replace(/[.!?]+$/, '').trim()
  const dur = new RegExp(`^(?:(?:in|after|for)\\s+)?(?:about |around )?(${DURATION})(?:\\s+(?:from now|time))?$`).exec(s)
  const len = dur ? durationMs(dur[1]) : null
  if (len) return { at: now.getTime() + len, ms: len }
  if (s.split(' ').length > 6) return null
  const when = timeOfDay(/^\d/.test(s) ? `at ${s}` : s, now)
  return when ? { at: when.at } : null
}

/** A time anywhere in their own words ("give me a nudge at 5pm about the bins" → 5 pm), to check what a model passed on. */
export function timeIn(raw: string, now = new Date()): { at: number; ms?: number } | null {
  const s = ` ${raw.toLowerCase().replace(/[.!?]+$/, '')} `
  const dur = new RegExp(`\\b(?:in|after|for|within)\\s+(?:about |around )?(${DURATION})`).exec(s)
  const len = dur ? durationMs(dur[1]) : null
  if (len) return { at: now.getTime() + len, ms: len }
  const when = timeOfDay(s, now)
  return when ? { at: when.at } : null
}

// ---- the request

/** "my" → "your", "I" → "you": she says it back to them. */
export function toSecondPerson(text: string): string {
  return text
    .replace(/\bi am\b/gi, 'you are')
    .replace(/\bi'm\b/gi, "you're")
    .replace(/\bi've\b/gi, "you've")
    .replace(/\bi'll\b/gi, "you'll")
    .replace(/\bmyself\b/gi, 'yourself')
    .replace(/\bmine\b/gi, 'yours')
    .replace(/\bmy\b/gi, 'your')
    .replace(/\bme\b/gi, 'you')
    .replace(/\bi\b/gi, 'you')
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^(?:\s*(?:to|that|about|of|for|and|then|,|please))+\s+/i, '')
    .replace(/(?:\s+(?:to|that|about|in|at|for|on|and|please|,))+\s*$/i, '')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim()
}

/** "remind me", and the other ways of asking for one: "nudge me", "ping me", "give me a nudge / a shout". */
const ASK_ME = /\bremind me\b|\b(?:nudge me|ping me|poke me|give me a (?:nudge|shout|heads up|reminder))\b(?=.*\b(?:in|at|by|on|tomorrow|tonight|noon|midnight)\b)/

const LEAD = /^(?:(?:hey|ok|okay|so|please|can you|could you|would you|will you|i need you to|i want you to)[\s,]+)+/i

/** What they asked about reminders or timers, or null when it is not about them. */
export function parseReminder(raw: string, now = new Date()): ReminderIntent | null {
  let s = raw.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  s = s.replace(LEAD, '').replace(/[\s,]+please$/, '').trim()
  if (!s) return null
  const about = /\b(?:remind(?:er|ers)?|timers?|alarms?)\b/
  if (!about.test(s) && !ASK_ME.test(s)) return null

  // What do I have?
  if (
    /^(?:what|which|any|do i have(?: any)?|have i got(?: any)?|show(?: me)?|list|tell me|read(?: me)?|check)\b.*\b(?:reminders?|timers?|alarms?)\b/.test(s) ||
    /^(?:my |all my |the )?(?:reminders|timers|alarms)$/.test(s) ||
    /^how (?:much time|long) (?:is )?left on (?:the|my) timer/.test(s)
  ) {
    return { kind: 'list' }
  }

  // Cancel one, or all.
  const cancel = /^(?:cancel|delete|remove|clear|stop|forget(?: about)?|drop|scrap|never ?mind|turn off|kill|get rid of)\b\s*(.*)$/.exec(s)
  if (cancel) {
    const rest = cancel[1]
    const all = /\ball\b|\bevery\b|\beverything\b/.test(rest)
    const timer = /\btimers?\b/.test(rest) && !/\breminders?\b/.test(rest)
    const query = rest
      .replace(/\b(?:the|my|that|this|those|these|all|every|of|reminders?|timers?|alarms?|to|about|for|which|one|ones|i set|you set|set)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return { kind: 'cancel', query: toSecondPerson(query), all, timer }
  }

  // "set a timer for 5 minutes", "a 10 minute timer for the pasta", "timer 5 minutes"; not "the timer app is broken".
  const timer = !ASK_ME.test(s) && /^(?:(?:set|start|make|put on|give me|run|begin|create|add)\s+(?:me\s+)?)?(?:a|an|another|the)?\s*(?:\S+\s+){0,3}?timer\b/.test(s) && !/\bremind me\b/.test(s)
  const reminder = new RegExp(`${ASK_ME.source}|^(?:set|add|make|create|put in|schedule)?\\s*(?:a |an |me a )?(?:reminder|alarm)\\b`).test(s)
  if (!timer && !reminder) return null

  let rest = ` ${s} `
  let at: number | null = null
  let ms: number | undefined
  // A length of time: "in 20 minutes", "for 5 minutes", "after an hour"; a timer's can stand alone ("a 5 minute timer").
  const dur = new RegExp(`\\b(?:in|after|for|within)\\s+(?:about |around |roughly )?(${DURATION})`).exec(rest) ?? (timer ? new RegExp(`\\b(${DURATION})`).exec(rest) : null)
  const len = dur ? durationMs(dur[1]) : null
  if (dur && len) {
    ms = len
    at = now.getTime() + len
    rest = rest.replace(dur[0], ' ')
  } else {
    const when = timeOfDay(rest, now)
    if (when) {
      at = when.at
      for (const span of when.spans) rest = rest.replace(span, ' ')
    }
  }

  if (timer) {
    // "set a timer for the pasta", "a 10 minute timer for the eggs": the label is what is left after "for".
    let label = rest
      .replace(/\b(?:set|start|make|put on|give me|run|begin)\b/g, ' ')
      .replace(/\b(?:a|an|the|me)\b(?=\s+(?:timer|\d|minute|second|hour))/g, ' ')
      .replace(/\btimer\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    label = tidy(label.replace(/^(?:for|called|named|labelled|labeled)\s+/, '').replace(/^(?:a|an)\s+/, ''))
    label = toSecondPerson(label)
    if (!at || !ms) return { kind: 'needTime', text: label, timer: true }
    return { kind: 'set', at, text: label || timerName(ms), timer: true, ms }
  }

  let what = rest
    .replace(/^\s*(?:set|add|make|create|put in|schedule)?\s*(?:a |an |me a )?(?:reminder|alarm)\s*(?:for me)?\b/, ' ')
    .replace(/\b(?:remind me|nudge me|ping me|poke me|give me a (?:nudge|shout|heads up|reminder))\b/, ' ')
    .replace(/\s+/g, ' ')
  what = tidy(what)
  what = what.replace(/^(?:i need to|i have to|i've got to|i gotta|i should|i must)\s+/i, '')
  what = toSecondPerson(tidy(what))
  if (!at) return { kind: 'needTime', text: what, timer: false }
  return { kind: 'set', at, text: what, timer: false, ...(ms ? { ms } : {}) }
}

// ---- what she says

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "in 20 minutes" when it is soon, else "at 6:00 PM" / "tomorrow at 9:00 AM" / "on Friday at 3:00 PM". */
export function whenText(at: number, now: number): string {
  const until = at - now
  if (until < 90 * 60_000) return until < 60_000 ? `in ${Math.max(1, Math.round(until / 1000))} seconds` : `in ${formatDuration(Math.round(until / 60_000) * 60_000)}`
  const d = new Date(at)
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = new Date(now)
  if (sameDay(d, today)) return `at ${clock}`
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(d, tomorrow)) return `tomorrow at ${clock}`
  if (until < 7 * 86_400_000) return `on ${d.toLocaleDateString([], { weekday: 'long' })} at ${clock}`
  return `on ${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} at ${clock}`
}

export function setLine(r: Reminder, now: number): string {
  if (r.timer) return `Timer set: ${formatDuration(r.ms ?? r.at - now)}${/ timer$/.test(r.text) ? '' : `, for ${r.text}`}.`
  // "to call mum", but "about the dentist".
  const about = /^(?:the|a|an|your|his|her|their|our|this|that|those|these)\b/i.test(r.text)
  return `Okay, I'll remind you ${whenText(r.at, now)}${r.text ? ` ${about ? 'about' : 'to'} ${r.text}` : ''}.`
}

/** The plain line when it goes off. */
export function dueLine(r: Reminder, lateMs = 0): string {
  const late = lateMs > 5 * 60_000 ? ' I missed it while I was off, sorry.' : ''
  if (r.timer) return / timer$/.test(r.text) || !r.text ? `Your ${r.ms ? timerName(r.ms) : 'timer'} is up.${late}` : `Timer's up: ${r.text}.${late}`
  return r.text ? `Reminder: ${r.text}.${late}` : `This is your reminder.${late}`
}

export function listLine(list: Reminder[], now: number): string {
  if (!list.length) return 'No reminders or timers right now.'
  const left = (r: Reminder): string => {
    const ms = r.at - now
    return ms < 60_000 ? formatDuration(Math.max(1000, Math.round(ms / 1000) * 1000)) : formatDuration(Math.round(ms / 60_000) * 60_000)
  }
  const items = list.slice(0, 6).map((r) => (r.timer ? `${/ timer$/.test(r.text) ? `a ${r.text}` : `the ${r.text} timer`}, ${left(r)} left` : `${r.text || 'a reminder'} ${whenText(r.at, now)}`))
  const more = list.length > 6 ? `, and ${list.length - 6} more` : ''
  const head = list.length === 1 ? 'One' : `${list.length}`
  return `${head}: ${items.join('; ')}${more}.`
}

// ---- keeping them

/** Words of the query found in a reminder's text, for "cancel the stretch reminder". */
function score(r: Reminder, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  const text = r.text.toLowerCase()
  return words.filter((w) => text.includes(w)).length
}

export class ReminderStore {
  private items: Reminder[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly path: string
  private readonly onDue: (r: Reminder, lateMs: number) => void
  private readonly now: () => number

  constructor(path: string, onDue: (r: Reminder, lateMs: number) => void, now: () => number = Date.now) {
    this.path = path
    this.onDue = onDue
    this.now = now
    try {
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, 'utf8')) as Reminder[]
        if (Array.isArray(data)) this.items = data.filter((r) => r && typeof r.at === 'number' && typeof r.text === 'string')
      }
    } catch (err) {
      console.warn('[reminders] could not read', path, (err as Error).message)
    }
  }

  list(): Reminder[] {
    return [...this.items].sort((a, b) => a.at - b.at)
  }

  add(r: Omit<Reminder, 'id' | 'createdAt'>): Reminder {
    const item: Reminder = { ...r, id: `${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: this.now() }
    this.items.push(item)
    this.save()
    this.arm()
    return item
  }

  remove(id: string): Reminder | null {
    const i = this.items.findIndex((r) => r.id === id)
    if (i < 0) return null
    const [r] = this.items.splice(i, 1)
    this.save()
    this.arm()
    return r
  }

  /** The ones a cancel request means: all of a kind, the best match for the words, or the next one when it is plain. */
  match(q: { query: string; all: boolean; timer: boolean }): Reminder[] {
    const pool = this.list().filter((r) => !q.timer || r.timer)
    if (q.all) return pool
    if (!q.query) return pool.length ? [pool[0]] : []
    const scored = pool.map((r) => ({ r, s: score(r, q.query) })).filter((x) => x.s > 0)
    if (!scored.length) return []
    const best = Math.max(...scored.map((x) => x.s))
    return scored.filter((x) => x.s === best).map((x) => x.r).slice(0, 1)
  }

  /** Starts the clock: anything already due (it came due while she was off) goes off now. */
  start(): void {
    this.arm()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private arm(): void {
    this.stop()
    const next = this.list()[0]
    if (!next) return
    const wait = Math.min(Math.max(0, next.at - this.now()), 60_000)
    this.timer = setTimeout(() => this.fire(), wait)
    this.timer.unref?.()
  }

  private fire(): void {
    const now = this.now()
    const due = this.list().filter((r) => r.at <= now + 250)
    if (due.length) {
      this.items = this.items.filter((r) => !due.includes(r))
      this.save()
      for (const r of due) {
        try {
          this.onDue(r, Math.max(0, now - r.at))
        } catch (err) {
          console.warn('[reminders]', (err as Error).message)
        }
      }
    }
    this.arm()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.items, null, 2))
      renameSync(tmp, this.path)
    } catch (err) {
      console.warn('[reminders] could not save', (err as Error).message)
    }
  }
}
