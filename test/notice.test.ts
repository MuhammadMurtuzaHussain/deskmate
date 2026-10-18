// Notices: quiet hours, dedupe, batching, the digest after quiet time; banner dedupe and lines; calendar nudges.
// No Electron, no helper. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dueEvents, eventLine, type CalendarEvent } from '../src/main/calendar.ts'
import { appAllowed, BannerWatch, messageLine, sender, type Banner } from '../src/main/inbox.ts'
import { DEFAULT_NOTICE_PREFS, digestLine, inQuietHours, NoticeCenter, noticePrefs, parseQuietHours, type Notice } from '../src/main/notice.ts'
import type { NoticePrefs } from '../src/shared/types.ts'

const clock = (h: number, m = 0): Date => new Date(2026, 9, 18, h, m)

test('quiet hours: parsing', () => {
  assert.deepEqual(parseQuietHours('23-8'), { start: 23 * 60, end: 8 * 60 })
  assert.deepEqual(parseQuietHours('23:30-07:15'), { start: 23 * 60 + 30, end: 7 * 60 + 15 })
  assert.deepEqual(parseQuietHours('11pm-7am'), { start: 23 * 60, end: 7 * 60 })
  assert.deepEqual(parseQuietHours('22 to 6'), { start: 22 * 60, end: 6 * 60 })
  assert.deepEqual(parseQuietHours('12pm-1pm'), { start: 12 * 60, end: 13 * 60 })
  assert.deepEqual(parseQuietHours('9–17'), { start: 9 * 60, end: 17 * 60 })
  for (const bad of ['', 'off', 'none', 'soon', '25-8', '8-8', '13pm-2', '23:75-8']) assert.equal(parseQuietHours(bad), null, bad)
})

test('quiet hours: across midnight and within a day', () => {
  const night = parseQuietHours('23-8')
  assert.equal(inQuietHours(clock(23), night), true)
  assert.equal(inQuietHours(clock(2, 30), night), true)
  assert.equal(inQuietHours(clock(7, 59), night), true)
  assert.equal(inQuietHours(clock(8), night), false)
  assert.equal(inQuietHours(clock(14), night), false)
  assert.equal(inQuietHours(clock(22, 59), night), false)
  const lunch = parseQuietHours('12-13:30')
  assert.equal(inQuietHours(clock(12, 15), lunch), true)
  assert.equal(inQuietHours(clock(13, 30), lunch), false)
  assert.equal(inQuietHours(clock(11, 59), lunch), false)
  assert.equal(inQuietHours(clock(3), null), false)
})

test('prefs: defaults, saved choices, and DESKMATE_QUIET_HOURS until Setup sets some', () => {
  assert.deepEqual(noticePrefs(undefined, ''), DEFAULT_NOTICE_PREFS)
  assert.equal(noticePrefs(undefined, '23-8').quietHours, '23-8')
  assert.equal(noticePrefs({ quietHours: '' }, '23-8').quietHours, '')
  assert.equal(noticePrefs({ quietHours: '22-6' }, '23-8').quietHours, '22-6')
  assert.deepEqual(noticePrefs({ allowApps: [' Calendar ', 'Calendar', ''] }, '').allowApps, ['Calendar'])
  assert.equal(noticePrefs({ calendarLead: 500 }, '').calendarLead, 120)
})

function center(over: Partial<NoticePrefs> = {}, opts: { now?: () => number; busy?: () => boolean } = {}) {
  const said: string[] = []
  const shown: string[] = []
  const logged: string[] = []
  const moves: string[] = []
  let prefs: NoticePrefs = { ...DEFAULT_NOTICE_PREFS, ...over }
  const c = new NoticeCenter({
    prefs: () => prefs,
    say: async (n: Notice) => {
      if (n.speak) await n.speak()
      said.push(n.text)
    },
    show: (t) => shown.push(t),
    wake: () => moves.push('wake'),
    approach: () => moves.push('approach'),
    log: (kind, text) => logged.push(`${kind}: ${text}`),
    busy: opts.busy ?? (() => false),
    now: opts.now,
    gapMs: 0,
    maxWaitMs: 50
  })
  return { c, said, shown, logged, moves, setPrefs: (p: Partial<NoticePrefs>) => (prefs = { ...prefs, ...p }) }
}

test('a notice is said once, logged, wakes her, and the important ones bring her over', async () => {
  const { c, said, logged, moves } = center()
  assert.equal(c.post({ kind: 'job', text: 'Claude finished "dark mode" in deskmate.', important: true }), 'queued')
  assert.equal(c.post({ kind: 'job', text: 'Claude finished "dark mode" in deskmate.', important: true }), 'duplicate')
  await c.drain()
  assert.deepEqual(said, ['Claude finished "dark mode" in deskmate.'])
  assert.deepEqual(logged, ['job: Claude finished "dark mode" in deskmate.'])
  assert.deepEqual(moves, ['wake', 'approach'])
  c.post({ kind: 'message', text: 'Sam messaged you on Discord.' })
  await c.drain()
  assert.deepEqual(moves, ['wake', 'approach', 'wake'])
})

test('dedupe expires after its window', async () => {
  let now = 0
  const { c, said } = center({}, { now: () => now })
  c.post({ kind: 'calendar', text: 'Standup in 10 minutes.', key: 'cal:1' })
  now += 11 * 60_000
  assert.equal(c.post({ kind: 'calendar', text: 'Standup in 10 minutes.', key: 'cal:1' }), 'queued')
  await c.drain()
  assert.equal(said.length, 2)
})

test('switched off in Setup: logged and shown, not said', async () => {
  const { c, said, shown, logged, moves } = center({ messages: false })
  assert.equal(c.post({ kind: 'message', text: 'Sam messaged you on Discord.' }), 'off')
  await c.drain()
  assert.deepEqual(said, [])
  assert.deepEqual(shown, ['Sam messaged you on Discord.'])
  assert.equal(logged.length, 1)
  assert.deepEqual(moves, [])
})

test('messages that pile up while she is busy are said together', async () => {
  let busy = true
  const { c, said } = center({}, { busy: () => busy })
  for (const [who, app] of [['Sam', 'Discord'], ['Ana', 'Slack'], ['Mum', 'Messages'], ['Jo', 'WhatsApp']]) {
    c.post({ kind: 'message', text: `${who} messaged you on ${app}.`, brief: `${who} on ${app}` })
  }
  setTimeout(() => (busy = false), 20)
  await c.drain()
  assert.deepEqual(said, ['Four messages: Sam on Discord, Ana on Slack, Mum on Messages and 1 more.'])
  c.post({ kind: 'message', text: 'Sam messaged you on Discord.', brief: 'Sam on Discord', key: 'again' })
  c.post({ kind: 'message', text: 'Ana messaged you on Slack.', brief: 'Ana on Slack', key: 'again2' })
  await c.drain()
  assert.deepEqual(said.slice(1), ['Sam messaged you on Discord.', 'Ana messaged you on Slack.'], 'one at a time when she is free')
})

test('quiet hours and do not disturb hold notices back, reminders still ring, and a digest follows', async () => {
  let now = clock(23, 30).getTime()
  const { c, said, shown, setPrefs } = center({ quietHours: '23-8' }, { now: () => now })
  assert.equal(c.quiet(), true)
  assert.equal(c.post({ kind: 'job', text: 'Claude finished "tests" in deskmate.', brief: 'Claude finished "tests"' }), 'held')
  assert.equal(c.post({ kind: 'message', text: 'Sam messaged you on Discord.', brief: 'Sam on Discord' }), 'held')
  assert.equal(c.post({ kind: 'message', text: 'Ana messaged you on Slack.', brief: 'Ana on Slack' }), 'held')
  assert.equal(c.post({ kind: 'calendar', text: 'Standup in 10 minutes.' }), 'held')
  assert.equal(c.post({ kind: 'reminder', text: 'Reminder: take your pills.', urgent: true }), 'queued')
  await c.drain()
  assert.deepEqual(said, ['Reminder: take your pills.'])
  assert.equal(shown.filter((s) => s.startsWith('(quiet)')).length, 4)
  c.tick()
  await c.drain()
  assert.equal(said.length, 1, 'still quiet')
  now = clock(8, 1).getTime() + 86_400_000
  c.tick()
  await c.drain()
  assert.deepEqual(said.slice(1), ['While I was quiet: Claude finished "tests" and 2 messages (Discord and Slack).'])
  c.tick()
  await c.drain()
  assert.equal(said.length, 2, 'the digest is said once')

  // Do not disturb, then off.
  setPrefs({ dnd: true })
  assert.equal(c.post({ kind: 'message', text: 'Mum messaged you on Messages.', brief: 'Mum on Messages' }), 'held')
  setPrefs({ dnd: false })
  c.tick()
  await c.drain()
  assert.equal(said.at(-1), 'While I was quiet: Mum on Messages.')
})

test('digest lines', () => {
  assert.equal(digestLine([]), '')
  assert.equal(digestLine([{ kind: 'calendar', text: 'Standup in 10 minutes.' }]), '')
  assert.equal(digestLine([{ kind: 'plan', text: 'Done: tidy downloads.', brief: 'the plan "tidy downloads" is done' }]), 'While I was quiet: the plan "tidy downloads" is done.')
})

test('a cap on spoken messages per hour', async () => {
  const said: string[] = []
  const c = new NoticeCenter({
    prefs: () => DEFAULT_NOTICE_PREFS,
    say: async (n) => void said.push(n.text),
    show: () => undefined,
    wake: () => undefined,
    approach: () => undefined,
    log: () => undefined,
    busy: () => false,
    gapMs: 0,
    messagesPerHour: 2
  })
  for (let i = 0; i < 4; i++) {
    c.post({ kind: 'message', text: `Person ${i} messaged you on Discord.` })
    await c.drain()
  }
  assert.equal(said.length, 2)
})

// ---- banners

const banner = (p: Partial<Banner>): Banner => ({ id: 'A', app: 'Discord', title: 'Sam', subtitle: '', body: 'are you around?', ...p })

test('banner dedupe: the first look only takes note; each banner once; the open panel never', () => {
  const w = new BannerWatch()
  let t = 0
  assert.deepEqual(w.update([banner({ id: 'old', title: 'Old news' })], t), [], 'already there when she started')
  t += 3000
  const fresh = w.update([banner({ id: 'A' })], t)
  assert.equal(fresh.length, 1)
  t += 3000
  assert.deepEqual(w.update([banner({ id: 'A' })], t), [], 'still on screen')
  t += 3000
  assert.deepEqual(w.update([banner({ id: 'B', inPanel: true })], t), [], 'moved into the list with a new id')
  // A stack keeps its id while the newest message changes: that is a new message.
  t += 3000
  assert.equal(w.update([banner({ id: 'A', body: 'hello??' })], t).length, 1)
  // Opening Notification Center shows things she never saw as banners: noted, not announced.
  t += 3000
  assert.deepEqual(w.update([banner({ id: 'C', app: 'Slack', title: 'Ana', body: 'lunch?', inPanel: true })], t), [])
  t += 3000
  assert.deepEqual(w.update([banner({ id: 'C2', app: 'Slack', title: 'Ana', body: 'lunch?' })], t), [], 'same words just seen in the panel')
  // Same words much later count as a new message.
  t += 11 * 60_000
  assert.equal(w.update([banner({ id: 'D', app: 'Slack', title: 'Ana', body: 'lunch?' })], t).length, 1)
})

test('which apps she mentions', () => {
  const prefs = { allowApps: ['Script Editor'], denyApps: ['Slack'] }
  assert.equal(appAllowed('Discord', prefs), true)
  assert.equal(appAllowed('messages', prefs), true)
  assert.equal(appAllowed('Slack', prefs), false, 'denied wins over chat apps')
  assert.equal(appAllowed('Script Editor', prefs), true, 'allowed')
  assert.equal(appAllowed('Screen Time', prefs), false, 'not a chat app, not allowed')
  assert.equal(appAllowed('Deskmate', { allowApps: ['Deskmate'], denyApps: [] }), false, 'never her own')
  assert.equal(appAllowed('', prefs), false)
})

test('what she says about a banner', () => {
  assert.equal(sender('Sam (#general, Design Team)'), 'Sam')
  assert.equal(sender('Sam in #general'), 'Sam')
  assert.deepEqual(messageLine(banner({}), false), { text: 'Sam messaged you on Discord.', brief: 'Sam on Discord' })
  assert.equal(messageLine(banner({}), true).text, 'Sam messaged you on Discord: "are you around?"')
  assert.equal(messageLine(banner({ app: 'Mail', title: 'Ana', subtitle: 'Invoice', body: 'attached' }), false).text, 'Ana emailed you.')
  assert.equal(messageLine(banner({ app: 'Mail', title: 'Ana', subtitle: 'Invoice', body: 'attached' }), true).text, 'Ana emailed you: "Invoice: attached"')
  assert.equal(messageLine(banner({ app: 'Script Editor', title: 'Deskmate test', body: 'hello' }), false).text, 'Script Editor: Deskmate test.')
  assert.equal(messageLine(banner({ title: '' }), false).text, 'New message on Discord.')
  assert.ok(messageLine(banner({ body: 'x '.repeat(400) }), true).text.length < 240)
})

// ---- calendar

test('calendar nudges: once, within the lead, never all-day or cancelled ones', () => {
  const now = clock(9, 50).getTime()
  const ev = (p: Partial<CalendarEvent>): CalendarEvent => ({ id: 'e1', title: 'Standup', start: clock(10).getTime(), end: clock(10, 15).getTime(), allDay: false, ...p })
  const mentioned = new Set<string>()
  const events = [ev({}), ev({ id: 'e2', title: 'Holiday', allDay: true }), ev({ id: 'e3', title: 'Later', start: clock(11).getTime() }), ev({ id: 'e4', title: 'Off', cancelled: true })]
  const due = dueEvents(events, now, 10, mentioned)
  assert.deepEqual(due.map((d) => [d.event.title, d.minutes]), [['Standup', 10]])
  assert.equal(eventLine(due[0].event, due[0].minutes), 'Standup in 10 minutes.')
  mentioned.add(due[0].key)
  assert.deepEqual(dueEvents(events, now + 60_000, 10, mentioned), [])
  // Moved to a new time: a new nudge.
  assert.equal(dueEvents([ev({ start: clock(9, 58).getTime() })], now, 10, mentioned).length, 1)
  assert.equal(eventLine(ev({ location: 'Room 4' }), 1), 'Standup in 1 minute, in Room 4.')
  assert.equal(eventLine(ev({ location: 'https://meet.example.com/x' }), 0), 'Standup starts now.')
})
