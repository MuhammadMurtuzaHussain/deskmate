import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// The .ts extension lets `npm test` load this file straight from Node; the bundler takes it either way.
import { boxHolds, chatLabel, DENY_APPS, EDITABLE_ROLES, MESSAGING_APPS, NEVER_TYPE, SEND_KEY, titleMatches } from './checks.ts'
import type { DesktopHands, FocusedElement } from './hands'

/**
 * Skills: app routines anyone can add without touching the core. A skill is a folder with a skill.json (a name, the
 * app, trigger phrases with slots like {to} and {text}, and steps made of her hands' primitives) and, optionally, a
 * handler for what a recipe can't say. Skills load from skills/ in the app and from <user data>/skills; a phrase that
 * matches a trigger runs the skill, the Claude agent gets each skill as a tool, and the planner can hand a step to one.
 *
 * The safety rules are the runner's, not the recipe's: keys only ever go to the skill's own app (refused if anything
 * else is in front), off-limits apps can't be targets, nothing that looks like a password or card number is typed,
 * and in a messaging app the Return after the message is a "send" step, which only runs after a spoken yes and a
 * read-back that the box holds exactly the text.
 */

export type SkillStep =
  /** open the app, or bring it to the front; waits `waitMs` (default 3000) more on a cold start */
  | { do: 'launch'; waitMs?: number }
  /** a chord such as "cmd+f", "down", "return"; `send: true` marks the key that sends to other people */
  | { do: 'key'; combo: string; send?: boolean }
  | { do: 'type'; text: string }
  /** through the clipboard, which is put back afterwards */
  | { do: 'paste'; text: string }
  /** puts the caret in the text box labelled `hint` ("message"; none: the last one), unless a text box already has it */
  | { do: 'focusInput'; hint?: string }
  /** the app's window title must hold every word of `contains`, within `timeoutMs` (default 2500) */
  | { do: 'checkTitle'; contains: string; timeoutMs?: number; fail?: string }
  /** a menu-bar item by its titles, matched from the end: ["New Note"] or ["File", "New Note"] */
  | { do: 'menu'; path: string[] }
  /** something on screen in the app's window whose name or value matches `text`, within `timeoutMs` (default 2500) */
  | { do: 'locate'; text: string; timeoutMs?: number; fail?: string }
  | { do: 'wait'; ms: number }
  /** reads the question out and waits for a yes; a no ends the skill */
  | { do: 'confirm'; question: string; no?: string }
  /** the focused text box must hold `text` before going on */
  | { do: 'readBack'; text: string }

export type StepKind = SkillStep['do']
export const STEP_KINDS: StepKind[] = ['launch', 'key', 'type', 'paste', 'focusInput', 'checkTitle', 'menu', 'locate', 'wait', 'confirm', 'readBack']

export interface SkillSlot {
  name: string
  /** what goes in it, for the agent and the planner ("the person or group") */
  description: string
  optional?: boolean
}

export interface SkillApp {
  name: string
  /** macOS bundle id */
  bundleId: string
  /** the process name on Windows ("WhatsApp"), for the experimental Windows hands */
  windows?: string
  /** treat it as an app where Return sends to other people even if it isn't on the built-in list */
  messaging?: boolean
}

export interface SkillContext {
  slots: Record<string, string>
  /** the app as her hands name it on this OS */
  app: string
  /** runs recipe steps inside this run, under the same rules */
  run(steps: SkillStep[]): Promise<void>
  /** the same hands, held to the skill's app: every key, paste and menu is refused unless that app is in front */
  hands: SkillHands
  /** presses the send key, only after a yes and a passing read-back */
  send(combo?: string): Promise<void>
  confirm(question: string): Promise<boolean>
  step(label: string): void
  log(line: string): void
}

export interface SkillHands {
  launch(): Promise<{ wasRunning: boolean }>
  key(combo: string): Promise<void>
  type(text: string): Promise<void>
  paste(text: string): Promise<void>
  focusInput(hint: string): Promise<FocusedElement | null>
  focused(): Promise<FocusedElement | null>
  windowTitle(): Promise<string | null>
  menu(path: string[]): Promise<string[]>
  locate(text: string): Promise<boolean>
}

/** What a skill's handler file may export (all optional). */
export interface SkillHandler {
  /** fixes or fills the slots before the run (null refuses: "I can't do that one") */
  slots?(slots: Record<string, string>, said: string): Record<string, string> | null | Promise<Record<string, string> | null>
  /** does the work instead of the recipe's steps; may return the line she says */
  run?(ctx: SkillContext): Promise<{ say?: string } | void>
}

export interface Skill {
  /** unique id, lower-case with dashes ("whatsapp-message") */
  name: string
  title: string
  description: string
  app: SkillApp
  slots: SkillSlot[]
  triggers: string[]
  steps: SkillStep[]
  /** her line when it worked, with slots ("Sent to {to}.") */
  done: string
  source: 'bundled' | 'user'
  dir: string
  handler?: SkillHandler
  patterns: RegExp[]
}

export interface SkillMatch {
  skill: Skill
  slots: Record<string, string>
}

export interface SkillResult {
  ok: boolean
  say: string
  summary: string
  where?: string
}

// ---- triggers

const SLOT_NAME = /^[a-z][a-z0-9_]{0,23}$/
const POLITE = String.raw`^(?:(?:hey|ok|okay|so)[,]?\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?`

/**
 * A trigger phrase as a regular expression. The phrase language is small: {slot} captures words, (a|b) is one of
 * several, [words] is optional, and anything else is matched as written, case-insensitive, with any run of spaces
 * matching any run of spaces. "(message|text) {to} on whatsapp[:] {text}" matches "Message Sam on WhatsApp: hi".
 */
export function compileTrigger(trigger: string): { patterns: RegExp[]; slots: string[] } {
  const slots: string[] = []
  let i = 0
  const src = trigger.trim()

  const fail = (why: string): never => {
    throw new Error(`trigger "${trigger}": ${why}`)
  }
  type Node = { kind: 'lit'; text: string } | { kind: 'ws' } | { kind: 'slot'; name: string } | { kind: 'opt'; body: Node[][] } | { kind: 'alt'; body: Node[][] }

  // seq := (lit | ws | {slot} | [alts] | (alts))*, alts := seq ('|' seq)*
  const parseAlts = (close: string): Node[][] => {
    const alts: Node[][] = [[]]
    while (i < src.length) {
      const c = src[i]
      if (c === close) {
        i++
        return alts
      }
      if (c === '|') {
        if (!close) fail('"|" outside (…) or […]')
        i++
        alts.push([])
        continue
      }
      alts[alts.length - 1].push(parseOne())
    }
    if (close) fail(`missing "${close}"`)
    return alts
  }
  const parseOne = (): Node => {
    const c = src[i]
    if (/\s/.test(c)) {
      while (i < src.length && /\s/.test(src[i])) i++
      return { kind: 'ws' }
    }
    if (c === '{') {
      const end = src.indexOf('}', i)
      if (end < 0) fail('missing "}"')
      const name = src.slice(i + 1, end).trim()
      if (!SLOT_NAME.test(name)) fail(`bad slot name "${name}"`)
      if (slots.includes(name)) fail(`slot {${name}} used twice`)
      slots.push(name)
      i = end + 1
      return { kind: 'slot', name }
    }
    if (c === '[') {
      i++
      return { kind: 'opt', body: parseAlts(']') }
    }
    if (c === '(') {
      i++
      return { kind: 'alt', body: parseAlts(')') }
    }
    if (c === ']' || c === ')' || c === '}') fail(`unexpected "${c}"`)
    let text = ''
    while (i < src.length && !/[\s{}[\]()|]/.test(src[i])) text += src[i++]
    return { kind: 'lit', text }
  }

  // Optional parts become variants of the phrase, tried with the parts in first: in "tell {to} [that] {text}", the
  // variant with "that" is what lets {to} be more than one word.
  const expandSeq = (seq: Node[]): Node[][] => {
    let variants: Node[][] = [[]]
    for (const n of seq) {
      const options: Node[][] =
        n.kind === 'opt' ? [[{ kind: 'alt', body: n.body.flatMap(expandSeq) }], []] : n.kind === 'alt' ? [[{ kind: 'alt', body: n.body.flatMap(expandSeq) }]] : [[n]]
      variants = variants.flatMap((v) => options.map((o) => [...v, ...o]))
      if (variants.length > 64) fail('too many optional parts')
    }
    // A part left out leaves two spaces side by side, or one at an end.
    return variants.map((v) => v.filter((n, k) => n.kind !== 'ws' || (k > 0 && k < v.length - 1 && v[k - 1].kind !== 'ws')))
  }
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const emitSeq = (seq: Node[]): string =>
    seq
      .map((n) => (n.kind === 'lit' ? escape(n.text) : n.kind === 'ws' ? '\\s+' : n.kind === 'slot' ? `(?<${n.name}>.+?)` : n.kind === 'alt' ? `(?:${n.body.map(emitSeq).join('|')})` : ''))
      .join('')

  const variants = expandSeq(parseAlts('')[0]).filter((v) => v.length)
  if (!variants.length) fail('empty')
  return { patterns: variants.map((v) => new RegExp(`${POLITE}${emitSeq(v)}[\\s.!?]*$`, 'iu')), slots }
}

function unquote(s: string): string {
  return s.trim().replace(/^["“'‘](.*)["”'’]$/su, '$1').trim()
}

/** A slot value as said: quotes off, and for a person or chat ("to") "the", "my" and "@" off too. */
export function cleanSlot(name: string, value: string): string {
  let v = unquote(value.replace(/\s+/g, ' '))
  if (name === 'to' || name === 'chat' || name === 'who') v = v.replace(/^(?:the|my|our)\s+/i, '').replace(/^@/, '').replace(/\s+(?:chat|conversation)$/i, '')
  return v.replace(/[,;:]+$/, '').trim()
}

/** {slot} in a step's text replaced with the slot's value; slots that aren't set become empty. */
export function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, name: string) => slots[name] ?? '')
}

/** The first skill whose trigger the sentence matches, with its slots, or null. */
export function matchSkill(skills: Skill[], said: string): SkillMatch | null {
  const text = said.replace(/\s+/g, ' ').trim()
  if (!text) return null
  for (const skill of skills) {
    for (const re of skill.patterns) {
      const m = re.exec(text)
      if (!m) continue
      const slots: Record<string, string> = {}
      for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) slots[k] = cleanSlot(k, v)
      if (skill.slots.every((s) => s.optional || slots[s.name])) return { skill, slots }
    }
  }
  return null
}

// ---- loading and checking

const STEP_FIELDS: Record<StepKind, Record<string, 'string' | 'number' | 'boolean' | 'string[]'>> = {
  launch: { waitMs: 'number' },
  key: { combo: 'string', send: 'boolean' },
  type: { text: 'string' },
  paste: { text: 'string' },
  focusInput: { hint: 'string' },
  checkTitle: { contains: 'string', timeoutMs: 'number', fail: 'string' },
  menu: { path: 'string[]' },
  locate: { text: 'string', timeoutMs: 'number', fail: 'string' },
  wait: { ms: 'number' },
  confirm: { question: 'string', no: 'string' },
  readBack: { text: 'string' }
}
const REQUIRED: Partial<Record<StepKind, string[]>> = {
  key: ['combo'],
  type: ['text'],
  paste: ['text'],
  checkTitle: ['contains'],
  menu: ['path'],
  locate: ['text'],
  wait: ['ms'],
  confirm: ['question'],
  readBack: ['text']
}

const isType = (v: unknown, t: string): boolean => (t === 'string[]' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === t)

export function isMessagingApp(app: SkillApp): boolean {
  return Boolean(app.messaging) || MESSAGING_APPS.has(app.bundleId)
}

/**
 * Checks the safety shape of a step list. In a messaging app every Return or Enter must say whether it sends
 * ("send": true) or only opens something, such as a search result ("send": false), and once text has gone into a box
 * reached with focusInput (the message box), Return there can only be a send. A send step needs a confirm before it
 * and a read-back after the last text entered. Returns the problems, empty when it is fine.
 */
export function checkSendRules(steps: SkillStep[], messaging: boolean): string[] {
  const errors: string[] = []
  let confirmed = false
  let inBox = false
  let boxText = false
  let unread = false
  steps.forEach((s, n) => {
    const at = `step ${n + 1}`
    if (s.do === 'confirm') confirmed = true
    if (s.do === 'focusInput') inBox = true
    if (s.do === 'type' || s.do === 'paste') {
      unread = true
      if (inBox) boxText = true
    }
    if (s.do === 'readBack') unread = false
    if (s.do !== 'key') return
    const sendKey = SEND_KEY.test(String(s.combo ?? '').toLowerCase().replace(/\s+/g, ''))
    if (messaging && sendKey && s.send === undefined) errors.push(`${at}: in a messaging app, say whether this ${s.combo} sends ("send": true) or only opens something ("send": false)`)
    if (messaging && sendKey && s.send === false && boxText) errors.push(`${at}: ${s.combo} after typing in the message box sends it; it must be "send": true`)
    if (s.send) {
      if (!confirmed) errors.push(`${at}: a send step needs a "confirm" step before it`)
      if (unread) errors.push(`${at}: a send step needs a "readBack" step after the text is entered`)
    }
  })
  return errors
}

/** A skill.json made into a skill, or the reasons it can't be one. */
export function parseSkill(raw: unknown, dir: string, source: Skill['source']): { skill?: Skill; errors: string[] } {
  const errors: string[] = []
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const name = str(o.name)
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(name)) errors.push('"name" must be 2–48 lower-case letters, digits or dashes')
  const appRaw = (o.app && typeof o.app === 'object' ? o.app : {}) as Record<string, unknown>
  const app: SkillApp = { name: str(appRaw.name), bundleId: str(appRaw.bundleId) }
  if (str(appRaw.windows)) app.windows = str(appRaw.windows)
  if (appRaw.messaging === true) app.messaging = true
  if (!app.name) errors.push('"app.name" is missing')
  if (!app.bundleId) errors.push('"app.bundleId" is missing')
  if (DENY_APPS.has(app.bundleId)) errors.push(`${app.bundleId} is off limits for skills`)

  const slots: SkillSlot[] = []
  for (const s of Array.isArray(o.slots) ? o.slots : []) {
    const r = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
    const slot: SkillSlot = { name: str(r.name), description: str(r.description) || str(r.name) }
    if (r.optional === true) slot.optional = true
    if (!SLOT_NAME.test(slot.name)) errors.push(`bad slot name "${slot.name}"`)
    else if (slots.some((x) => x.name === slot.name)) errors.push(`slot "${slot.name}" declared twice`)
    else slots.push(slot)
  }
  const declared = new Set(slots.map((s) => s.name))

  const triggers = (Array.isArray(o.triggers) ? o.triggers : []).filter((t): t is string => typeof t === 'string' && t.trim() !== '')
  if (!triggers.length) errors.push('"triggers" needs at least one phrase')
  const patterns: RegExp[] = []
  for (const t of triggers) {
    try {
      const { patterns: res, slots: used } = compileTrigger(t)
      for (const u of used) if (!declared.has(u)) errors.push(`trigger "${t}" uses {${u}}, which isn't in "slots"`)
      for (const s of slots) if (!s.optional && !used.includes(s.name)) errors.push(`trigger "${t}" leaves out the required slot {${s.name}}`)
      patterns.push(...res)
    } catch (err) {
      errors.push((err as Error).message)
    }
  }

  const steps: SkillStep[] = []
  const rawSteps = Array.isArray(o.steps) ? o.steps : []
  if (!rawSteps.length && !existsHandler(dir)) errors.push('"steps" is empty (and there is no handler)')
  rawSteps.forEach((s, n) => {
    const r = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
    const kind = r.do as StepKind
    if (!STEP_KINDS.includes(kind)) {
      errors.push(`step ${n + 1}: unknown "do": ${JSON.stringify(r.do)} (one of ${STEP_KINDS.join(', ')})`)
      return
    }
    const fields = STEP_FIELDS[kind]
    for (const k of Object.keys(r)) {
      if (k === 'do' || k === 'note') continue
      if (!(k in fields)) errors.push(`step ${n + 1} (${kind}): unknown field "${k}"`)
      else if (!isType(r[k], fields[k])) errors.push(`step ${n + 1} (${kind}): "${k}" must be ${fields[k]}`)
    }
    for (const k of REQUIRED[kind] ?? []) if (r[k] === undefined || r[k] === '') errors.push(`step ${n + 1} (${kind}): "${k}" is missing`)
    for (const v of Object.values(r).flat()) {
      if (typeof v !== 'string') continue
      for (const m of v.matchAll(/\{([^}]*)\}/g)) if (!declared.has(m[1])) errors.push(`step ${n + 1} (${kind}): {${m[1]}} isn't in "slots"`)
    }
    const { note: _note, ...step } = r
    steps.push(step as SkillStep)
  })
  errors.push(...checkSendRules(steps, isMessagingApp(app)))
  if (errors.length) return { errors }
  return {
    skill: {
      name,
      title: str(o.title) || name,
      description: str(o.description) || str(o.title) || name,
      app,
      slots,
      triggers,
      steps,
      done: str(o.done) || 'Done.',
      source,
      dir,
      patterns
    },
    errors
  }
}

const HANDLER_FILES = ['handler.mjs', 'handler.js', 'handler.cjs', 'handler.ts']

function existsHandler(dir: string): string | null {
  for (const f of HANDLER_FILES) if (dir && existsSync(join(dir, f))) return join(dir, f)
  return null
}

export interface SkillLoad {
  skills: Skill[]
  /** folders that did not load, and why (shown in the log and the tray) */
  problems: { dir: string; errors: string[] }[]
}

/**
 * Every skill in the given folders, each a sub-folder with a skill.json. A user skill with the same name as a bundled
 * one replaces it. Handlers in bundled skills always load; a user skill's handler is code from outside the app, so it
 * only loads with `allowUserCode` (DESKMATE_SKILL_CODE=1), and the skill is left out otherwise.
 */
export async function loadSkills(roots: { dir: string; source: Skill['source'] }[], opts: { allowUserCode?: boolean } = {}): Promise<SkillLoad> {
  const byName = new Map<string, Skill>()
  const problems: SkillLoad['problems'] = []
  for (const root of roots) {
    if (!existsSync(root.dir)) continue
    for (const entry of readdirSync(root.dir).sort()) {
      const dir = join(root.dir, entry)
      const file = join(dir, 'skill.json')
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (err) {
        problems.push({ dir, errors: [`skill.json is not valid JSON: ${(err as Error).message}`] })
        continue
      }
      const { skill, errors } = parseSkill(raw, dir, root.source)
      if (!skill) {
        problems.push({ dir, errors })
        continue
      }
      const handlerFile = existsHandler(dir)
      if (handlerFile) {
        if (root.source === 'user' && !opts.allowUserCode) {
          problems.push({ dir, errors: ['has a handler (code); user skills with code only load with DESKMATE_SKILL_CODE=1'] })
          continue
        }
        try {
          const mod = (await import(pathToFileURL(handlerFile).href)) as { default?: SkillHandler } & SkillHandler
          const h = mod.default ?? mod
          skill.handler = { slots: typeof h.slots === 'function' ? h.slots : undefined, run: typeof h.run === 'function' ? h.run : undefined }
        } catch (err) {
          problems.push({ dir, errors: [`handler did not load: ${(err as Error).message}`] })
          continue
        }
      }
      byName.set(skill.name, skill)
    }
  }
  return { skills: [...byName.values()], problems }
}

// ---- running

export interface SkillDeps {
  hands: DesktopHands
  /** which OS her hands are on (process.platform); picks the app id */
  platform?: string
  /** reads the question out and waits for a yes */
  confirm(question: string): Promise<boolean>
  /** false only when they turned read-backs off (DESKMATE_CONFIRM_SENDS=never) */
  confirmSends: boolean
  onStep(text: string): void
  log(line: string): void
  stopped(): boolean
  /** for tests: waits that don't wait */
  sleep?(ms: number): Promise<void>
}

/** The app as her hands name it: the bundle id on macOS, the process name on Windows. */
export function appIdFor(app: SkillApp, platform: string = process.platform): string {
  return platform === 'win32' ? app.windows || app.name : app.bundleId
}

class SkillStop extends Error {
  readonly say: string
  readonly summary: string
  constructor(say: string, summary: string) {
    super(summary)
    this.say = say
    this.summary = summary
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** One run of a skill: the step machine and the state its safety rules need. */
class SkillRun {
  private confirmed = false
  /** text was typed or pasted and no read-back has passed since */
  private unread = false
  /** any text typed or pasted in this run */
  private entered = false
  /** the caret was put in a text box with focusInput (the message box), and text since then */
  private inBox = false
  private boxText = false
  private lastTitle: string | null = null
  where: string | undefined
  readonly id: string
  readonly messaging: boolean
  readonly skill: Skill
  readonly slots: Record<string, string>
  readonly deps: SkillDeps

  constructor(skill: Skill, slots: Record<string, string>, deps: SkillDeps) {
    this.skill = skill
    this.slots = slots
    this.deps = deps
    this.id = appIdFor(skill.app, deps.platform)
    this.messaging = isMessagingApp(skill.app)
  }

  private wait(ms: number): Promise<void> {
    return (this.deps.sleep ?? sleep)(ms)
  }

  step(label: string): void {
    if (this.deps.stopped()) throw new SkillStop('Stopped.', 'stopped by the user')
    this.deps.onStep(`${this.skill.app.name} · ${label}`)
    this.deps.log(label)
  }

  private stop(say: string, summary = say): never {
    throw new SkillStop(say, summary)
  }

  private guardText(text: string): void {
    if (NEVER_TYPE.test(text)) this.stop("That looks like a password or a card number, so I won't type it. You'll have to.", 'refused: secret-looking text')
  }

  async launch(): Promise<{ wasRunning: boolean }> {
    const r = await this.deps.hands.launch(this.id)
    this.deps.log(`launched pid ${r.pid} in ${r.ms} ms${r.wasRunning ? '' : ' (cold start)'}`)
    return { wasRunning: r.wasRunning }
  }

  /** `from`: a recipe step (its "send" flag already checked by checkSendRules) or a handler's own key press. */
  async key(combo: string, send = false, from: 'step' | 'handler' = 'step'): Promise<void> {
    const c = combo.toLowerCase().replace(/\s+/g, '')
    if (send) {
      if (!this.confirmed) this.stop("I didn't get your yes, so I didn't send it.", 'send refused: no confirm in this run')
      if (this.unread) this.stop("I couldn't check what's in the box, so I didn't send it.", 'send refused: no read-back since the text went in')
    } else if (this.messaging && SEND_KEY.test(c) && (from === 'handler' ? this.entered : this.boxText)) {
      this.stop("That would send the message without your yes, so I didn't press it.", `refused ${c}: in a messaging app, Return after typing is only allowed as a send`)
    }
    await this.deps.hands.key(c, this.id)
  }

  async type(text: string, paste: boolean): Promise<void> {
    this.guardText(text)
    if (paste) await this.deps.hands.paste(text, this.id)
    else await this.deps.hands.type(text, this.id)
    this.entered = true
    this.unread = true
    if (this.inBox) this.boxText = true
  }

  async focusInput(hint: string): Promise<FocusedElement | null> {
    const focus = await this.deps.hands.focused(this.id).catch(() => null)
    let box: FocusedElement | null = focus?.role && EDITABLE_ROLES.has(focus.role) ? focus : null
    if (!box) {
      box = await this.deps.hands.focusInput(this.id, hint, this.id).catch((err: Error) => {
        this.deps.log(`no text box labelled "${hint}": ${err.message}`)
        return null
      })
      if (box) await this.wait(150)
    }
    if (box) this.inBox = true
    return box
  }

  async readBack(text: string): Promise<void> {
    await this.wait(250)
    const box = await this.deps.hands.focused(this.id).catch(() => null)
    this.deps.log(`read-back: ${JSON.stringify(box)}`)
    if (!box || !boxHolds(box, text)) this.stop(`I couldn't see it land in the box in ${this.skill.app.name}, so I stopped there.`, 'read-back failed')
    this.unread = false
  }

  async ask(question: string, no?: string): Promise<boolean> {
    if (!this.deps.confirmSends) {
      this.deps.log(`confirm skipped (read-backs are off): ${question}`)
      this.confirmed = true
      return true
    }
    this.step('waiting for your yes')
    const yes = await this.deps.confirm(question)
    if (!yes) this.stop(no ?? 'Okay, I left it.', `${this.skill.name}: they said no`)
    // They may have used the computer while she waited: bring the app back and check it is still where it was.
    await this.deps.hands.launch(this.id)
    if (this.lastTitle) {
      const title = await this.deps.hands.windowTitle(this.id).catch(() => null)
      if (!titleMatches(this.lastTitle, title)) this.stop(`${this.skill.app.name} moved off ${this.where ?? this.lastTitle} while I waited, so I stopped.`, `window changed before going on (${title ?? 'unknown'})`)
    }
    this.confirmed = true
    return true
  }

  async exec(s: SkillStep): Promise<void> {
    const f = (t: string): string => fill(t, this.slots)
    const { hands } = this.deps
    switch (s.do) {
      case 'launch': {
        this.step('opening')
        const r = await this.launch()
        if (!r.wasRunning) await this.wait(Math.min(s.waitMs ?? 3000, 15_000))
        return
      }
      case 'key':
        this.step(s.send ? 'sending' : `pressing ${s.combo}`)
        await this.key(f(s.combo), s.send)
        await this.wait(s.send ? 600 : 250)
        return
      case 'type':
      case 'paste':
        this.step(`typing`)
        await this.type(f(s.text), s.do === 'paste')
        await this.wait(300)
        return
      case 'focusInput':
        if (!(await this.focusInput(f(s.hint ?? '')))) this.stop(`I couldn't get into the text box in ${this.skill.app.name}, so I didn't type anything.`, `no text box "${f(s.hint ?? '')}"`)
        return
      case 'checkTitle': {
        const want = f(s.contains)
        this.step(`checking it's ${want}`)
        let title: string | null = null
        for (let tries = Math.ceil((s.timeoutMs ?? 2500) / 300); ; tries--) {
          title = await hands.windowTitle(this.id).catch(() => null)
          if (titleMatches(want, title) || tries <= 0) break
          await this.wait(300)
        }
        this.deps.log(`window title: ${JSON.stringify(title)}`)
        if (!titleMatches(want, title)) {
          this.stop(s.fail ? f(s.fail) : `I couldn't find ${want} in ${this.skill.app.name}, so I left it alone.`, `window title ${JSON.stringify(title)} does not show "${want}"`)
        }
        this.lastTitle = want
        this.where = chatLabel(title as string, this.skill.app.name)
        return
      }
      case 'menu': {
        const path = s.path.map(f)
        this.step(`menu ${path.join(' › ')}`)
        const pressed = await hands.pressMenu(this.id, path, this.id).catch((err: Error & { code?: string }) => {
          // Missing or greyed out: a welcome screen, a sheet or a dialog is usually in the way.
          if (err.code === 'focus_changed') throw err
          return this.stop(`${path.join(' › ')} isn't available in ${this.skill.app.name} right now (a dialog or welcome screen may be in the way), so I stopped.`, `menu ${path.join(' > ')}: ${err.message}`)
        })
        this.deps.log(`menu: ${pressed.join(' > ')}`)
        await this.wait(500)
        return
      }
      case 'locate': {
        const want = f(s.text)
        this.step(`looking for ${want}`)
        for (let tries = Math.ceil((s.timeoutMs ?? 2500) / 300); ; tries--) {
          const rect = await hands.locate(this.id, want).catch(() => null)
          if (rect) return
          if (tries <= 0) break
          await this.wait(300)
        }
        this.stop(s.fail ? f(s.fail) : `I couldn't see ${want} in ${this.skill.app.name}, so I stopped.`, `"${want}" not found on screen`)
        return
      }
      case 'wait':
        await this.wait(Math.min(s.ms, 10_000))
        return
      case 'confirm':
        await this.ask(f(s.question), s.no ? f(s.no) : undefined)
        return
      case 'readBack':
        await this.readBack(f(s.text))
        return
    }
  }

  context(): SkillContext {
    return {
      slots: this.slots,
      app: this.id,
      run: async (steps) => {
        const problems = checkSendRules(steps, this.messaging)
        if (problems.length) this.stop("That skill tried to send without asking, so I stopped it.", `handler steps refused: ${problems.join('; ')}`)
        for (const s of steps) await this.exec(s)
      },
      hands: {
        launch: () => this.launch(),
        key: (combo) => this.key(combo, false, 'handler'),
        type: (text) => this.type(text, false),
        paste: (text) => this.type(text, true),
        focusInput: (hint) => this.focusInput(hint),
        focused: () => this.deps.hands.focused(this.id),
        windowTitle: () => this.deps.hands.windowTitle(this.id),
        menu: (path) => this.deps.hands.pressMenu(this.id, path, this.id),
        locate: async (text) => Boolean(await this.deps.hands.locate(this.id, text).catch(() => null))
      },
      send: (combo = 'return') => this.key(combo, true),
      confirm: (question) => this.ask(question).catch((err) => (err instanceof SkillStop ? false : Promise.reject(err))),
      step: (label) => this.step(label),
      log: (line) => this.deps.log(line)
    }
  }
}

/** Runs a skill with its slots: the handler's run() if it has one, else the recipe's steps, under the rules above. */
export async function runSkill(skill: Skill, slotsIn: Record<string, string>, deps: SkillDeps, said = ''): Promise<SkillResult> {
  const fail = (say: string, summary = say): SkillResult => {
    deps.log(`failed: ${summary}`)
    return { ok: false, say, summary: `${skill.title}: ${summary}` }
  }
  let slots = { ...slotsIn }
  try {
    if (skill.handler?.slots) {
      const fixed = await skill.handler.slots(slots, said)
      if (!fixed) return fail(`I can't do that one with ${skill.title}.`, 'the handler refused the slots')
      slots = fixed
    }
    for (const s of skill.slots) if (!s.optional && !slots[s.name]?.trim()) return fail(`I need ${s.description.toLowerCase()} for that.`, `missing slot ${s.name}`)
    for (const [k, v] of Object.entries(slots)) if (NEVER_TYPE.test(v)) return fail("That looks like a password or a card number, so I won't type it. You'll have to.", `refused: slot ${k} looks secret`)
    const run = new SkillRun(skill, slots, deps)
    deps.log(`skill ${skill.name} (${skill.source}) with ${JSON.stringify(slots)} → ${run.id}`)
    if (!(await deps.hands.installed(run.id).catch(() => true))) return fail(`${skill.app.name} isn't installed here.`, `${run.id} not installed`)
    let say: string | undefined
    if (skill.handler?.run) say = (await skill.handler.run(run.context()))?.say
    else for (const s of skill.steps) await run.exec(s)
    const line = say ?? fill(skill.done, { ...slots, where: run.where ?? slots.to ?? '' })
    deps.log(`done: ${line}`)
    return { ok: true, say: line, summary: `${skill.title}: ${JSON.stringify(slots).slice(0, 160)}`, ...(run.where ? { where: run.where } : {}) }
  } catch (err) {
    if (err instanceof SkillStop) return fail(err.say, err.summary)
    const code = (err as { code?: string }).code
    if (code === 'focus_changed') return fail(`You switched apps, so I stopped before pressing anything in ${skill.app.name}.`, (err as Error).message)
    if (code === 'not_installed') return fail(`${skill.app.name} isn't installed here.`, (err as Error).message)
    if (code === 'no_window' || code === 'launch_timeout') return fail(`${skill.app.name} didn't show a window I could use (it may be on another desktop). Try again once it's up.`, (err as Error).message)
    return fail(`${skill.app.name} gave me trouble: ${(err as Error).message.slice(0, 120)}`, `error: ${(err as Error).message}`)
  }
}

// ---- for the agent and the planner

/** A tool name for the Claude agent: "skill_whatsapp_message". */
export function skillToolName(skill: Skill): string {
  return `skill_${skill.name.replace(/-/g, '_')}`.slice(0, 64)
}

/** The skill as a Claude tool: its slots are the inputs (strings; optional ones may be empty). */
export function skillTool(skill: Skill): { name: string; description: string; strict: true; input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false } } {
  const properties: Record<string, unknown> = {}
  for (const s of skill.slots) properties[s.name] = { type: 'string', description: `${s.description}${s.optional ? ' (may be empty)' : ''}` }
  const confirms = skill.steps.some((s) => s.do === 'confirm') || Boolean(skill.handler)
  return {
    name: skillToolName(skill),
    description: `${skill.description} (${skill.app.name}). A ready-made routine: prefer it over driving ${skill.app.name} by hand.${confirms ? ' It asks the user before anything is sent.' : ''}`,
    strict: true,
    input_schema: { type: 'object', properties, required: skill.slots.map((s) => s.name), additionalProperties: false }
  }
}

/** One line per skill for the planner: what it does and how to word a step's input so it matches. */
export function skillsForPlanner(skills: Skill[]): string {
  return skills.map((s) => `  - ${s.title} (${s.app.name}): ${s.description}. Input like: "${exampleFor(s)}"`).join('\n')
}

/** A trigger written out for a person: slots as <to>, the first of each choice, optional words left out but optional
 * punctuation kept, since it is what tells where a name ends ("whatsapp: message <to>: <text>"). */
export function exampleFor(skill: Skill): string {
  let out = skill.triggers[0] ?? ''
  for (let n = 0; n < 5; n++) {
    out = out
      .replace(/\(([^()[\]]*)\)/g, (_, alts: string) => alts.split('|')[0])
      .replace(/\[([^()[\]]*)\]/g, (_, alts: string) => {
        const first = alts.split('|')[0]
        return /^\p{P}+$/u.test(first) ? first : ''
      })
  }
  return out.replace(/\{(\w+)\}/g, '<$1>').replace(/\s+/g, ' ').replace(/\s+([:,])/g, '$1').trim()
}
