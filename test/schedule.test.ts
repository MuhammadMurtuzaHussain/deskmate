import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { nextRun, parseRule, parseSchedule, resolveSchedule, ruleFromFields, ruleText, ScheduleStore, wallClock, zonedTime, type Job, type Rule } from '../src/main/schedule.ts'

const NY = 'America/New_York'
const DUB = 'Europe/Dublin'

/** "2026-10-19 09:00" in a zone, as a moment. */
function at(stamp: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(stamp)!
  return zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]) * 60 + Number(m[5]), tz)
}

/** A moment as "Mon 2026-10-19 09:00" on that zone's wall clock. */
function wall(t: number | null, tz: string): string {
  if (t === null) return 'none'
  const w = wallClock(t, tz)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][w.wd]} ${w.y}-${p(w.mo)}-${p(w.d)} ${p(w.h)}:${p(w.mi)}`
}

const weekdays9: Rule = { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] }

test('weekdays at 9: Friday evening goes to Monday', () => {
  assert.equal(wall(nextRun(weekdays9, at('2026-10-23 18:00', NY), NY), NY), 'Mon 2026-10-26 09:00')
  assert.equal(wall(nextRun(weekdays9, at('2026-10-21 08:59', NY), NY), NY), 'Wed 2026-10-21 09:00')
  // exactly at 9: the next one, not this one
  assert.equal(wall(nextRun(weekdays9, at('2026-10-21 09:00', NY), NY), NY), 'Thu 2026-10-22 09:00')
})

test('the clock time holds across daylight saving, both ways', () => {
  // US clocks go back on Sunday 1 November 2026; Ireland's a week earlier, on 25 October.
  const daily: Rule = { kind: 'weekly', days: [], times: ['09:00'] }
  const t1 = nextRun(daily, at('2026-10-30 10:00', NY), NY)!
  const t2 = nextRun(daily, t1, NY)!
  assert.equal(wall(t1, NY), 'Sat 2026-10-31 09:00')
  assert.equal(wall(t2, NY), 'Sun 2026-11-01 09:00')
  assert.equal(t2 - t1, 25 * 3_600_000)
  const d1 = nextRun(daily, at('2026-10-24 10:00', DUB), DUB)!
  assert.equal(wall(d1, DUB), 'Sun 2026-10-25 09:00')
  // spring forward (8 March 2026 in New York): 9:00 is still 9:00
  const s1 = nextRun(daily, at('2026-03-06 10:00', NY), NY)!
  const s2 = nextRun(daily, s1, NY)!
  assert.equal(wall(s2, NY), 'Sun 2026-03-08 09:00')
  assert.equal(s2 - s1, 23 * 3_600_000)
})

test('a time the clock skips comes just after the jump; one it repeats runs once', () => {
  const night: Rule = { kind: 'weekly', days: [], times: ['02:30'] }
  // 8 March 2026, New York: 2:00 → 3:00, so 2:30 does not exist
  assert.equal(wall(nextRun(night, at('2026-03-07 12:00', NY), NY), NY), 'Sun 2026-03-08 03:30')
  // 1 November 2026: 1:00–2:00 happens twice; 1:30 runs at the first one only
  const early: Rule = { kind: 'weekly', days: [], times: ['01:30'] }
  const first = nextRun(early, at('2026-10-31 12:00', NY), NY)!
  assert.equal(wall(first, NY), 'Sun 2026-11-01 01:30')
  assert.equal(wall(nextRun(early, first, NY), NY), 'Mon 2026-11-02 01:30')
})

test('every hour keeps to the clock, and a window keeps to its hours', () => {
  const hourly: Rule = { kind: 'interval', minutes: 60, days: [], from: null, to: null }
  assert.equal(wall(nextRun(hourly, at('2026-10-19 10:17', DUB), DUB), DUB), 'Mon 2026-10-19 11:00')
  const work: Rule = { kind: 'interval', minutes: 30, days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }
  assert.equal(wall(nextRun(work, at('2026-10-19 16:45', DUB), DUB), DUB), 'Mon 2026-10-19 17:00')
  assert.equal(wall(nextRun(work, at('2026-10-19 17:00', DUB), DUB), DUB), 'Tue 2026-10-20 09:00')
  assert.equal(wall(nextRun(work, at('2026-10-23 18:00', DUB), DUB), DUB), 'Mon 2026-10-26 09:00')
  // on the fall-back night an hourly job runs for every real hour (01:00 twice)
  const a = nextRun(hourly, at('2026-11-01 00:30', NY), NY)!
  const b = nextRun(hourly, a, NY)!
  const c = nextRun(hourly, b, NY)!
  assert.deepEqual([wall(a, NY), wall(b, NY), wall(c, NY)], ['Sun 2026-11-01 01:00', 'Sun 2026-11-01 01:00', 'Sun 2026-11-01 02:00'])
})

test('monthly: the 31st in a short month, the first Friday, the last day', () => {
  const r31: Rule = { kind: 'monthly', day: 31, nth: null, weekday: null, times: ['09:00'] }
  assert.equal(wall(nextRun(r31, at('2026-11-01 10:00', DUB), DUB), DUB), 'Mon 2026-11-30 09:00')
  const firstFri: Rule = { kind: 'monthly', day: null, nth: 1, weekday: 5, times: ['08:00'] }
  assert.equal(wall(nextRun(firstFri, at('2026-10-19 10:00', DUB), DUB), DUB), 'Fri 2026-11-06 08:00')
  const last: Rule = { kind: 'monthly', day: -1, nth: null, weekday: null, times: ['17:00'] }
  assert.equal(wall(nextRun(last, at('2027-02-01 10:00', DUB), DUB), DUB), 'Sun 2027-02-28 17:00')
})

test('every other day and once', () => {
  const other: Rule = { kind: 'days', every: 2, start: '2026-10-19', times: ['07:00'] }
  assert.equal(wall(nextRun(other, at('2026-10-19 08:00', DUB), DUB), DUB), 'Wed 2026-10-21 07:00')
  const once: Rule = { kind: 'once', at: at('2026-10-20 15:00', DUB) }
  assert.equal(wall(nextRun(once, at('2026-10-19 08:00', DUB), DUB), DUB), 'Tue 2026-10-20 15:00')
  assert.equal(nextRun(once, at('2026-10-21 08:00', DUB), DUB), null)
})

// ---- their words

const MONDAY = new Date(2026, 9, 19, 10, 0)

function parsed(text: string, tz = DUB): { rule: Rule; task: string; when: string; clean: boolean } | null {
  return parseSchedule(text, MONDAY, tz)
}

test('the three examples', () => {
  const a = parsed('every weekday at 9 summarise my Slack')!
  assert.deepEqual(a.rule, { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] })
  assert.equal(a.task, 'summarise my Slack')
  assert.equal(a.clean, true)
  const b = parsed('every Sunday evening plan my week')!
  assert.deepEqual(b.rule, { kind: 'weekly', days: [0], times: ['18:00'] })
  assert.equal(b.task, 'plan my week')
  const c = parsed('every hour check if the build is green')!
  assert.deepEqual(c.rule, { kind: 'interval', minutes: 60, days: [], from: null, to: null })
  assert.equal(c.task, 'check if the build is green')
})

test('more ways of saying when', () => {
  const cases: [string, Rule, string][] = [
    ['summarise my slack every weekday at 9am', { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] }, 'summarise my slack'],
    ['each morning at 7:30, read me the headlines', { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['07:30'] }, 'read me the headlines'],
    ['every day at noon check my email', { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['12:00'] }, 'check my email'],
    ['every monday, wednesday and friday at 6pm tidy my downloads', { kind: 'weekly', days: [1, 3, 5], times: ['18:00'] }, 'tidy my downloads'],
    ['on weekends at 10 play some jazz', { kind: 'weekly', days: [0, 6], times: ['10:00'] }, 'play some jazz'],
    ['every 15 minutes between 9 and 5 on weekdays check the deploy', { kind: 'interval', minutes: 15, days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }, 'check the deploy'],
    ['every two hours look at the build', { kind: 'interval', minutes: 120, days: [], from: null, to: null }, 'look at the build'],
    ['on the first friday of every month at 8 send ana the invoice', { kind: 'monthly', day: null, nth: 1, weekday: 5, times: ['08:00'] }, 'send ana the invoice'],
    ['on the 1st of every month at 9 sort my receipts', { kind: 'monthly', day: 1, nth: null, weekday: null, times: ['09:00'] }, 'sort my receipts'],
    ['every night at 11 back up the vlog folder', { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['23:00'] }, 'back up the vlog folder'],
    ['every other day at 7 check the plant cam', { kind: 'days', every: 2, start: '2026-10-19', times: ['07:00'] }, 'check the plant cam'],
    ['fridays at 4 write my weekly report', { kind: 'weekly', days: [5], times: ['16:00'] }, 'write my weekly report'],
    ['every weekday at 9 and 5 check slack', { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00', '17:00'] }, 'check slack']
  ]
  for (const [text, rule, task] of cases) {
    const p = parsed(text)
    assert.ok(p, text)
    assert.deepEqual(p.rule, rule, text)
    assert.equal(p.task, task, text)
  }
})

test('not schedules: reminders, questions, one-offs, "every time"', () => {
  for (const text of ['remind me every weekday at 9 to do standup', 'every hour, remind me to drink water', 'what do I do every day?', 'tomorrow at 9 summarise my slack', 'every time I open slack say hi', 'I go running every', 'every weekday']) {
    assert.equal(parsed(text), null, text)
  }
})

test("odd phrasing: the agent's fields win over a partial parse", () => {
  const fields = { task: 'look over my github notifications', when: 'twice a day, at 10 and at 4, on workdays', as_plan: false, kind: 'weekly', days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], times: ['10:00', '16:00'], every_minutes: null, day_of_month: null, nth: null, between: null, at: null }
  assert.deepEqual(resolveSchedule(fields, MONDAY, DUB), { rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['10:00', '16:00'] } })
  // the same words alone now parse whole
  assert.deepEqual(parseRule('on workdays at 10 and at 4', MONDAY, DUB)?.rule, { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['10:00', '16:00'] })
  // their clean words win over fields that disagree
  assert.deepEqual(resolveSchedule({ ...fields, when: 'every weekday at 9', times: ['08:00'] }, MONDAY, DUB), { rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] } })
  assert.match((resolveSchedule({ ...fields, when: 'whenever', kind: 'interval', every_minutes: null }, MONDAY, DUB) as { error: string }).error, /could not tell/)
  assert.match((resolveSchedule({ ...fields, task: 'remind me to stretch' }, MONDAY, DUB) as { error: string }).error, /reminder/)
})

test('the timing alone, and the fields the agent fills for odd phrasing', () => {
  assert.deepEqual(parseRule('weekly on friday at 4pm', MONDAY, DUB)?.rule, { kind: 'weekly', days: [5], times: ['16:00'] })
  assert.equal(parseRule('twice a fortnight-ish', MONDAY, DUB), null)
  const r = ruleFromFields({ kind: 'weekly', days: ['tuesday', 'thursday'], times: ['08:15'], every_minutes: null, day_of_month: null, nth: null, between: null, at: null }, MONDAY, DUB)
  assert.deepEqual(r, { kind: 'weekly', days: [2, 4], times: ['08:15'] })
  assert.equal(ruleFromFields({ kind: 'interval', days: [], times: [], every_minutes: 0, day_of_month: null, nth: null, between: null, at: null }, MONDAY, DUB), null)
})

test('in words', () => {
  assert.equal(ruleText(weekdays9), 'every weekday at 9:00 AM')
  assert.equal(ruleText({ kind: 'interval', minutes: 60, days: [], from: null, to: null }), 'every hour')
  assert.equal(ruleText({ kind: 'interval', minutes: 15, days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }), 'every 15 minutes from 9:00 AM to 5:00 PM on weekdays')
  assert.equal(ruleText({ kind: 'monthly', day: null, nth: 1, weekday: 5, times: ['08:00'] }), 'on the first Friday of every month at 8:00 AM')
  assert.equal(ruleText({ kind: 'weekly', days: [0], times: ['18:00'] }), 'every Sunday at 6:00 PM')
})

// ---- the store: catch-up once, pause, waiting steps

test('a job missed while asleep runs once when she wakes, then goes back to its times', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskmate-schedule-'))
  try {
    let now = at('2026-10-19 08:00', DUB)
    const runs: { job: Job; lateMs: number }[] = []
    const store = new ScheduleStore(join(dir, 'schedule.json'), (job, info) => runs.push({ job, lateMs: info.lateMs }), { now: () => now })
    const hourly = store.add({ task: 'check the build', rule: { kind: 'interval', minutes: 60, days: [], from: null, to: null }, when: 'every hour', tz: DUB })
    store.add({ task: 'summarise my Slack', rule: weekdays9, when: 'every weekday at 9', tz: DUB })
    // The Mac sleeps from 8:00 to 13:20: five hourly slots and the 9:00 job went by.
    now = at('2026-10-19 13:20', DUB)
    store.check()
    assert.equal(runs.length, 2)
    assert.deepEqual(runs.map((r) => r.job.task).sort(), ['check the build', 'summarise my Slack'])
    assert.ok(runs.every((r) => r.lateMs > 0))
    assert.equal(wall(store.get(hourly.id)!.nextAt, DUB), 'Mon 2026-10-19 14:00')
    // Nothing more until the next slot.
    store.check()
    assert.equal(runs.length, 2)
    // Too late (asleep for two days): dropped, not run.
    const missed: string[] = []
    const store2 = new ScheduleStore(join(dir, 'schedule.json'), (job) => runs.push({ job, lateMs: 0 }), { now: () => now, onMissed: (job) => missed.push(job.task) })
    now = at('2026-10-21 16:00', DUB)
    store2.check()
    assert.equal(runs.length, 2)
    assert.equal(missed.length, 2)
    store.stop()
    store2.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pause, resume, match, one-offs and steps waiting for a yes survive a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskmate-schedule-'))
  try {
    let now = at('2026-10-19 08:00', DUB)
    const runs: string[] = []
    const path = join(dir, 'schedule.json')
    const store = new ScheduleStore(path, (job) => runs.push(job.task), { now: () => now })
    const slack = store.add({ task: 'summarise my Slack', rule: weekdays9, when: 'every weekday at 9', tz: DUB })
    store.add({ task: 'check if the build is green', rule: { kind: 'interval', minutes: 60, days: [], from: null, to: null }, when: 'every hour', tz: DUB })
    const once = store.add({ task: 'look at the deploy', rule: { kind: 'once', at: at('2026-10-19 08:30', DUB) }, when: 'at 8:30', tz: DUB })
    assert.deepEqual(store.match('the slack summary').map((j) => j.id), [slack.id])
    assert.equal(store.match('the build').length, 1)
    store.setPaused(slack.id, true)
    now = at('2026-10-19 09:05', DUB)
    store.check()
    assert.deepEqual(runs.sort(), ['check if the build is green', 'look at the deploy'])
    assert.equal(store.get(once.id), null)
    store.setPaused(slack.id, false)
    assert.equal(wall(store.get(slack.id)!.nextAt, DUB), 'Tue 2026-10-20 09:00')
    store.addWaiting({ jobId: slack.id, label: slack.label, tool: 'send_message', input: { app: 'slack', to: 'ana', text: 'hi' }, what: 'send "hi" to ana on slack' })
    // the same step from the next run is one entry, not two
    store.addWaiting({ jobId: slack.id, label: slack.label, tool: 'send_message', input: { app: 'slack', to: 'ana', text: 'hi' }, what: 'send "hi" to ana on slack' })
    assert.equal(store.waiting().length, 1)
    store.record(slack.id, 'waiting', 'wants to send a message')
    store.stop()
    const again = new ScheduleStore(path, () => {}, { now: () => now })
    assert.equal(again.list().length, 2)
    assert.equal(again.waiting().length, 1)
    assert.equal(again.get(slack.id)?.last?.status, 'waiting')
    assert.ok(again.takeWaiting(again.waiting()[0].id))
    assert.equal(again.waiting().length, 0)
    again.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
