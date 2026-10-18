import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What she did, by day: one line per thing that happened on the computer (a message sent, a plan run, a Claude job
 * finished, a file found), in <user data>/log/YYYY-MM-DD.jsonl. "What did you do today?" reads it back.
 */

export interface JournalEntry {
  at: number
  kind: string
  text: string
}

function day(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export class Journal {
  constructor(private readonly dir: string) {}

  add(kind: string, text: string): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, `${day()}.jsonl`), `${JSON.stringify({ at: Date.now(), kind, text: text.slice(0, 400) })}\n`)
    } catch (err) {
      console.warn('[journal]', (err as Error).message)
    }
  }

  /** Entries for a day: 0 today, -1 yesterday. */
  read(offsetDays = 0): JournalEntry[] {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    const p = join(this.dir, `${day(d)}.jsonl`)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as JournalEntry]
        } catch {
          return []
        }
      })
  }

  /** The day as plain lines with times, for her brain to tell back. */
  describe(offsetDays = 0): string {
    const entries = this.read(offsetDays)
    if (!entries.length) return ''
    return entries
      .map((e) => `${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${e.kind}: ${e.text}`)
      .join('\n')
  }
}
