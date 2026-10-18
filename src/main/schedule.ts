import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Scheduled jobs: things she does on her own at set times, in plain words ("every weekday at 9 summarise my Slack",
 * "every Sunday evening plan my week", "every hour check if the build is green"). A rule says when; the next run is
 * worked out on the wall clock of the job's time zone, so 9:00 stays 9:00 across daylight saving (a time the clock
 * skips moves to just after the jump; a time it repeats runs once). A run missed while the Mac slept or was off is
 * caught up once, not once per missed slot. Kept in <user data>/schedule.json. No Electron in here.
 */

export type Rule =
  /** on these weekdays (0 Sunday … 6 Saturday) at these clock times ("HH:MM") */
  | { kind: 'weekly'; days: number[]; times: string[] }
  /** every N minutes (under a day), on these weekdays, between from and to ("HH:MM"; null: the whole day) */
  | { kind: 'interval'; minutes: number; days: number[]; from: string | null; to: string | null }
  /** a day of the month (31 means the last day in shorter months; -1 the last), or the nth weekday (-1 the last) */
  | { kind: 'monthly'; day: number | null; nth: number | null; weekday: number | null; times: string[] }
  /** every N days from a start date ("YYYY-MM-DD") */
  | { kind: 'days'; every: number; start: string; times: string[] }
  /** once, at a moment */
  | { kind: 'once'; at: number }

export type RunStatus = 'ok' | 'failed' | 'waiting' | 'skipped' | 'missed'

export interface Job {
  id: string
  /** what to do, in their words ("summarise my Slack"); the run gets it as if they had just said it */
  task: string
  /** a few words for lists and the tray */
  label: string
  rule: Rule
  /** IANA time zone the clock times are in (the Mac's when it was set up) */
  tz: string
  /** their words for when ("every weekday at 9") */
  when: string
  /** agent: one agent turn each time · plan: a plan on the card, waiting for their go */
  mode: 'agent' | 'plan'
  createdAt: number
  /** the next run, ms since 1970; null once a one-off has run */
  nextAt: number | null
  paused: boolean
  runs: number
  last?: { at: number; status: RunStatus; summary: string }
}

/** A risky step a run wanted while the user was away: it waits here for their yes. */
export interface Waiting {
  id: string
  jobId: string
  label: string
  /** the tool and its input, run as they were once the user says yes */
  tool: string
  input: Record<string, unknown>
  /** the action, starting with a verb ("send \"build is green\" to sam on Slack") */
  what: string
  at: number
}

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

// ---- clocks in a time zone

export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

const formats = new Map<string, Intl.DateTimeFormat>()
function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(tz, f)
  }
  return f
}

export function validZone(tz: string): boolean {
  try {
    format(tz)
    return true
  } catch {
    return false
  }
}

export interface Wall {
  y: number
  /** 1–12 */
  mo: number
  d: number
  h: number
  mi: number
  s: number
  /** 0 Sunday … 6 Saturday */
  wd: number
}

/** The wall clock in a zone at a moment. */
export function wallClock(at: number, tz: string): Wall {
  const p: Record<string, number> = {}
  for (const part of format(tz).formatToParts(new Date(at))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const w = { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second, wd: 0 }
  w.wd = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()
  return w
}

function offsetAt(at: number, tz: string): number {
  const w = wallClock(at, tz)
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(at / 1000) * 1000
}

/** The moment a wall-clock time happens in a zone. A time skipped by a clock change comes just after it (2:30 on the
 * spring-forward night is 3:30); a time that happens twice (the fall-back hour) is the first one. */
export function zonedTime(y: number, mo: number, d: number, minuteOfDay: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60)
  const before = offsetAt(guess - 86_400_000, tz)
  const after = offsetAt(guess + 86_400_000, tz)
  const hits = [...new Set([before, after])]
    .map((o) => guess - o)
    .filter((t) => {
      const w = wallClock(t, tz)
      return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) === guess
    })
  return hits.length ? Math.min(...hits) : guess - before
}

/** "HH:MM" → minutes after midnight; null for anything else. */
export function clockMinutes(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null
  return h * 60 + mi
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

interface Day {
  y: number
  mo: number
  d: number
  wd: number
}

function addDays(day: Day, n: number): Day {
  const t = new Date(Date.UTC(day.y, day.mo - 1, day.d + n))
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() }
}

function dayNumber(day: { y: number; mo: number; d: number }): number {
  return Math.round(Date.UTC(day.y, day.mo - 1, day.d) / 86_400_000)
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

function sortedTimes(times: string[]): number[] {
  return [...new Set(times.map(clockMinutes).filter((m): m is number => m !== null))].sort((a, b) => a - b)
}

/** The day of a month a monthly rule means, or null when the month has none (a fifth Monday). */
function monthlyDay(rule: Extract<Rule, { kind: 'monthly' }>, y: number, mo: number): number | null {
  const len = daysInMonth(y, mo)
  if (rule.day !== null) return rule.day === -1 ? len : Math.min(rule.day, len)
  if (rule.nth === null || rule.weekday === null) return null
  if (rule.nth === -1) {
    const lastWd = new Date(Date.UTC(y, mo - 1, len)).getUTCDay()
    return len - ((lastWd - rule.weekday + 7) % 7)
  }
  const firstWd = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay()
  const d = 1 + ((rule.weekday - firstWd + 7) % 7) + (rule.nth - 1) * 7
  return d <= len ? d : null
}

/** The first run of a rule strictly after `after`, or null when there is none (a one-off that has passed). */
export function nextRun(rule: Rule, after: number, tz: string): number | null {
  const w = wallClock(after, tz)
  const today: Day = { y: w.y, mo: w.mo, d: w.d, wd: w.wd }
  switch (rule.kind) {
    case 'once':
      return rule.at > after ? rule.at : null
    case 'weekly': {
      const times = sortedTimes(rule.times)
      const days = rule.days.length ? rule.days : ALL_DAYS
      if (!times.length) return null
      for (let i = 0; i <= 8; i++) {
        const day = addDays(today, i)
        if (!days.includes(day.wd)) continue
        for (const m of times) {
          const t = zonedTime(day.y, day.mo, day.d, m, tz)
          if (t > after) return t
        }
      }
      return null
    }
    case 'days': {
      const times = sortedTimes(rule.times)
      const start = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rule.start)
      if (!times.length || !start || rule.every < 1) return null
      const first = dayNumber({ y: Number(start[1]), mo: Number(start[2]), d: Number(start[3]) })
      for (let i = 0; i <= rule.every + 1; i++) {
        const day = addDays(today, i)
        const n = dayNumber(day) - first
        if (n < 0 || n % rule.every !== 0) continue
        for (const m of times) {
          const t = zonedTime(day.y, day.mo, day.d, m, tz)
          if (t > after) return t
        }
      }
      // Before the start date: the first run is the start.
      const at = zonedTime(Number(start[1]), Number(start[2]), Number(start[3]), times[0], tz)
      return at > after ? at : null
    }
    case 'monthly': {
      const times = sortedTimes(rule.times)
      if (!times.length) return null
      for (let i = 0; i <= 24; i++) {
        const y = w.y + Math.floor((w.mo - 1 + i) / 12)
        const mo = ((w.mo - 1 + i) % 12) + 1
        const d = monthlyDay(rule, y, mo)
        if (d === null) continue
        for (const m of times) {
          const t = zonedTime(y, mo, d, m, tz)
          if (t > after) return t
        }
      }
      return null
    }
    case 'interval': {
      if (!(rule.minutes >= 1) || rule.minutes >= 1440) return null
      const step = Math.round(rule.minutes) * 60_000
      const days = rule.days.length ? rule.days : ALL_DAYS
      const from = clockMinutes(rule.from) ?? 0
      const to = clockMinutes(rule.to)
      for (let i = 0; i <= 8; i++) {
        const day = addDays(today, i)
        if (!days.includes(day.wd)) continue
        // Each day starts its own count at `from` (midnight for a whole-day rule), so the slots stay on the clock.
        const start = zonedTime(day.y, day.mo, day.d, from, tz)
        const next = addDays(day, 1)
        const end = to !== null && to > from ? zonedTime(day.y, day.mo, day.d, to, tz) : zonedTime(next.y, next.mo, next.d, 0, tz) - 1
        const k = after < start ? 0 : Math.floor((after - start) / step) + 1
        const t = start + k * step
        if (t <= end) return t
      }
      return null
    }
  }
}

/** Is the rule something nextRun can work with? */
export function validRule(rule: Rule): boolean {
  const days = (d: number[]): boolean => Array.isArray(d) && d.every((x) => Number.isInteger(x) && x >= 0 && x <= 6)
  const times = (t: string[]): boolean => Array.isArray(t) && t.length > 0 && t.length <= 6 && t.every((x) => clockMinutes(x) !== null)
  switch (rule?.kind) {
    case 'once':
      return Number.isFinite(rule.at)
    case 'weekly':
      return days(rule.days) && times(rule.times)
    case 'interval':
      return rule.minutes >= 1 && rule.minutes < 1440 && days(rule.days) && (rule.from === null || clockMinutes(rule.from) !== null) && (rule.to === null || clockMinutes(rule.to) !== null)
    case 'monthly':
      return times(rule.times) && (rule.day !== null ? (rule.day >= 1 && rule.day <= 31) || rule.day === -1 : rule.nth !== null && rule.weekday !== null && ((rule.nth >= 1 && rule.nth <= 5) || rule.nth === -1) && rule.weekday >= 0 && rule.weekday <= 6)
    case 'days':
      return rule.every >= 1 && rule.every <= 365 && /^\d{4}-\d{2}-\d{2}$/.test(rule.start) && times(rule.times)
    default:
      return false
  }
}

// ---- in words

/** "9:00 AM", "6:30 PM", "noon", "midnight". */
export function clockText(time: string): string {
  const m = clockMinutes(time) ?? 0
  if (m === 720) return 'noon'
  if (m === 0 || m === 1440) return 'midnight'
  const h = Math.floor(m / 60) % 24
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

function dayName(d: number): string {
  return WEEKDAYS[d][0].toUpperCase() + WEEKDAYS[d].slice(1)
}

function joinWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function daysText(days: number[]): string {
  const set = [...new Set(days)].sort()
  if (!set.length || set.length === 7) return 'every day'
  if (set.join() === '1,2,3,4,5') return 'every weekday'
  if (set.join() === '0,6') return 'on weekends'
  return `every ${joinWords(set.map(dayName))}`
}

function timesText(times: string[]): string {
  return joinWords(sortedTimes(times).map((m) => clockText(hhmm(m))))
}

const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth']

function nthDay(n: number): string {
  if (n === -1) return 'last day'
  const s = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'
  return `${n}${s}`
}

/** "every weekday at 9:00 AM", "every 15 minutes from 9:00 AM to 5:00 PM on weekdays", "on the 1st of every month at 9:00 AM". */
export function ruleText(rule: Rule, tz?: string): string {
  switch (rule.kind) {
    case 'once': {
      const d = new Date(rule.at)
      return `once, on ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(tz ? { timeZone: tz } : {}) })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) })}`
    }
    case 'weekly':
      return `${daysText(rule.days)} at ${timesText(rule.times)}`
    case 'days':
      return `${rule.every === 2 ? 'every other day' : `every ${rule.every} days`} at ${timesText(rule.times)}`
    case 'monthly': {
      const at = ` at ${timesText(rule.times)}`
      if (rule.day !== null) return `on the ${nthDay(rule.day)} of every month${at}`
      return `on the ${rule.nth === -1 ? 'last' : ORDINAL[rule.nth ?? 1]} ${dayName(rule.weekday ?? 1)} of every month${at}`
    }
    case 'interval': {
      const every = rule.minutes === 60 ? 'every hour' : rule.minutes % 60 === 0 ? `every ${rule.minutes / 60} hours` : rule.minutes === 30 ? 'every half hour' : `every ${rule.minutes} minutes`
      const window = rule.from || rule.to ? ` from ${clockText(rule.from ?? '00:00')} to ${clockText(rule.to ?? '24:00')}` : ''
      const days = rule.days.length && rule.days.length < 7 ? ` ${daysText(rule.days).replace(/^every (weekday)$/, 'on weekdays').replace(/^every /, 'on ')}` : ''
      return `${every}${window}${days}`
    }
  }
}

/** "every weekday at 9:00 AM" → "Every weekday at 9:00 AM". */
export function cap(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/** A short name from the task: "summarise my Slack", "check if the build is green". */
export function labelFor(task: string): string {
  const t = task.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  return t.length <= 48 ? t : `${t.slice(0, 45).replace(/\s+\S*$/, '')}…`
}

// ---- reading it from their words

const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, 'forty five': 45, 'forty-five': 45, ninety: 90 }
const NUM = `(?:\\d{1,3}|${Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|')})`
function num(word: string): number {
  return /^\d/.test(word) ? Number(word) : (NUM_WORDS[word] ?? NaN)
}

const DAY = '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)s?'
function dayIndex(word: string): number {
  const w = word.toLowerCase().slice(0, 3)
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(w)
}

const PART_TIMES: Record<string, number> = { morning: 8 * 60, afternoon: 15 * 60, evening: 18 * 60, night: 21 * 60, tonight: 21 * 60 }
const CLOCK = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?'
const ORDINALS: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 }

interface Span {
  start: number
  end: number
}

/** A clock time as minutes after midnight; a bare hour reads the way people schedule things (7–11 morning, 1–6 afternoon). */
function clockOf(h: string, m: string | undefined, ap: string | undefined, part: 'am' | 'pm' | null): number | null {
  let hour = Number(h)
  const minute = Number(m ?? 0)
  if (minute > 59) return null
  if (ap) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (ap[0] === 'p' ? 12 : 0)
  } else if (hour > 23) return null
  else if (hour >= 1 && hour <= 12) {
    if (part === 'pm' && hour < 12) hour += 12
    else if (part === 'am') hour %= 12
    else if (!part && hour <= 6) hour += 12
  }
  return hour * 60 + minute
}

export interface ParsedWhen {
  rule: Rule
  /** where in the text the timing words were, to cut them out of the task */
  spans: Span[]
}

/** The timing in their words ("every weekday at 9", "every Sunday evening", "hourly between 9 and 5"), or null. */
export function parseRule(raw: string, now = new Date(), tz = localZone()): ParsedWhen | null {
  const s = raw.toLowerCase().replace(/[‘’]/g, "'")
  const spans: Span[] = []
  const take = (m: RegExpExecArray | null): RegExpExecArray | null => {
    if (m) spans.push({ start: m.index, end: m.index + m[0].length })
    return m
  }

  // Part of the day ("every sunday evening", "each morning"): a default time and a hint for bare hours.
  const partM = /\b(?:in the |every |each |on (?:\w+ )?)?(morning|afternoon|evening|night)s?\b/.exec(s)
  const part = partM ? (partM[1] === 'morning' ? 'am' : 'pm') : null

  // ---- every N minutes / hours
  let minutes: number | null = null
  const every = take(new RegExp(`\\b(?:every|each)\\s+(?:(${NUM}|other|couple of|few)\\s+)?(minutes?|mins?|hours?|hrs?)\\b`).exec(s))
  if (every) {
    const n = every[1] === 'other' || every[1] === 'couple of' ? 2 : every[1] === 'few' ? 3 : every[1] ? num(every[1]) : 1
    minutes = n * (/^h/.test(every[2]) ? 60 : 1)
  } else if (take(/\b(?:every half(?:[- ]an)? hour|every half-hour|twice an hour)\b/.exec(s))) minutes = 30
  else if (take(/\bevery quarter(?: of an)? hour\b/.exec(s))) minutes = 15
  else if (take(/\bhourly\b/.exec(s))) minutes = 60

  // ---- which days
  let days: number[] | null = null
  let daysEvery: number | null = null
  let monthly: { day: number | null; nth: number | null; weekday: number | null } | null = null

  const nthWd = take(new RegExp(`\\b(?:(?:on )?(?:every|each|the) )?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last) (${DAY}) (?:of|in) (?:every|each|the) month\\b`).exec(s))
  const monthDay =
    nthWd ??
    take(/\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)? (?:day )?of (?:every|each|the) month\b/.exec(s)) ??
    take(/\b(?:every|each) month on the (\d{1,2})(?:st|nd|rd|th)?\b/.exec(s)) ??
    take(/\bmonthly on the (\d{1,2})(?:st|nd|rd|th)?\b/.exec(s))
  const firstOrLast = monthDay ? null : take(/\b(?:on )?the (first|1st|last) (?:day )?of (?:every|each|the) month\b/.exec(s))
  if (nthWd) monthly = { day: null, nth: ORDINALS[nthWd[1]], weekday: dayIndex(nthWd[2]) }
  else if (monthDay) {
    const d = Number(monthDay[1])
    if (d < 1 || d > 31) return null
    monthly = { day: d, nth: null, weekday: null }
  } else if (firstOrLast) monthly = { day: firstOrLast[1] === 'last' ? -1 : 1, nth: null, weekday: null }
  else if (take(/\b(?:monthly|every month|each month)\b/.exec(s))) monthly = { day: wallClock(now.getTime(), tz).d, nth: null, weekday: null }

  const nDays = monthly ? null : take(new RegExp(`\\bevery (other|${NUM}) days\\b|\\bevery other day\\b`).exec(s))
  if (nDays) daysEvery = nDays[1] && nDays[1] !== 'other' ? num(nDays[1]) : 2

  if (!monthly && !daysEvery) {
    const weekdays = take(/\b(?:every |each |on )?(?:weekdays?|work ?days?|working days?|business days?)\b|\b(?:monday|mon) (?:to|through|thru|-|–) (?:friday|fri)\b|\bmon-fri\b/.exec(s))
    const weekends = weekdays ? null : take(/\b(?:every |each |on |at )?(?:the )?weekends?\b/.exec(s))
    const named = weekdays || weekends ? null : take(new RegExp(`\\b(?:every|each|on)\\s+(${DAY}(?:\\s*(?:,\\s*and|,|and|&|or)\\s*${DAY})*)\\b`).exec(s))
    const plural = weekdays || weekends || named ? null : take(new RegExp(`\\b((?:sun|mon|tues|wednes|thurs|fri|satur)days)\\b`).exec(s))
    const some = Boolean(weekdays || weekends || named || plural)
    const daily = some ? null : take(/\b(?:every ?day|each day|daily|every (?:morning|afternoon|evening|night)|each (?:morning|afternoon|evening|night)|nightly)\b/.exec(s))
    const weekly = some || daily ? null : take(/\b(?:weekly|every week|each week|once a week)\b(?! (?:report|review|plan|update|summary|newsletter|meeting|call))/.exec(s))
    if (weekdays) days = [1, 2, 3, 4, 5]
    else if (weekends) days = [0, 6]
    else if (named) days = [...new Set(named[1].split(/\s*(?:,|and|&|or)\s*/).map(dayIndex).filter((d) => d >= 0))]
    else if (plural) days = [dayIndex(plural[1])]
    else if (daily) days = [...ALL_DAYS]
    else if (weekly) {
      const on = take(new RegExp(`\\bon (${DAY})\\b`).exec(s))
      days = [on ? dayIndex(on[1]) : wallClock(now.getTime(), tz).wd]
    }
  }

  // Nothing that repeats: not a schedule.
  if (minutes === null && !days && !monthly && !daysEvery) return null

  // ---- a window for intervals: "between 9 and 5", "from 9am to 6pm", "during work hours"
  let from: number | null = null
  let to: number | null = null
  const window = take(new RegExp(`\\b(?:between|from)\\s+${CLOCK}\\s*(?:and|to|until|till|-|–)\\s*${CLOCK}`).exec(s))
  if (window) {
    from = clockOf(window[1], window[2], window[3], null)
    // "between 9 and 5": the end is in the afternoon when it would come before the start.
    to = clockOf(window[4], window[5], window[6] ?? (window[3] && Number(window[4]) < 12 ? window[3] : undefined), null)
    if (from !== null && from > 12 * 60 && !window[3] && Number(window[1]) <= 12) from -= 12 * 60
    if (from !== null && to !== null && to <= from && !window[6] && to + 720 > from && to < 720) to += 720
  } else if (take(/\b(?:during|in) (?:work(?:ing)?|office|business) hours\b/.exec(s))) {
    from = 9 * 60
    to = 17 * 60
  }

  // ---- clock times: "at 9", "at 9:30am and 5pm", "at noon"
  const times: number[] = []
  const at = take(new RegExp(`\\b(?:at|@|by)\\s+(${CLOCK}(?:\\s*(?:,|and|&)\\s*(?:at\\s+)?${CLOCK})*|noon|midday|midnight)(?![\\d:])`).exec(s))
  if (at) {
    if (/^(?:noon|midday)$/.test(at[1])) times.push(720)
    else if (at[1] === 'midnight') times.push(0)
    else
      for (const m of at[1].matchAll(new RegExp(CLOCK, 'g'))) {
        const t = clockOf(m[1], m[2], m[3], part)
        if (t === null) return null
        times.push(t)
      }
  } else {
    const bare = take(new RegExp(`\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?![a-z])`).exec(s)) ?? take(/\b(?:at )?(noon|midday|midnight)\b/.exec(s))
    if (bare?.[1] && /^(?:noon|midday)$/.test(bare[1])) times.push(720)
    else if (bare?.[1] === 'midnight') times.push(0)
    else if (bare) {
      const t = clockOf(bare[1], bare[2], bare[3], part)
      if (t !== null) times.push(t)
    }
  }
  if (partM) spans.push({ start: partM.index, end: partM.index + partM[0].length })
  if (!times.length && partM) times.push(PART_TIMES[partM[1]])

  let rule: Rule
  if (minutes !== null) {
    if (minutes < 1 || minutes >= 1440) return null
    rule = { kind: 'interval', minutes, days: days && days.length < 7 ? days : [], from: from !== null ? hhmm(from) : null, to: to !== null ? hhmm(to) : null }
  } else {
    const clock = (times.length ? times : [9 * 60]).map(hhmm)
    if (monthly) rule = { kind: 'monthly', ...monthly, times: clock }
    else if (daysEvery) {
      const w = wallClock(now.getTime(), tz)
      rule = { kind: 'days', every: daysEvery, start: `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`, times: clock }
    } else rule = { kind: 'weekly', days: days ?? [...ALL_DAYS], times: clock }
  }
  return validRule(rule) ? { rule, spans } : null
}

export interface ParsedSchedule {
  rule: Rule
  /** what to do, in their words, with the timing cut out */
  task: string
  /** the timing words, as they said them */
  when: string
  /** the timing sat at the start or the end of the sentence (the shortcut takes only those) */
  clean: boolean
}

/** Asking to be reminded, rather than for her to do something: reminders.ts has those. */
export const REMINDER_WORDS = /\b(?:remind(?:er)?s?|nudge me|ping me|poke me|alarms?|timers?|wake me)\b/i

/** "every weekday at 9 summarise my Slack" → the rule, "summarise my Slack" and "every weekday at 9". */
export function parseSchedule(raw: string, now = new Date(), tz = localZone()): ParsedSchedule | null {
  const text = raw.replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '')
  if (!text || /\?$/.test(text) || REMINDER_WORDS.test(text) || /\bevery ?(?:time|one|thing|body|where)\b|\beach (?:time|other)\b/i.test(text)) return null
  const parsed = parseRule(text, now, tz)
  if (!parsed) return null
  // Spans → merged, in order.
  const spans = parsed.spans.sort((a, b) => a.start - b.start).reduce<Span[]>((out, sp) => {
    const last = out.at(-1)
    if (last && sp.start <= last.end + 2) last.end = Math.max(last.end, sp.end)
    else out.push({ ...sp })
    return out
  }, [])
  let task = ''
  let cursor = 0
  const pieces: string[] = []
  for (const sp of spans) {
    pieces.push(text.slice(cursor, sp.start))
    cursor = sp.end
  }
  pieces.push(text.slice(cursor))
  const kept = pieces.map((p) => p.trim()).filter((p) => p && !/^[\s,;:–—-]*(?:and|then|to)?[\s,;:–—-]*$/i.test(p))
  task = kept.join(' ')
  task = task
    .replace(/^(?:\s*(?:,|:|-|–|—|and|then|to|please|could you|can you|would you|i want you to|i'd like you to|i need you to|schedule (?:a job )?to|set (?:up )?a (?:job|task) to))+\s*/i, '')
    .replace(/(?:\s+(?:and|then|,|please|for me))+\s*$/i, '')
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim()
  if (!/[a-z]{2}/i.test(task)) return null
  const when = spans.map((sp) => text.slice(sp.start, sp.end)).join(' ').trim()
  return { rule: parsed.rule, task, when, clean: kept.length === 1 }
}

/** The structured timing the agent gives for odd phrasing, as a rule; null when it does not add up. */
export function ruleFromFields(
  f: { kind: string; days: string[]; times: string[]; every_minutes: number | null; day_of_month: number | null; nth: number | null; between: string | null; at: string | null },
  now = new Date(),
  tz = localZone()
): Rule | null {
  const days = [...new Set((f.days ?? []).map((d) => dayIndex(String(d))).filter((d) => d >= 0))]
  const times = (f.times ?? []).map((t) => String(t).trim()).filter((t) => clockMinutes(t) !== null)
  let rule: Rule | null = null
  switch (f.kind) {
    case 'weekly':
      rule = { kind: 'weekly', days: days.length ? days : [...ALL_DAYS], times }
      break
    case 'interval': {
      const [from, to] = (f.between ?? '').split(/\s*[-–]\s*/)
      rule = { kind: 'interval', minutes: Math.round(Number(f.every_minutes)), days: days.length < 7 ? days : [], from: clockMinutes(from) !== null ? from : null, to: clockMinutes(to) !== null ? to : null }
      break
    }
    case 'monthly':
      rule = f.nth !== null && days.length ? { kind: 'monthly', day: null, nth: f.nth, weekday: days[0], times } : { kind: 'monthly', day: f.day_of_month, nth: null, weekday: null, times }
      break
    case 'days': {
      const w = wallClock(now.getTime(), tz)
      const every = Math.round(Number(f.every_minutes) / 1440) || Number(f.day_of_month) || 0
      rule = { kind: 'days', every, start: `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`, times }
      break
    }
    case 'once': {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(f.at ?? '')
      if (m) rule = { kind: 'once', at: zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]) * 60 + Number(m[5]), tz) }
      break
    }
  }
  return rule && validRule(rule) ? rule : null
}

/** A rule as the structured fields schedule_job takes (what a shortcut passes on). */
export function ruleFields(rule: Rule): { kind: string; days: string[]; times: string[]; every_minutes: number | null; day_of_month: number | null; nth: number | null; between: string | null; at: string | null } {
  const base = { kind: rule.kind, days: [] as string[], times: [] as string[], every_minutes: null as number | null, day_of_month: null as number | null, nth: null as number | null, between: null as string | null, at: null as string | null }
  switch (rule.kind) {
    case 'weekly':
      return { ...base, days: rule.days.map((d) => WEEKDAYS[d]), times: rule.times }
    case 'interval':
      return { ...base, days: rule.days.map((d) => WEEKDAYS[d]), every_minutes: rule.minutes, between: rule.from || rule.to ? `${rule.from ?? '00:00'}-${rule.to ?? '24:00'}` : null }
    case 'monthly':
      return { ...base, days: rule.weekday !== null ? [WEEKDAYS[rule.weekday]] : [], times: rule.times, day_of_month: rule.day, nth: rule.nth }
    case 'days':
      return { ...base, times: rule.times, every_minutes: rule.every * 1440 }
    case 'once':
      return { ...base, at: new Date(rule.at).toISOString().slice(0, 16) }
  }
}

// ---- keeping them

function score(job: Job, query: string): number {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !['the', 'job', 'jobs', 'scheduled', 'one', 'that', 'every', 'check'].includes(w))
  const hay = `${job.label} ${job.task} ${job.when}`.toLowerCase()
  return words.filter((w) => hay.includes(w)).length
}

export interface DueInfo {
  /** how late it runs (the Mac slept through it, or she was off) */
  lateMs: number
}

export interface StoreOptions {
  now?: () => number
  /** a run later than this is dropped instead of caught up (default 24 hours; DESKMATE_SCHEDULE_CATCHUP_HOURS) */
  graceMs?: number
  /** a run dropped because it was too late */
  onMissed?(job: Job, lateMs: number): void
}

interface FileShape {
  jobs: Job[]
  waiting: Waiting[]
}

export class ScheduleStore {
  private jobs: Job[] = []
  private waits: Waiting[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly path: string
  private readonly onDue: (job: Job, info: DueInfo) => void
  private readonly opts: StoreOptions

  constructor(path: string, onDue: (job: Job, info: DueInfo) => void, opts: StoreOptions = {}) {
    this.path = path
    this.onDue = onDue
    this.opts = opts
    try {
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<FileShape>
        this.jobs = (Array.isArray(data.jobs) ? data.jobs : []).filter((j) => j && typeof j.task === 'string' && validRule(j.rule) && validZone(j.tz))
        this.waits = (Array.isArray(data.waiting) ? data.waiting : []).filter((w) => w && typeof w.tool === 'string')
      }
    } catch (err) {
      console.warn('[schedule] could not read', path, (err as Error).message)
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  list(): Job[] {
    return [...this.jobs].sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))
  }

  get(id: string): Job | null {
    return this.jobs.find((j) => j.id === id) ?? null
  }

  add(j: { task: string; rule: Rule; when: string; tz?: string; label?: string; mode?: Job['mode'] }): Job {
    const now = this.now()
    const tz = j.tz && validZone(j.tz) ? j.tz : localZone()
    const job: Job = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      task: j.task.trim(),
      label: (j.label?.trim() || labelFor(j.task)).slice(0, 60),
      rule: j.rule,
      tz,
      when: j.when.trim(),
      mode: j.mode ?? 'agent',
      createdAt: now,
      nextAt: nextRun(j.rule, now, tz),
      paused: false,
      runs: 0
    }
    this.jobs.push(job)
    this.save()
    this.arm()
    return job
  }

  /** Changes a job; a new rule (or zone) moves its next run. */
  update(id: string, patch: Partial<Pick<Job, 'task' | 'label' | 'rule' | 'when' | 'mode' | 'tz'>>): Job | null {
    const job = this.get(id)
    if (!job) return null
    Object.assign(job, patch)
    if (patch.task && !patch.label) job.label = labelFor(patch.task)
    if (patch.rule || patch.tz) job.nextAt = nextRun(job.rule, this.now(), job.tz)
    this.save()
    this.arm()
    return job
  }

  /** Paused jobs keep their place; resuming starts from now (what was missed while paused is not caught up). */
  setPaused(id: string, paused: boolean): Job | null {
    const job = this.get(id)
    if (!job) return null
    job.paused = paused
    if (!paused) job.nextAt = nextRun(job.rule, this.now(), job.tz)
    this.save()
    this.arm()
    return job
  }

  remove(id: string): Job | null {
    const i = this.jobs.findIndex((j) => j.id === id)
    if (i < 0) return null
    const [job] = this.jobs.splice(i, 1)
    this.waits = this.waits.filter((w) => w.jobId !== id)
    this.save()
    this.arm()
    return job
  }

  /** The jobs a request means: all, the best match for its words, or the only one. */
  match(query: string, all = false): Job[] {
    const pool = this.list()
    if (all) return pool
    if (!query.trim()) return pool.length === 1 ? pool : []
    const scored = pool.map((j) => ({ j, s: score(j, query) })).filter((x) => x.s > 0)
    if (!scored.length) return []
    const best = Math.max(...scored.map((x) => x.s))
    const top = scored.filter((x) => x.s === best)
    return top.length === 1 ? [top[0].j] : top.map((x) => x.j)
  }

  /** What a run came to. */
  record(id: string, status: RunStatus, summary: string): void {
    const job = this.get(id)
    if (!job) return
    job.last = { at: this.now(), status, summary: summary.slice(0, 400) }
    if (status !== 'skipped' && status !== 'missed') job.runs++
    this.save()
  }

  // ---- steps waiting for a yes

  waiting(): Waiting[] {
    return [...this.waits]
  }

  addWaiting(w: Omit<Waiting, 'id' | 'at'>): Waiting {
    const item: Waiting = { ...w, id: `w${this.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: this.now() }
    this.waits.push(item)
    this.save()
    return item
  }

  takeWaiting(id: string): Waiting | null {
    const i = this.waits.findIndex((w) => w.id === id)
    if (i < 0) return null
    const [w] = this.waits.splice(i, 1)
    this.save()
    return w
  }

  /** Starts the clock: whatever came due while she was off runs now (once). */
  start(): void {
    this.arm()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Looks again now (after the Mac wakes up). */
  check(): void {
    this.fire()
  }

  private arm(): void {
    this.stop()
    const next = this.jobs.filter((j) => !j.paused && j.nextAt !== null).sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))[0]
    if (!next || next.nextAt === null) return
    // At most a minute at a time: a timer does not tick while the Mac sleeps, and the clock may have jumped.
    const wait = Math.min(Math.max(0, next.nextAt - this.now()), 60_000)
    this.timer = setTimeout(() => this.fire(), wait)
    this.timer.unref?.()
  }

  private fire(): void {
    const now = this.now()
    const grace = this.opts.graceMs ?? 24 * 3_600_000
    const due: { job: Job; lateMs: number }[] = []
    let changed = false
    for (const job of this.jobs) {
      if (job.paused || job.nextAt === null || job.nextAt > now + 250) continue
      const lateMs = Math.max(0, now - job.nextAt)
      // The next run comes after now, so however many slots were slept through, this one runs once.
      job.nextAt = nextRun(job.rule, now, job.tz)
      changed = true
      if (lateMs > grace) {
        job.last = { at: now, status: 'missed', summary: `missed while the Mac was asleep or off (due ${new Date(now - lateMs).toISOString()})` }
        this.opts.onMissed?.(job, lateMs)
        continue
      }
      due.push({ job, lateMs })
    }
    // A one-off that ran (or was missed) is done.
    const before = this.jobs.length
    this.jobs = this.jobs.filter((j) => !(j.rule.kind === 'once' && j.nextAt === null && !j.paused))
    if (changed || this.jobs.length !== before) this.save()
    for (const { job, lateMs } of due) {
      try {
        this.onDue(job, { lateMs })
      } catch (err) {
        console.warn('[schedule]', (err as Error).message)
      }
    }
    this.arm()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ jobs: this.jobs, waiting: this.waits } satisfies FileShape, null, 2))
      renameSync(tmp, this.path)
    } catch (err) {
      console.warn('[schedule] could not save', (err as Error).message)
    }
  }
}

// ---- what the tools say (the app's host and the eval's fake share these)

export interface ScheduleFields {
  task: string
  when: string
  as_plan: boolean
  kind: string
  days: string[]
  times: string[]
  every_minutes: number | null
  day_of_month: number | null
  nth: number | null
  between: string | null
  at: string | null
}

/** Words of a timing phrase the rules did not account for ("twice a day"): a sign the parse is only partial. */
function leftover(when: string, spans: Span[]): string {
  let rest = when.toLowerCase()
  for (const sp of [...spans].sort((a, b) => b.start - a.start)) rest = rest.slice(0, sp.start) + ' ' + rest.slice(sp.end)
  return rest
    .replace(/\b(?:at|on|in|and|the|a|an|every|each|of|from|to|starting|beginning|o'?clock|please|then|also|both|local|time)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** The rule for schedule_job: their words first, the agent's fields when the words are too odd for the rules (a parse
 * that leaves words unexplained gives way to valid fields). */
export function resolveSchedule(a: ScheduleFields, now = new Date(), tz = localZone()): { rule: Rule } | { error: string } {
  if (!a.task.trim()) return { error: 'What should the job do each time? Ask the user.' }
  if (REMINDER_WORDS.test(a.task) && /^(?:remind|nudge|ping|poke|wake)\b/i.test(a.task.trim())) return { error: 'That is a reminder, not a job: use set_reminder with a repeat.' }
  const parsed = parseRule(a.when, now, tz)
  const fields = ruleFromFields(a, now, tz)
  const rule = parsed && (!leftover(a.when, parsed.spans) || !fields) ? parsed.rule : (fields ?? parsed?.rule ?? null)
  if (!rule) return { error: `I could not tell when "${a.when}" is. Ask the user for a day and a time ("every weekday at 9", "every hour").` }
  if (rule.kind === 'once' && rule.at <= now.getTime()) return { error: `${a.at ?? a.when} has already passed; ask the user.` }
  if (nextRun(rule, now.getTime(), tz) === null) return { error: `"${a.when}" never comes round; ask the user.` }
  return { rule }
}

/** "my" → "your", for her lines about the task. */
function yours(task: string): string {
  return task.replace(/\bmy\b/gi, 'your').replace(/\bme\b/gi, 'you').replace(/\bi\b/g, 'you')
}

/** "In 20 minutes", "at 9:00 AM", "tomorrow at 9:00 AM", "on Monday at 9:00 AM". */
export function nextText(at: number, now: number, tz?: string): string {
  const until = at - now
  if (until < 90 * 60_000) return `in ${Math.max(1, Math.round(until / 60_000))} minute${Math.round(until / 60_000) === 1 ? '' : 's'}`
  const opts = tz ? { timeZone: tz } : {}
  const clock = new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...opts })
  const day = (t: number): string => new Date(t).toLocaleDateString('en-CA', opts)
  if (day(at) === day(now)) return `at ${clock}`
  if (day(at) === day(now + 86_400_000)) return `tomorrow at ${clock}`
  const weekday = new Date(at).toLocaleDateString('en-US', { weekday: 'long', ...(until > 6 * 86_400_000 ? { month: 'long', day: 'numeric' } : {}), ...opts })
  return `on ${weekday} at ${clock}`
}

/** "Okay: every weekday at 9:00 AM I'll summarise your Slack. First run on Monday at 9:00 AM." */
export function scheduledLine(job: Job, now: number): string {
  const first = job.nextAt !== null ? ` First run ${nextText(job.nextAt, now, job.tz)}.` : ''
  const what = job.mode === 'plan' ? `put a plan on the card to ${yours(job.task)}` : yours(job.task)
  return `Okay: ${ruleText(job.rule, job.tz)}, I'll ${what}.${first}`
}

/** The jobs in one or two lines for her to say, or for the agent to read. */
export function jobsLine(jobs: Job[], waiting: Waiting[], now: number): string {
  if (!jobs.length) return waiting.length ? `No scheduled jobs, but ${waiting.length} step${waiting.length === 1 ? '' : 's'} still wait for your yes.` : 'No scheduled jobs.'
  const items = jobs.slice(0, 8).map((j) => {
    const next = j.paused ? 'paused' : j.nextAt !== null ? `next ${nextText(j.nextAt, now, j.tz)}` : 'done'
    const last = j.last ? `; last run ${j.last.status}${j.last.summary ? `: ${j.last.summary.slice(0, 80)}` : ''}` : ''
    return `"${j.label}" ${ruleText(j.rule, j.tz)} (${next}${last})`
  })
  const more = jobs.length > 8 ? `, and ${jobs.length - 8} more` : ''
  const wait = waiting.length ? ` Waiting for your yes: ${waiting.slice(0, 3).map((w) => `${w.what} (for "${w.label}")`).join('; ')}.` : ''
  return `${jobs.length === 1 ? 'One scheduled job' : `${jobs.length} scheduled jobs`}: ${items.join('; ')}${more}.${wait}`
}

/** change_job on a store; run_now comes back as `run` for the caller to start. */
export function changeJob(
  store: ScheduleStore,
  a: { query: string; action: 'pause' | 'resume' | 'delete' | 'run_now' | 'change'; when: string | null; task: string | null },
  now = new Date()
): { ok: boolean; text: string; run?: Job } {
  const hits = store.match(a.query, /^(?:all|every(?:thing| job)?|all (?:of )?(?:them|my jobs))$/i.test(a.query.trim()) && (a.action === 'pause' || a.action === 'resume' || a.action === 'delete'))
  if (!hits.length) return { ok: false, text: `No scheduled job matches "${a.query}". ${jobsLine(store.list(), [], now.getTime())}` }
  if (hits.length > 1 && a.action !== 'pause' && a.action !== 'resume' && a.action !== 'delete') return { ok: false, text: `Which one? ${jobsLine(hits, [], now.getTime())}` }
  const names = joinWords(hits.map((j) => `"${j.label}"`))
  switch (a.action) {
    case 'pause':
      for (const j of hits) store.setPaused(j.id, true)
      return { ok: true, text: `Paused ${names}.` }
    case 'resume':
      for (const j of hits) store.setPaused(j.id, false)
      return { ok: true, text: `${names} ${hits.length > 1 ? 'are' : 'is'} back on${hits.length === 1 && hits[0].nextAt ? `; next run ${nextText(store.get(hits[0].id)?.nextAt ?? 0, now.getTime(), hits[0].tz)}` : ''}.` }
    case 'delete':
      for (const j of hits) store.remove(j.id)
      return { ok: true, text: `Deleted ${names}.` }
    case 'run_now':
      return { ok: true, text: `Running "${hits[0].label}" now; I'll say what it finds.`, run: hits[0] }
    case 'change': {
      const job = hits[0]
      const patch: Parameters<ScheduleStore['update']>[1] = {}
      if (a.when) {
        const rule = parseRule(a.when, now, job.tz)?.rule
        if (!rule) return { ok: false, text: `I could not tell when "${a.when}" is. Ask for a day and a time.` }
        patch.rule = rule
        patch.when = a.when
      }
      if (a.task) patch.task = a.task
      if (!a.when && !a.task) return { ok: false, text: 'Change it how? Give a new when or task.' }
      const done = store.update(job.id, patch)
      return done ? { ok: true, text: scheduledLine(done, now.getTime()).replace(/^Okay: /, 'Changed: ') } : { ok: false, text: 'That job is gone.' }
    }
  }
}
