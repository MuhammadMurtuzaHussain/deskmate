// Skills: trigger phrases, loading and checking skill.json, slot parsing, and running steps against a fake pair of
// hands that records every call. No Electron, no helper, nothing pressed. Run with `npm test`.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DesktopHands, FocusedElement } from '../src/main/hands.ts'
import {
  appIdFor,
  checkSendRules,
  cleanSlot,
  compileTrigger,
  exampleFor,
  loadSkills,
  matchSkill,
  parseSkill,
  runSkill,
  skillTool,
  skillToolName,
  type Skill,
  type SkillDeps,
  type SkillStep
} from '../src/main/skills.ts'

const BUNDLED = join(import.meta.dirname, '..', 'skills')

// ---- a fake pair of hands

interface Call {
  cmd: string
  args: unknown[]
}

class FakeHands {
  calls: Call[] = []
  front = ''
  /** what the focused text box holds; paste/type add to it */
  box: FocusedElement | null = null
  title: string | null = null
  locateHits = true
  installedApps = new Set(['net.whatsapp.WhatsApp', 'ru.keepcoder.Telegram', 'com.apple.Notes', 'WhatsApp', 'com.example.chatty'])
  /** throws focus_changed on this command */
  switchAwayOn: string | null = null
  /** a paste that the box doesn't show */
  dropPaste = false

  private rec(cmd: string, ...args: unknown[]): void {
    this.calls.push({ cmd, args })
    if (cmd === this.switchAwayOn) throw Object.assign(new Error('focus_changed: com.apple.finder'), { code: 'focus_changed' })
  }
  private expect(expect: string | undefined): void {
    if (expect && expect !== this.front) throw Object.assign(new Error(`focus_changed: ${this.front}`), { code: 'focus_changed' })
  }

  available = true
  calendarDisclaim = false
  async permissions() {
    return { keys: true, accessibility: true, screen: true }
  }
  async installed(app: string) {
    this.rec('installed', app)
    return this.installedApps.has(app)
  }
  async launch(app: string) {
    this.rec('launch', app)
    this.front = app
    return { pid: 1, wasRunning: true, ms: 5 }
  }
  async frontmost() {
    return { bundleId: this.front, name: this.front }
  }
  async windowTitle(app: string) {
    this.rec('windowTitle', app)
    return this.title
  }
  async focused(app: string) {
    this.rec('focused', app)
    return this.box ? { ...this.box } : null
  }
  async focusInput(app: string, hint: string, expect?: string) {
    this.rec('focusInput', app, hint, expect)
    this.expect(expect)
    this.box = { role: 'AXTextArea', value: '' }
    return { ...this.box }
  }
  async key(combo: string, expect?: string) {
    this.rec('key', combo, expect)
    this.expect(expect)
  }
  async type(text: string, expect?: string) {
    this.rec('type', text, expect)
    this.expect(expect)
  }
  async paste(text: string, expect?: string) {
    this.rec('paste', text, expect)
    this.expect(expect)
    if (this.box && !this.dropPaste) this.box.value = `${this.box.value ?? ''}${text}`
  }
  async menuItems() {
    return []
  }
  async pressMenu(app: string, path: string[], expect?: string) {
    this.rec('menu', app, path, expect)
    this.expect(expect)
    this.box = { role: 'AXTextArea', value: '' }
    return path
  }
  async resolve(name: string) {
    return { bundleId: name, name }
  }
  async snapshot() {
    return { app: '', bundleId: '', title: null, elements: [], text: '' }
  }
  async act() {
    return { element: {} }
  }
  async ocr() {
    return { app: '', bundleId: '', items: [] }
  }
  async clickText() {}
  async topWindow() {
    return null
  }
  async windowById() {
    return null
  }
  async elementFrame() {
    return { x: 0, y: 0, w: 1, h: 1 }
  }
  async textFrame() {
    return { x: 0, y: 0, w: 1, h: 1 }
  }
  async locate(app: string, text: string) {
    this.rec('locate', app, text)
    return this.locateHits ? { x: 10, y: 10, w: 100, h: 20 } : null
  }
  async banners() {
    return []
  }
  async calendarStatus() {
    return 'unavailable'
  }
  async calendarEvents() {
    return []
  }
  async requestCalendarAccess() {
    return { granted: false, status: 'unavailable' }
  }
  stop() {}

  /** the calls that press or type something */
  input(): Call[] {
    return this.calls.filter((c) => ['key', 'type', 'paste', 'focusInput', 'menu'].includes(c.cmd))
  }
}

function deps(hands: FakeHands, answers: boolean[] = [true], extra: Partial<SkillDeps> = {}): SkillDeps & { asked: string[]; lines: string[] } {
  const asked: string[] = []
  const lines: string[] = []
  return {
    hands: hands as unknown as DesktopHands,
    platform: 'darwin',
    confirm: async (q) => {
      asked.push(q)
      return answers.shift() ?? false
    },
    confirmSends: true,
    onStep: () => undefined,
    log: (line) => lines.push(line),
    stopped: () => false,
    sleep: async () => undefined,
    asked,
    lines,
    ...extra
  }
}

async function bundled(): Promise<Skill[]> {
  const { skills, problems } = await loadSkills([{ dir: BUNDLED, source: 'bundled' }])
  assert.deepEqual(problems, [])
  return skills
}

function skillJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-chat',
    title: 'Test chat',
    description: 'Send a test chat message',
    app: { name: 'Chatty', bundleId: 'com.example.chatty', messaging: true },
    slots: [
      { name: 'to', description: 'Who' },
      { name: 'text', description: 'What' }
    ],
    triggers: ['chatty {to}: {text}'],
    steps: [
      { do: 'launch' },
      { do: 'key', combo: 'cmd+k' },
      { do: 'type', text: '{to}' },
      { do: 'key', combo: 'return', send: false },
      { do: 'checkTitle', contains: '{to}' },
      { do: 'confirm', question: 'Send "{text}" to {to}?' },
      { do: 'focusInput', hint: 'message' },
      { do: 'paste', text: '{text}' },
      { do: 'readBack', text: '{text}' },
      { do: 'key', combo: 'return', send: true }
    ],
    done: 'Sent to {where}.',
    ...over
  }
}

function make(over: Record<string, unknown> = {}): Skill {
  const { skill, errors } = parseSkill(skillJson(over), '', 'user')
  assert.deepEqual(errors, [])
  return skill as Skill
}

// ---- triggers

const first = (patterns: RegExp[], s: string) => patterns.map((re) => re.exec(s)).find(Boolean)?.groups

test('trigger phrases: slots, choices, optional parts, polite openers, trailing punctuation', () => {
  const { patterns, slots } = compileTrigger('(message|text) {to} on whatsapp[:|,] [that|saying] {text}')
  assert.deepEqual(slots, ['to', 'text'])
  const m = (s: string) => first(patterns, s)
  assert.deepEqual({ ...m('message Sam on WhatsApp: running late') }, { to: 'Sam', text: 'running late' })
  assert.deepEqual({ ...m('Text the study group on whatsapp saying see you at 6!') }, { to: 'the study group', text: 'see you at 6' })
  assert.deepEqual({ ...m('can you please message Ana on whatsapp that I am on my way.') }, { to: 'Ana', text: 'I am on my way' })
  assert.deepEqual({ ...m('message  Sam   on whatsapp hi') }, { to: 'Sam', text: 'hi' })
  assert.equal(m('message Sam on telegram: hi'), undefined)
  assert.equal(m('email Sam on whatsapp: hi'), undefined)
})

test('trigger phrases: an optional part at the start, and literal punctuation', () => {
  const notes = compileTrigger('[please] notes: {text}').patterns
  assert.equal(first(notes, 'notes: buy milk')?.text, 'buy milk')
  assert.equal(first(notes, 'please notes: buy milk')?.text, 'buy milk')
  const dots = compileTrigger('open {site}.com').patterns
  assert.equal(first(dots, 'open example.com')?.site, 'example')
  assert.equal(first(dots, 'open exampleXcom'), undefined)
  // a name of several words, when the optional word that ends it is there
  const tell = compileTrigger('tell {to} [that] {text}').patterns
  assert.deepEqual({ ...first(tell, 'tell the night shift that the build is green') }, { to: 'the night shift', text: 'the build is green' })
  assert.deepEqual({ ...first(tell, 'tell sam hi there') }, { to: 'sam', text: 'hi there' })
})

test('trigger phrases that cannot compile say why', () => {
  assert.throws(() => compileTrigger('message {to on whatsapp'), /missing "}"/)
  assert.throws(() => compileTrigger('message (to|from {to}'), /missing "\)"/)
  assert.throws(() => compileTrigger('message {To}: {text}'), /bad slot name/)
  assert.throws(() => compileTrigger('{to} and {to}'), /used twice/)
  assert.throws(() => compileTrigger('a | b'), /outside/)
})

test('slot values: quotes, "the", "@" and trailing punctuation come off', () => {
  assert.equal(cleanSlot('text', '"on my way"'), 'on my way')
  assert.equal(cleanSlot('text', '“see you at 6”'), 'see you at 6')
  assert.equal(cleanSlot('to', 'the study group chat'), 'study group')
  assert.equal(cleanSlot('to', '@ana,'), 'ana')
  assert.equal(cleanSlot('text', 'the plan is fine'), 'the plan is fine')
})

// ---- loading and checking

test('the bundled skills load, with the Notes handler', async () => {
  const skills = await bundled()
  assert.deepEqual(skills.map((s) => s.name).sort(), ['notes-new-note', 'telegram-message', 'whatsapp-message'])
  const notes = skills.find((s) => s.name === 'notes-new-note') as Skill
  assert.equal(typeof notes.handler?.slots, 'function')
  assert.equal(notes.handler?.run, undefined)
  for (const s of skills) assert.equal(s.source, 'bundled')
})

test('matching phrases to the bundled skills', async () => {
  const skills = await bundled()
  const hit = (s: string) => {
    const m = matchSkill(skills, s)
    return m ? [m.skill.name, m.slots] : null
  }
  assert.deepEqual(hit('message Sam on WhatsApp: running late'), ['whatsapp-message', { to: 'Sam', text: 'running late' }])
  assert.deepEqual(hit('whatsapp mum: home by 7'), ['whatsapp-message', { to: 'mum', text: 'home by 7' }])
  assert.deepEqual(hit('on whatsapp, tell the family group that dinner is ready'), ['whatsapp-message', { to: 'family group', text: 'dinner is ready' }])
  assert.deepEqual(hit('send "on my way" to Ana on whatsapp'), ['whatsapp-message', { to: 'Ana', text: 'on my way' }])
  assert.deepEqual(hit('tell Sam on telegram that the build is green'), ['telegram-message', { to: 'Sam', text: 'the build is green' }])
  assert.deepEqual(hit('make a new note saying buy milk'), ['notes-new-note', { text: 'buy milk' }])
  assert.deepEqual(hit('jot down call the dentist in notes'), ['notes-new-note', { text: 'call the dentist' }])
  assert.equal(hit('message Sam on discord: hi'), null)
  assert.equal(hit('what is whatsapp?'), null)
  assert.equal(hit('how do I make a note'), null)
})

test('a skill.json with problems is refused, with every reason', () => {
  const { skill, errors } = parseSkill(
    {
      name: 'Bad Name',
      app: { name: 'Keychain', bundleId: 'com.apple.keychainaccess' },
      slots: [{ name: 'to' }],
      triggers: ['keychain {to} {what}', 'keychain'],
      steps: [{ do: 'click', at: 3 }, { do: 'key' }, { do: 'paste', text: '{secret}', speed: 2 }]
    },
    '',
    'user'
  )
  assert.equal(skill, undefined)
  const all = errors.join('\n')
  assert.match(all, /"name" must be/)
  assert.match(all, /off limits/)
  assert.match(all, /uses \{what\}, which isn't in "slots"/)
  assert.match(all, /trigger "keychain" leaves out the required slot \{to\}/)
  assert.match(all, /unknown "do": "click"/)
  assert.match(all, /step 2 \(key\): "combo" is missing/)
  assert.match(all, /step 3 \(paste\): unknown field "speed"/)
  assert.match(all, /\{secret\} isn't in "slots"/)
})

test('send rules: a Return in a messaging app must say whether it sends, and a send needs a yes and a read-back', () => {
  const s = (steps: SkillStep[], messaging = true) => checkSendRules(steps, messaging)
  assert.deepEqual(s(skillJson().steps as SkillStep[]), [])
  assert.match(s([{ do: 'key', combo: 'return' }]).join(), /say whether this return sends/)
  assert.deepEqual(s([{ do: 'key', combo: 'return' }], false), [])
  assert.match(s([{ do: 'focusInput', hint: 'message' }, { do: 'paste', text: 'hi' }, { do: 'key', combo: 'return', send: false }]).join(), /must be "send": true/)
  assert.match(s([{ do: 'paste', text: 'hi' }, { do: 'readBack', text: 'hi' }, { do: 'key', combo: 'return', send: true }]).join(), /needs a "confirm"/)
  assert.match(s([{ do: 'confirm', question: 'ok?' }, { do: 'paste', text: 'hi' }, { do: 'key', combo: 'cmd+enter', send: true }]).join(), /needs a "readBack"/)
  // A Return that sends in an app not on the list, once the skill says it is a messaging app.
  const { errors } = parseSkill(skillJson({ steps: [{ do: 'focusInput', hint: 'message' }, { do: 'paste', text: '{text}' }, { do: 'key', combo: 'return' }] }), '', 'user')
  assert.match(errors.join(), /say whether/)
})

test('user skills: same name replaces a bundled one, bad ones are reported, code only loads when allowed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'deskmate-skills-'))
  const put = (dir: string, json: unknown, handler?: string) => {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'skill.json'), typeof json === 'string' ? json : JSON.stringify(json))
    if (handler) writeFileSync(join(root, dir, 'handler.mjs'), handler)
  }
  put('mine', { ...skillJson(), name: 'whatsapp-message', title: 'My WhatsApp' })
  put('broken', '{ "name": ')
  put('coded', skillJson({ name: 'coded-chat' }), 'export async function run(ctx) { return { say: "hi from code" } }')
  writeFileSync(join(root, 'stray.txt'), 'not a skill')

  const off = await loadSkills([{ dir: BUNDLED, source: 'bundled' }, { dir: root, source: 'user' }])
  assert.equal(off.skills.find((s) => s.name === 'whatsapp-message')?.title, 'My WhatsApp')
  assert.equal(off.skills.find((s) => s.name === 'whatsapp-message')?.source, 'user')
  assert.equal(off.skills.some((s) => s.name === 'coded-chat'), false)
  assert.match(JSON.stringify(off.problems), /not valid JSON/)
  assert.match(JSON.stringify(off.problems), /DESKMATE_SKILL_CODE=1/)

  const on = await loadSkills([{ dir: root, source: 'user' }], { allowUserCode: true })
  const coded = on.skills.find((s) => s.name === 'coded-chat') as Skill
  assert.equal(typeof coded.handler?.run, 'function')
  const hands = new FakeHands()
  const r = await runSkill(coded, { to: 'sam', text: 'hi' }, deps(hands))
  assert.deepEqual([r.ok, r.say], [true, 'hi from code'])
  assert.deepEqual(hands.input(), [])
})

// ---- running

test('WhatsApp: every key goes to WhatsApp, the yes comes before typing, and send is the last thing pressed', async () => {
  const wa = (await bundled()).find((s) => s.name === 'whatsapp-message') as Skill
  const hands = new FakeHands()
  const d = deps(hands)
  const r = await runSkill(wa, { to: 'Sam', text: 'running late' }, d)
  assert.equal(r.ok, true, r.say)
  assert.equal(r.say, 'Sent to Sam on WhatsApp.')
  assert.deepEqual(d.asked, ['Send "running late" to Sam on WhatsApp?'])
  const input = hands.input()
  for (const c of input) assert.equal(c.args.at(-1), 'net.whatsapp.WhatsApp', `${c.cmd} went to ${String(c.args.at(-1))}`)
  assert.deepEqual(
    input.map((c) => `${c.cmd} ${c.args[0]}`),
    ['key cmd+f', 'type Sam', 'key return', 'focusInput net.whatsapp.WhatsApp', 'paste running late', 'key return']
  )
  // the chat was looked for before the question, and the app brought back after it
  const order = hands.calls.map((c) => c.cmd)
  assert.ok(order.indexOf('locate') < order.lastIndexOf('launch'))
})

test('a no means nothing is typed into the chat and nothing is sent', async () => {
  const wa = (await bundled()).find((s) => s.name === 'whatsapp-message') as Skill
  const hands = new FakeHands()
  const r = await runSkill(wa, { to: 'Sam', text: 'running late' }, deps(hands, [false]))
  assert.deepEqual([r.ok, r.say], [false, 'Okay, not sent.'])
  assert.deepEqual(
    hands.input().map((c) => `${c.cmd} ${c.args[0]}`),
    ['key cmd+f', 'type Sam', 'key return']
  )
})

test('no chat found, or a read-back that fails, stops before sending', async () => {
  const wa = (await bundled()).find((s) => s.name === 'whatsapp-message') as Skill
  const lost = new FakeHands()
  lost.locateHits = false
  const r1 = await runSkill(wa, { to: 'Nobody', text: 'hi' }, deps(lost))
  assert.equal(r1.ok, false)
  assert.equal(r1.say, "I couldn't see a chat with Nobody in WhatsApp, so I didn't type anything.")
  assert.equal(lost.calls.some((c) => c.cmd === 'paste'), false)

  const dropped = new FakeHands()
  dropped.dropPaste = true
  dropped.box = { role: 'AXTextArea', value: 'something else' }
  const d = deps(dropped)
  const r2 = await runSkill(wa, { to: 'Sam', text: 'running late' }, d)
  assert.equal(r2.ok, false)
  assert.match(r2.say, /couldn't see it land in the box/)
  assert.equal(dropped.input().filter((c) => c.cmd === 'key' && c.args[0] === 'return').length, 1)
})

test('switching apps mid-run stops it; secrets are never typed', async () => {
  const tg = (await bundled()).find((s) => s.name === 'telegram-message') as Skill
  const hands = new FakeHands()
  hands.switchAwayOn = 'type'
  const r = await runSkill(tg, { to: 'Sam', text: 'hi' }, deps(hands))
  assert.equal(r.ok, false)
  assert.match(r.say, /switched apps/)
  assert.equal(hands.calls.some((c) => c.cmd === 'paste'), false)

  const clean = new FakeHands()
  const card = await runSkill(tg, { to: 'Sam', text: 'my card is 4111 1111 1111 1111' }, deps(clean))
  assert.equal(card.ok, false)
  assert.match(card.say, /password or a card number/)
  assert.deepEqual(clean.input(), [])
})

test('the window title check, and the app moving while she waited for the yes', async () => {
  const skill = make()
  const hands = new FakeHands()
  hands.title = '#general | Acme - Chatty'
  const r = await runSkill(skill, { to: 'general', text: 'standup moved' }, deps(hands))
  assert.equal(r.ok, true, r.say)
  assert.equal(r.say, 'Sent to #general.')
  assert.equal(r.where, '#general')

  const wrong = new FakeHands()
  wrong.title = '#random | Acme - Chatty'
  const r2 = await runSkill(skill, { to: 'general', text: 'standup moved' }, deps(wrong))
  assert.equal(r2.ok, false)
  assert.match(r2.say, /couldn't find general in Chatty/)
  assert.equal(wrong.calls.some((c) => c.cmd === 'paste'), false)

  const moved = new FakeHands()
  moved.title = '#general | Acme - Chatty'
  const d = deps(moved, [true])
  const confirm = d.confirm
  d.confirm = async (q) => {
    moved.title = '#random | Acme - Chatty'
    return confirm(q)
  }
  const r3 = await runSkill(skill, { to: 'general', text: 'standup moved' }, d)
  assert.equal(r3.ok, false)
  assert.match(r3.say, /moved off #general/)
  assert.equal(moved.calls.some((c) => c.cmd === 'paste'), false)
})

test('Notes: the handler tidies the text, the menu makes the note, no question asked', async () => {
  const notes = (await bundled()).find((s) => s.name === 'notes-new-note') as Skill
  const m = matchSkill([notes], 'make a note saying buy milk in notes')
  assert.deepEqual(m?.slots, { text: 'buy milk in notes' })
  const hands = new FakeHands()
  const d = deps(hands, [])
  const r = await runSkill(notes, m!.slots, d, 'make a note saying buy milk in notes')
  assert.equal(r.ok, true, r.say)
  assert.deepEqual(d.asked, [])
  assert.deepEqual(
    hands.input().map((c) => [c.cmd, c.args[0] === 'com.apple.Notes' ? c.args[1] : c.args[0]]),
    [
      ['menu', ['File', 'New Note']],
      ['paste', 'Buy milk']
    ]
  )
})

test('a greyed-out menu item stops the skill with a plain reason', async () => {
  const notes = (await bundled()).find((s) => s.name === 'notes-new-note') as Skill
  const hands = new FakeHands()
  hands.pressMenu = async () => {
    throw Object.assign(new Error('menu_item_missing: File > New Note'), { code: 'menu_item_missing' })
  }
  const r = await runSkill(notes, { text: 'buy milk' }, deps(hands, []))
  assert.equal(r.ok, false)
  assert.match(r.say, /File › New Note isn't available in Notes right now/)
  assert.equal(hands.calls.some((c) => c.cmd === 'paste'), false)
})

test('a handler is held to the same rules: no send without a yes, no Return after typing', async () => {
  const sneaky = make({ name: 'sneaky' })
  sneaky.handler = {
    run: async (ctx) => {
      await ctx.hands.paste(ctx.slots.text)
      await ctx.send()
    }
  }
  const h1 = new FakeHands()
  h1.front = 'com.example.chatty'
  const r1 = await runSkill(sneaky, { to: 'sam', text: 'hi' }, deps(h1))
  assert.equal(r1.ok, false)
  assert.match(r1.summary, /no confirm/)
  assert.equal(h1.calls.some((c) => c.cmd === 'key'), false)

  const sneakier = make({ name: 'sneakier' })
  sneakier.handler = {
    run: async (ctx) => {
      await ctx.hands.paste(ctx.slots.text)
      await ctx.hands.key('return')
    }
  }
  const h2 = new FakeHands()
  h2.front = 'com.example.chatty'
  const r2 = await runSkill(sneakier, { to: 'sam', text: 'hi' }, deps(h2))
  assert.equal(r2.ok, false)
  assert.match(r2.say, /without your yes/)
  assert.equal(h2.calls.some((c) => c.cmd === 'key'), false)

  const polite = make({ name: 'polite' })
  polite.handler = {
    run: async (ctx) => {
      await ctx.hands.launch()
      if (!(await ctx.confirm(`Send ${ctx.slots.text}?`))) return { say: 'fine' }
      await ctx.run([{ do: 'focusInput', hint: 'message' }, { do: 'paste', text: '{text}' }, { do: 'readBack', text: '{text}' }])
      await ctx.send()
      return { say: 'sent it' }
    }
  }
  const h3 = new FakeHands()
  const r3 = await runSkill(polite, { to: 'sam', text: 'hi' }, deps(h3))
  assert.deepEqual([r3.ok, r3.say], [true, 'sent it'])
  assert.deepEqual(h3.input().at(-1), { cmd: 'key', args: ['return', 'com.example.chatty'] })
})

test('read-backs off (DESKMATE_CONFIRM_SENDS=never) skips the question but not the box check', async () => {
  const skill = make()
  const hands = new FakeHands()
  hands.title = 'general - Chatty'
  const d = deps(hands, [], { confirmSends: false })
  const r = await runSkill(skill, { to: 'general', text: 'hi' }, d)
  assert.equal(r.ok, true, r.say)
  assert.deepEqual(d.asked, [])
})

test('on Windows the app is its process name; not installed is said plainly', async () => {
  const wa = (await bundled()).find((s) => s.name === 'whatsapp-message') as Skill
  assert.equal(appIdFor(wa.app, 'win32'), 'WhatsApp')
  assert.equal(appIdFor(wa.app, 'darwin'), 'net.whatsapp.WhatsApp')
  const hands = new FakeHands()
  const r = await runSkill(wa, { to: 'Sam', text: 'hi' }, deps(hands, [true], { platform: 'win32' }))
  assert.equal(r.ok, true, r.say)
  for (const c of hands.input()) assert.equal(c.args.at(-1), 'WhatsApp')

  const none = new FakeHands()
  none.installedApps.clear()
  const r2 = await runSkill(wa, { to: 'Sam', text: 'hi' }, deps(none))
  assert.deepEqual([r2.ok, r2.say], [false, "WhatsApp isn't installed here."])
})

test('skills as Claude tools and as planner lines', async () => {
  const wa = (await bundled()).find((s) => s.name === 'whatsapp-message') as Skill
  assert.equal(skillToolName(wa), 'skill_whatsapp_message')
  const t = skillTool(wa)
  assert.deepEqual(t.input_schema.required, ['to', 'text'])
  assert.match(t.description, /asks the user before anything is sent/)
  assert.equal(exampleFor(wa), 'whatsapp: message <to>: <text>')
  assert.equal(matchSkill([wa], 'whatsapp: message the night shift: see you at 6')?.slots.to, 'night shift')
  const notes = (await bundled()).find((s) => s.name === 'notes-new-note') as Skill
  assert.equal(exampleFor(notes), 'notes: <text>')
})
