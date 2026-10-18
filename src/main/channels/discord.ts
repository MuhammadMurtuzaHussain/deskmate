import { ChannelError, scrub, sleep, type Channel, type ChannelEvents, type OutFile } from './channel.ts'

// Discord: a bot of the user's own (discord.com/developers → New Application → Bot → Reset Token). Deskmate opens the
// gateway (a WebSocket out; no server, no open port) for direct messages only, and answers through the REST API. Bots
// get the text of DMs sent to them without the privileged Message Content intent, so the only intent asked for is
// DIRECT_MESSAGES. Pairing: the owner DMs the bot the code Setup shows (hub.ts). Messages in servers are ignored.

type Fetch = typeof fetch

/** The WebSocket the gateway uses (the built-in one in the app; a fake in the tests). */
export interface Socket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}
export type SocketFactory = (url: string) => Socket

export function defaultSocket(url: string): Socket {
  return new WebSocket(url) as unknown as Socket
}

interface DiscordUser {
  id: string
  username: string
  global_name?: string | null
  bot?: boolean
}

interface DiscordMessage {
  id: string
  channel_id: string
  guild_id?: string
  author: DiscordUser
  content: string
  timestamp: string
  flags?: number
  attachments?: { url: string; filename: string; content_type?: string; size: number }[]
}

const DIRECT_MESSAGES = 1 << 12
const IS_VOICE_MESSAGE = 1 << 13

export class DiscordApi {
  private readonly token: string
  private readonly base: string
  private readonly fetch: Fetch

  constructor(token: string, opts: { base?: string; fetch?: Fetch } = {}) {
    this.token = token.trim()
    this.base = (opts.base?.trim() || 'https://discord.com/api/v10').replace(/\/+$/, '')
    this.fetch = opts.fetch ?? fetch
  }

  get secret(): string {
    return this.token
  }

  async call<T>(method: string, path: string, body?: Record<string, unknown> | FormData, retried = false): Promise<T> {
    let res: Response
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bot ${this.token}`, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
      })
    } catch (err) {
      throw new ChannelError(`can't reach Discord: ${scrub((err as Error).message, [this.token])}`)
    }
    if (res.status === 204) return undefined as T
    const data = (await res.json().catch(() => null)) as (T & { message?: string; retry_after?: number; code?: number }) | null
    if (res.ok) return data as T
    const retryAfter = Number(data?.retry_after ?? 0)
    if (res.status === 429 && !retried && retryAfter > 0 && retryAfter <= 30) {
      await sleep(retryAfter * 1000)
      return this.call(method, path, body, true)
    }
    throw new ChannelError(data?.message ?? `Discord answered ${res.status}`, { code: res.status, retryAfter, fatal: res.status === 401 })
  }

  me(): Promise<DiscordUser> {
    return this.call('GET', '/users/@me')
  }

  async gatewayUrl(): Promise<string> {
    const g = await this.call<{ url: string }>('GET', '/gateway/bot')
    return g.url
  }

  send(channelId: string, content: string): Promise<DiscordMessage> {
    // Nobody gets pinged by what she says.
    return this.call('POST', `/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [] } })
  }

  edit(channelId: string, messageId: string, content: string): Promise<DiscordMessage> {
    return this.call('PATCH', `/channels/${channelId}/messages/${messageId}`, { content })
  }

  typing(channelId: string): Promise<void> {
    return this.call('POST', `/channels/${channelId}/typing`)
  }

  sendFile(channelId: string, file: OutFile, caption?: string): Promise<DiscordMessage> {
    const form = new FormData()
    form.append('payload_json', JSON.stringify({ content: caption ?? '', allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: file.name }] }))
    form.append('files[0]', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name)
    return this.call('POST', `/channels/${channelId}/messages`, form)
  }

  /** An attachment someone sent (its CDN link needs no token). */
  async download(url: string): Promise<Uint8Array> {
    if (!/^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\//.test(url) && !url.startsWith(this.base)) throw new ChannelError('not a Discord attachment link')
    const res = await this.fetch(url)
    if (!res.ok) throw new ChannelError(`Discord answered ${res.status} for the file`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

/** Checks a bot token for Setup: who the bot is. */
export async function checkDiscordToken(token: string, opts: { base?: string; fetch?: Fetch } = {}): Promise<{ ok: boolean; bot?: string; error?: string }> {
  const t = token.trim()
  if (!/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(t)) return { ok: false, error: 'That does not look like a Discord bot token (Developer Portal → your app → Bot → Reset Token).' }
  try {
    const me = await new DiscordApi(t, opts).me()
    return { ok: true, bot: me.username }
  } catch (err) {
    const e = err as ChannelError
    if (e.code === 401) return { ok: false, error: 'Discord does not know that token. Reset it in the Developer Portal and paste the new one.' }
    return { ok: false, error: e.message }
  }
}

function name(u: DiscordUser): string {
  return u.global_name && u.global_name !== u.username ? `${u.global_name} (@${u.username})` : `@${u.username}`
}

export class DiscordChannel implements Channel {
  readonly id = 'discord' as const
  readonly pairing = 'code' as const
  readonly answersStrangers = true
  readonly limit = 2000
  readonly api: DiscordApi
  private readonly socket: SocketFactory
  private ws: Socket | null = null
  private events: ChannelEvents | null = null
  private on = false
  private heartbeat: NodeJS.Timeout | null = null
  private acked = true
  private seq: number | null = null
  private session: { id: string; url: string } | null = null
  private user: DiscordUser | null = null
  private backoff = 0
  private readonly reconnectMs: number

  constructor(api: DiscordApi, opts: { socket?: SocketFactory; reconnectMs?: number } = {}) {
    this.api = api
    this.socket = opts.socket ?? defaultSocket
    this.reconnectMs = opts.reconnectMs ?? 2000
  }

  get running(): boolean {
    return this.on
  }

  get account(): string | null {
    return this.user ? `@${this.user.username}` : null
  }

  start(events: ChannelEvents): void {
    if (this.on) return
    this.on = true
    this.events = events
    void this.connect()
  }

  stop(): void {
    this.on = false
    this.clearHeartbeat()
    const ws = this.ws
    this.ws = null
    try {
      ws?.close(1000, 'bye')
    } catch {
      // already closed
    }
  }

  async sendText(chat: string, text: string, opts: { ask?: boolean } = {}): Promise<string> {
    const msg = await this.api.send(chat, opts.ask ? `${text}\n-# reply yes or no` : text)
    return msg.id
  }

  async editText(chat: string, id: string, text: string): Promise<void> {
    await this.api.edit(chat, id, text)
  }

  async sendImage(chat: string, png: Uint8Array, caption?: string): Promise<void> {
    await this.api.sendFile(chat, { name: 'deskmate.png', bytes: png, mime: 'image/png' }, caption)
  }

  async sendFile(chat: string, file: OutFile, caption?: string): Promise<void> {
    if (file.bytes.byteLength > 10 * 1024 * 1024) throw new ChannelError('Discord takes files up to 10 MB from bots')
    await this.api.sendFile(chat, file, caption)
  }

  async typing(chat: string): Promise<void> {
    await this.api.typing(chat)
  }

  private log(line: string): void {
    this.events?.log(scrub(line, [this.api.secret]))
  }

  private async connect(): Promise<void> {
    if (!this.on) return
    let url: string
    try {
      url = this.session?.url ?? (await this.api.gatewayUrl())
    } catch (err) {
      const e = err as ChannelError
      if (e.fatal) return this.fail('Discord rejected the bot token. Paste it again in Setup.')
      return this.retry(e.message)
    }
    if (!this.on) return
    const ws = this.socket(`${url.replace(/\/+$/, '')}/?v=10&encoding=json`)
    this.ws = ws
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      try {
        this.frame(JSON.parse(String(ev.data)) as { op: number; d: unknown; s: number | null; t: string | null })
      } catch (err) {
        this.log(`bad gateway frame: ${(err as Error).message}`)
      }
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearHeartbeat()
      if (!this.on) return
      // 4004: the token is wrong. 4013 / 4014: intents refused. 4010–4012: our mistake. Nothing to retry.
      if (ev.code === 4004) return this.fail('Discord rejected the bot token. Paste it again in Setup.')
      if (ev.code >= 4010 && ev.code <= 4014) return this.fail(`Discord closed the connection (${ev.code}${ev.reason ? `: ${ev.reason}` : ''}).`)
      // 4007 (bad sequence) and 4009 (timed out) can't resume.
      if (ev.code === 4007 || ev.code === 4009) this.session = null
      this.retry(`gateway closed (${ev.code})`)
    }
    ws.onerror = () => undefined
  }

  private retry(why: string): void {
    if (!this.on) return
    this.backoff = Math.min(60_000, this.backoff ? this.backoff * 2 : this.reconnectMs)
    this.log(`${why}; connecting again in ${Math.round(this.backoff / 1000)}s`)
    setTimeout(() => void this.connect(), this.backoff).unref?.()
  }

  private fail(message: string): void {
    this.stop()
    this.events?.fatal(message)
  }

  private sendFrame(op: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ op, d }))
  }

  private frame(f: { op: number; d: unknown; s: number | null; t: string | null }): void {
    if (f.s !== null && f.s !== undefined) this.seq = f.s
    switch (f.op) {
      case 10: {
        // Hello: beat at the interval asked for (the first after a random part of it), then identify or resume.
        const every = Number((f.d as { heartbeat_interval: number }).heartbeat_interval) || 41_250
        this.acked = true
        this.clearHeartbeat()
        const beat = (): void => {
          if (!this.acked) {
            // No answer to the last beat: the connection is a zombie.
            this.log('no heartbeat answer; reconnecting')
            try {
              this.ws?.close(4000, 'zombie')
            } catch {
              // gone
            }
            return
          }
          this.acked = false
          this.sendFrame(1, this.seq)
        }
        const first = setTimeout(() => {
          beat()
          this.heartbeat = setInterval(beat, every)
          this.heartbeat.unref?.()
        }, Math.floor(every * Math.random()))
        first.unref?.()
        this.heartbeat = first
        if (this.session) this.sendFrame(6, { token: this.api.secret, session_id: this.session.id, seq: this.seq })
        else this.sendFrame(2, { token: this.api.secret, intents: DIRECT_MESSAGES, properties: { os: process.platform, browser: 'deskmate', device: 'deskmate' } })
        return
      }
      case 11:
        this.acked = true
        return
      case 1:
        this.sendFrame(1, this.seq)
        return
      case 7:
        // Asked to reconnect: resume on a new connection.
        try {
          this.ws?.close(4000, 'reconnect')
        } catch {
          // gone
        }
        return
      case 9:
        // Invalid session: resumable when d is true; otherwise start over after a short wait.
        if (!f.d) {
          this.session = null
          this.seq = null
        }
        setTimeout(() => {
          if (this.session) this.sendFrame(6, { token: this.api.secret, session_id: this.session.id, seq: this.seq })
          else this.sendFrame(2, { token: this.api.secret, intents: DIRECT_MESSAGES, properties: { os: process.platform, browser: 'deskmate', device: 'deskmate' } })
        }, 1000 + Math.random() * 4000).unref?.()
        return
      case 0:
        return this.dispatch(f.t ?? '', f.d)
    }
  }

  private dispatch(type: string, d: unknown): void {
    if (type === 'READY') {
      const r = d as { session_id: string; resume_gateway_url: string; user: DiscordUser }
      this.session = { id: r.session_id, url: r.resume_gateway_url }
      this.user = r.user
      this.backoff = 0
      this.log(`connected as @${r.user.username}`)
      return
    }
    if (type === 'RESUMED') {
      this.backoff = 0
      return
    }
    if (type !== 'MESSAGE_CREATE') return
    const m = d as DiscordMessage
    if (!m.author || m.author.bot || m.author.id === this.user?.id) return
    const audio = m.attachments?.find((a) => a.content_type?.startsWith('audio/'))
    const voice = audio && ((m.flags ?? 0) & IS_VOICE_MESSAGE || !m.content.trim()) ? audio : undefined
    if (!m.content.trim() && !voice) return
    this.events?.inbound({
      chat: m.channel_id,
      from: { id: m.author.id, name: name(m.author) },
      text: m.content,
      voice: voice ? { mime: voice.content_type ?? 'audio/ogg', fetch: () => this.api.download(voice.url) } : undefined,
      at: Date.parse(m.timestamp) || Date.now(),
      direct: !m.guild_id
    })
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearTimeout(this.heartbeat)
      clearInterval(this.heartbeat)
    }
    this.heartbeat = null
  }
}
