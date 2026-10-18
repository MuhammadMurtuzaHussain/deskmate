/**
 * Calendar nudges: the helper reads upcoming events through EventKit (read only, after macOS asks once for
 * Calendars access), and this picks the ones about to start: "Standup in 10 minutes." Each event is mentioned once.
 */

export interface CalendarEvent {
  id: string
  title: string
  /** ms since 1970 */
  start: number
  end: number
  allDay: boolean
  calendar?: string
  location?: string
  cancelled?: boolean
}

/** Events starting within `leadMin` minutes (or that started in the last minute) not mentioned yet. */
export function dueEvents(events: CalendarEvent[], now: number, leadMin: number, mentioned: Set<string>): { event: CalendarEvent; minutes: number; key: string }[] {
  const out: { event: CalendarEvent; minutes: number; key: string }[] = []
  for (const e of events) {
    if (e.allDay || e.cancelled) continue
    const until = e.start - now
    if (until > leadMin * 60_000 || until < -60_000) continue
    const key = `${e.id}@${e.start}`
    if (mentioned.has(key)) continue
    out.push({ event: e, minutes: Math.max(0, Math.round(until / 60_000)), key })
  }
  return out
}

function eventName(e: CalendarEvent): string {
  return e.title.trim() || 'Your next event'
}

/** "Standup in 10 minutes." / "Standup starts now." */
export function eventLine(e: CalendarEvent, minutes: number): string {
  const name = eventName(e)
  const where = e.location && !/^https?:\/\//i.test(e.location) ? `, in ${e.location.split('\n')[0].slice(0, 60)}` : ''
  if (minutes <= 0) return `${name} starts now${where}.`
  return `${name} in ${minutes} minute${minutes === 1 ? '' : 's'}${where}.`
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "What's on my calendar today?": the events left in that day, in one line. */
export function agendaLine(events: CalendarEvent[], now: number, label: string): string {
  const left = events.filter((e) => !e.cancelled && (e.allDay || e.end > now))
  if (!left.length) return `Nothing on your calendar ${label}.`
  const parts = left.slice(0, 6).map((e) => (e.allDay ? `${eventName(e)} (all day)` : `${eventName(e)} at ${clockTime(e.start)}`))
  const more = left.length > 6 ? `, and ${left.length - 6} more` : ''
  return `${label[0].toUpperCase()}${label.slice(1)}: ${parts.join(', ')}${more}.`
}
