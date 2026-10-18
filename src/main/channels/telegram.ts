import { ChannelError, scrub, sleep, type Channel, type ChannelEvents, type OutFile } from './channel.ts'

// Telegram: a bot the user makes with @BotFather. Deskmate long-polls the Bot API (no server, no open port). Pairing
// is a /start answered with a yes on the Mac (hub.ts).

export interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TgMessage {
  message_id: number
  /** unix seconds */
  date: number
  chat: { id: number; type: string }
  from?: TgUser
  text?: string
  caption?: string
  voice?: { file_id: string; mime_type?: string; duration?: number; file_size?: number }
  audio?: { file_id: string; mime_type?: string; duration?: number; file_size?: number }
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
}

type Fetch = typeof fetch

/** The handful of Bot API methods she needs, over fetch. */
export class TelegramApi {
  private readonly token: string
  private readonly base: string
  private readonly fetch: Fetch

  constructor(token: string, opts: { base?: string; fetch?: Fetch } = {}) {
    this.token = token.trim()
    this.base = (opts.base?.trim() || 'https://api.telegram.org').replace(/\/+$/, '')
    this.fetch = opts.fetch ?? fetch
  }

  async call<T>(method: string, body?: Record<string, unknown> | FormData, signal?: AbortSignal, retried = false): Promise<T> {
    let res: Response
    try {
      res = await this.fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: body instanceof FormData || !body ? undefined : { 'content-type': 'application/json' },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        signal
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new ChannelError(`can't reach Telegram: ${scrub((err as Error).message, [this.token])}`)
    }
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      result?: T
      error_code?: number
      description?: string
      parameters?: { retry_after?: number }
    } | null
    if (data?.ok) return data.result as T
    const code = data?.error_code ?? res.status
    const retryAfter = data?.parameters?.retry_after ?? 0
    // Flood control: wait as told, once, when the wait is short.
    if (code === 429 && !retried && retryAfter > 0 && retryAfter <= 30) {
      await sleep(retryAfter * 1000, signal)
      return this.call(method, body, signal, true)
    }
    throw new ChannelError(data?.description ?? `Telegram answered ${res.status}`, { code, retryAfter, fatal: code === 401 || code === 404 })
  }

  getMe(signal?: AbortSignal): Promise<TgUser> {
    return this.call('getMe', undefined, signal)
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, signal)
  }

  sendMessage(chatId: number | string, text: string, extra: Record<string, unknown> = {}): Promise<TgMessage> {
    return this.call('sendMessage', { chat_id: chatId, text, ...extra })
  }

  editMessageText(chatId: number | string, messageId: number, text: string): Promise<unknown> {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text })
  }

  sendPhoto(chatId: number | string, png: Uint8Array, caption?: string): Promise<TgMessage> {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (caption) form.append('caption', caption)
    form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'deskmate.png')
    return this.call('sendPhoto', form)
  }

  /** A file as a document (any type), or a sound as audio so it plays in the chat. */
  sendFile(chatId: number | string, file: OutFile, caption?: string): Promise<TgMessage> {
    const audio = file.mime.startsWith('audio/')
    const field = audio ? 'audio' : 'document'
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (caption) form.append('caption', caption)
    form.append(field, new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name)
    return this.call(audio ? 'sendAudio' : 'sendDocument', form)
  }

  sendChatAction(chatId: number | string, action = 'typing'): Promise<unknown> {
    return this.call('sendChatAction', { chat_id: chatId, action })
  }

  setMyCommands(commands: { command: string; description: string }[]): Promise<unknown> {
    return this.call('setMyCommands', { commands })
  }

  /** A file someone sent (a voice note), by its file_id. */
  async download(fileId: string): Promise<Uint8Array> {
    const f = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
    if (!f.file_path) throw new ChannelError('Telegram has no path for that file')
    if ((f.file_size ?? 0) > 20 * 1024 * 1024) throw new ChannelError('that file is too big to fetch')
    const res = await this.fetch(`${this.base}/file/bot${this.token}/${f.file_path}`).catch((err) => {
      throw new ChannelError(`can't fetch the file: ${scrub((err as Error).message, [this.token])}`)
    })
    if (!res.ok) throw new ChannelError(`Telegram answered ${res.status} for the file`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

/** Checks a bot token the way the setup window does: getMe, and the bot's @name when it works. */
export async function checkTelegramToken(token: string, opts: { base?: string; fetch?: Fetch } = {}): Promise<{ ok: boolean; bot?: string; error?: string }> {
  if (!/^\d+:[\w-]{20,}$/.test(token.trim())) return { ok: false, error: 'That does not look like a bot token (it looks like 123456:ABC…, from @BotFather).' }
  try {
    const me = await new TelegramApi(token, opts).getMe(AbortSignal.timeout(15_000))
    return { ok: true, bot: me.username ?? me.first_name ?? 'your bot' }
  } catch (err) {
    const e = err as ChannelError
    if (e.code === 401 || e.code === 404) return { ok: false, error: 'Telegram does not know that token. Copy it again from @BotFather.' }
    return { ok: false, error: e.message }
  }
}

const COMMANDS = [
  { command: 'selfie', description: 'a picture of her' },
  { command: 'stop', description: 'stop what she is doing' },
  { command: 'help', description: 'what you can send' },
  { command: 'unpair', description: 'forget this chat' }
]

export function telegramName(u: TgUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  if (name && u.username) return `${name} (@${u.username})`
  return name || (u.username ? `@${u.username}` : `user ${u.id}`)
}

export class TelegramChannel implements Channel {
  readonly id = 'telegram' as const
  readonly pairing = 'ask' as const
  readonly answersStrangers = true
  readonly limit = 4000
  readonly api: TelegramApi
  private abort: AbortController | null = null
  private offset = 0
  private bot: string | null = null
  private readonly pollTimeoutSec: number

  constructor(api: TelegramApi, opts: { pollTimeoutSec?: number } = {}) {
    this.api = api
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 50
  }

  get running(): boolean {
    return Boolean(this.abort)
  }

  get account(): string | null {
    return this.bot ? `@${this.bot}` : null
  }

  start(events: ChannelEvents): void {
    if (this.abort) return
    this.abort = new AbortController()
    const signal = this.abort.signal
    void this.api.setMyCommands(COMMANDS).catch(() => undefined)
    void this.api.getMe(signal).then(
      (me) => (this.bot = me.username ?? null),
      () => undefined
    )
    void this.loop(signal, events)
  }

  stop(): void {
    this.abort?.abort()
    this.abort = null
  }

  async sendText(chat: string, text: string, opts: { ask?: boolean; clearAsk?: boolean } = {}): Promise<string> {
    let markup: Record<string, unknown> | undefined
    if (opts.ask) markup = { keyboard: [[{ text: 'Yes' }, { text: 'No' }]], one_time_keyboard: true, resize_keyboard: true }
    else if (opts.clearAsk) markup = { remove_keyboard: true }
    const msg = await this.api.sendMessage(chat, text, markup ? { reply_markup: markup } : {})
    return String(msg.message_id)
  }

  async editText(chat: string, id: string, text: string): Promise<void> {
    await this.api.editMessageText(chat, Number(id), text)
  }

  async sendImage(chat: string, png: Uint8Array, caption?: string): Promise<void> {
    await this.api.sendPhoto(chat, png, caption)
  }

  async sendFile(chat: string, file: OutFile, caption?: string): Promise<void> {
    await this.api.sendFile(chat, file, caption)
  }

  async typing(chat: string): Promise<void> {
    await this.api.sendChatAction(chat)
  }

  private async loop(signal: AbortSignal, events: ChannelEvents): Promise<void> {
    let backoff = 0
    while (!signal.aborted) {
      try {
        const timeout = this.pollTimeoutSec
        const updates = await this.api.getUpdates(this.offset, timeout, AbortSignal.any([signal, AbortSignal.timeout((timeout + 20) * 1000)]))
        backoff = 0
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1)
          this.emit(u, events)
        }
      } catch (err) {
        if (signal.aborted) break
        const e = err as ChannelError
        if (e.fatal) {
          this.stop()
          events.fatal('Telegram rejected the bot token. Paste it again in Setup.')
          break
        }
        // 409: another copy of Deskmate (or a webhook) is reading this bot. Network trouble: try again, slower each time.
        backoff = Math.min(60_000, backoff ? backoff * 2 : 2000)
        events.log(`${e.code === 409 ? 'another program is reading this bot (a second Deskmate, or a webhook)' : e.message}; trying again in ${backoff / 1000}s`)
        await sleep(backoff, signal)
      }
    }
  }

  private emit(u: TgUpdate, events: ChannelEvents): void {
    const m = u.message
    if (!m?.from || m.from.is_bot) return
    const note = m.voice ?? m.audio
    const text = m.text ?? m.caption ?? ''
    if (!text && !note) return
    events.inbound({
      chat: String(m.chat.id),
      from: { id: String(m.from.id), name: telegramName(m.from) },
      text,
      voice: note ? { mime: note.mime_type ?? 'audio/ogg', fetch: () => this.api.download(note.file_id) } : undefined,
      at: m.date * 1000,
      direct: m.chat.type === 'private'
    })
  }
}
