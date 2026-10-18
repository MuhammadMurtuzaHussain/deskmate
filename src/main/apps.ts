import { Hands, HandsError, type FocusedElement } from './hands'

/**
 * Her hands in desktop apps: a message to someone on Discord or Slack, a prompt typed into the Claude app, or just
 * "go to #general on Discord". Each app has a fixed routine (launch, quick switcher, check the window title, read
 * back, paste, Enter), so no model is in the loop while keys are being pressed and a small local model is enough to
 * fill in who and what. Nothing is ever sent before the window title shows the chat they named.
 */

export type AppId = 'discord' | 'slack' | 'claude'
export type AppAction = 'message' | 'open' | 'prompt'

export interface AppRequest {
  app: AppId
  action: AppAction
  /** the person, channel or chat ("sam", "#general"); empty for the Claude app */
  to: string
  /** exactly what to send or type; empty for open */
  text: string
}

export const APPS: Record<AppId, { name: string; bundleId: string }> = {
  discord: { name: 'Discord', bundleId: 'com.hnc.Discord' },
  slack: { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' },
  claude: { name: 'Claude', bundleId: 'com.anthropic.claudefordesktop' }
}

// ---- understanding the request

const CHAT_APP = '(discord|slack)'
const VERB = '(?:message|msg|dm|text|tell|ping|write(?: to)?|send(?: a message to| a dm to| a note to)?)'
const POLITE = '^(?:(?:hey |ok |okay |so )?(?:can|could|would) you (?:please )?|please )?'
const SEP = '(?:,|:| that| saying| to say| and say| and tell (?:them|him|her))'
const CLAUDE_APP = '(?:the )?claude(?: desktop app| desktop| app| chat)'

const MESSAGE_PATTERNS: { re: RegExp; app: number; to: number; text: number }[] = [
  // "discord: sam: running late" (the /discord command)
  { re: new RegExp(`^${CHAT_APP}:\\s*([^:]+?):\\s*(.+)$`, 'i'), app: 1, to: 2, text: 3 },
  // "Discord: tell sam the build is green" (how her brain hands it over)
  { re: new RegExp(`^${CHAT_APP}:\\s*${VERB} ([@#]?[\\w.'-]+)${SEP}?\\s+(.+)$`, 'i'), app: 1, to: 2, text: 3 },
  // "tell sam on discord that I'm running late", "message #general in slack: standup moved"
  { re: new RegExp(`${POLITE}${VERB} (.+?) (?:on|in|over|via|through) ${CHAT_APP}${SEP}?\\s+(.+)$`, 'i'), to: 1, app: 2, text: 3 },
  // "on discord, tell sam that I'm late" / "on slack message ana: running late"
  { re: new RegExp(`^(?:on|in|over) ${CHAT_APP}[,:]? ${VERB} (.+?)${SEP}\\s+(.+)$`, 'i'), app: 1, to: 2, text: 3 },
  // "on discord tell sam I'm late" (one-word name, no separator)
  { re: new RegExp(`^(?:on|in|over) ${CHAT_APP}[,:]? ${VERB} ([@#]?[\\w.'-]+) (.+)$`, 'i'), app: 1, to: 2, text: 3 },
  // "send 'on my way' to sam on discord"
  { re: new RegExp(`${POLITE}send ["“'](.+?)["”'] to (.+?) (?:on|in|over|via) ${CHAT_APP}$`, 'i'), text: 1, to: 2, app: 3 },
  // "tell sam that I'm running late on discord"
  { re: new RegExp(`${POLITE}${VERB} ([@#]?[\\w.'-]+(?: [\\w.'-]+)?)${SEP} (.+?) (?:on|in|over|via) ${CHAT_APP}$`, 'i'), to: 1, text: 2, app: 3 },
  // "send hi to sam on discord"
  { re: new RegExp(`${POLITE}send (.+?) to (.+?) (?:on|in|over|via) ${CHAT_APP}$`, 'i'), text: 1, to: 2, app: 3 }
]
const OPEN_PATTERNS: { re: RegExp; app: number; to: number }[] = [
  // "slack: #general", "discord: go to gaming" (the /slack command; a short name, not a sentence)
  { re: new RegExp(`^${CHAT_APP}:\\s*(?:(?:open|go to|switch to|jump to) )?([@#]?[\\w.'-]+(?: [\\w.'-]+){0,3})$`, 'i'), app: 1, to: 2 },
  // "go to #general on discord", "open my DMs with sam in slack"
  { re: new RegExp(`${POLITE}(?:open|go to|switch to|jump to|take me to|show(?: me)?) (.+?) (?:on|in) ${CHAT_APP}$`, 'i'), to: 1, app: 2 },
  // "open discord and go to #general"
  { re: new RegExp(`${POLITE}(?:open|launch) ${CHAT_APP},?(?: and| then)* (?:go to|open|switch to|jump to) (.+)$`, 'i'), app: 1, to: 2 }
]
const PROMPT_PATTERNS: RegExp[] = [
  // "open claude and ask it what a monad is", "in the claude app, type: draft a cover letter", "claude app, ask …"
  new RegExp(
    `${POLITE}(?:(?:open|launch|go to|use|in|on) (?:the )?claude(?: desktop app| desktop| app| chat)?|${CLAUDE_APP})(?:,| and| then)*\\s+(?:ask|prompt|type|tell|say|write|send|paste|enter)(?: it| claude| this| in| into it| in there)?(?: to| with| that|:)?[,:]?\\s+(.+)$`,
    'i'
  ),
  // "ask the claude app to draft a cover letter", "ask claude desktop what a monad is"
  new RegExp(`${POLITE}(?:ask|tell|prompt) ${CLAUDE_APP}(?: to)?[,:]? (.+)$`, 'i')
]

function cleanText(s: string): string {
  return s.trim().replace(/^["“'](.*)["”'][.!]?$/s, '$1').trim()
}

/** "the general channel" → "#general", "my dms with sam" → "sam", "@ana" → "ana". */
export function cleanTarget(raw: string): string {
  let s = raw.trim().replace(/^["“'](.*)["”']$/, '$1')
  s = s.replace(/^(?:the |my |our )/i, '').replace(/^(?:dms?|direct messages?|chat|conversation) with /i, '')
  const channel = /^(.+?) channel$/i.exec(s) ?? /^channel (.+)$/i.exec(s)
  if (channel) s = `#${channel[1].replace(/^#/, '')}`
  return s.replace(/^@/, '').trim()
}

/** The requests that need no model to understand. Null when the sentence is not about a desktop app. */
export function parseAppRequest(raw: string): AppRequest | null {
  const text = raw.replace(/\s+/g, ' ').trim().replace(/[?]+$/, '')
  for (const re of PROMPT_PATTERNS) {
    const m = re.exec(text)
    if (m && m[1].trim()) return { app: 'claude', action: 'prompt', to: '', text: cleanText(m[1]) }
  }
  for (const p of MESSAGE_PATTERNS) {
    const m = p.re.exec(text)
    if (m && m[p.text]?.trim() && m[p.to]?.trim()) {
      return { app: m[p.app].toLowerCase() as AppId, action: 'message', to: cleanTarget(m[p.to]), text: cleanText(m[p.text]) }
    }
  }
  for (const p of OPEN_PATTERNS) {
    const m = p.re.exec(text.replace(/[.!]+$/, ''))
    if (m && m[p.to]?.trim() && !/^(?:discord|slack)$/i.test(m[p.to].trim())) {
      return { app: m[p.app].toLowerCase() as AppId, action: 'open', to: cleanTarget(m[p.to]), text: '' }
    }
  }
  return null
}

/** For what the patterns miss: one planning call fills in the slots. */
export const APP_PLAN_SYSTEM = `You turn a request about a desktop app into JSON. Reply with ONE JSON object: {"app": "discord"|"slack"|"claude"|"other", "action": "message"|"open"|"prompt", "to": string, "text": string}
- "message": send "text" to a person, channel or group ("to") in Discord or Slack.
- "open": just go to that chat or channel ("to") in Discord or Slack, sending nothing.
- "prompt": type "text" into a new chat in the Claude desktop app and send it ("to" is "").
- "to": only the name of the person, channel or server ("sam", "#general"), nothing else.
- "text": exactly the words to send, as they want them to read, without "saying", "that" or quotes. Do not add or improve anything.
- "other": any other app, or not a request for an app.`

export const APP_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    app: { type: 'string', enum: ['discord', 'slack', 'claude', 'other'] },
    action: { type: 'string', enum: ['message', 'open', 'prompt'] },
    to: { type: 'string' },
    text: { type: 'string' }
  },
  required: ['app', 'action', 'to', 'text']
}

export function fromPlan(obj: Record<string, unknown>): AppRequest | null {
  const app = String(obj.app ?? '').toLowerCase()
  if (!(app in APPS)) return null
  const action = (['message', 'open', 'prompt'].includes(String(obj.action)) ? obj.action : app === 'claude' ? 'prompt' : 'message') as AppAction
  const req: AppRequest = { app: app as AppId, action: app === 'claude' ? 'prompt' : action, to: cleanTarget(String(obj.to ?? '')), text: cleanText(String(obj.text ?? '')) }
  if (req.action !== 'prompt' && !req.to) return null
  if (req.action !== 'open' && !req.text) return null
  return req
}

// ---- doing it

export interface RoutineDeps {
  hands: Hands
  /** reads the question out and waits for a yes */
  confirm(question: string): Promise<boolean>
  /** whether a message waits for a yes before it is sent (prompts to the Claude app have their own switch) */
  confirmMessages: boolean
  confirmPrompts: boolean
  onStep(text: string): void
  log(line: string): void
  /** polled between steps; true when they said stop */
  stopped(): boolean
}

export interface RoutineResult {
  ok: boolean
  /** her line about it, plain and exact */
  say: string
  /** for her memory: what happened, in a few words */
  summary: string
  /** the chat she ended up in, from the window title */
  where?: string
}

class Stopped extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/** True when every word of what they named shows up in the window title ("general chat" ↔ "#general-chat | …"). */
export function titleMatches(target: string, title: string | null): boolean {
  if (!title) return false
  const have = new Set(words(title))
  const want = words(target)
  return want.length > 0 && want.every((w) => have.has(w) || [...have].some((h) => h.startsWith(w) && w.length >= 3))
}

/** "(3) #general | My Server - Discord" → "#general"; "general (Channel) - Acme - Slack" → "general". */
export function chatLabel(title: string, appName: string): string {
  const parts = title
    .replace(/^\(\d+\)\s*/, '')
    .replace(/^•\s*/, '')
    .split(/\s+[|–—-]\s+/)
    .map((p) => p.trim())
    .filter((p) => p && p.toLowerCase() !== appName.toLowerCase())
  return (parts[0] ?? title).replace(/\s*\((?:channel|dm|group dm)\)$/i, '').trim()
}

const EDITABLE_ROLES = new Set(['AXTextArea', 'AXTextField', 'AXComboBox'])

function squash(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** True unless the box reports a value that does not hold `text` (a box that reports nothing gets the benefit). */
function boxHolds(box: FocusedElement | null, text: string): boolean {
  if (box?.value === undefined) return true
  return squash(box.value).includes(squash(text).slice(0, 40))
}

/** Puts the caret in a text box: the one that has focus, else the one labelled `hint` ("message"). Null if none. */
async function ensureInput(hands: Hands, id: string, hint: string, log: (line: string) => void): Promise<FocusedElement | null> {
  const focus = await hands.focused(id).catch(() => null)
  log(`focused: ${JSON.stringify(focus)}`)
  if (focus?.role && EDITABLE_ROLES.has(focus.role)) return focus
  const box = await hands.focusInput(id, hint, id).catch((err: Error) => {
    log(`no text box labelled "${hint}": ${err.message}`)
    return null
  })
  if (box) {
    log(`focused the text box ${JSON.stringify(box)}`)
    await sleep(150)
  }
  return box
}

/** Backs out of a quick switcher: the first Escape clears its search, the second closes it (measured in Discord). */
async function backOut(hands: Hands, id: string): Promise<void> {
  await hands.key('escape', id).catch(() => undefined)
  await sleep(200)
  await hands.key('escape', id).catch(() => undefined)
}

export async function runApp(req: AppRequest, deps: RoutineDeps): Promise<RoutineResult> {
  const { hands } = deps
  const app = APPS[req.app]
  const id = app.bundleId
  const step = async (label: string, ms = 0): Promise<void> => {
    if (deps.stopped()) throw new Stopped()
    deps.onStep(`${app.name} · ${label}`)
    deps.log(label)
    if (ms) await sleep(ms)
  }
  const fail = (say: string, summary = say): RoutineResult => {
    deps.log(`failed: ${summary}`)
    return { ok: false, say, summary }
  }

  try {
    if (!(await hands.installed(id))) return fail(`${app.name} isn't installed on this Mac.`)
    await step(`opening`)
    const opened = await hands.launch(id)
    deps.log(`launched pid ${opened.pid} in ${opened.ms} ms${opened.wasRunning ? '' : ' (cold start)'}`)
    // A cold start shows a splash or updater first; give the real window a moment.
    if (!opened.wasRunning) await step('waiting for it to load', req.app === 'claude' ? 2500 : 4000)

    if (req.app === 'claude') return await promptClaude(req, deps, step)

    // Discord and Slack: ⌘K is the quick switcher / "jump to" in both.
    await step(`finding ${req.to}`)
    // Back out of a switcher or dialog left open (an earlier run cut short); a bare Escape in a Discord channel
    // would mark it read, so only when one is actually up.
    const before = await hands.focused(id).catch(() => null)
    if (before?.subrole === 'AXApplicationDialog' || before?.role === 'AXComboBox') {
      deps.log(`closing ${before.description ?? 'a dialog'} first`)
      await backOut(hands, id)
      await sleep(200)
    }
    await hands.key('cmd+k', id)
    // Type only once the search box is seen to have focus: if ⌘K did not open it, the name (and the Enter after it)
    // would land in whatever chat is open. Unreadable counts as not open (a run that could not read it is why).
    let search: FocusedElement | null = null
    for (let i = 0; i < 8 && !(search?.role && EDITABLE_ROLES.has(search.role)); i++) {
      await sleep(250)
      search = await hands.focused(id).catch(() => null)
    }
    deps.log(`switcher opened: ${JSON.stringify(search)}`)
    if (!(search?.role && EDITABLE_ROLES.has(search.role))) {
      return fail(`I couldn't see ${app.name}'s search open, so I didn't type anything.`, `quick switcher not seen after cmd+k (${JSON.stringify(search)})`)
    }
    await hands.type(req.to, id)
    await sleep(req.app === 'slack' ? 1400 : 1000)
    search = await hands.focused(id).catch(() => null)
    deps.log(`switcher: ${JSON.stringify(search)}`)
    if (!search?.value || !boxHolds(search, req.to)) {
      await backOut(hands, id)
      return fail(`${app.name}'s search didn't take what I typed, so I stopped.`, `quick switcher did not show "${req.to}" (${JSON.stringify(search)})`)
    }
    await hands.key('return', id)
    let title: string | null = null
    for (let i = 0; i < 6 && !titleMatches(req.to, title); i++) {
      await sleep(350)
      title = await hands.windowTitle(id)
    }
    deps.log(`window title: ${JSON.stringify(title)}`)
    if (!titleMatches(req.to, title)) {
      await backOut(hands, id)
      return fail(
        title ? `I couldn't find "${req.to}" in ${app.name}. It's showing ${chatLabel(title, app.name)}, so I left it alone.` : `I couldn't tell which chat ${app.name} opened, so I didn't type anything.`,
        `could not find "${req.to}" in ${app.name} (window: ${title ?? 'unknown'})`
      )
    }
    const where = chatLabel(title as string, app.name)
    if (req.action === 'open') {
      deps.log(`opened ${where}`)
      return { ok: true, say: `${where}, open in ${app.name}.`, summary: `opened ${where} in ${app.name}`, where }
    }

    if (deps.confirmMessages) {
      await step(`in ${where} · waiting for your yes`)
      const yes = await deps.confirm(`Send "${req.text}" to ${where} on ${app.name}?`)
      if (!yes) return fail('Okay, not sent.', `did not send to ${where} on ${app.name}: they said no`)
      // They may have used the computer while she waited: bring the app back and check it is still the same chat.
      await hands.launch(id)
      const again = await hands.windowTitle(id)
      if (!titleMatches(req.to, again)) return fail(`${app.name} moved off ${where} while I waited, so I didn't send it.`, `chat changed before sending (${again ?? 'unknown'})`)
    }

    await step(`typing in ${where}`)
    if (!(await ensureInput(hands, id, 'message', deps.log))) {
      return fail(`I couldn't get into the message box in ${app.name}, so I didn't type anything.`, `no message box in ${where} on ${app.name}`)
    }
    await hands.paste(req.text, id)
    await sleep(300)
    const box = await hands.focused(id).catch(() => null)
    deps.log(`after paste: ${JSON.stringify(box)}`)
    if (!boxHolds(box, req.text)) {
      return fail(`I couldn't see the message land in the box in ${where}, so I didn't press send.`, `pasted text not visible in ${where} on ${app.name}`)
    }
    await step('sending')
    await hands.key('return', id)
    await sleep(600)
    const after = await hands.focused(id).catch(() => null)
    if (after?.value && after.value.includes(req.text.slice(0, 20))) {
      return fail(`I typed it into ${where}, but it didn't seem to send. It's still in the box.`, `typed in ${where} on ${app.name} but Enter did not send`)
    }
    deps.log(`sent to ${where}`)
    return { ok: true, say: `Sent to ${where}.`, summary: `sent "${req.text}" to ${where} on ${app.name}`, where }
  } catch (err) {
    if (err instanceof Stopped) return fail('Stopped.', 'stopped by the user')
    return fail(handsMessage(err, app.name), `error: ${(err as Error).message}`)
  }
}

async function promptClaude(req: AppRequest, deps: RoutineDeps, step: (label: string, ms?: number) => Promise<void>): Promise<RoutineResult> {
  const { hands } = deps
  const id = APPS.claude.bundleId
  // The app has a chat side and a Code side (Go › Claude, Go › Code). ⌘N is "New Session" on the Code side, so switch
  // to chat first; menu titles are matched, not positions, so a renamed item fails loudly instead of misfiring.
  await step('new chat')
  try {
    await hands.pressMenu(id, ['Go', 'Claude'], id)
    await sleep(700)
  } catch (err) {
    deps.log(`no Go > Claude menu item (${(err as Error).message})`)
  }
  try {
    const pressed = await hands.pressMenu(id, ['New Chat'], id)
    deps.log(`menu: ${pressed.join(' > ')}`)
  } catch (err) {
    deps.log(`no "New Chat" menu item (${(err as Error).message}); trying cmd+n`)
    await hands.key('cmd+n', id)
  }
  await sleep(900)
  if (deps.confirmPrompts) {
    await step('waiting for your yes')
    if (!(await deps.confirm(`Ask Claude: "${req.text}"?`))) return { ok: false, say: 'Okay, not asking.', summary: 'did not prompt Claude: they said no' }
    await hands.launch(id)
  }
  await step('typing the prompt')
  if (!(await ensureInput(hands, id, '', deps.log))) {
    return { ok: false, say: "I couldn't get into Claude's prompt box, so I didn't type anything.", summary: 'no prompt box in the Claude app' }
  }
  await hands.paste(req.text, id)
  await sleep(300)
  const box = await hands.focused(id).catch(() => null)
  deps.log(`after paste: ${JSON.stringify(box)}`)
  if (!boxHolds(box, req.text)) {
    return { ok: false, say: "I couldn't see the prompt land in Claude's box, so I didn't send it.", summary: 'pasted prompt not visible in the Claude app' }
  }
  await step('sending')
  await hands.key('return', id)
  deps.log('prompt sent')
  return { ok: true, say: "Asked Claude. It's answering in the app.", summary: `asked the Claude app: "${req.text}"` }
}

export function handsMessage(err: unknown, appName = 'the app'): string {
  if (!(err instanceof HandsError)) return `Something went wrong in ${appName}: ${(err as Error).message}`
  switch (err.code) {
    case 'unavailable':
      return "I can only work other apps on a Mac, and my hands helper isn't built yet (npm run build)."
    case 'not_installed':
      return `${appName} isn't installed on this Mac.`
    case 'focus_changed':
      return `You switched apps, so I stopped before pressing anything in ${appName}.`
    case 'launch_timeout':
    case 'no_window':
      return `${appName} didn't open a window in time. Try again once it's up.`
    case 'not_running':
      return `${appName} closed while I was working in it.`
    case 'timeout':
    case 'helper_gone':
      return `My hands froze working in ${appName}. Try again.`
    default:
      return `${appName} gave me trouble: ${err.message}`
  }
}
