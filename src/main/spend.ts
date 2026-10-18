import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The spending meter: every Anthropic (and Gemini) call's tokens, split into uncached input, cache reads, cache
 * writes and output, priced from a table per model, kept per month in <user data>/spend/YYYY-MM.jsonl. Today and this
 * month show in the tray and Setup, broken down by where the call came from (chat at the desk, a chat app, scheduled
 * jobs, the heartbeat, background looks). A monthly budget warns at 80% and stops at 100% until the user says to
 * go on. The prices are estimates for display; the provider's bill is the truth.
 */

/** US dollars per million tokens. */
export interface Price {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const p = (input: number, output: number, cacheRead = input / 10, cacheWrite = input * 1.25): Price => ({ input, output, cacheRead, cacheWrite })

/** Anthropic list prices (first-party API, October 2026); Gemini paid-tier prices, where known. Longest prefix wins. */
export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': p(10, 50, 0.25),
  'claude-fable-5': p(10, 50),
  'claude-mythos-5': p(10, 50),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25),
  'claude-opus-4': p(5, 25),
  'claude-sonnet-5-5': p(2, 10, 0.2),
  'claude-sonnet-5': p(2, 10),
  'claude-sonnet-4': p(3, 15),
  'claude-haiku-5-5': p(0.1, 0.5),
  'claude-haiku-4': p(1, 5),
  'claude-3-5-haiku': p(0.8, 4),
  'gemini-2.5-pro': p(1.25, 10, 0.31, 1.25),
  'gemini-2.5-flash-lite': p(0.1, 0.4, 0.025, 0.1),
  'gemini-2.5-flash': p(0.3, 2.5, 0.075, 0.3),
  'gemini-2.0-flash': p(0.1, 0.4, 0.025, 0.1),
  // Newer Gemini Flash models: an estimate until the table is updated (prices.json in user data overrides it).
  'gemini-flash': p(0.5, 3, 0.05, 0.5)
}

/** The price for a model id: the longest table key it starts with; Gemini "…-flash" models fall back to the
 * generic Flash row. Null when unknown (the call is counted, at $0, and marked unpriced). */
export function priceFor(model: string, table: Record<string, Price> = PRICES): Price | null {
  const m = model.toLowerCase().replace(/^models\//, '')
  let best: string | null = null
  for (const k of Object.keys(table)) if (m.startsWith(k) && (!best || k.length > best.length)) best = k
  if (best) return table[best]
  if (/^gemini-.*flash/.test(m) && table['gemini-flash']) return table['gemini-flash']
  return null
}

export interface Usage {
  /** uncached input tokens */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Dollars for one call. */
export function costOf(model: string, u: Usage, table: Record<string, Price> = PRICES): number {
  const price = priceFor(model, table)
  if (!price) return 0
  return (u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead + u.cacheWrite * price.cacheWrite) / 1_000_000
}

/** An Anthropic response's usage as a Usage. */
export function anthropicUsage(u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): Usage {
  return { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0 }
}

/** A Gemini response's usageMetadata as a Usage (thinking is billed as output; the prompt count includes the cached). */
export function geminiUsage(u: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number } | undefined): Usage {
  const cached = u?.cachedContentTokenCount ?? 0
  return { input: Math.max(0, (u?.promptTokenCount ?? 0) - cached), output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0), cacheRead: cached, cacheWrite: 0 }
}

/** Where a call came from, for the breakdown. */
export type SpendOrigin = 'chat' | 'channel' | 'schedule' | 'heartbeat' | 'background'
export const SPEND_ORIGINS: SpendOrigin[] = ['chat', 'channel', 'schedule', 'heartbeat', 'background']
export const SPEND_LABELS: Record<SpendOrigin, string> = { chat: 'chat at the desk', channel: 'chat apps', schedule: 'scheduled jobs', heartbeat: 'heartbeat', background: 'looking and learning' }

const where = new AsyncLocalStorage<SpendOrigin>()

/** Runs fn with its model calls counted under this origin. */
export function withSpendOrigin<T>(origin: SpendOrigin, fn: () => T): T {
  return where.run(origin, fn)
}

export function spendOrigin(): SpendOrigin {
  return where.getStore() ?? 'chat'
}

export interface SpendRecord extends Usage {
  at: number
  model: string
  origin: SpendOrigin
  cost: number
  /** no price for this model */
  unpriced?: boolean
}

export interface SpendTotals {
  today: number
  month: number
  calls: number
  byOrigin: Record<SpendOrigin, number>
  tokens: Usage
  unpriced: number
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export type BudgetState = 'none' | 'ok' | 'warn' | 'over'

/** 80% of the budget warns; 100% stops. */
export function budgetState(spent: number, budget: number): BudgetState {
  if (!budget || budget <= 0) return 'none'
  if (spent >= budget) return 'over'
  if (spent >= budget * 0.8) return 'warn'
  return 'ok'
}

/** Before a call: go, ask the user (at 100% from the desk or a chat app), or stop (at 100% with nobody asking:
 * a schedule, the heartbeat, a background look). Once the user says go on, the rest of that month goes. */
export function budgetDecision(a: { spent: number; budget: number; month: string; overMonth?: string; origin: SpendOrigin }): 'go' | 'ask' | 'stop' {
  if (budgetState(a.spent, a.budget) !== 'over' || a.overMonth === a.month) return 'go'
  return a.origin === 'chat' || a.origin === 'channel' ? 'ask' : 'stop'
}

export function dollars(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(n < 100 ? 1 : 0)}`
}

export class SpendMeter {
  private cache: { month: string; records: SpendRecord[] } | null = null
  table: Record<string, Price>

  private readonly dir: string

  constructor(dir: string, opts: { table?: Record<string, Price> } = {}) {
    this.dir = dir
    this.table = { ...PRICES, ...(opts.table ?? {}) }
  }

  /** Counts one call. */
  record(model: string, usage: Usage, origin: SpendOrigin = spendOrigin(), at = Date.now()): SpendRecord {
    const unpriced = !priceFor(model, this.table)
    const rec: SpendRecord = { at, model, origin, ...usage, cost: costOf(model, usage, this.table), ...(unpriced ? { unpriced } : {}) }
    const month = monthKey(new Date(at))
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, `${month}.jsonl`), `${JSON.stringify(rec)}\n`)
    } catch (err) {
      console.warn('[spend]', (err as Error).message)
    }
    if (this.cache?.month === month) this.cache.records.push(rec)
    return rec
  }

  private month(now: Date): SpendRecord[] {
    const key = monthKey(now)
    if (this.cache?.month === key) return this.cache.records
    const path = join(this.dir, `${key}.jsonl`)
    const records: SpendRecord[] = []
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line) as SpendRecord)
        } catch {
          // a broken line is skipped
        }
      }
    }
    this.cache = { month: key, records }
    return records
  }

  totals(now = new Date()): SpendTotals {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const byOrigin = Object.fromEntries(SPEND_ORIGINS.map((o) => [o, 0])) as Record<SpendOrigin, number>
    const tokens: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let today = 0
    let month = 0
    let unpriced = 0
    const records = this.month(now)
    for (const r of records) {
      month += r.cost
      if (r.at >= start) today += r.cost
      byOrigin[r.origin in byOrigin ? r.origin : 'chat'] += r.cost
      tokens.input += r.input
      tokens.output += r.output
      tokens.cacheRead += r.cacheRead
      tokens.cacheWrite += r.cacheWrite
      if (r.unpriced) unpriced++
    }
    return { today, month, calls: records.length, byOrigin, tokens, unpriced }
  }

  monthKey(now = new Date()): string {
    return monthKey(now)
  }
}
