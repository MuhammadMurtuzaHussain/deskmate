import { AsyncLocalStorage } from 'node:async_hooks'

// The phone remote: a Telegram bot the user makes with @BotFather. Deskmate long-polls the Bot API (no server, no
// open port), relays the paired chat's messages into her chat path, and sends every line she says while working on
// one back to the phone. Only one Telegram account may control her, and pairing it takes a yes on the Mac.
// No Electron in here, so the tests can drive it with a fake Bot API.

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
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
}

export class TelegramError extends Error {
  readonly code: number
  readonly retryAfter: number

  constructor(message: string, code = 0, retryAfter = 0) {
    super(message)
    this.name = 'TelegramError'
    this.code = code
    this.retryAfter = retryAfter
  }
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
      throw new TelegramError(`can't reach Telegram: ${(err as Error).message}`)
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
    throw new TelegramError(data?.description ?? `Telegram answered ${res.status}`, code, retryAfter)
  }

  getMe(signal?: AbortSignal): Promise<TgUser> {
    return this.call('getMe', undefined, signal)
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, signal)
  }

  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<TgMessage> {
    return this.call('sendMessage', { chat_id: chatId, text, ...extra })
  }

  editMessageText(chatId: number, messageId: number, text: string): Promise<unknown> {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text })
  }

  sendPhoto(chatId: number, png: Uint8Array, caption?: string): Promise<TgMessage> {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (caption) form.append('caption', caption)
    form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'deskmate.png')
    return this.call('sendPhoto', form)
  }

  setMyCommands(commands: { command: string; description: string }[]): Promise<unknown> {
    return this.call('setMyCommands', { commands })
  }
}

/** Checks a bot token the way the setup window does: getMe, and the bot's @name when it works. */
export async function checkToken(token: string, opts: { base?: string; fetch?: Fetch } = {}): Promise<{ ok: boolean; bot?: string; error?: string }> {
  if (!/^\d+:[\w-]{20,}$/.test(token.trim())) return { ok: false, error: 'That does not look like a bot token (it looks like 123456:ABC…, from @BotFather).' }
  try {
    const me = await new TelegramApi(token, opts).getMe(AbortSignal.timeout(15_000))
    return { ok: true, bot: me.username ?? me.first_name ?? 'your bot' }
  } catch (err) {
    const e = err as TelegramError
    if (e.code === 401 || e.code === 404) return { ok: false, error: 'Telegram does not know that token. Copy it again from @BotFather.' }
    return { ok: false, error: e.message }
  }
}

/** The Telegram account allowed to control her. In a private chat the chat id is the user id; both are checked. */
export interface Paired {
  chatId: number
  userId: number
  name: string
}

/** A /start from someone while nobody is paired: the Mac has to say yes, and the code lets the user check it is them. */
export interface PairRequest extends Paired {
  code: string
}

export interface RemoteOptions {
  api: TelegramApi
  paired: Paired | null
  /** asked on the Mac (her read-back, or the setup window); resolves true to pair that chat */
  askToPair(req: PairRequest): Promise<boolean>
  /** remember (or forget, with null) the paired account */
  onPaired(paired: Paired | null): void
  /** one message from the paired phone; runs inside the phone context, so what she says comes back */
  onMessage(text: string): Promise<void>
  /** the token stopped working; polling has stopped */
  onFatal?(message: string): void
  log?(line: string): void
  /** messages older than this (seconds) came in while she was away and are not acted on (default 120) */
  maxAgeSec?: number
  /** how long status steps gather before one goes out (ms, default 1200) */
  statusDelayMs?: number
  /** after a refused or unanswered pairing, how long further /start messages are ignored (ms, default 60 s) */
  pairCooldownMs?: number
  /** long-poll length (seconds, default 50) */
  pollTimeoutSec?: number
  now?(): number
}

interface PhoneContext {
  chatId: number
}

const phone = new AsyncLocalStorage<PhoneContext>()

/** Runs fn outside any phone context, for timers that outlive a phone message (watching the screen, for one). */
export function outsidePhone<T>(fn: () => T): T {
  return phone.exit(fn)
}

const HELP =
  'Text me anything you would type in my command bar: "message Sam on Discord saying I\'m late", "what\'s on my screen?", ' +
  '"ask Claude to fix the tests in deskmate". Everything I say while I work on it comes back here, and when I ask ' +
  'before sending something, answer yes or no.\n\n/selfie  a picture of me\n/stop  stop what I am doing\n/unpair  forget this phone'

const COMMANDS = [
  { command: 'selfie', description: 'a picture of her' },
  { command: 'stop', description: 'stop what she is doing' },
  { command: 'help', description: 'what you can send' },
  { command: 'unpair', description: 'forget this phone' }
]

const LIMIT = 4000

function displayName(u: TgUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  if (name && u.username) return `${name} (@${u.username})`
  return name || (u.username ? `@${u.username}` : `user ${u.id}`)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

/** Splits a long line at paragraph, line or word breaks so each piece fits one Telegram message. */
export function chunks(text: string, limit = LIMIT): string[] {
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

export class PhoneRemote {
  readonly api: TelegramApi
  private readonly opts: RemoteOptions
  private pairedWith: Paired | null
  private request: PairRequest | null = null
  private pairBlockedUntil = 0
  /** refusals per Telegram user; two and they are ignored until the remote restarts */
  private readonly refused = new Map<number, number>()
  private abort: AbortController | null = null
  private offset = 0
  /** sends go out one at a time, in order */
  private queue: Promise<unknown> = Promise.resolve()
  private statusText = ''
  private statusSent = ''
  private statusTimer: NodeJS.Timeout | null = null
  private statusMessageId: number | null = null
  private keyboardUp = false

  constructor(opts: RemoteOptions) {
    this.opts = opts
    this.api = opts.api
    this.pairedWith = opts.paired
  }

  get running(): boolean {
    return Boolean(this.abort)
  }

  get paired(): Paired | null {
    return this.pairedWith
  }

  get pairing(): PairRequest | null {
    return this.request
  }

  /** true while handling something that came from the phone, and in everything that work leads to */
  get active(): boolean {
    const ctx = phone.getStore()
    return Boolean(ctx && this.pairedWith && ctx.chatId === this.pairedWith.chatId && this.running)
  }

  start(): void {
    if (this.abort) return
    this.abort = new AbortController()
    void this.api.setMyCommands(COMMANDS).catch(() => undefined)
    void this.loop(this.abort.signal)
  }

  stop(): void {
    this.abort?.abort()
    this.abort = null
    this.request = null
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.statusTimer = null
  }

  /** Forgets the paired account; the next /start asks the Mac again. */
  unpair(): void {
    const was = this.pairedWith
    this.pairedWith = null
    this.refused.clear()
    this.pairBlockedUntil = 0
    if (was) this.opts.onPaired(null)
  }

  /** Runs fn as phone work: lines and status steps said inside it, and in whatever it starts, go to the phone. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.pairedWith) return fn()
    return phone.run({ chatId: this.pairedWith.chatId }, fn)
  }

  /** One of her lines. Sent only while handling phone work; ask=true puts Yes / No buttons under it. */
  say(text: string, opts: { ask?: boolean } = {}): void {
    if (!this.active || !text.trim()) return
    const chatId = this.pairedWith!.chatId
    // A line ends the current status message: the next step starts a new one below it.
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.statusTimer = null
    this.statusText = ''
    this.statusSent = ''
    this.statusMessageId = null
    const parts = chunks(text)
    parts.forEach((part, i) => {
      const last = i === parts.length - 1
      let markup: Record<string, unknown> | undefined
      if (last && opts.ask) markup = { keyboard: [[{ text: 'Yes' }, { text: 'No' }]], one_time_keyboard: true, resize_keyboard: true }
      else if (last && this.keyboardUp) markup = { remove_keyboard: true }
      if (last) this.keyboardUp = Boolean(opts.ask)
      this.send(() => this.api.sendMessage(chatId, part, markup ? { reply_markup: markup } : {}))
    })
  }

  /** A step of the work ("working out who and what…"). Steps are gathered and shown as one message, edited in place. */
  status(text: string): void {
    if (!this.active || !text.trim()) return
    this.statusText = text.trim().slice(0, 300)
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.flushStatus()
    }, this.opts.statusDelayMs ?? 1200)
  }

  /** A picture for the phone (her selfie). Only while handling phone work. */
  async photo(png: Uint8Array, caption?: string): Promise<void> {
    if (!this.active) return
    const chatId = this.pairedWith!.chatId
    await this.send(() => this.api.sendPhoto(chatId, png, caption))
  }

  private flushStatus(): void {
    const chatId = this.pairedWith?.chatId
    const text = `… ${this.statusText}`
    if (!chatId || !this.statusText || text === this.statusSent) return
    this.statusSent = text
    const id = this.statusMessageId
    this.send(async () => {
      if (id !== null) {
        try {
          await this.api.editMessageText(chatId, id, text)
          return
        } catch {
          // too old or gone: a new one below
        }
      }
      const msg = await this.api.sendMessage(chatId, text)
      // Only keep it as the status message if no line came in between.
      if (this.statusSent === text) this.statusMessageId = msg.message_id
    })
  }

  private send(op: () => Promise<unknown>): Promise<void> {
    const next = this.queue.then(op).then(
      () => undefined,
      (err) => this.log(`send failed: ${(err as Error).message}`)
    )
    this.queue = next
    return next
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let backoff = 0
    while (!signal.aborted) {
      try {
        const timeout = this.opts.pollTimeoutSec ?? 50
        const updates = await this.api.getUpdates(this.offset, timeout, AbortSignal.any([signal, AbortSignal.timeout((timeout + 20) * 1000)]))
        backoff = 0
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1)
          // Not awaited: a "yes" or "stop" has to get through while the message before it is still being worked on.
          void this.handle(u).catch((err) => this.log(`update ${u.update_id}: ${(err as Error).message}`))
        }
      } catch (err) {
        if (signal.aborted) break
        const e = err as TelegramError
        if (e.code === 401 || e.code === 404) {
          this.log('Telegram rejected the bot token; the phone remote is off')
          this.stop()
          this.opts.onFatal?.('Telegram rejected the bot token. Paste it again in Setup.')
          break
        }
        // 409: another copy of Deskmate (or a webhook) is reading this bot. Network trouble: try again, slower each time.
        backoff = Math.min(60_000, backoff ? backoff * 2 : 2000)
        this.log(`${e.code === 409 ? 'another program is reading this bot (a second Deskmate, or a webhook)' : e.message}; trying again in ${backoff / 1000}s`)
        await sleep(backoff, signal)
      }
    }
  }

  private async handle(u: TgUpdate): Promise<void> {
    const m = u.message
    if (!m?.from || typeof m.text !== 'string') return
    const who = displayName(m.from)
    if (m.chat.type !== 'private' || m.from.is_bot) {
      this.log(`ignored a ${m.chat.type} message from ${who}`)
      return
    }
    const text = m.text.trim()
    const ageSec = Math.round(this.now() / 1000 - m.date)
    const stale = ageSec > (this.opts.maxAgeSec ?? 120)
    const paired = this.pairedWith

    if (!paired) {
      if (!/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
        this.log(`ignored a message from ${who} (chat ${m.chat.id}): no phone is paired yet, and it was not /start`)
        return
      }
      if (stale) return this.log(`ignored an old /start from ${who}`)
      if (this.request) return this.log(`ignored /start from ${who}: already asking the Mac about ${this.request.name}`)
      if ((this.refused.get(m.from.id) ?? 0) >= 2) return this.log(`ignored /start from ${who}: refused on the Mac twice`)
      if (this.now() < this.pairBlockedUntil) return this.log(`ignored /start from ${who}: the last pairing was just refused`)
      return this.pair({ chatId: m.chat.id, userId: m.from.id, name: who, code: String(Math.floor(1000 + Math.random() * 9000)) })
    }

    if (m.chat.id !== paired.chatId || m.from.id !== paired.userId) {
      this.log(`ignored a message from ${who} (chat ${m.chat.id}): not the paired phone`)
      return
    }
    if (stale) {
      const late = ageSec < 3600 ? `${Math.round(ageSec / 60)} min` : `${Math.round(ageSec / 3600)} h`
      this.log(`not acting on a message from ${late} ago`)
      this.send(() => this.api.sendMessage(paired.chatId, `"${text.slice(0, 80)}" reached me ${late} late, so I left it. Send it again if you still want it.`))
      return
    }
    const command = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text)
    const verb = command?.[1].toLowerCase()
    if (verb === 'start' || verb === 'help') {
      this.send(() => this.api.sendMessage(paired.chatId, HELP))
      return
    }
    if (verb === 'unpair') {
      this.send(() => this.api.sendMessage(paired.chatId, 'Unpaired. Pairing again takes a /start and a yes on the Mac.', { reply_markup: { remove_keyboard: true } }))
      this.log(`unpaired ${paired.name} from the phone`)
      this.unpair()
      return
    }
    const message = verb === 'stop' ? 'stop' : text
    if (!message) return
    await this.run(() => this.opts.onMessage(message)).catch((err) => {
      this.log(`handling "${message.slice(0, 40)}" failed: ${(err as Error).message}`)
      this.send(() => this.api.sendMessage(paired.chatId, `That went wrong on my side: ${(err as Error).message}`))
    })
  }

  private async pair(req: PairRequest): Promise<void> {
    this.request = req
    this.log(`pairing request from ${req.name} (chat ${req.chatId}), code ${req.code}`)
    this.send(() =>
      this.api.sendMessage(req.chatId, `Hi! To let this chat control Deskmate, say yes on the Mac (or press Allow in Setup). The code on the Mac is ${req.code}.`)
    )
    let yes = false
    try {
      yes = await this.opts.askToPair(req)
    } catch (err) {
      this.log(`pairing question failed: ${(err as Error).message}`)
    }
    if (this.request !== req) return // stopped meanwhile
    this.request = null
    if (yes && !this.pairedWith) {
      this.pairedWith = { chatId: req.chatId, userId: req.userId, name: req.name }
      this.opts.onPaired(this.pairedWith)
      this.log(`paired with ${req.name}`)
      this.send(() => this.api.sendMessage(req.chatId, `Paired. ${HELP}`))
    } else {
      this.refused.set(req.userId, (this.refused.get(req.userId) ?? 0) + 1)
      this.pairBlockedUntil = this.now() + (this.opts.pairCooldownMs ?? 60_000)
      this.log(`pairing with ${req.name} refused`)
      this.send(() => this.api.sendMessage(req.chatId, 'Not paired: nobody said yes on the Mac.'))
    }
  }
}
