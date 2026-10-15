import * as chrome from './chrome'
import type { Observation, PageElement } from './chrome'

/** The brain's planning call: a system prompt, one user message, a JSON schema; returns the parsed object. */
export type Planner = (system: string, user: string, schema: Record<string, unknown>) => Promise<Record<string, unknown>>

export interface BrowseDeps {
  plan: Planner
  /** read back a risky action and wait for a yes */
  confirm(question: string): Promise<boolean>
  onStep(text: string): void
  log(line: string): void
  /** polled before each step; true means the user said stop */
  stopped?(): boolean
  maxSteps?: number
}

export interface BrowseResult {
  ok: boolean
  answer: string
  steps: number
  url?: string
}

interface Decision {
  thought?: string
  action?: string
  ref?: number | null
  text?: string
  answer?: string
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: { type: 'string', enum: ['open', 'search', 'click', 'type', 'scroll', 'back', 'done'] },
    ref: { type: ['integer', 'null'] },
    text: { type: 'string' },
    answer: { type: 'string' }
  },
  required: ['thought', 'action', 'ref', 'text', 'answer']
}

const SYSTEM = `You operate the user's Chrome tab to reach a goal, one action per turn. Each turn you get the page URL, title, the start of its text, and numbered elements you can act on.
Reply with ONE JSON object: {"thought": string, "action": "open"|"search"|"click"|"type"|"scroll"|"back"|"done", "ref": integer|null, "text": string, "answer": string}
- "search": web search; "text" is the query. Use it when you do not know the URL.
- "open": "text" is a full URL.
- "click": "ref" of a link or button.
- "type": "ref" of a text field, "text" what to type; end "text" with "\\n" to press Enter.
- "scroll": "text" is "down" or "up", to see more of the page.
- "back": previous page.
- "done": the goal is reached or cannot be reached; "answer" is what you tell the user, two or three spoken sentences, concrete facts from the page, no markdown. If you could not finish, say exactly where you got stuck.
Rules: one action per turn; "thought" is one short sentence. Read what is on the page before clicking around. Never type passwords, card numbers or personal data; never buy, send, post, delete or sign anything; if the goal needs that, stop with "done" and say what is left for the user to do. If the same action did not help twice, try another way or finish.`

const RISKY_LABEL = /\b(buy|pay|checkout|check out|place order|purchase|order now|send|submit|post|publish|tweet|reply|delete|remove|confirm|sign out|log out|unsubscribe|transfer|donate|book now|reserve|apply|agree|accept)\b/i
const RISKY_URL = /checkout|payment|\/pay\b|billing|cart|order/i
const NEVER_TYPE = /password|card|cvc|cvv|iban|account number|ssn|social security|passport/i

/**
 * Bounded browse loop: look, decide, act, repeat, then hand back an answer for her to say. Anything that spends,
 * sends or deletes is read back to the user first; passwords and card numbers are never typed.
 */
export async function browse(goal: string, deps: BrowseDeps): Promise<BrowseResult> {
  const maxSteps = deps.maxSteps ?? Math.max(3, Number(process.env.DESKMATE_BROWSE_STEPS) || 12)
  const history: string[] = []
  let lastKey = ''
  let repeats = 0
  let obs: Observation | null = null
  deps.log(`# browse: ${goal}`)

  // Her own tab: the one the user is looking at stays as it is. A search for the goal is the usual first move,
  // and the planner can still open a specific site from there.
  await chrome.open(chrome.searchUrl(goal), 'tab')
  await settle()

  for (let step = 1; step <= maxSteps; step++) {
    if (deps.stopped?.()) return { ok: false, answer: 'Stopped browsing, as you asked.', steps: step - 1, url: obs?.url }
    obs = await chrome.observe()
    const user = describe(goal, obs, history)
    const decision = (await deps.plan(SYSTEM, user, DECISION_SCHEMA)) as Decision
    const action = String(decision.action ?? 'done')
    const text = String(decision.text ?? '').trim()
    const ref = typeof decision.ref === 'number' ? decision.ref : null
    const element = ref ? obs.elements.find((e) => e.ref === ref) : undefined
    deps.log(`step ${step} @ ${obs.url}\n  thought: ${decision.thought ?? ''}\n  action: ${action} ref=${ref ?? '-'} text=${JSON.stringify(text.slice(0, 80))}`)
    deps.onStep(`browsing · ${step}/${maxSteps} · ${action}${element ? ` "${element.text.slice(0, 30)}"` : text ? ` ${text.slice(0, 30)}` : ''}`)

    const key = `${action}:${ref ?? ''}:${text.slice(0, 40)}`
    repeats = key === lastKey ? repeats + 1 : 0
    lastKey = key
    if (repeats >= 2) {
      return { ok: false, answer: `I kept trying the same thing on ${obs.title || obs.url} and got nowhere. Take a look and tell me what to do next.`, steps: step, url: obs.url }
    }

    if (action === 'done') {
      const answer = String(decision.answer ?? '').trim() || 'Done, but the page gave me nothing to report.'
      deps.log(`# done: ${answer}`)
      return { ok: true, answer, steps: step, url: obs.url }
    }

    let result = ''
    switch (action) {
      case 'search':
        await chrome.open(chrome.searchUrl(text || goal), step === 1 && isBlank(obs) ? 'current' : 'current')
        result = `searched "${text || goal}"`
        await settle()
        break
      case 'open':
        if (!text) {
          result = 'open: no URL given'
          break
        }
        await chrome.open(text, 'current')
        result = `opened ${text}`
        await settle()
        break
      case 'click': {
        if (!element) {
          result = `click: no element ${ref}`
          break
        }
        if (RISKY_LABEL.test(element.text) || RISKY_URL.test(obs.url)) {
          const ok = await deps.confirm(`On ${obs.title || obs.url}, I'm about to click "${element.text || 'that button'}". Should I?`)
          if (!ok) return { ok: false, answer: `Stopped before clicking "${element.text}" on ${obs.title}. Your call from here.`, steps: step, url: obs.url }
        }
        result = await chrome.click(element.ref)
        await settle()
        break
      }
      case 'type': {
        if (!element) {
          result = `type: no element ${ref}`
          break
        }
        if (element.kind === 'password' || NEVER_TYPE.test(element.text)) {
          return { ok: false, answer: `That needs a password or payment detail typed in, and I don't do that. I left you on ${obs.title}.`, steps: step, url: obs.url }
        }
        if (RISKY_URL.test(obs.url)) {
          const ok = await deps.confirm(`On ${obs.title || obs.url}, I'm about to type "${text.replace(/\n$/, '')}" into "${element.text || element.kind}". Should I?`)
          if (!ok) return { ok: false, answer: `Stopped before typing on ${obs.title}. Your call from here.`, steps: step, url: obs.url }
        }
        const submit = /\n$/.test(decision.text ?? '')
        result = await chrome.type(element.ref, text.replace(/\n$/, ''), submit)
        if (submit) await settle()
        break
      }
      case 'scroll':
        await chrome.scroll(/up/i.test(text) ? 'up' : 'down')
        result = `scrolled ${/up/i.test(text) ? 'up' : 'down'}`
        break
      case 'back':
        await chrome.navigate('back')
        result = 'went back'
        await settle()
        break
      default:
        result = `unknown action ${action}`
    }
    history.push(`${step}. ${result} (then at: ${obs.title.slice(0, 50)})`)
    if (history.length > 6) history.shift()
  }
  return { ok: false, answer: `I ran out of steps on ${obs?.title || 'the page'} without finishing. Tell me what to do next, or take over.`, steps: maxSteps, url: obs?.url }
}

function describe(goal: string, obs: Observation, history: string[]): string {
  const els = obs.elements
    .map((e) => `[${e.ref}] ${e.kind}${e.inView ? '' : ' (below)'}: ${e.text || elementFallback(e)}`)
    .join('\n')
  const where = obs.scrollMax > 0 ? ` (scrolled ${Math.round((100 * obs.scrollY) / obs.scrollMax)}% of the page)` : ''
  return `Goal: ${goal}\n\nSo far:\n${history.length ? history.join('\n') : '(nothing yet)'}\n\nPage: ${obs.title}\nURL: ${obs.url}${where}\n\nText:\n${obs.text || '(no text)'}\n\nElements:\n${els || '(none)'}`
}

function elementFallback(e: PageElement): string {
  return e.href ? e.href.replace(/^https?:\/\//, '').slice(0, 60) : '(no label)'
}

function isBlank(obs: Observation): boolean {
  return /^(?:chrome:\/\/newtab|about:blank)/.test(obs.url) || (!obs.text && obs.elements.length === 0)
}

/** Pages need a moment after navigation before the next look. */
function settle(ms = 1500): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
