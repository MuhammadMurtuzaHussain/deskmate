// The chat apps she can be reached through (Telegram, Discord, iMessage, Slack, Signal). Each one is a Channel: it
// connects, turns what arrives into Inbound messages, and sends text, pictures and files back. Everything about who
// may talk to her (pairing, the owner allowlist, strangers, old messages, commands) lives in the hub (hub.ts), the
// same for every channel. No Electron in here, so the tests drive channels with fake APIs.

export type ChannelId = 'telegram' | 'discord' | 'imessage' | 'slack' | 'signal' | 'whatsapp'

/** The order they show in Setup and the tray. */
export const CHANNEL_IDS: ChannelId[] = ['telegram', 'discord', 'imessage', 'slack', 'signal', 'whatsapp']

export const CHANNEL_LABELS: Record<ChannelId, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  imessage: 'iMessage',
  slack: 'Slack',
  signal: 'Signal',
  whatsapp: 'WhatsApp'
}

/**
 * How someone becomes the owner on a channel:
 * - ask: they send /start and the user says yes on the Mac (Telegram)
 * - code: they send the code the Mac shows while pairing is open (Discord, Slack)
 * - allowlist: the handles typed into Setup, plus the user's own account writing to itself (iMessage, Signal)
 */
export type PairingKind = 'ask' | 'code' | 'allowlist'

export interface Sender {
  /** the account id on that service (a Telegram user id, a Discord snowflake, an iMessage handle) */
  id: string
  name: string
}

/** A voice note or audio clip, fetched when it is needed. */
export interface VoiceNote {
  mime: string
  fetch(): Promise<Uint8Array>
}

export interface Inbound {
  /** where replies go: the chat, DM channel or conversation id */
  chat: string
  from: Sender
  /** the text, or '' for a voice note without words */
  text: string
  voice?: VoiceNote
  /** when it was sent (ms since 1970) */
  at: number
  /** a one-to-one chat; group messages are never acted on */
  direct: boolean
  /** the user's own account wrote it (iMessage or Signal note to self): the owner without a pairing step */
  self?: boolean
}

/** A file to send: its name as the other side sees it, the bytes and their type. */
export interface OutFile {
  name: string
  bytes: Uint8Array
  mime: string
}

export interface ChannelEvents {
  inbound(m: Inbound): void
  /** the channel stopped for good (a token rejected, permission missing); it says why */
  fatal(message: string): void
  log(line: string): void
}

export interface Channel {
  readonly id: ChannelId
  readonly pairing: PairingKind
  /** strangers may get one short "not paired" line (bots); on a personal account (iMessage, Signal) they get silence */
  readonly answersStrangers: boolean
  /** characters per message */
  readonly limit: number
  readonly running: boolean
  /** her account there once connected ("@my_bot", "Deskmate#1234"), for Setup */
  readonly account: string | null
  start(events: ChannelEvents): void
  stop(): void
  /** sends a line; ask puts Yes / No buttons under it where the app has them. Returns an id when the message can be
   * edited later (the status message). */
  sendText(chat: string, text: string, opts?: { ask?: boolean; clearAsk?: boolean }): Promise<string | void>
  editText?(chat: string, id: string, text: string): Promise<void>
  sendImage(chat: string, png: Uint8Array, caption?: string): Promise<void>
  sendFile(chat: string, file: OutFile, caption?: string): Promise<void>
  /** "typing…" for a few seconds */
  typing?(chat: string): Promise<void>
}

export class ChannelError extends Error {
  readonly code: number
  readonly retryAfter: number
  /** the credentials were refused: no point trying again */
  readonly fatal: boolean

  constructor(message: string, opts: { code?: number; retryAfter?: number; fatal?: boolean } = {}) {
    super(message)
    this.name = 'ChannelError'
    this.code = opts.code ?? 0
    this.retryAfter = opts.retryAfter ?? 0
    this.fatal = opts.fatal ?? false
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Splits a long line at paragraph, line or word breaks so each piece fits one message. */
export function chunks(text: string, limit = 4000): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const at = cut > limit / 2 ? cut : limit
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}

/** Takes secrets out of a line before it is logged (an error message can echo a URL with a token in it). */
export function scrub(line: string, secrets: (string | undefined)[]): string {
  let out = line
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('‹token›')
  // Anything that still looks like a bot or app token.
  return out
    .replace(/\bbot\d{5,}:[\w-]{20,}/g, 'bot‹token›')
    .replace(/\bxox[abpr]-[\w-]{10,}/g, '‹token›')
    .replace(/\bxapp-[\w-]{10,}/g, '‹token›')
}

/** A sound file's type from its name, for voice replies and files sent back. */
export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }
  return types[ext] ?? 'application/octet-stream'
}
