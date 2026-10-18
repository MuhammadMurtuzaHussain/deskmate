// Reminder and timer requests, parsed without a model, and the store that keeps them. Run with `npm test`.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dueLine, durationMs, listLine, parseReminder, parseWhen, ReminderStore, setLine, whenText, type Reminder, type ReminderIntent } from '../src/main/reminders.ts'

// Sunday 18 October 2026, 2:00 pm, local time.
const NOW = new Date(2026, 9, 18, 14, 0, 0)
const at = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m, 0).getTime()
const MIN = 60_000

function set(text: string, now = NOW): Extract<ReminderIntent, { kind: 'set' }> {
  const r = parseReminder(text, now)
  assert.ok(r && r.kind === 'set', `${text} → ${JSON.stringify(r)}`)
  return r as Extract<ReminderIntent, { kind: 'set' }>
}

test('in so many minutes', () => {
  assert.deepEqual(set('remind me in 20 minutes to stretch'), { kind: 'set', at: NOW.getTime() + 20 * MIN, text: 'stretch', timer: false, ms: 20 * MIN })
  assert.equal(set('remind me to stretch in 20 minutes').text, 'stretch')
  assert.equal(set('Can you remind me in 5 mins to drink water please?').at, NOW.getTime() + 5 * MIN)
  assert.equal(set('in 2 hours remind me to leave').at, NOW.getTime() + 120 * MIN)
  assert.equal(set('remind me in twenty five minutes to check on dinner').at, NOW.getTime() + 25 * MIN)
  assert.equal(set('remind me in half an hour that I need to move the car').text, 'move the car')
  assert.equal(set('remind me in an hour and a half to check the oven').at, NOW.getTime() + 90 * MIN)
  assert.equal(set('remind me in 1h30 to stop').at, NOW.getTime() + 90 * MIN)
  assert.equal(set('remind me in an hour to call my sister').text, 'call your sister')
})

test('durations on their own', () => {
  assert.equal(durationMs('5 minutes'), 5 * MIN)
  assert.equal(durationMs('two and a half hours'), 150 * MIN)
  assert.equal(durationMs('1 hour and 20 minutes'), 80 * MIN)
  assert.equal(durationMs('90 seconds'), 90_000)
  assert.equal(durationMs('a couple of minutes'), 2 * MIN)
  assert.equal(durationMs('a quarter of an hour'), 15 * MIN)
  assert.equal(durationMs('nothing here'), null)
})

test('at a time of day', () => {
  assert.deepEqual(set('remind me at 6pm to call mum'), { kind: 'set', at: at(18, 18), text: 'call mum', timer: false })
  assert.equal(set('remind me to call mum at 6pm').at, at(18, 18))
  assert.equal(set('set a reminder for 7:30pm to watch the match').at, at(18, 19, 30))
  assert.equal(set('remind me at 18:45 to cook').at, at(18, 18, 45))
  // No am/pm: the next time that hour comes round (6 → 6 pm today, 1 → 1 am tonight).
  assert.equal(set('remind me at 6 to call mum').at, at(18, 18))
  assert.equal(set('remind me at 1 to eat').at, at(19, 1))
  // Already past today: tomorrow.
  assert.equal(set('remind me at 9am to send the invoice').at, at(19, 9))
  assert.equal(set('remind me at noon to eat lunch').at, at(19, 12))
})

test('days', () => {
  assert.equal(set('remind me tomorrow at 9 to send the invoice').at, at(19, 9))
  assert.equal(set('remind me tomorrow at 3 to ring the bank').at, at(19, 15))
  assert.equal(set('remind me tonight to take my pills').at, at(18, 20))
  assert.equal(set('remind me tonight to take my pills').text, 'take your pills')
  assert.equal(set('remind me tomorrow morning to water the plants').at, at(19, 9))
  assert.deepEqual(set('remind me on friday at 3pm about the dentist'), { kind: 'set', at: at(23, 15), text: 'the dentist', timer: false })
  assert.equal(set('remind me next sunday at 10am to call dad').at, at(25, 10))
})

test('timers', () => {
  assert.deepEqual(set('set a timer for 5 minutes'), { kind: 'set', at: NOW.getTime() + 5 * MIN, text: '5 minute timer', timer: true, ms: 5 * MIN })
  assert.deepEqual(set('set a 10 minute timer for the pasta'), { kind: 'set', at: NOW.getTime() + 10 * MIN, text: 'the pasta', timer: true, ms: 10 * MIN })
  assert.equal(set('5 minute timer').ms, 5 * MIN)
  assert.equal(set('timer for 90 seconds').text, '90 second timer')
  assert.equal(set('start a timer for an hour').ms, 60 * MIN)
})

test('lists, cancels, and things that are not requests', () => {
  assert.deepEqual(parseReminder('what reminders do I have', NOW), { kind: 'list' })
  assert.deepEqual(parseReminder('What timers do I have?', NOW), { kind: 'list' })
  assert.deepEqual(parseReminder('any reminders?', NOW), { kind: 'list' })
  assert.deepEqual(parseReminder('cancel the stretch reminder', NOW), { kind: 'cancel', query: 'stretch', all: false, timer: false })
  assert.deepEqual(parseReminder('cancel my reminder to call mum', NOW), { kind: 'cancel', query: 'call mum', all: false, timer: false })
  assert.deepEqual(parseReminder('cancel the timer', NOW), { kind: 'cancel', query: '', all: false, timer: true })
  assert.deepEqual(parseReminder('cancel all my reminders', NOW), { kind: 'cancel', query: '', all: true, timer: false })
  assert.deepEqual(parseReminder('never mind the reminder about mum', NOW), { kind: 'cancel', query: 'mum', all: false, timer: false })
  assert.deepEqual(parseReminder('remind me to stretch', NOW), { kind: 'needTime', text: 'stretch', timer: false })
  assert.equal(parseReminder('I set a reminder yesterday', NOW), null)
  assert.equal(parseReminder('what time is it', NOW), null)
  assert.equal(parseReminder('tell sam on discord that the timer app is broken', NOW), null)
})

test('the answer to "when should I remind you?"', () => {
  assert.deepEqual(parseWhen('in 10 minutes', NOW), { at: NOW.getTime() + 10 * MIN, ms: 10 * MIN })
  assert.deepEqual(parseWhen('ten minutes', NOW), { at: NOW.getTime() + 10 * MIN, ms: 10 * MIN })
  assert.deepEqual(parseWhen('at 6', NOW), { at: at(18, 18) })
  assert.deepEqual(parseWhen('6pm', NOW), { at: at(18, 18) })
  assert.deepEqual(parseWhen('tomorrow morning', NOW), { at: at(19, 9) })
  assert.equal(parseWhen('what is the weather like', NOW), null)
})

test('what she says', () => {
  const now = NOW.getTime()
  const r = (p: Partial<Reminder>): Reminder => ({ id: 'x', text: 'stretch', at: now + 20 * MIN, createdAt: now, timer: false, ...p })
  assert.equal(setLine(r({}), now), "Okay, I'll remind you in 20 minutes to stretch.")
  assert.equal(setLine(r({ text: 'the dentist', at: at(23, 15) }), now), "Okay, I'll remind you on Friday at 3:00 PM about the dentist.")
  assert.equal(setLine(r({ timer: true, text: '5 minute timer', ms: 5 * MIN }), now), 'Timer set: 5 minutes.')
  assert.equal(setLine(r({ timer: true, text: 'the pasta', ms: 10 * MIN }), now), 'Timer set: 10 minutes, for the pasta.')
  assert.equal(dueLine(r({})), 'Reminder: stretch.')
  assert.equal(dueLine(r({ timer: true, text: '5 minute timer', ms: 5 * MIN })), 'Your 5 minute timer is up.')
  assert.equal(dueLine(r({ timer: true, text: 'the pasta', ms: 5 * MIN })), "Timer's up: the pasta.")
  assert.match(dueLine(r({}), 30 * MIN), /missed it while I was off/)
  assert.equal(whenText(at(19, 9), now), 'tomorrow at 9:00 AM')
  assert.equal(listLine([], now), 'No reminders or timers right now.')
  assert.equal(listLine([r({}), r({ timer: true, text: '5 minute timer', at: now + 4 * MIN })], now), '2: stretch in 20 minutes; a 5 minute timer, 4 minutes left.')
})

test('the store keeps them across a restart, fires what came due while off, and finds one to cancel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskmate-reminders-'))
  const path = join(dir, 'reminders.json')
  let clock = NOW.getTime()
  const fired: [string, number][] = []
  const a = new ReminderStore(path, (r, late) => fired.push([r.text, late]), () => clock)
  a.add({ text: 'stretch', at: clock + 20 * MIN, timer: false })
  a.add({ text: 'call mum', at: clock + 240 * MIN, timer: false })
  a.add({ text: '5 minute timer', at: clock + 5 * MIN, timer: true, ms: 5 * MIN })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).length, 3)
  assert.deepEqual(a.match({ query: 'stretch', all: false, timer: false }).map((r) => r.text), ['stretch'])
  assert.deepEqual(a.match({ query: '', all: false, timer: true }).map((r) => r.text), ['5 minute timer'])
  assert.deepEqual(a.match({ query: 'dentist', all: false, timer: false }), [])
  assert.equal(a.match({ query: '', all: true, timer: false }).length, 3)
  a.stop()

  // "Restart" half an hour later: the timer and the stretch came due while she was off.
  clock += 30 * MIN
  const b = new ReminderStore(path, (r, late) => fired.push([r.text, late]), () => clock)
  assert.equal(b.list().length, 3)
  b.start()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(fired, [
    ['5 minute timer', 25 * MIN],
    ['stretch', 10 * MIN]
  ])
  assert.deepEqual(b.list().map((r) => r.text), ['call mum'])
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).length, 1)
  b.stop()

  // A broken file is not her end.
  writeFileSync(path, '{nope')
  assert.deepEqual(new ReminderStore(path, () => undefined).list(), [])
})

test('a reminder fires on time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskmate-reminders-'))
  const fired: string[] = []
  const s = new ReminderStore(join(dir, 'r.json'), (r) => fired.push(r.text))
  s.add({ text: 'soon', at: Date.now() + 60, timer: false })
  assert.deepEqual(fired, [])
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(fired, ['soon'])
  s.stop()
})
