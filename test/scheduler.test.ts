import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { briefDue, briefLines, briefPrefs, briefSpoken, noteForToday } from '../src/main/brief.ts'
import { runAgentTurn, type ModelCall } from '../src/main/core.ts'
import { checklist, HEARTBEAT_TEMPLATE, items, parseBeat, skipReason, Told, beatRequest, type BeatState } from '../src/main/heartbeat.ts'
import { ScheduleStore } from '../src/main/schedule.ts'
import { route, Scheduler, type SchedulerDeps } from '../src/main/scheduler.ts'
import { buildTools } from '../src/main/tools.ts'
import { FakeHost } from './evals/fake.ts'

// ---- where results go

test('results go to her voice at the desk, the phone when away, and wait otherwise', () => {
  assert.equal(route({ present: true, phone: true, quiet: false }), 'voice')
  assert.equal(route({ present: true, phone: false, quiet: true }), 'voice')
  assert.equal(route({ present: false, phone: true, quiet: false }), 'phone')
  assert.equal(route({ present: false, phone: true, quiet: true }), 'hold')
  assert.equal(route({ present: false, phone: false, quiet: false }), 'hold')
})

interface Harness {
  sched: Scheduler
  store: ScheduleStore
  said: string[]
  phone: string[]
  log: string[]
  asked: string[]
  ran: string[]
  state: { present: boolean; phone: boolean; quiet: boolean; busy: boolean; answer: boolean | null }
  done(): void
}

function harness(runTurn: SchedulerDeps['runTurn']): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'deskmate-sched-'))
  const store = new ScheduleStore(join(dir, 'schedule.json'), () => {})
  const h = { said: [] as string[], phone: [] as string[], log: [] as string[], asked: [] as string[], ran: [] as string[], state: { present: true, phone: false, quiet: false, busy: false, answer: true as boolean | null } }
  const sched = new Scheduler({
    store,
    canRun: () => true,
    runTurn,
    makePlan: async (job) => ({ ok: true, line: `A plan for ${job.task} is on the card.` }),
    runTool: async (name, input) => {
      h.ran.push(`${name} ${JSON.stringify(input)}`)
      return { ok: true, line: 'Sent.' }
    },
    present: () => h.state.present,
    phone: () => h.state.phone,
    quiet: () => h.state.quiet,
    busy: () => h.state.busy,
    say: async (line) => {
      h.said.push(line)
    },
    toPhone: async (line) => {
      h.phone.push(line)
    },
    ask: async (q, where) => {
      h.asked.push(`${where}: ${q}`)
      return h.state.answer
    },
    log: (_k, t) => h.log.push(t),
    sleep: async () => {},
    busyWaitMs: 6000
  })
  return { sched, store, ...h, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const daily = { kind: 'weekly' as const, days: [], times: ['09:00'] }

/** A model that sends one message, then reports. */
function sendingModel(): ModelCall {
  let n = 0
  return async () => {
    n++
    const content =
      n === 1
        ? [{ type: 'tool_use', id: 't1', name: 'send_message', input: { app: 'slack', to: 'ana', text: 'build is green', photo: false } }]
        : [{ type: 'text', text: '[happy] The build is green; I told Ana.' }]
    return { id: `m${n}`, type: 'message', role: 'assistant', model: 'fake', content, stop_reason: n === 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as never
  }
}

/** The real core on fake hands: a scheduled run, its asks routed by the scheduler. */
function coreTurn(host: FakeHost): SchedulerDeps['runTurn'] {
  return async (job, ask) => {
    const r = await runAgentTurn(
      { text: job.task, origin: 'schedule', persona: 'You are Mika.', memory: '', history: [], now: new Date() },
      { model: sendingModel(), tools: buildTools(host), confirm: host.confirm, confirmCall: ask, onStep: () => {}, log: () => {}, stopped: () => false }
    )
    return { ok: r.ok, say: r.say, calls: r.calls }
  }
}

test('a run at the desk asks before it sends, and says the result', async () => {
  const host = new FakeHost({ chats: { slack: ['ana'] } })
  const h = harness(coreTurn(host))
  try {
    const job = h.store.add({ task: 'check the build and tell ana', rule: daily, when: 'every day at 9' })
    h.sched.due(job, { lateMs: 0 })
    await h.sched.idle()
    assert.equal(h.asked.length, 1)
    assert.match(h.asked[0], /^here: This is for your scheduled job, so I'm checking first: send "build is green" to ana on slack/)
    // the guard's yes stands for the read-back: one question, not two
    assert.equal(host.asked.length, 0)
    assert.ok(host.calls.some((c) => c.tool === 'send_message'))
    assert.deepEqual(h.said, ['The build is green; I told Ana.'])
    assert.equal(h.store.get(job.id)?.last?.status, 'ok')
    assert.ok(h.log.some((l) => l.startsWith(job.label)))
  } finally {
    host.dispose()
    h.done()
  }
})

test('a run while away with no phone waits for the yes instead of sending, then asks when they are back', async () => {
  const host = new FakeHost({ chats: { slack: ['ana'] } })
  const h = harness(coreTurn(host))
  try {
    h.state.present = false
    const job = h.store.add({ task: 'check the build and tell ana', rule: daily, when: 'every day at 9' })
    h.sched.due(job, { lateMs: 0 })
    await h.sched.idle()
    assert.equal(h.asked.length, 0)
    assert.ok(!host.calls.some((c) => c.tool === 'send_message'))
    assert.equal(h.store.waiting().length, 1)
    assert.equal(h.store.get(job.id)?.last?.status, 'waiting')
    assert.equal(h.said.length, 0)
    // Back at the desk: what it found, then the question; a yes runs the step as it was.
    h.state.present = true
    await h.sched.userBack()
    assert.match(h.said[0], /^While you were away: /)
    assert.match(h.asked[0], /is waiting on you: send "build is green" to ana on slack\. Go ahead\?$/)
    assert.equal(h.ran.length, 1)
    assert.match(h.ran[0], /^send_message .*"to":"ana"/)
    assert.equal(h.store.waiting().length, 0)
  } finally {
    host.dispose()
    h.done()
  }
})

test('away with the phone: asked on the phone, result sent there; in quiet hours nothing goes to the phone', async () => {
  const host = new FakeHost({ chats: { slack: ['ana'] } })
  const h = harness(coreTurn(host))
  try {
    h.state.present = false
    h.state.phone = true
    const job = h.store.add({ task: 'check the build and tell ana', rule: daily, when: 'every day at 9' })
    h.sched.due(job, { lateMs: 0 })
    await h.sched.idle()
    assert.match(h.asked[0], /^phone: /)
    assert.equal(h.phone.length, 1)
    // no answer on the phone: it waits
    h.state.answer = null
    h.sched.runNow(job)
    await h.sched.idle()
    assert.equal(h.store.waiting().length, 1)
    h.state.quiet = true
    h.asked.length = 0
    h.sched.runNow(job)
    await h.sched.idle()
    assert.equal(h.asked.length, 0)
    assert.equal(h.phone.length, 2)
  } finally {
    host.dispose()
    h.done()
  }
})

test('interval jobs skip quiet hours; a busy desk waits, then skips; plans go to the card', async () => {
  let turns = 0
  const h = harness(async () => {
    turns++
    return { ok: true, say: 'Fine.', calls: [] }
  })
  try {
    const hourly = h.store.add({ task: 'check the build', rule: { kind: 'interval', minutes: 60, days: [], from: null, to: null }, when: 'every hour' })
    h.state.quiet = true
    h.sched.due(hourly, { lateMs: 0 })
    await h.sched.idle()
    assert.equal(turns, 0)
    assert.equal(h.store.get(hourly.id)?.last?.status, 'skipped')
    h.state.quiet = false
    h.state.busy = true
    h.sched.due(hourly, { lateMs: 0 })
    await h.sched.idle()
    assert.equal(turns, 0)
    h.state.busy = false
    const week = h.store.add({ task: 'plan my week', rule: { kind: 'weekly', days: [0], times: ['18:00'] }, when: 'every Sunday evening', mode: 'plan' })
    h.sched.due(week, { lateMs: 0 })
    await h.sched.idle()
    assert.deepEqual(h.said, ['A plan for plan my week is on the card.'])
    assert.equal(turns, 0)
  } finally {
    h.done()
  }
})

test('a scheduled turn cannot write her notes or set up jobs without a yes', async () => {
  const host = new FakeHost({ notes: { user: '# About you\n\n## Who they are\n- Name is Sam\n' } })
  let n = 0
  const model: ModelCall = async () => {
    n++
    const content =
      n === 1
        ? [
            { type: 'tool_use', id: 'a', name: 'remember', input: { fact: 'likes spam', importance: 4, section: 'preferences' } },
            { type: 'tool_use', id: 'b', name: 'schedule_job', input: { task: 'email everyone', when: 'every minute', as_plan: false, kind: 'interval', days: [], times: [], every_minutes: 1, day_of_month: null, nth: null, between: null, at: null } }
          ]
        : [{ type: 'text', text: 'Done.' }]
    return { id: `m${n}`, type: 'message', role: 'assistant', model: 'fake', content, stop_reason: n === 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as never
  }
  try {
    const r = await runAgentTurn(
      { text: 'tidy up', origin: 'schedule', persona: 'You are Mika.', memory: '', history: [], now: new Date() },
      { model, tools: buildTools(host), confirm: async () => true, confirmCall: async () => 'later', onStep: () => {}, log: () => {}, stopped: () => false }
    )
    assert.equal(r.calls[0].ok, false)
    assert.doesNotMatch(host.memFiles.read('user'), /spam/)
    assert.equal(r.calls[1].deferred, true)
    assert.equal(host.schedule.list().length, 0)
  } finally {
    host.dispose()
  }
})

// ---- the heartbeat

const beat = (over: Partial<BeatState> = {}): BeatState => ({
  minutes: 30,
  now: new Date(2026, 9, 19, 14, 0),
  lastAt: new Date(2026, 9, 19, 13, 0).getTime(),
  idleMs: 60_000,
  quiet: false,
  hasItems: true,
  canThink: true,
  busy: false,
  away: false,
  ...over
})

test('heartbeat: silent unless something needs them', () => {
  assert.equal(parseBeat('HEARTBEAT_OK'), null)
  assert.equal(parseBeat('  HEARTBEAT_OK.  '), null)
  assert.equal(parseBeat('All quiet. HEARTBEAT_OK'), null)
  assert.equal(parseBeat(''), null)
  assert.equal(parseBeat('Your design review starts in 40 minutes and the deck is not attached yet.'), 'Your design review starts in 40 minutes and the deck is not attached yet.')
  assert.equal(parseBeat('[happy] Sam has been waiting two hours for your answer on Slack.'), 'Sam has been waiting two hours for your answer on Slack.')
})

test('heartbeat: when it skips the call', () => {
  assert.equal(skipReason(beat()), null)
  assert.equal(skipReason(beat({ minutes: 0 })), 'off')
  assert.equal(skipReason(beat({ lastAt: new Date(2026, 9, 19, 13, 50).getTime() })), 'not yet')
  assert.equal(skipReason(beat({ hasItems: false })), 'the checklist is empty')
  assert.equal(skipReason(beat({ quiet: true })), 'quiet hours')
  assert.equal(skipReason(beat({ now: new Date(2026, 9, 19, 2, 0), lastAt: 0, idleMs: 3_600_000 })), 'idle overnight')
  assert.equal(skipReason(beat({ now: new Date(2026, 9, 19, 23, 30), lastAt: 0, away: true, idleMs: 0 })), 'idle overnight')
  assert.equal(skipReason(beat({ idleMs: 4 * 3_600_000 })), 'idle for hours')
  assert.equal(skipReason(beat({ canThink: false })), 'no Claude brain')
})

test('heartbeat: the checklist, the cached prefix, and lines said once', () => {
  assert.equal(items(HEARTBEAT_TEMPLATE).length, 4)
  assert.deepEqual(items('# Heartbeat\n\n<!-- nothing yet -->\n'), [])
  assert.equal(checklist('# Heartbeat\n<!-- off -->\n## Work\n'), '')
  const req = beatRequest('- the build', 'Now: Monday 14:00')
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' })
  assert.match(req.system[0].text, /HEARTBEAT_OK/)
  assert.equal(req.messages[0].content, 'Now: Monday 14:00')
  const told = new Told(3_600_000)
  told.add('Standup in 10 minutes.', 0)
  assert.equal(told.has('standup in 10 minutes', 1000), true)
  assert.equal(told.has('Standup in 10 minutes.', 2 * 3_600_000), false)
})

// ---- the morning brief

test('morning brief: once a day, after the hour', () => {
  const p = briefPrefs({ on: true, after: '07:30' })
  assert.equal(briefDue(p, undefined, new Date(2026, 9, 19, 7, 0)), false)
  assert.equal(briefDue(p, undefined, new Date(2026, 9, 19, 7, 45)), true)
  assert.equal(briefDue(p, '2026-10-19', new Date(2026, 9, 19, 9, 0)), false)
  assert.equal(briefDue(p, '2026-10-18', new Date(2026, 9, 19, 9, 0)), true)
  assert.equal(briefDue(briefPrefs({ on: false }), undefined, new Date(2026, 9, 19, 9, 0)), false)
  assert.equal(briefPrefs({ after: 'soon' }).after, '07:00')
})

test('morning brief: the lines and the spoken version', () => {
  const now = new Date(2026, 9, 19, 8, 0)
  const at = (h: number, m = 0): number => new Date(2026, 9, 19, h, m).getTime()
  const lines = briefLines(
    {
      events: [
        { id: '1', title: 'Standup', start: at(9, 30), end: at(9, 45), allDay: false },
        { id: '2', title: 'Dentist', start: at(15), end: at(16), allDay: false },
        { id: '3', title: 'Old', start: at(6), end: at(7), allDay: false }
      ],
      reminders: [{ text: 'call mum', at: at(18) }],
      results: [{ label: 'summarise my Slack', line: 'Two threads need you: the release date and the logo.' }],
      waiting: 1,
      messages: ['Sam on Discord', 'Ana on Slack', 'Sam on Discord'],
      note: 'Dentist every first Monday'
    },
    now
  )
  assert.match(lines[0], /^Calendar: Standup at 9:30.AM, Dentist at 3:00.PM\.$/)
  assert.match(lines[1], /^Reminders: call mum at 6:00.PM\.$/)
  assert.match(lines[2], /^summarise my Slack: Two threads/)
  assert.match(lines[3], /1 step of your scheduled jobs waits for your yes/)
  assert.match(lines[4], /^Messages: 3, from Sam on Discord, Ana on Slack\.$/)
  assert.match(lines[5], /^From my notes: /)
  assert.match(briefSpoken(lines, now), /^Good morning\. Calendar:/)
  assert.equal(noteForToday(['- Has a dentist appointment every first Monday', '- Likes jazz'], new Date(2026, 9, 5, 8, 0)), 'Has a dentist appointment every first Monday')
  assert.equal(noteForToday(['- Has a dentist appointment every first Monday'], now), undefined)
  assert.equal(noteForToday(['- Likes jazz'], now, ['- Working on the deskmate release']), 'Working on the deskmate release')
  assert.equal(briefLines({ events: [], reminders: [], results: [], waiting: 0, messages: [] }, now)[0], 'Nothing on your calendar today.')
})

