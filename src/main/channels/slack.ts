import { ChannelError, scrub, sleep, type Channel, type ChannelEvents, type OutFile } from './channel.ts'
import { defaultSocket, type Socket, type SocketFactory } from './discord.ts'

// Slack: an app of the user's own in their workspace, in Socket Mode, so events come over a WebSocket she opens (no
// public URL, no open port). It needs two tokens: the bot token (xoxb-…, to answer) and an app-level token (xapp-…,
// with connections:write, to open the socket). Only direct messages to the app are read (the message.im event);
// pairing is the owner DMing the code Setup shows (hub.ts).

type Fetch = typeof fetch

const FATAL = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type', 'missing_scope'])

export class SlackApi {
  private readonly bot: string
  private readonly app: string
  private readonly base: string
  private readonly fetch: Fetch

  constructor(botToken: string, appToken: string, opts: { base?: string; fetch?: Fetch } = {}) {
    this.bot = botToken.trim()
    this.app = appToken.trim()
    this.base = (opts.base?.trim() || 'https://slack.com/api').replace(/\/+$/, '')
    this.fetch = opts.fetch ?? fetch
  }

  get secrets(): string[] {
    return [this.bot, this.app]
  }

  async call<T>(method: string, body: Record<string, unknown> = {}, opts: { app?: boolean; form?: boolean } = {}, retried = false): Promise<T> {
    let res: Response
    const token = opts.app ? this.app : this.bot
    try {
      res = await this.fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': opts.form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8'
        },
        body: opts.form ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(body)
      })
    } catch (err) {
      throw new ChannelError(`can't reach Slack: ${scrub((err as Error).message, this.secrets)}`)
    }
    if (res.status === 429 && !retried) {
      const wait = Number(res.headers.get('retry-after') ?? 0)
      if (wait > 0 && wait <= 30) {
        await sleep(wait * 1000)
        return this.call(method, body, opts, true)
      }
    }
    const data = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null
    if (data?.ok) return data
    const error = data?.error ?? `HTTP ${res.status}`
    throw new ChannelError(`Slack ${method}: ${error}`, { code: res.status, fatal: FATAL.has(error) })
  }

  authTest(): Promise<{ user_id: string; user: string; team: string; bot_id?: string }> {
    return this.call('auth.test')
  }

  async socketUrl(): Promise<string> {
    const r = await this.call<{ url: string }>('apps.connections.open', {}, { app: true })
    return r.url
  }

  post(channel: string, text: string): Promise<{ ts: string }> {
    return this.call('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false })
  }

  update(channel: string, ts: string, text: string): Promise<unknown> {
    return this.call('chat.update', { channel, ts, text })
  }

  /** Slack's upload: ask for a URL, put the bytes there, then share the file into the DM. */
  async upload(channel: string, file: OutFile, comment?: string): Promise<void> {
    const r = await this.call<{ upload_url: string; file_id: string }>('files.getUploadURLExternal', { filename: file.name, length: file.bytes.byteLength }, { form: true })
    const put = await this.fetch(r.upload_url, { method: 'POST', body: new Blob([new Uint8Array(file.bytes)], { type: file.mime }) }).catch((err) => {
      throw new ChannelError(`can't upload to Slack: ${scrub((err as Error).message, this.secrets)}`)
    })
    if (!put.ok) throw new ChannelError(`Slack upload answered ${put.status}`)
    await this.call('files.completeUploadExternal', { files: [{ id: r.file_id, title: file.name }], channel_id: channel, ...(comment ? { initial_comment: comment } : {}) })
  }

  /** A file someone sent (a voice clip): Slack's private links take the bot token. */
  async download(url: string): Promise<Uint8Array> {
    if (!/^https:\/\/files\.slack\.com\//.test(url) && !url.startsWith(this.base)) throw new ChannelError('not a Slack file link')
    const res = await this.fetch(url, { headers: { authorization: `Bearer ${this.bot}` } })
    if (!res.ok) throw new ChannelError(`Slack answered ${res.status} for the file`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

/** Checks both tokens for Setup. */
export async function checkSlackTokens(botToken: string, appToken: string, opts: { base?: string; fetch?: Fetch } = {}): Promise<{ ok: boolean; bot?: string; error?: string }> {
  if (!/^xoxb-[\w-]{10,}$/.test(botToken.trim())) return { ok: false, error: 'The bot token starts with xoxb- (your app → OAuth & Permissions → Bot User OAuth Token).' }
  if (!/^xapp-[\w-]{10,}$/.test(appToken.trim())) return { ok: false, error: 'The app token starts with xapp- (your app → Basic Information → App-Level Tokens, with connections:write).' }
  const api = new SlackApi(botToken, appToken, opts)
  try {
    const me = await api.authTest()
    await api.socketUrl()
    return { ok: true, bot: `${me.user} in ${me.team}` }
  } catch (err) {
    const e = err as ChannelError
    if (e.fatal) return { ok: false, error: `Slack refused a token (${e.message.replace(/^Slack [\w.]+: /, '')}). Check both, and that Socket Mode is on.` }
    return { ok: false, error: e.message }
  }
}

interface SlackEvent {
  type: string
  channel_type?: string
  subtype?: string
  bot_id?: string
  user?: string
  text?: string
  channel?: string
  ts?: string
  files?: { mimetype?: string; subtype?: string; url_private_download?: string; size?: number }[]
}

export class SlackChannel implements Channel {
  readonly id = 'slack' as const
  readonly pairing = 'code' as const
  readonly answersStrangers = true
  readonly limit = 3500
  readonly api: SlackApi
  private readonly socket: SocketFactory
  private ws: Socket | null = null
  private events: ChannelEvents | null = null
  private on = false
  private me: { id: string; name: string } | null = null
  private backoff = 0
  private readonly reconnectMs: number
  /** Slack sends an event again when the ack was late: each one is acted on once */
  private readonly done = new Set<string>()

  constructor(api: SlackApi, opts: { socket?: SocketFactory; reconnectMs?: number } = {}) {
    this.api = api
    this.socket = opts.socket ?? defaultSocket
    this.reconnectMs = opts.reconnectMs ?? 2000
  }

  get running(): boolean {
    return this.on
  }

  get account(): string | null {
    return this.me ? `@${this.me.name}` : null
  }

  start(events: ChannelEvents): void {
    if (this.on) return
    this.on = true
    this.events = events
    void this.api.authTest().then(
      (r) => (this.me = { id: r.user_id, name: r.user }),
      (err) => {
        if ((err as ChannelError).fatal) this.fail('Slack refused the bot token. Paste it again in Setup.')
      }
    )
    void this.connect()
  }

  stop(): void {
    this.on = false
    const ws = this.ws
    this.ws = null
    try {
      ws?.close(1000, 'bye')
    } catch {
      // gone
    }
  }

  async sendText(chat: string, text: string, opts: { ask?: boolean } = {}): Promise<string> {
    const r = await this.api.post(chat, opts.ask ? `${text}\n_(reply yes or no)_` : text)
    return r.ts
  }

  async editText(chat: string, id: string, text: string): Promise<void> {
    await this.api.update(chat, id, text)
  }

  async sendImage(chat: string, png: Uint8Array, caption?: string): Promise<void> {
    await this.api.upload(chat, { name: 'deskmate.png', bytes: png, mime: 'image/png' }, caption)
  }

  async sendFile(chat: string, file: OutFile, caption?: string): Promise<void> {
    await this.api.upload(chat, file, caption)
  }

  private log(line: string): void {
    this.events?.log(scrub(line, this.api.secrets))
  }

  private fail(message: string): void {
    if (!this.on) return
    this.stop()
    this.events?.fatal(message)
  }

  private async connect(): Promise<void> {
    if (!this.on) return
    let url: string
    try {
      url = await this.api.socketUrl()
    } catch (err) {
      const e = err as ChannelError
      if (e.fatal) return this.fail('Slack refused the app token (xapp-…). Make one with connections:write and paste it again in Setup.')
      return this.retry(e.message)
    }
    if (!this.on) return
    const ws = this.socket(url)
    this.ws = ws
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      try {
        this.frame(ws, JSON.parse(String(ev.data)) as { type: string; envelope_id?: string; payload?: { event?: SlackEvent; event_id?: string } })
      } catch (err) {
        this.log(`bad socket frame: ${(err as Error).message}`)
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.retry('socket closed')
    }
    ws.onerror = () => undefined
  }

  private retry(why: string): void {
    if (!this.on) return
    this.backoff = Math.min(60_000, this.backoff ? this.backoff * 2 : this.reconnectMs)
    this.log(`${why}; connecting again in ${Math.round(this.backoff / 1000)}s`)
    setTimeout(() => void this.connect(), this.backoff).unref?.()
  }

  private frame(ws: Socket, f: { type: string; envelope_id?: string; payload?: { event?: SlackEvent; event_id?: string } }): void {
    if (f.type === 'hello') {
      this.backoff = 0
      this.log('connected')
      return
    }
    if (f.type === 'disconnect') {
      // Slack rotates sockets every few hours: open a new one.
      try {
        ws.close(1000, 'refresh')
      } catch {
        // gone
      }
      return
    }
    // Every envelope is acked at once, or Slack sends it again.
    if (f.envelope_id) ws.send(JSON.stringify({ envelope_id: f.envelope_id }))
    if (f.type !== 'events_api' || !f.payload?.event) return
    const key = f.payload.event_id ?? f.envelope_id ?? ''
    if (key) {
      if (this.done.has(key)) return
      this.done.add(key)
      if (this.done.size > 500) this.done.delete(this.done.values().next().value!)
    }
    const e = f.payload.event
    if (e.type !== 'message' || !e.user || !e.channel || e.bot_id) return
    if (e.subtype && e.subtype !== 'file_share') return
    if (this.me && e.user === this.me.id) return
    const clip = e.files?.find((x) => x.mimetype?.startsWith('audio/') || x.subtype === 'slack_audio')
    const text = (e.text ?? '').trim()
    if (!text && !clip?.url_private_download) return
    this.events?.inbound({
      chat: e.channel,
      from: { id: e.user, name: `<@${e.user}>` },
      text,
      voice: clip?.url_private_download ? { mime: clip.mimetype ?? 'audio/webm', fetch: () => this.api.download(clip.url_private_download!) } : undefined,
      at: e.ts ? Math.round(Number(e.ts) * 1000) : Date.now(),
      direct: e.channel_type === 'im'
    })
  }
}
