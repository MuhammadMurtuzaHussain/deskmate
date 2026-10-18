import type { ToolCall } from '../shared/types'
import { parseAppRequest } from './apps.ts'
import { parseReminder } from './reminders.ts'

export interface Routed extends ToolCall {
  /** the user named the tool outright ("ask claude to…", "/tasks", "next tab"), so no model had to decide */
  explicit: true
}

const RE_ASK =
  /^(?:hey |ok |okay |yo |so )?(?:can|could|would|will) you (?:please )?(?:ask|tell|get|have|make|let) (?:claude|the agent) (?:to )?(.+)$|^(?:hey |ok |okay |yo |so )?(?:please )?(?:ask|tell|get|have|make|let) (?:claude|the agent) (?:to )?(.+)$|^claude[,:]\s*(.+)$/i
const RE_RESUME_HEAD =
  /^(?:(?:please )?(?:ask|tell|get|have) claude to |claude[,:]?\s+)?(?:please )?(?:resume|continue|pick (?:it |that |things )?up(?: again)?|carry on|keep going|finish)\b(.*)$/i
const RE_STATUS =
  /^(?:(?:hey |so )?how(?:'s| is| are)? (?:claude|the task|the job|that task|that job|it|things) ?(?:doing|going|coming along|looking)?|(?:what(?:'s| is) )?(?:the )?(?:task |job |claude )?status|(?:is )?claude (?:done|finished|still (?:working|going|running|busy))|(?:any )?(?:tasks?|jobs?)(?: update)?|claude\?)\??$/i
const RE_CANCEL =
  /^(?:(?:please )?(?:stop|cancel|kill|abort) (?:the |that |this )?(?:claude |current |running )?(?:task|job|run|work|it|browsing)|(?:ask|tell) claude to stop|claude[,:]? stop)[.!]?$/i
const RE_OPEN = /^(?:please )?(?:open|launch) (.+?)(?: in (?:chrome|the browser|my browser|a (?:new )?tab))?$/i
const NOT_A_FOLDER =
  /^(?:it|this|that|there|here|order|general|time|case|fact|short|particular|detail|english|python|typescript|javascript|rust|go|css|html|react|the end|a way|some way|place|places)$/i

// Chrome: the page in front of them, tabs, and things to click or find.
const RE_FIND_ON_PAGE = /^(?:(?:please )?(?:find|search for|look for|where(?:'s| is)) ["“']?(.+?)["”']? (?:on|in) (?:this|the|that) (?:page|tab|site))[.!?]?$/i
const RE_PAGE_REF = /\b(?:this|the|that|current|open) (?:web ?page|page|tab|article|website|site|post|thread|doc|document)\b/i
const RE_PAGE_LEAD = /^(?:what|summari[sz]e|read|explain|tl;?dr|tell me|give me|is there|are there|does|do|how|who|when|where|which|why|whats|what's|can you (?:summari[sz]e|read|explain|tell)|any)/i
const RE_SEARCH =
  /^(?:(?:please )?(?:google|web search(?: for)?|search(?: the web| online| google| chrome)?(?: for| up)?) (.+?)(?:,? (?:on|in) (?:google|chrome|the web|the internet|the browser|safari))?)[.!?]?$/i
const RE_BROWSE_LEAD = /^(?:(?:go )?(?:online|on the web|on the internet|in chrome|in the browser|in my browser)[,:]? (?:and )?(.+))$/i
const RE_BROWSE_TAIL = /^(.+?),? (?:online|on the web|on the internet|in chrome|in the browser|in my browser)[.!?]?$/i
const RE_BROWSE_VERB = /^(?:(?:please )?(?:browse|surf|look up|look into|find out|find me|research|check(?: out)?|look it up[,:]?) (.+))$/i
const RE_CLICK = /^(?:(?:please )?(?:click|press|tap|hit|choose|select) (?:on )?(?:the )?["“']?(.+?)["”']?(?: (?:button|link|tab|option|one))?)[.!?]?$/i
const TAB_VERBS: [RegExp, string][] = [
  [/^(?:(?:go to |switch to |show |move to )?(?:the )?(?:next|right) tab|next tab|tab right)$/i, 'next_tab'],
  [/^(?:(?:go to |switch to |show |move to )?(?:the )?(?:previous|prev|last|left) tab|tab left)$/i, 'prev_tab'],
  [/^(?:close (?:this |the |that |current )?tab)$/i, 'close_tab'],
  [/^(?:go back|back|previous page|page back)$/i, 'back'],
  [/^(?:go forward|forward|page forward)$/i, 'forward'],
  [/^(?:reload|refresh)(?: (?:this |the )?(?:page|tab))?$/i, 'reload'],
  [/^(?:scroll|page) down(?: (?:a bit|more|a little|please|some))?$/i, 'scroll_down'],
  [/^(?:scroll|page) up(?: (?:a bit|more|a little|please|some))?$/i, 'scroll_up']
]

/**
 * Explicit commands take no model to understand: "ask claude to fix the build", "resume the vlog edit",
 * "how's claude doing", "stop the task", "what's on this page", "next tab", "search for …", "look up …".
 * Anything else goes to her brain, which may still decide to use a tool from context. Returns null when the
 * text is just conversation.
 */
export function routeCommand(raw: string): Routed | null {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const tool = (name: ToolCall['name'], input: string, dir: string | null = null): Routed => ({ name, input, dir, explicit: true })

  // Slash commands, for the typed box.
  const slash = /^\/(\w+)\s*(.*)$/.exec(text)
  if (slash) {
    const [, cmd, rest] = slash
    switch (cmd.toLowerCase()) {
      case 'claude':
      case 'ask':
      case 'do':
        return rest ? withDir('claude', rest) : null
      case 'resume':
      case 'continue':
        return parseResume(rest)
      case 'tasks':
      case 'status':
        return tool('tasks', '')
      case 'cancel':
      case 'stop':
        return tool('cancel', '')
      case 'open':
        return rest ? tool('open', rest) : null
      case 'browse':
      case 'web':
        return rest ? tool('browse', rest) : null
      case 'page':
      case 'read':
        return tool('page', rest || 'What is this page about? Give me the gist.')
      case 'search':
      case 'google':
        return rest ? tool('chrome', `search:${rest}`) : null
      case 'click':
        return rest ? tool('chrome', `click:${rest}`) : null
      case 'tab':
        return tool('chrome', /^(?:prev|previous|left|back)/i.test(rest) ? 'prev_tab' : /^close/i.test(rest) ? 'close_tab' : 'next_tab')
      case 'app':
        return rest ? tool('app', rest) : null
      case 'computer':
      case 'agent':
        return rest ? tool('computer', rest) : null
      case 'remind':
      case 'reminder':
        return rest ? tool('remind', `remind me ${rest}`) : tool('remind', 'what reminders do I have')
      case 'timer':
        return rest ? tool('remind', `set a timer for ${rest}`) : tool('remind', 'what timers do I have')
      case 'reminders':
      case 'timers':
        return tool('remind', 'what reminders do I have')
      case 'discord':
      case 'slack':
        // /discord sam: running late · /slack #general
        return rest ? tool('app', `${cmd.toLowerCase()}: ${rest}`) : null
      default:
        return null
    }
  }

  // Reminders and timers: "remind me in 20 minutes to stretch", "set a timer for 5 minutes", "cancel the stretch reminder".
  if (parseReminder(text)) return tool('remind', text)

  // Desktop apps first: "ask the claude app to …" is a prompt in the app, not a Claude Code job.
  if (parseAppRequest(text)) return tool('app', text)

  const bare = text.toLowerCase().replace(/[.!?]+$/g, '')
  if (RE_STATUS.test(bare)) return tool('tasks', '')
  if (RE_CANCEL.test(bare)) return tool('cancel', '')

  const resume = RE_RESUME_HEAD.exec(text)
  if (resume && /\b(claude|task|session|job|work|edit|editing|where (?:you|it|we) left|last time|earlier|previous)\b/i.test(text)) {
    return parseResume(resume[1] ?? '')
  }

  const ask = RE_ASK.exec(text)
  if (ask) {
    const body = (ask[1] ?? ask[2] ?? ask[3] ?? '').trim()
    if (!body) return null
    if (/^(?:resume|continue|pick (?:it |that )?up|carry on|keep going)\b/i.test(body)) {
      return parseResume(body.replace(/^(?:resume|continue|pick (?:it |that )?up|carry on|keep going)/i, ''))
    }
    return withDir('claude', body)
  }

  // Chrome, in order from most to least specific.
  const findOnPage = RE_FIND_ON_PAGE.exec(text)
  if (findOnPage) return tool('chrome', `find:${findOnPage[1].trim()}`)
  if (RE_PAGE_REF.test(text) && RE_PAGE_LEAD.test(bare)) return tool('page', text.replace(/[.!?]+$/g, ''))
  for (const [re, verb] of TAB_VERBS) if (re.test(bare)) return tool('chrome', verb)
  const click = RE_CLICK.exec(text)
  if (click && click[1].split(' ').length <= 6) return tool('chrome', `click:${click[1].trim()}`)
  const search = RE_SEARCH.exec(text)
  if (search && search[1].trim()) return tool('chrome', `search:${search[1].trim()}`)

  const open = RE_OPEN.exec(text)
  if (open) {
    const target = open[1].trim().replace(/[.!]+$/g, '')
    // Only things that look like a site, a path, or a short app name; "open your heart" is conversation and
    // "open my notifications and tell me what's new" is a browsing goal.
    if (/^(?:https?:\/\/|www\.|[\w-]+\.(?:com|org|net|io|dev|app|ai|co|uk|ie|de|fr)\b|~|\/)/i.test(target) || target.split(' ').length <= 3) {
      return tool('open', target.replace(/^(?:the |my )/i, ''))
    }
  }

  const lead = RE_BROWSE_LEAD.exec(text) ?? RE_BROWSE_TAIL.exec(text)
  const verb = lead ? null : RE_BROWSE_VERB.exec(text)
  // "in chrome, …" drops the preamble; "look up …" keeps its verb, the planner wants the whole sentence.
  const goal = (lead ? lead[1] : verb ? text : '').trim().replace(/[.!?]+$/g, '')
  if (goal) {
    const rest = verb ? verb[1].trim() : goal
    if (rest.split(' ').length >= 2 && !/^(?:this|that|it|these|those)\b/i.test(rest)) return tool('browse', goal)
  }
  return null
}

/** "…in the vlog project" / "…on deskmate" / "…for my website" at the end of an instruction names the folder. */
function withDir(name: 'claude' | 'claude_resume', body: string): Routed {
  const m = /^(.*?)(?:,? (?:in|on|inside|for|within) (?:the |my |our )?([\w][\w .'\-]{1,60}?)(?: (?:project|folder|repo|repository|directory|dir|app))?)[.!]?$/i.exec(body)
  if (m && m[2] && !NOT_A_FOLDER.test(m[2].trim())) {
    return { name, input: m[1].trim().replace(/[,;]+$/, ''), dir: m[2].trim(), explicit: true }
  }
  return { name, input: body.replace(/[.!]+$/g, '').trim(), dir: null, explicit: true }
}

/** "the vlog edit", "the last task in deskmate", "with the dark mode, then add tests": folder hint plus what to say next. */
function parseResume(rest: string): Routed {
  let s = rest.trim().replace(/^(?:with|on|at)\s+/i, '')
  let dir: string | null = null
  let next = ''
  // Anything after a comma or "and then" is the new instruction for Claude.
  const tail = /^(.*?)(?:[,;:]| and then | then | and )(.+)$/i.exec(s)
  if (tail) {
    s = tail[1].trim()
    next = tail[2].trim().replace(/^(?:and then|and|then)\s+/i, '')
  }
  s = s.replace(/^(?:the |my |our |that |this )?(?:last |previous |earlier |old |unfinished )?/i, '').replace(/^(?:claude(?:'s)? )?/i, '')
  const inside = /^(?:task|session|job|work|edit|editing|thing|stuff|conversation|chat)?\s*(?:in|on|for|from|of|with)\s+(?:the |my |our )?(.+?)(?: (?:project|folder|repo|repository|directory|dir))?$/i.exec(s)
  if (inside) dir = inside[1].trim()
  else {
    const named = /^(.+?)\s+(?:task|session|job|work|edit|editing|project|stuff|thing)$/i.exec(s)
    if (named) dir = named[1].trim()
    else if (s && !/^(?:task|session|job|work|where (?:you|it|we) left off|it|that|this|please)$/i.test(s)) dir = s
  }
  if (dir && /^(?:where (?:you|it|we) left off|last time|earlier|previous|it|that|this)$/i.test(dir)) dir = null
  return { name: 'claude_resume', input: next.replace(/[.!]+$/g, ''), dir, explicit: true }
}
