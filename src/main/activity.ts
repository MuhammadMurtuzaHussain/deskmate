import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Approval } from './core'
import type { Origin } from './tools'
import { redact, redactDeep } from './secrets.ts'
import { canUndo, undoLabel, type Undo } from './undo.ts'

/**
 * Every tool call she makes, written down: when, from where (voice, the command bar, a chat app, a schedule), which
 * tool with which arguments (secrets redacted), what came of it, who said yes, and why (the request the turn was
 * for). One JSON line per call in <user data>/activity/YYYY-MM-DD.jsonl, which the search index reads too
 * ("what did you do with my resume?"). The Activity window lists today's, with Undo where undo is honest.
 */

export interface ActivityEntry {
  id: string
  at: number
  origin: Origin | 'heartbeat'
  tool: string
  args: Record<string, unknown>
  ok: boolean
  /** what came of it, short */
  result: string
  approval: Approval
  /** the request the turn was for */
  why: string
  ms: number
  undo?: Undo
  /** when it was taken back */
  undone?: number
}

function day(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The argument that says most about a call, short ("sam: running late", "~/Documents/old.pdf"). */
export function mainDetail(tool: string, args: Record<string, unknown>, home = ''): string {
  const str = (k: string): string => (typeof args[k] === 'string' ? String(args[k]).trim() : '')
  if (tool === 'send_message' && str('to')) return `${str('to')}${str('app') ? ` on ${str('app')}` : ''}: ${str('text')}`
  if (tool === 'move_file' && str('from')) return `${str('from')} → ${str('to')}`
  for (const k of ['command', 'path', 'target', 'goal', 'query', 'instruction', 'text', 'task', 'what', 'prompt', 'to']) {
    const v = str(k)
    if (v) return home && v.startsWith(home) ? `~${v.slice(home.length)}` : v
  }
  const first = Object.values(args).find((v) => typeof v === 'string' && v.trim())
  return typeof first === 'string' ? first : ''
}

/** Tools whose calls are only looking, not doing: the window can hide them. */
export const LOOKING = new Set(['read_page', 'see_screen', 'list_reminders', 'list_jobs', 'calendar', 'recall_day', 'recent_messages', 'search_past', 'read_skill', 'recent_actions', 'claude_jobs'])

export class ActivityLog {
  private seq = 0
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /** Writes one call down (redacted) and returns it with its id. */
  add(e: Omit<ActivityEntry, 'id'>): ActivityEntry {
    const entry: ActivityEntry = {
      ...e,
      id: `${e.at.toString(36)}-${(this.seq++).toString(36)}`,
      args: redactDeep(trimArgs(e.args)),
      result: redact(e.result).slice(0, 400),
      why: redact(e.why).slice(0, 240)
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, `${day(new Date(e.at))}.jsonl`), `${JSON.stringify(entry)}\n`)
    } catch (err) {
      console.warn('[activity]', (err as Error).message)
    }
    return entry
  }

  /** A day's calls, oldest first, with undone ones marked: 0 today, -1 yesterday. */
  read(offsetDays = 0, now = new Date()): ActivityEntry[] {
    const d = new Date(now)
    d.setDate(d.getDate() + offsetDays)
    const p = join(this.dir, `${day(d)}.jsonl`)
    if (!existsSync(p)) return []
    const out: ActivityEntry[] = []
    const undone = new Map<string, number>()
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line) as ActivityEntry & { undid?: string }
        if (o.undid) undone.set(o.undid, o.at)
        else if (o.tool) out.push(o)
      } catch {
        // a broken line is skipped
      }
    }
    for (const e of out) if (undone.has(e.id)) e.undone = undone.get(e.id)
    return out
  }

  /** The last calls today and yesterday, newest last. */
  recent(n = 10, now = new Date()): ActivityEntry[] {
    return [...this.read(-1, now), ...this.read(0, now)].slice(-n)
  }

  find(id: string, now = new Date()): ActivityEntry | null {
    return [...this.read(0, now), ...this.read(-1, now)].find((e) => e.id === id) ?? null
  }

  /** The newest call that can still be undone (today or yesterday). */
  lastUndoable(now = new Date()): ActivityEntry | null {
    const all = [...this.read(-1, now), ...this.read(0, now)]
    for (let i = all.length - 1; i >= 0; i--) if (canUndo(all[i].undo) && !all[i].undone && all[i].ok) return all[i]
    return null
  }

  /** Notes that a call was taken back (a line of its own: the log is append-only). */
  markUndone(entry: ActivityEntry, at = Date.now()): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, `${day(new Date(entry.at))}.jsonl`), `${JSON.stringify({ undid: entry.id, at })}\n`)
    } catch (err) {
      console.warn('[activity]', (err as Error).message)
    }
  }
}

/** Arguments as stored: long strings cut, nothing huge. */
function trimArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === 'string') out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v
    else if (Array.isArray(v)) out[k] = v.slice(0, 20)
    else out[k] = v
  }
  return out
}

const APPROVAL_WORDS: Record<Approval, string> = {
  auto: 'on its own',
  asked: 'after your yes',
  readback: 'after reading it back',
  refused: 'you said no',
  blocked: 'switched off',
  waiting: 'waiting for you'
}

export function approvalText(a: Approval): string {
  return APPROVAL_WORDS[a] ?? a
}

/** "Moved Resume.pdf to the Trash" style line: the tool, its main argument, how it went. */
export function entryLine(e: ActivityEntry): string {
  const raw = Object.values(e.args).find((v) => typeof v === 'string' && v.trim()) as string | undefined
  // A full path reads as its file name.
  const main = raw && /^(?:\/|~\/)[^\s]*\/[^/]+$/.test(raw.trim()) ? raw.trim().split('/').pop() : raw
  const t = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const status = e.undone ? 'undone' : e.approval === 'refused' || e.approval === 'blocked' || e.approval === 'waiting' ? approvalText(e.approval) : e.ok ? 'done' : 'failed'
  return `${t} ${e.tool}${main ? ` "${main.slice(0, 60)}"` : ''}: ${status}${e.ok && !e.undone && e.approval !== 'auto' ? ` (${approvalText(e.approval)})` : ''}${e.undo ? `; ${canUndo(e.undo) && !e.undone ? `undo would ${undoLabel(e.undo)}` : e.undo.kind === 'none' ? undoLabel(e.undo) : ''}` : ''}`
}

/** For "what did you just do?": the calls of the last turn (or the last few), as plain lines. */
export function describeRecent(entries: ActivityEntry[]): string {
  const doing = entries.filter((e) => !LOOKING.has(e.tool))
  const list = doing.length ? doing : entries
  if (!list.length) return 'Nothing yet today.'
  return list.map((e) => `${entryLine(e)}${e.why ? ` — for "${e.why.slice(0, 80)}"` : ''}`).join('\n')
}
