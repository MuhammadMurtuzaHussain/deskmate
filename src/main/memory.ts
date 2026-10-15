import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
}

const DAY = 86_400_000
/** How long a fact of a given importance survives without being recalled. */
const TTL: Record<number, number> = { 1: 3 * DAY, 2: 10 * DAY, 3: 45 * DAY, 4: 365 * DAY, 5: Infinity }

/**
 * Tiered memory, the small-town version of what Kyndred describes:
 * short-term = recent turns; long-term = facts with an importance score and graded forgetting.
 * No vector DB: with a few hundred facts, importance + recency is enough.
 */
export class Memory {
  private store: Store = { facts: [], history: [] }

  constructor(private readonly path: string) {
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
    this.store.history.push({ role, text, ts: Date.now() })
    this.store.history = this.store.history.slice(-40)
    this.save()
  }

  remember(items: { text: string; importance: number }[]): void {
    const now = Date.now()
    for (const item of items) {
      const text = item.text.trim()
      if (!text) continue
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
