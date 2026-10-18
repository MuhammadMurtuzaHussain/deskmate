import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { sameHandle } from './hub.ts'
import type { Channel, ChannelEvents, Inbound, OutFile } from './channel.ts'

// iMessage, on the user's own Apple ID: she reads the Messages database (~/Library/Messages/chat.db, which macOS only
// opens to apps with Full Disk Access) for rows newer than the last one she saw, and answers through the Messages
// AppleScript path apps.ts already uses. Only two kinds of message ever reach the hub:
// - one the user sent to themself (a note-to-self chat whose other end is one of their own handles), and
// - one that came in from a handle on the allowlist in Setup (their second number, their other Apple ID).
// Messages that came in count only over iMessage, whose senders Apple checks: an SMS sender can be spoofed.
// Every other row is skipped here without being logged: nobody else's texts are read past the row's sender, and
// nobody who is not on the list is ever answered.

export const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db')

/** Apple counts from 2001-01-01; modern chat.db dates are in nanoseconds, older ones in seconds. */
const APPLE_EPOCH_MS = 978_307_200_000

export function appleDateMs(date: number | bigint | null | undefined): number {
  const d = Number(date ?? 0)
  if (!d) return 0
  return APPLE_EPOCH_MS + (d > 1e11 ? d / 1e6 : d * 1000)
}

/**
 * The plain text inside a message's attributedBody (an NSAttributedString in Apple's old "typedstream" format), for
 * rows whose text column is empty, as it is for most messages on recent macOS. The string follows the NSString
 * class name: a few bytes of type info, then its length (one byte, or 0x81 and two bytes little-endian, or 0x82 and
 * three), then the UTF-8 text.
 */
export function attributedText(body: Uint8Array | null | undefined): string {
  if (!body || body.length < 16) return ''
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
  const marker = new TextEncoder().encode('NSString')
  let at = -1
  outer: for (let i = 0; i + marker.length <= bytes.length; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer
    at = i + marker.length
    break
  }
  if (at < 0) return ''
  // "\x01\x94\x84\x01+" (or close to it) sits between the class name and the length: skip to the '+' (0x2b).
  let p = at
  const stop = Math.min(bytes.length, at + 12)
  while (p < stop && bytes[p] !== 0x2b) p++
  if (p >= stop) return ''
  p++
  let len = bytes[p]
  p++
  if (len === 0x81) {
    len = bytes[p] | (bytes[p + 1] << 8)
    p += 2
  } else if (len === 0x82) {
    len = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)
    p += 3
  }
  if (p + len > bytes.length) len = bytes.length - p
  return new TextDecoder().decode(bytes.subarray(p, p + len)).replace(/￼/g, '').trim()
}

/** One row of chat.db as she reads it. */
export interface ChatRow {
  rowid: number
  text: string
  fromMe: boolean
  /** the other end's handle for a message that came in ('' for one the user sent) */
  handle: string
  /** the chat's guid ("iMessage;-;+15551234567"), which the AppleScript send takes as the chat id */
  chatGuid: string
  /** the other end of a one-to-one chat (a phone number or an email) */
  chatIdentifier: string
  /** one-to-one (45) or group (43) */
  direct: boolean
  /** "iMessage", "SMS" or "RCS": only iMessage senders are checked by Apple, an SMS sender can be spoofed */
  service: string
  at: number
  /** a voice message (an audio attachment) and where its file is */
  audio: { path: string; mime: string } | null
}

const ROWS = `SELECT m.ROWID AS rowid, m.text AS text, m.attributedBody AS body, m.is_from_me AS fromMe, m.date AS date, COALESCE(m.service, '') AS service,
  COALESCE(m.is_audio_message, 0) AS audio, COALESCE(m.associated_message_type, 0) AS assoc, COALESCE(m.item_type, 0) AS itemType,
  h.id AS handle, c.guid AS chatGuid, c.chat_identifier AS chatIdentifier, c.style AS style
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.ROWID > ?
ORDER BY m.ROWID
LIMIT 200`

const AUDIO = `SELECT a.filename AS filename, a.mime_type AS mime FROM message_attachment_join maj
JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id = ? LIMIT 1`

function openDb(path: string): DatabaseSync {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) throw new Error('node:sqlite is not available in this runtime')
  return new sqlite.DatabaseSync(path, { readOnly: true })
}

/** Reads chat.db (or a copy of its tables, in the tests) from a row on. Read-only: nothing is ever written. */
export class ChatDb {
  private db: DatabaseSync | null = null
  readonly path: string

  constructor(path = CHAT_DB) {
    this.path = path
  }

  private open(): DatabaseSync {
    this.db ??= openDb(this.path)
    return this.db
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // already closed
    }
    this.db = null
  }

  /** The newest row now: she starts reading after it, so nothing old is ever acted on. */
  latest(): number {
    const r = this.open().prepare('SELECT COALESCE(MAX(ROWID), 0) AS n FROM message').get() as { n: number | bigint }
    return Number(r.n)
  }

  /** Rows after `rowid`, oldest first; reactions, edits and system rows are left out. */
  since(rowid: number): ChatRow[] {
    const db = this.open()
    // Dates are nanoseconds since 2001: past 2^53, so they are read as BigInts (as plain numbers they would throw).
    const stmt = db.prepare(ROWS)
    stmt.setReadBigInts(true)
    const rows = stmt.all(rowid) as {
      rowid: number | bigint
      text: string | null
      body: Uint8Array | null
      fromMe: number | bigint
      date: number | bigint
      service: string
      audio: number | bigint
      assoc: number | bigint
      itemType: number | bigint
      handle: string | null
      chatGuid: string | null
      chatIdentifier: string | null
      style: number | bigint | null
    }[]
    const out: ChatRow[] = []
    for (const r of rows) {
      // Tapbacks and other "associated" rows, group renames and such: not messages to act on.
      if (Number(r.assoc) !== 0 || Number(r.itemType) !== 0) {
        out.push({ rowid: Number(r.rowid), text: '', fromMe: false, handle: '', chatGuid: '', chatIdentifier: '', direct: false, service: '', at: 0, audio: null })
        continue
      }
      let audio: ChatRow['audio'] = null
      if (Number(r.audio)) {
        const a = db.prepare(AUDIO).get(r.rowid) as { filename: string | null; mime: string | null } | undefined
        if (a?.filename) audio = { path: a.filename.replace(/^~(?=\/)/, homedir()), mime: a.mime || 'audio/x-caf' }
      }
      out.push({
        rowid: Number(r.rowid),
        text: (r.text ?? '').replace(/￼/g, '').trim() || attributedText(r.body),
        fromMe: Number(r.fromMe) === 1,
        handle: r.handle ?? '',
        chatGuid: r.chatGuid ?? '',
        chatIdentifier: r.chatIdentifier ?? '',
        direct: Number(r.style ?? 45) === 45,
        service: r.service,
        at: appleDateMs(r.date),
        audio
      })
    }
    return out
  }
}

/** Whether she may read chat.db, and what to tell the user when not. */
export function chatDbAccess(path = CHAT_DB): { ok: boolean; reason?: string } {
  if (process.platform !== 'darwin') return { ok: false, reason: 'iMessage is only on macOS.' }
  try {
    // Without Full Disk Access the open itself is refused (EPERM), even though the file is the user's.
    const fd = openSync(path, 'r')
    try {
      readSync(fd, Buffer.alloc(16), 0, 16, 0)
    } finally {
      closeSync(fd)
    }
    return { ok: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && !existsSync(join(homedir(), 'Library', 'Messages'))) return { ok: false, reason: 'Messages has never been set up on this Mac: open Messages and sign in with your Apple ID first.' }
    return {
      ok: false,
      reason: 'macOS keeps the Messages database private. System Settings → Privacy & Security → Full Disk Access → turn on Deskmate (Electron when run from source), then switch iMessage off and on here.'
    }
  }
}

export interface IMessageDeps {
  db: ChatDb
  /** the handles that count as the user (their own number and Apple ID, a second number): read each poll */
  handles(): string[]
  /** sends a line (and a file, by path) to a chat by its guid, through the Messages AppleScript */
  send(chatGuid: string, text: string, file?: OutFile): Promise<void>
  /** checks Full Disk Access (the real check in the app; true in the tests) */
  access?(): { ok: boolean; reason?: string }
  pollMs?: number
  now?(): number
}

/** How long a line she sent counts as hers when it shows up again in chat.db (sent and delivered rows both do). */
const ECHO_MS = 3 * 60_000
/** A note to self shows up twice (the sent copy and the received copy): the second within this is the same one. */
const TWIN_MS = 15_000

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase()

export class IMessageChannel implements Channel {
  readonly id = 'imessage' as const
  readonly pairing = 'allowlist' as const
  readonly answersStrangers = false
  readonly limit = 4000
  readonly account: string | null = null
  private readonly deps: IMessageDeps
  private timer: NodeJS.Timeout | null = null
  private last = 0
  private events: ChannelEvents | null = null
  /** what she sent lately, so her own lines coming back through chat.db are not read as the user's */
  private sent: { text: string; at: number }[] = []
  /** notes to self already passed on, so the twin row is not */
  private seen: { text: string; chat: string; at: number }[] = []

  constructor(deps: IMessageDeps) {
    this.deps = deps
  }

  get running(): boolean {
    return Boolean(this.timer)
  }

  start(events: ChannelEvents): void {
    if (this.timer) return
    this.events = events
    const access = (this.deps.access ?? chatDbAccess)()
    if (!access.ok) {
      events.fatal(access.reason ?? 'Deskmate cannot read the Messages database.')
      return
    }
    try {
      this.last = this.deps.db.latest()
    } catch (err) {
      events.fatal(`Could not read the Messages database: ${(err as Error).message}`)
      return
    }
    events.log(`reading Messages from row ${this.last}`)
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.deps.db.close()
  }

  /** One look for new rows (the timer calls it; the tests call it directly). */
  poll(): void {
    let rows: ChatRow[]
    try {
      rows = this.deps.db.since(this.last)
    } catch (err) {
      // The database is busy being written or was swapped: the next poll reopens it.
      this.deps.db.close()
      this.events?.log(`chat.db: ${(err as Error).message}`)
      return
    }
    for (const r of rows) {
      this.last = Math.max(this.last, r.rowid)
      const m = this.inbound(r)
      if (m) this.events?.inbound(m)
    }
  }

  /** The row as a message for the hub, or null when it is not one of the user's own. */
  inbound(r: ChatRow): Inbound | null {
    if (!r.chatGuid || !r.direct || (!r.text && !r.audio)) return null
    const handles = this.deps.handles()
    const mine = (h: string): boolean => handles.some((x) => sameHandle(x, h))
    const now = this.deps.now?.() ?? Date.now()
    let self = false
    if (r.fromMe) {
      // Something the user sent: only a note to self counts, never a text to anyone else.
      if (!mine(r.chatIdentifier)) return null
      self = true
    } else if (!mine(r.handle) || r.service !== 'iMessage') return null
    // (A text message's sender can be forged, so even an SMS "from" one of their own numbers is not theirs.)
    this.sent = this.sent.filter((s) => now - s.at < ECHO_MS)
    const text = norm(r.text)
    if (text && this.sent.some((s) => s.text === text)) return null
    this.seen = this.seen.filter((s) => now - s.at < TWIN_MS)
    if (text && this.seen.some((s) => s.text === text && s.chat === r.chatIdentifier)) return null
    if (text) this.seen.push({ text, chat: r.chatIdentifier, at: now })
    const audio = r.audio
    return {
      chat: r.chatGuid,
      from: { id: self ? r.chatIdentifier : r.handle, name: self ? 'you (note to self)' : r.handle },
      text: r.text,
      voice: audio ? { mime: audio.mime, fetch: async () => new Uint8Array(readFileSync(audio.path)) } : undefined,
      at: r.at || now,
      direct: true,
      self
    }
  }

  private remember(text: string): void {
    const t = norm(text)
    if (t) this.sent.push({ text: t, at: this.deps.now?.() ?? Date.now() })
  }

  async sendText(chat: string, text: string, opts: { ask?: boolean } = {}): Promise<void> {
    const line = opts.ask ? `${text} (yes / no)` : text
    this.remember(line)
    await this.deps.send(chat, line)
  }

  async sendImage(chat: string, png: Uint8Array, caption?: string): Promise<void> {
    if (caption) this.remember(caption)
    await this.deps.send(chat, caption ?? '', { name: 'deskmate.png', bytes: png, mime: 'image/png' })
  }

  async sendFile(chat: string, file: OutFile, caption?: string): Promise<void> {
    if (caption) this.remember(caption)
    await this.deps.send(chat, caption ?? '', file)
  }
}
