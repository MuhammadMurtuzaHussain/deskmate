import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

/**
 * "What did I ask you about the dentist last week?": a full-text index (SQLite FTS5, built into Node and Electron as
 * node:sqlite) over everything she keeps in plain files: the chat archive (<user data>/chats/YYYY-MM-DD.jsonl), her
 * day logs (<user data>/log/YYYY-MM-DD.jsonl) and the plans with their step results (<user data>/plans/*.json).
 * The files stay the truth; the index is a cache next to them. Appended lines are read from where the last pass
 * stopped, a rewritten plan is indexed again, and a missing or broken database is rebuilt from the files.
 */

export type PastCategory = 'chat' | 'did' | 'plans'

export interface PastHit {
  at: number
  category: PastCategory
  /** you / her for chat, the log's kind (app, browse, plan, step, reminder…) otherwise */
  kind: string
  text: string
}

export interface PastSources {
  chats: string
  journal: string
  plans: string
}

const SCHEMA = 2

/** The words of a question as an FTS5 query: each word as a prefix, any of them (bm25 ranks those with more first). */
export function ftsQuery(query: string): string {
  const STOP = new Set(['the', 'and', 'for', 'you', 'did', 'what', 'when', 'about', 'ask', 'asked', 'tell', 'told', 'that', 'this', 'with', 'from', 'was', 'were', 'have', 'has', 'any', 'anything', 'last', 'week', 'yesterday', 'today', 'me', 'my', 'we', 'our', 'your', 'a', 'an', 'to', 'of', 'in', 'on', 'it', 'i', 'is', 'do'])
  const words = query
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
  const unique = [...new Set(words)].slice(0, 12)
  return unique.map((w) => `"${w}"*`).join(' OR ')
}

type Db = DatabaseSyncType

function openDb(path: string): Db {
  // Loaded when first needed, so a runtime without it only loses search, and a bundler leaves the built-in alone.
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) throw new Error('node:sqlite is not available in this runtime')
  return new sqlite.DatabaseSync(path)
}

export class PastIndex {
  private db: Db | null = null
  private readonly dbPath: string
  private readonly sources: PastSources

  constructor(dbPath: string, sources: PastSources) {
    this.dbPath = dbPath
    this.sources = sources
  }

  private open(): Db {
    if (this.db) return this.db
    mkdirSync(dirname(this.dbPath), { recursive: true })
    let db: Db
    try {
      db = openDb(this.dbPath)
      const v = this.version(db)
      if (v !== SCHEMA) {
        db.close()
        throw new Error(`schema ${v}`)
      }
    } catch {
      // Missing, old or broken: start over; the files hold everything.
      for (const f of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) rmSync(f, { force: true })
      db = openDb(this.dbPath)
      this.create(db)
    }
    this.db = db
    return db
  }

  private version(db: Db): number {
    try {
      const row = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v?: string } | undefined
      return Number(row?.v ?? 0)
    } catch {
      return 0
    }
  }

  private create(db: Db): void {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, src TEXT NOT NULL, at INTEGER NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS items_src ON items (src);
      CREATE INDEX IF NOT EXISTS items_at ON items (at);
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5 (text, content = 'items', content_rowid = 'id', tokenize = 'porter unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts (rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN INSERT INTO items_fts (items_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, offset INTEGER NOT NULL);
    `)
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").run(String(SCHEMA))
  }

  /** Brings the index up to date with the files; returns how many entries went in. Cheap when nothing changed. */
  sync(): number {
    const db = this.open()
    const insert = db.prepare('INSERT INTO items (src, at, category, kind, text) VALUES (?, ?, ?, ?, ?)')
    const getFile = db.prepare('SELECT size, mtime, offset FROM files WHERE path = ?')
    const setFile = db.prepare('INSERT OR REPLACE INTO files (path, size, mtime, offset) VALUES (?, ?, ?, ?)')
    const dropSrc = db.prepare('DELETE FROM items WHERE src = ?')
    let added = 0
    const seen = new Set<string>()

    const jsonl = (dir: string, category: PastCategory, toItem: (o: Record<string, unknown>) => { at: number; kind: string; text: string } | null): void => {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
        const path = join(dir, name)
        seen.add(path)
        const st = statSync(path)
        const prev = getFile.get(path) as { size: number; mtime: number; offset: number } | undefined
        if (prev && prev.size === st.size && prev.mtime === Math.round(st.mtimeMs)) continue
        let offset = prev?.offset ?? 0
        // Smaller than before: the file was rewritten, so it is read again from the top.
        if (prev && st.size < prev.offset) {
          dropSrc.run(path)
          offset = 0
        }
        const length = st.size - offset
        if (length <= 0) {
          setFile.run(path, st.size, Math.round(st.mtimeMs), offset)
          continue
        }
        const buf = Buffer.alloc(length)
        const fd = openSync(path, 'r')
        try {
          readSync(fd, buf, 0, length, offset)
        } finally {
          closeSync(fd)
        }
        // Only whole lines: a line still being written is picked up next time.
        const end = buf.lastIndexOf(0x0a)
        if (end < 0) continue
        for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            const item = toItem(JSON.parse(line) as Record<string, unknown>)
            if (item?.text) {
              insert.run(path, item.at, category, item.kind, item.text)
              added++
            }
          } catch {
            // a broken line is skipped
          }
        }
        setFile.run(path, st.size, Math.round(st.mtimeMs), offset + end + 1)
      }
    }

    db.exec('BEGIN')
    try {
      jsonl(this.sources.chats, 'chat', (o) => (typeof o.text === 'string' && typeof o.at === 'number' ? { at: o.at, kind: o.role === 'assistant' ? 'her' : 'you', text: o.text } : null))
      jsonl(this.sources.journal, 'did', (o) => (typeof o.text === 'string' && typeof o.at === 'number' ? { at: o.at, kind: String(o.kind ?? 'log'), text: o.text } : null))
      if (existsSync(this.sources.plans)) {
        for (const name of readdirSync(this.sources.plans)) {
          if (!name.endsWith('.json')) continue
          const path = join(this.sources.plans, name)
          seen.add(path)
          const st = statSync(path)
          const prev = getFile.get(path) as { size: number; mtime: number } | undefined
          if (prev && prev.size === st.size && prev.mtime === Math.round(st.mtimeMs)) continue
          dropSrc.run(path)
          try {
            const p = JSON.parse(readFileSync(path, 'utf8')) as { title?: string; goal?: string; createdAt?: number; status?: string; steps?: { text?: string; status?: string; result?: string }[] }
            const at = typeof p.createdAt === 'number' ? p.createdAt : Math.round(st.mtimeMs)
            const steps = (p.steps ?? []).map((s, i) => `${i + 1}. ${s.text ?? ''} (${s.status ?? 'pending'})${s.result ? `: ${s.result}` : ''}`).join('\n')
            insert.run(path, at, 'plans', String(p.status ?? 'plan'), `Plan "${p.title ?? ''}" for: ${p.goal ?? ''}\n${steps}`.slice(0, 4000))
            added++
          } catch {
            // not a plan
          }
          setFile.run(path, st.size, Math.round(st.mtimeMs), 0)
        }
      }
      // A file that went away takes its entries with it.
      for (const row of db.prepare('SELECT path FROM files').all() as { path: string }[]) {
        if (seen.has(row.path)) continue
        dropSrc.run(row.path)
        db.prepare('DELETE FROM files WHERE path = ?').run(row.path)
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return added
  }

  /** The best matches, newest first among equals. `query` '' lists the latest entries in the window. */
  search(query: string, opts: { category?: PastCategory; since?: number; limit?: number } = {}): PastHit[] {
    // Search sees what was written a moment ago too (a pass over unchanged files is a stat each).
    this.sync()
    const db = this.open()
    const limit = Math.max(1, Math.min(40, opts.limit ?? 10))
    const where: string[] = []
    const args: (string | number)[] = []
    if (opts.category) {
      where.push('i.category = ?')
      args.push(opts.category)
    }
    if (opts.since) {
      where.push('i.at >= ?')
      args.push(opts.since)
    }
    const fts = ftsQuery(query)
    if (fts) {
      const sql = `SELECT i.at, i.category, i.kind, i.text FROM items_fts JOIN items i ON i.id = items_fts.rowid WHERE items_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''} ORDER BY bm25(items_fts), i.at DESC LIMIT ?`
      return db.prepare(sql).all(fts, ...args, limit) as unknown as PastHit[]
    }
    const sql = `SELECT i.at, i.category, i.kind, i.text FROM items i${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY i.at DESC LIMIT ?`
    return db.prepare(sql).all(...args, limit) as unknown as PastHit[]
  }

  /** How many entries are indexed (for the log and Setup). */
  count(): number {
    const row = this.open().prepare('SELECT count(*) AS n FROM items').get() as { n: number }
    return row.n
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}

/** Hits as lines for her brain, with the day and time each happened. */
export function describeHits(hits: PastHit[], now = new Date()): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return hits
    .map((h) => {
      const d = new Date(h.at)
      const days = Math.round((today.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000)
      const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
      const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      const who = h.category === 'chat' ? (h.kind === 'her' ? 'you said' : 'they said') : h.category === 'plans' ? 'plan' : h.kind
      return `- ${when} ${time} · ${who}: ${h.text.replace(/\s+/g, ' ').slice(0, 400)}`
    })
    .join('\n')
}
