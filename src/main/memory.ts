import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { guessSection, type MemoryFiles, type MemorySection } from './memfiles.ts'
import { looksSecret, redact } from './secrets.ts'

export interface Fact {
  text: string
  /** 1 = small talk (fades in days), 3 = useful (weeks), 5 = defining (forever) */
  importance: number
  created: number
  lastRecalled: number
}

export interface Turn {
  role: 'user' | 'assistant'
  text: string
  ts: number
}

interface Store {
  facts: Fact[]
  history: Turn[]
  /** the facts worth keeping moved to USER.md / MEMORY.md once (memfiles.ts) */
  movedToFiles?: boolean
}

export interface MemoryOptions {
  /** USER.md and MEMORY.md: facts of importance 3 and up go there, and into every prompt */
  files?: MemoryFiles
  /** every turn is also appended to <dir>/YYYY-MM-DD.jsonl, the chat archive search_past reads (the JSON keeps 40) */
  archiveDir?: string
}

function day(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const DAY = 86_400_000
/** How long a fact of a given importance survives without being recalled. */
const TTL: Record<number, number> = { 1: 3 * DAY, 2: 10 * DAY, 3: 45 * DAY, 4: 365 * DAY, 5: Infinity }

/**
 * Tiered memory: short-term = recent turns; small talk = facts with an importance score and graded forgetting;
 * long-term = USER.md and MEMORY.md (memfiles.ts), plain Markdown the user can edit. Remembering something of
 * importance 3 or more writes it to those files; 1 and 2 fade here in days unless they come up again.
 */
export class Memory {
  private store: Store = { facts: [], history: [] }
  readonly files?: MemoryFiles
  private readonly archiveDir?: string
  private readonly path: string

  constructor(path: string, opts: MemoryOptions = {}) {
    this.path = path
    this.files = opts.files
    this.archiveDir = opts.archiveDir
    this.load()
    this.decay()
  }

  private load(): void {
    try {
      if (existsSync(this.path)) this.store = JSON.parse(readFileSync(this.path, 'utf8')) as Store
    } catch {
      this.store = { facts: [], history: [] }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.store, null, 2))
  }

  /** Forget what a person would forget. */
  private decay(): void {
    const now = Date.now()
    this.store.facts = this.store.facts.filter((f) => {
      const ttl = TTL[Math.min(5, Math.max(1, Math.round(f.importance)))] ?? TTL[3]
      return now - f.lastRecalled < ttl
    })
    this.store.history = this.store.history.slice(-40)
    this.save()
  }

  /** Forget everything: facts and history. */
  clear(): void {
    this.store = { facts: [], history: [] }
    this.save()
  }

  recentTurns(n = 16): Turn[] {
    return this.store.history.slice(-n)
  }

  addTurn(role: Turn['role'], text: string): void {
    const ts = Date.now()
    this.store.history.push({ role, text, ts })
    this.store.history = this.store.history.slice(-40)
    this.save()
    // The archive keeps what was said; "[you used: …]" and the other bracketed notes are in the day log already.
    if (this.archiveDir && !/^\[[^]*\]$/.test(text.trim())) {
      try {
        mkdirSync(this.archiveDir, { recursive: true })
        appendFileSync(join(this.archiveDir, `${day(ts)}.jsonl`), `${JSON.stringify({ at: ts, role, text: redact(text.slice(0, 2000)) })}\n`)
      } catch (err) {
        console.warn('[memory] archive:', (err as Error).message)
      }
    }
  }

  /** Keeps facts: importance 3 and up in USER.md / MEMORY.md (when the files are set), the rest here, fading. */
  remember(items: { text: string; importance: number; section?: MemorySection }[]): { ok: boolean; text: string }[] {
    const now = Date.now()
    const out: { ok: boolean; text: string }[] = []
    for (const item of items) {
      const text = item.text.trim()
      if (!text) continue
      // Keys and passwords never go into her memory, whichever brain picked the fact.
      if (looksSecret(text)) {
        out.push({ ok: false, text: 'Not kept: it holds a key, token or password.' })
        continue
      }
      if (this.files && item.importance >= 3) {
        out.push(this.files.add(text, item.section ?? guessSection(text)))
        continue
      }
      out.push({ ok: true, text: 'Kept for now (small talk fades in a few days unless it comes up again).' })
      const existing = this.store.facts.find((f) => f.text.toLowerCase() === text.toLowerCase())
      if (existing) {
        existing.lastRecalled = now
        existing.importance = Math.max(existing.importance, item.importance)
      } else {
        this.store.facts.push({ text, importance: item.importance, created: now, lastRecalled: now })
      }
    }
    this.store.facts.sort((a, b) => b.importance - a.importance || b.lastRecalled - a.lastRecalled)
    this.store.facts = this.store.facts.slice(0, 300)
    this.save()
    return out
  }

  /** Drops a fading fact that `query` names (a piece of its text); true when one went. */
  forget(query: string): string | null {
    const q = query.toLowerCase().trim()
    if (!q) return null
    const i = this.store.facts.findIndex((f) => f.text.toLowerCase().includes(q))
    if (i < 0) return null
    const [gone] = this.store.facts.splice(i, 1)
    this.save()
    return gone.text
  }

  /** Once: hands the facts of importance 3 and up to USER.md / MEMORY.md and keeps only the fading ones here. */
  moveToFiles(): number {
    if (!this.files || this.store.movedToFiles) return 0
    const keep: Fact[] = []
    let moved = 0
    for (const f of this.store.facts) {
      if (f.importance >= 3 && this.files.add(f.text, guessSection(f.text)).ok) moved++
      else keep.push(f)
    }
    this.store.facts = keep
    this.store.movedToFiles = true
    this.save()
    return moved
  }

  /** USER.md and MEMORY.md for a system prompt ('' when both are empty). */
  notesBlock(): string {
    const files = this.files?.prompt()
    return files ? `Your notes (yours to keep up to date with remember, update_memory and forget):\n${files}` : ''
  }

  /** The fading facts for a system prompt ('' when there are none). Recalling refreshes them. */
  recentBlock(limit = 25): string {
    const facts = this.recall(limit)
    if (!facts.length) return ''
    return `${this.files ? 'Lately, in passing' : 'What you remember about this person'} (importance in brackets; small things fade):\n${facts.map((f) => `- [${f.importance}] ${f.text}`).join('\n')}`
  }

  /** Everything she remembers, for one system prompt (the older brains). */
  promptBlock(limit = 25): string {
    return [this.notesBlock(), this.recentBlock(limit)].filter(Boolean).join('\n\n') || 'You do not know this person yet.'
  }

  /** Top facts for the prompt: importance first, then recency. Recalling refreshes them. */
  recall(limit = 25): Fact[] {
    const now = Date.now()
    const picked = [...this.store.facts]
      .sort((a, b) => b.importance - a.importance || b.lastRecalled - a.lastRecalled)
      .slice(0, limit)
    for (const f of picked) f.lastRecalled = now
    return picked
  }
}
