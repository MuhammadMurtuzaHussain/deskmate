import type { ToolCall } from '../shared/types'

export interface Routed extends ToolCall {
  /** the user named the tool outright ("ask claude to…", "/tasks"), so no model had to decide */
  explicit: true
}

const RE_ASK =
  /^(?:hey |ok |okay |yo |so )?(?:can|could|would|will) you (?:please )?(?:ask|tell|get|have|make|let) (?:claude|the agent) (?:to )?(.+)$|^(?:hey |ok |okay |yo |so )?(?:please )?(?:ask|tell|get|have|make|let) (?:claude|the agent) (?:to )?(.+)$|^claude[,:]\s*(.+)$/i
const RE_RESUME_HEAD =
  /^(?:(?:please )?(?:ask|tell|get|have) claude to |claude[,:]?\s+)?(?:please )?(?:resume|continue|pick (?:it |that |things )?up(?: again)?|carry on|keep going|finish)\b(.*)$/i
const RE_STATUS =
  /^(?:(?:hey |so )?how(?:'s| is| are)? (?:claude|the task|the job|that task|that job|it|things) ?(?:doing|going|coming along|looking)?|(?:what(?:'s| is) )?(?:the )?(?:task |job |claude )?status|(?:is )?claude (?:done|finished|still (?:working|going|running|busy))|(?:any )?(?:tasks?|jobs?)(?: update)?|claude\?)\??$/i
const RE_CANCEL =
  /^(?:(?:please )?(?:stop|cancel|kill|abort) (?:the |that |this )?(?:claude |current |running )?(?:task|job|run|work|it)|(?:ask|tell) claude to stop|claude[,:]? stop)[.!]?$/i
const RE_OPEN = /^(?:please )?(?:open|launch) (.+)$/i
const NOT_A_FOLDER =
  /^(?:it|this|that|there|here|order|general|time|case|fact|short|particular|detail|english|python|typescript|javascript|rust|go|css|html|react|the end|a way|some way|place|places)$/i

/**
 * Explicit commands take no model to understand: "ask claude to fix the build", "resume the vlog edit",
 * "how's claude doing", "stop the task", "/claude …". Anything else goes to her brain, which may still decide
 * to use a tool from context. Returns null when the text is just conversation.
 */
export function routeCommand(raw: string): Routed | null {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return null

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
        return { name: 'tasks', input: '', explicit: true }
      case 'cancel':
      case 'stop':
        return { name: 'cancel', input: '', explicit: true }
      case 'open':
        return rest ? { name: 'open', input: rest, explicit: true } : null
      default:
        return null
    }
  }

  const bare = text.toLowerCase().replace(/[.!?]+$/g, '')
  if (RE_STATUS.test(bare)) return { name: 'tasks', input: '', explicit: true }
  if (RE_CANCEL.test(bare)) return { name: 'cancel', input: '', explicit: true }

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

  const open = RE_OPEN.exec(text)
  if (open) {
    const target = open[1].trim().replace(/[.!]+$/g, '')
    // Only things that look like a site, a path, or a short app name; "open your heart" is conversation.
    if (/^(?:https?:\/\/|www\.|[\w-]+\.(?:com|org|net|io|dev|app|ai|co)\b|~|\/)/i.test(target) || target.split(' ').length <= 3) {
      return { name: 'open', input: target.replace(/^(?:the |my )/i, ''), explicit: true }
    }
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
    next = tail[2].trim().replace(/^(?:and then|and|then)\s+/i, '').replace(/^(?:and then|and|then)\s+/i, '')
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
