import type { CalendarEvent } from './calendar.ts'
import { clockTime } from './calendar.ts'

/**
 * The morning brief (opt-in in Setup): the first time the user wakes or unlocks the Mac, or comes back to it, after a
 * set hour, she tells them about the day in a few short sentences and shows the same on a card: today's calendar,
 * reminders, what scheduled jobs did overnight, the messages that came in, and one line from her notes. Once a day.
 * Pure, so it can be tested.
 */

export interface BriefPrefs {
  on: boolean
  /** "HH:MM": not before this */
  after: string
}

export const DEFAULT_BRIEF: BriefPrefs = { on: false, after: '07:00' }

export function briefPrefs(saved: Partial<BriefPrefs> | undefined): BriefPrefs {
  const p = { ...DEFAULT_BRIEF, ...(saved ?? {}) }
  if (!/^\d{1,2}:\d{2}$/.test(p.after)) p.after = DEFAULT_BRIEF.after
  p.on = Boolean(p.on)
  return p
}

/** "2026-10-19" in local time. */
export function dayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Time for the brief? On, not given today, past the hour (and not in the middle of the night past midnight). */
export function briefDue(prefs: BriefPrefs, lastDay: string | undefined, now: Date): boolean {
  if (!prefs.on || lastDay === dayKey(now)) return false
  const [h, m] = prefs.after.split(':').map(Number)
  const minutes = now.getHours() * 60 + now.getMinutes()
  return minutes >= h * 60 + m && now.getHours() < 21
}

export interface BriefInput {
  events: CalendarEvent[]
  /** today's reminders: text and when */
  reminders: { text: string; at: number }[]
  /** what scheduled jobs reported since yesterday evening */
  results: { label: string; line: string }[]
  /** steps of jobs waiting for a yes */
  waiting: number
  /** message notices that came in overnight ("Sam on Discord") */
  messages: string[]
  /** one of her notes worth a mention today */
  note?: string
  /** the calendar could not be read: why */
  calendarProblem?: string
}

/** The brief as short lines, for the card and for her to say. */
export function briefLines(b: BriefInput, now: Date): string[] {
  const lines: string[] = []
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  const today = b.events.filter((e) => !e.cancelled && (e.allDay || (e.end > now.getTime() && e.start <= end.getTime())))
  if (b.calendarProblem) lines.push(b.calendarProblem)
  else if (!today.length) lines.push('Nothing on your calendar today.')
  else {
    const parts = today.slice(0, 5).map((e) => (e.allDay ? `${e.title || 'an all-day event'} (all day)` : `${e.title || 'an event'} at ${clockTime(e.start)}`))
    lines.push(`Calendar: ${parts.join(', ')}${today.length > 5 ? `, and ${today.length - 5} more` : ''}.`)
  }
  const rem = b.reminders.filter((r) => r.at >= now.getTime() && r.at <= end.getTime())
  if (rem.length) lines.push(`Reminders: ${rem.slice(0, 4).map((r) => `${r.text || 'a reminder'} at ${clockTime(r.at)}`).join(', ')}${rem.length > 4 ? `, and ${rem.length - 4} more` : ''}.`)
  for (const r of b.results.slice(-3)) lines.push(`${r.label}: ${r.line.replace(/\s+/g, ' ').slice(0, 160)}`)
  if (b.results.length > 3) lines.push(`(${b.results.length - 3} more job results in my log.)`)
  if (b.waiting) lines.push(`${b.waiting} step${b.waiting === 1 ? '' : 's'} of your scheduled jobs ${b.waiting === 1 ? 'waits' : 'wait'} for your yes.`)
  if (b.messages.length) {
    const senders = [...new Set(b.messages)]
    const who = senders.slice(0, 3)
    lines.push(`Messages: ${b.messages.length === 1 ? who[0] : `${b.messages.length}, from ${who.join(', ')}${senders.length > who.length ? ' and others' : ''}`}.`)
  }
  if (b.note) lines.push(`From my notes: ${b.note}`)
  return lines
}

/** The plain spoken version, when no brain phrases it: a greeting and the first few lines. */
export function briefSpoken(lines: string[], now: Date): string {
  const hello = now.getHours() < 12 ? 'Good morning.' : now.getHours() < 18 ? 'Good afternoon.' : 'Good evening.'
  return `${hello} ${lines.slice(0, 3).join(' ')}`.trim()
}

/** A note from USER.md / MEMORY.md that names today ("Has a dentist appointment every first Friday"), else the first
 * of `fallback` (her project notes). */
export function noteForToday(notes: string[], now: Date, fallback: string[] = []): string | undefined {
  const day = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase()
  const firstWeek = now.getDate() <= 7
  const hit = notes.find((n) => {
    const t = n.toLowerCase()
    return t.includes(day) && (!/\bfirst\b/.test(t) || firstWeek)
  })
  return (hit ?? fallback[0])?.replace(/^- /, '').trim() || undefined
}
