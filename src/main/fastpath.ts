import { parseAppRequest, type AppRequest } from './apps.ts'
import { routeCommand } from './commands.ts'
import { parseReminder } from './reminders.ts'
import { matchSkill, skillToolName, type Skill } from './skills.ts'

/**
 * Zero-latency shortcuts in front of the agent: commands so unambiguous that no model needs to read them ("tell sam on
 * discord I'm late", "remind me in 20 minutes to stretch", "next tab", "/claude fix the build", "where's my resume").
 * Each one becomes the same tool call the agent would make, so both paths share one set of workers and one set of
 * rules. Anything with more than one step, a repeat, or a judgment call goes to the agent instead.
 */

export interface FastCall {
  /** a tool name from tools.ts (or a skill tool) */
  tool: string
  input: Record<string, unknown>
  /** which shortcut matched, for the log */
  why: string
}

/** "where's my resume", "find the tax pdf": a place on this Mac. */
export const RE_FIND =
  /^(?:where(?:'s| is| are| did i (?:put|save|leave))|find|show me(?: where)?|locate|look for|can you find)\s+(?:my|the|that|this|a|an)\s+(.+?)(?:\s+(?:is|are|went|file|folder|document))?(?: on (?:my|this) (?:mac|computer|laptop))?[?.!]*$/i
export const FILEISH =
  /\b(?:file|files|folder|pdf|docx?|document|photo|picture|pic|image|screenshot|resume|cv|invoice|receipt|spreadsheet|slides|presentation|zip|video|recording|download(?:s|ed)?|\.\w{2,4})\b/i
const NOT_A_FILE = /\b(?:page|tab|website|site|screen|error|bug|flight|price|cheapest|best|weather)\b/i

/** More than one thing to do: the agent orders the steps. */
const COMPOUND = /\b(?:and then|then|after that|afterwards|and (?:open|send|text|tell|message|play|remind|email|share|show|read|delete|move|copy|rename|upload|attach))\b/i
/** "every day at 9", "each morning": a repeat, which the shortcut parser does not know. */
const REPEATS = /\b(?:every|each|daily|weekly|hourly|weekdays|on weekdays)\b/i

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** A moment as the local clock string set_reminder takes. */
export function localStamp(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function appCall(req: AppRequest): FastCall {
  switch (req.action) {
    case 'message':
      return { tool: 'send_message', input: { app: req.app, to: req.to, text: req.text, photo: Boolean(req.photo) }, why: 'app message' }
    case 'open':
      return { tool: 'open_chat', input: { app: req.app, to: req.to }, why: 'app chat' }
    case 'prompt':
      return { tool: 'ask_claude_app', input: { prompt: req.text }, why: 'claude app prompt' }
    case 'control':
      return { tool: 'spotify', input: { action: req.text === 'now' ? 'now_playing' : req.text, query: '' }, why: 'spotify' }
    case 'play_query':
      return { tool: 'spotify', input: { action: 'play_query', query: req.text }, why: 'spotify search' }
  }
}

function reminderCall(text: string, now: Date): FastCall | null {
  if (REPEATS.test(text)) return null
  const intent = parseReminder(text, now)
  if (!intent) return null
  switch (intent.kind) {
    case 'set': {
      const input = intent.ms
        ? { text: intent.text, in_minutes: Math.round((intent.ms / 60_000) * 100) / 100, at: null, timer: intent.timer, repeat: 'none' }
        : { text: intent.text, in_minutes: null, at: localStamp(intent.at), timer: intent.timer, repeat: 'none' }
      return { tool: 'set_reminder', input, why: 'reminder' }
    }
    case 'list':
      return { tool: 'list_reminders', input: {}, why: 'reminders list' }
    case 'cancel':
      return { tool: 'cancel_reminder', input: { query: intent.query, all: intent.all }, why: 'reminder cancel' }
    case 'needTime':
      // "Remind me to stretch": the agent asks when, and the answer comes back in the next turn.
      return null
  }
}

/** The shortcut for this message, or null when the agent should read it. */
export function fastRoute(raw: string, opts: { skills?: Skill[]; now?: Date } = {}): FastCall | null {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const now = opts.now ?? new Date()
  const slash = text.startsWith('/')

  // A skill names its app in its trigger, so it is never ambiguous ("message sam on whatsapp: running late").
  const hit = opts.skills?.length ? matchSkill(opts.skills, text) : null
  if (hit) return { tool: skillToolName(hit.skill), input: hit.slots, why: `skill ${hit.skill.name}` }

  if (!slash) {
    const reminder = reminderCall(text, now)
    if (reminder) return reminder
    const app = parseAppRequest(text)
    if (app) return appCall(app)
  }

  const routed = routeCommand(text)
  if (routed) {
    switch (routed.name) {
      case 'remind':
        return reminderCall(routed.input, now)
      case 'app': {
        const req = parseAppRequest(routed.input)
        if (req) return appCall(req)
        const m = /^(discord|slack):\s*([^:]+?)(?::\s*(.+))?$/i.exec(routed.input)
        if (m) {
          const app = m[1].toLowerCase()
          return m[3]
            ? { tool: 'send_message', input: { app, to: m[2].trim(), text: m[3].trim(), photo: false }, why: 'slash app' }
            : { tool: 'open_chat', input: { app, to: m[2].trim() }, why: 'slash app' }
        }
        return null
      }
      case 'tasks':
        // "how's it going?" is small talk unless it names the work.
        if (!slash && !/\b(?:claude|tasks?|jobs?|status)\b/i.test(text)) return null
        return { tool: 'claude_jobs', input: { action: 'status' }, why: 'job status' }
      case 'cancel':
        if (!slash && !/\b(?:claude|tasks?|jobs?|browsing)\b/i.test(text)) return null
        return { tool: 'claude_jobs', input: { action: 'cancel' }, why: 'job cancel' }
      case 'claude':
        if (COMPOUND.test(routed.input) && !slash) return null
        return { tool: 'claude_code', input: { instruction: routed.input, folder: routed.dir, resume: false }, why: 'claude job' }
      case 'claude_resume':
        return { tool: 'claude_code', input: { instruction: routed.input, folder: routed.dir, resume: true }, why: 'claude resume' }
      case 'chrome': {
        const [verb, ...rest] = routed.input.split(':')
        const arg = rest.join(':').trim()
        if (verb === 'click') return null // "press the blue button" could mean any app
        if (verb === 'find') return { tool: 'browser_tab', input: { verb: 'find_on_page', text: arg }, why: 'chrome find' }
        if (verb === 'search') return { tool: 'browser_tab', input: { verb: 'search', text: arg }, why: 'chrome search' }
        return { tool: 'browser_tab', input: { verb, text: '' }, why: 'chrome tab' }
      }
      case 'open':
        if (COMPOUND.test(routed.input)) return null
        return { tool: 'open', input: { target: routed.input }, why: 'open' }
      case 'computer':
        return { tool: 'use_computer', input: { goal: routed.input }, why: 'slash computer' }
      case 'browse':
        // "look up …", "check …", "find out …" are judgment calls; only the typed /browse is a shortcut.
        return slash ? { tool: 'browse', input: { goal: routed.input }, why: 'slash browse' } : null
      case 'page':
      case 'find':
      case 'plan':
        return null
    }
  }

  const said = text.replace(/^(?:can you |could you |please )+/i, '').replace(/[.!]+$/, '')
  const look = RE_FIND.exec(said)
  if (look && !NOT_A_FILE.test(look[1]) && !COMPOUND.test(look[1])) {
    if (/^where/i.test(said) || FILEISH.test(look[1]) || FILEISH.test(said)) return { tool: 'find_file', input: { query: look[1] }, why: 'find' }
  }
  return null
}
