import type { Risk } from './untrusted'

/**
 * What she may do, per tool and per place the request came from. Every tool (built-in, skill, MCP) has a level:
 *   allow  runs without asking (the injection guard still asks after she read someone else's text: allow never
 *          switches that off)
 *   ask    asks the user first every time (a tool with its own read-back reads it back; others get "… Go ahead?")
 *   never  does not run, and is left out of her tool list
 * The defaults come from what a tool could do wrong: reading is allow; sending, deleting, buying, running commands,
 * Claude Code jobs and files leaving the Mac are ask. The user changes a tool everywhere, or only for one origin
 * (voice at the desk, the command bar, a chat app, a scheduled job, the heartbeat), and can make a whole origin
 * stricter: "anything risky from a chat app asks" or "never from a schedule". A "yes, always" to a question adds an
 * allow for that tool from that origin. Pure, so the tests and the eval resolve levels without Electron.
 */

export type Level = 'allow' | 'ask' | 'never'
export const LEVELS: Level[] = ['allow', 'ask', 'never']

/** Where a request came from, as the permissions page names them. */
export type PermOrigin = 'voice' | 'typed' | 'phone' | 'schedule' | 'heartbeat'
export const PERM_ORIGINS: PermOrigin[] = ['voice', 'typed', 'phone', 'schedule', 'heartbeat']
export const ORIGIN_LABELS: Record<PermOrigin, string> = {
  voice: 'Voice at the desk',
  typed: 'Command bar and chat',
  phone: 'Chat apps (phone)',
  schedule: 'Scheduled jobs',
  heartbeat: 'Heartbeat'
}

export interface OriginPrefs {
  /** per-tool levels for this origin only (they beat the tool's level everywhere) */
  tools?: Record<string, Level>
  /** a floor for every risky tool from here: 'ask' or 'never' (null: as each tool is set) */
  risky?: 'ask' | 'never' | null
}

export interface PermissionPrefs {
  /** per-tool levels everywhere */
  tools?: Record<string, Level>
  origins?: Partial<Record<PermOrigin, OriginPrefs>>
}

/** The read-back settings from .env that the defaults follow (DESKMATE_CONFIRM_SENDS / _JOBS). */
export interface ReadbackBase {
  /** always (default) | voice | never */
  sends: 'always' | 'voice' | 'never'
  /** unset: Claude Code jobs ask; always | voice | never when DESKMATE_CONFIRM_JOBS is set */
  jobs: 'always' | 'voice' | 'never' | null
}

export const DEFAULT_BASE: ReadbackBase = { sends: 'always', jobs: null }

export interface ToolFacts {
  name: string
  /** the risk of this call (risk(input) for tools whose risk depends on it) */
  risk: Risk | null
  /** the tool could ever be risky (for the permissions page's "risky" marker) */
  risky?: boolean
}

export interface Decision {
  level: Level
  /** where the level came from */
  source: 'default' | 'tool' | 'origin' | 'origin-floor'
  /** the user set this level themselves (an explicit allow turns her own read-back off for the tool) */
  explicit: boolean
  /** plain words for the log and the activity window ("asks: sends a message (default)") */
  why: string
}

const RANK: Record<Level, number> = { allow: 0, ask: 1, never: 2 }
export function stricter(a: Level, b: Level): Level {
  return RANK[a] >= RANK[b] ? a : b
}

/** Tools whose default is not the one their risk class gives. */
const TOOL_DEFAULTS: Record<string, Level> = {
  // A cancelled reminder can be put back with "undo that".
  cancel_reminder: 'allow',
  claude_code: 'ask',
  run_command: 'ask',
  run_skill_script: 'ask',
  trash_file: 'ask',
  // A file leaving the Mac is always read back (send_to_me does it itself, whatever the level).
  send_to_me: 'ask'
}

const RISK_WORDS: Record<Risk, string> = {
  send: 'sends something to someone',
  delete: 'deletes something',
  purchase: 'buys or pays for something',
  shell: 'runs a command on this Mac',
  external: 'changes something outside'
}

function readback(policy: 'always' | 'voice' | 'never', origin: PermOrigin): Level {
  if (policy === 'never') return 'allow'
  if (policy === 'voice') return origin === 'voice' ? 'ask' : 'allow'
  return 'ask'
}

/** The level a tool has before the user changes anything. */
export function defaultLevel(t: ToolFacts, origin: PermOrigin, base: ReadbackBase = DEFAULT_BASE): Level {
  if (t.name === 'claude_code') return base.jobs ? readback(base.jobs, origin) : 'ask'
  if (t.name in TOOL_DEFAULTS) return TOOL_DEFAULTS[t.name]
  if (!t.risk) return 'allow'
  if (t.risk === 'send') return readback(base.sends, origin)
  if (t.risk === 'external') return 'allow'
  return 'ask'
}

/** The level for one call: the origin's own setting for the tool, else the tool's, else the default; an origin's
 * floor for risky tools then makes it stricter. */
export function resolve(prefs: PermissionPrefs | undefined, t: ToolFacts, origin: PermOrigin, base: ReadbackBase = DEFAULT_BASE): Decision {
  const o = prefs?.origins?.[origin]
  const what = t.risk ? RISK_WORDS[t.risk] : 'only reads or is harmless'
  const own = o?.tools?.[t.name]
  if (own) return { level: own, source: 'origin', explicit: true, why: `${own} for ${t.name} from ${ORIGIN_LABELS[origin].toLowerCase()} (your setting)` }
  const set = prefs?.tools?.[t.name]
  let d: Decision = set
    ? { level: set, source: 'tool', explicit: true, why: `${set} for ${t.name} (your setting)` }
    : { level: defaultLevel(t, origin, base), source: 'default', explicit: false, why: `${defaultLevel(t, origin, base)}: ${what} (default)` }
  const floor = o?.risky
  if (floor && t.risk && RANK[floor] > RANK[d.level]) {
    d = { level: floor, source: 'origin-floor', explicit: true, why: `${floor}: risky tools from ${ORIGIN_LABELS[origin].toLowerCase()} (your setting)` }
  }
  return d
}

/** A copy of the prefs with one tool's level set (null clears it) for every origin, or for one. */
export function withLevel(prefs: PermissionPrefs | undefined, tool: string, level: Level | null, origin?: PermOrigin): PermissionPrefs {
  const next: PermissionPrefs = JSON.parse(JSON.stringify(prefs ?? {})) as PermissionPrefs
  if (origin) {
    const o = (next.origins ??= {})[origin] ?? {}
    const tools = { ...(o.tools ?? {}) }
    if (level) tools[tool] = level
    else delete tools[tool]
    next.origins[origin] = { ...o, tools }
  } else {
    const tools = { ...(next.tools ?? {}) }
    if (level) tools[tool] = level
    else delete tools[tool]
    next.tools = tools
  }
  return next
}

/** A copy of the prefs with an origin's floor for risky tools set (null clears it). */
export function withFloor(prefs: PermissionPrefs | undefined, origin: PermOrigin, floor: 'ask' | 'never' | null): PermissionPrefs {
  const next: PermissionPrefs = JSON.parse(JSON.stringify(prefs ?? {})) as PermissionPrefs
  const o = (next.origins ??= {})[origin] ?? {}
  next.origins[origin] = { ...o, risky: floor }
  return next
}

/** Only well-formed levels survive (settings.json is the user's to edit). */
export function cleanPrefs(raw: unknown): PermissionPrefs {
  const levels = (v: unknown): Record<string, Level> =>
    Object.fromEntries(Object.entries(v && typeof v === 'object' ? (v as Record<string, unknown>) : {}).filter((e): e is [string, Level] => LEVELS.includes(e[1] as Level)))
  const r = (raw && typeof raw === 'object' ? raw : {}) as PermissionPrefs
  const origins: PermissionPrefs['origins'] = {}
  for (const o of PERM_ORIGINS) {
    const p = r.origins?.[o]
    if (!p) continue
    origins[o] = { tools: levels(p.tools), risky: p.risky === 'ask' || p.risky === 'never' ? p.risky : null }
  }
  return { tools: levels(r.tools), origins }
}

/** The gate the agent core asks about each call (core.ts Gate): the user's prefs as they are now, resolved for the
 * call's risk and origin. */
export function makeGate(
  prefs: () => PermissionPrefs | undefined,
  base: ReadbackBase = DEFAULT_BASE
): (spec: { name: string; risk?: Risk | ((input: Record<string, unknown>) => Risk | null) }, input: Record<string, unknown>, origin: PermOrigin) => Decision {
  return (spec, input, origin) => {
    const risk = typeof spec.risk === 'function' ? spec.risk(input) : (spec.risk ?? null)
    return resolve(prefs(), { name: spec.name, risk }, origin, base)
  }
}
