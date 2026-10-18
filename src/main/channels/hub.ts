import { AsyncLocalStorage } from 'node:async_hooks'
import { CHANNEL_IDS, CHANNEL_LABELS, chunks, type Channel, type ChannelId, type Inbound, type OutFile } from './channel.ts'

// The hub: every chat app she can be reached through goes through here, so the rules are the same everywhere.
// - Only the owner of a channel reaches her: the account paired on the Mac (a /start and a yes, or the code the Mac
//   shows), or on iMessage and Signal the user's own account and the handles typed into Setup. Anyone else gets one
//   short "not paired" line a day at most (bots only), or silence (personal accounts); never her.
// - Group chats and messages that waited too long (she was asleep) are not acted on.
// - The owner's message goes through the same chat path as typed text, inside a channel context (AsyncLocalStorage):
//   every line she says and every step of the work in it (and in what it starts) goes back to that chat, a yes she
//   waits for gets Yes / No buttons where the app has them, and a "yes" sent back answers it.
// - What she tells you on her own (notices, scheduled runs while you are away) goes to the channel you used last.

/** The account allowed to control her on one channel. */
export interface Owner {
  /** the chat replies go to */
  chat: string
  /** the account id that must send */
  id: string
  name: string
}

/** Someone asking to become the owner: a /start (Telegram), answered on the Mac. */
export interface PairRequest extends Owner {
  channel: ChannelId
  code: string
}

export interface HubOptions {
  owners?: Partial<Record<ChannelId, Owner | null>>
  /** allowlist channels: the handles that count as the owner (the user's own number, a second Apple ID) */
  allowlist?: Partial<Record<ChannelId, string[]>>
  /** asked on the Mac (her read-back, or Allow in Setup); true pairs that account */
  askToPair(req: PairRequest): Promise<boolean>
  /** remember (or forget, with null) a channel's owner */
  onPaired(channel: ChannelId, owner: Owner | null): void
  /** one message from an owner, as text; runs inside the channel context */
  onMessage(text: string, from: { channel: ChannelId; name: string; voice: boolean }): Promise<void>
  /** a voice note to text (the local Whisper server); null when nothing could be made out */
  transcribe?(audio: Uint8Array, mime: string): Promise<string | null>
  /** her line as a voice clip (Kokoro), for answering a voice note with one; null when there is no voice */
  speak?(text: string): Promise<OutFile | null>
  /** a channel stopped for good */
  onFatal?(channel: ChannelId, message: string): void
  /** something changed that Setup and the tray show */
  onChange?(): void
  log?(line: string): void
  /** messages older than this (seconds) came in while she was away and are not acted on (default 120) */
  maxAgeSec?: number
  /** how long status steps gather before one goes out (ms, default 1200) */
  statusDelayMs?: number
  /** after a refused pairing, how long further /start messages are ignored (ms, default 60 s) */
  pairCooldownMs?: number
  /** one "not paired" line per stranger per this long (ms, default a day) */
  strangerGapMs?: number
  /** how long a pairing code works (ms, default 10 min) */
  codeTtlMs?: number
  now?(): number
}

interface Context {
  channel: ChannelId
  chat: string
  /** the message came as a voice note: with voice replies on, she answers with one */
  voice: boolean
}

interface State {
  channel: Channel
  owner: Owner | null
  /** allowlist channels: the chat the owner wrote from last (replies and notices go there) */
  lastChat: Owner | null
  request: PairRequest | null
  code: string | null
  codeUntil: number
  pairBlockedUntil: number
  /** refused pairings per account; two and they are ignored until the hub restarts */
  refused: Map<string, number>
  /** wrong codes per account; three and they are ignored */
  wrongCodes: Map<string, number>
  /** when each stranger last got the "not paired" line */
  strangerAt: Map<string, number>
  lastUsed: number
  queue: Promise<unknown>
  statusText: string
  statusSent: string
  statusTimer: NodeJS.Timeout | null
  statusId: string | null
  askUp: boolean
  error: string | null
}

const store = new AsyncLocalStorage<Context>()

/** Runs fn outside any channel context, for timers that outlive a message (watching the screen, for one). */
export function outsideChannels<T>(fn: () => T): T {
  return store.exit(fn)
}

export const HELP =
  'Text me anything you would type in my command bar: "message Sam on Discord saying I\'m late", "what\'s on my screen?", ' +
  '"send me a screenshot", "ask Claude to fix the tests in deskmate". Voice notes work too. Everything I say while I ' +
  'work on it comes back here, and when I ask before doing something, answer yes or no.\n\n/selfie  a picture of me\n/stop  stop what I am doing\n/unpair  forget this chat'

/** Handles compared loosely: case, spaces, dashes and the "tel:" / "mailto:" prefixes do not matter. */
export function sameHandle(a: string, b: string): boolean {
  const n = (h: string): string =>
    h
      .trim()
      .toLowerCase()
      .replace(/^(?:tel:|mailto:|imessage:|sms:)/, '')
      .replace(/[\s().-]/g, '')
  return n(a) !== '' && n(a) === n(b)
}

function code(digits: number): string {
  let out = ''
  for (let i = 0; i < digits; i++) out += String(Math.floor(Math.random() * 10))
  return out.startsWith('0') ? `1${out.slice(1)}` : out
}

export class ChannelHub {
  private readonly opts: HubOptions
  private readonly states = new Map<ChannelId, State>()
  private readonly allow: Partial<Record<ChannelId, string[]>>
  /** each channel's owner, kept across remove() and add() (a channel is rebuilt when its token changes) */
  private readonly owners: Partial<Record<ChannelId, Owner | null>>

  constructor(opts: HubOptions) {
    this.opts = opts
    this.allow = { ...(opts.allowlist ?? {}) }
    this.owners = { ...(opts.owners ?? {}) }
  }

  // ---- channels

  /** Adds (or replaces) a channel; it starts when start() is called. */
  add(channel: Channel): void {
    this.remove(channel.id)
    this.states.set(channel.id, {
      channel,
      owner: this.owners[channel.id] ?? null,
      lastChat: null,
      request: null,
      code: null,
      codeUntil: 0,
      pairBlockedUntil: 0,
      refused: new Map(),
      wrongCodes: new Map(),
      strangerAt: new Map(),
      lastUsed: 0,
      queue: Promise.resolve(),
      statusText: '',
      statusSent: '',
      statusTimer: null,
      statusId: null,
      askUp: false,
      error: null
    })
  }

  remove(id: ChannelId): void {
    const s = this.states.get(id)
    if (!s) return
    this.stopState(s)
    this.states.delete(id)
  }

  get(id: ChannelId): Channel | null {
    return this.states.get(id)?.channel ?? null
  }

  start(id: ChannelId): void {
    const s = this.states.get(id)
    if (!s || s.channel.running) return
    s.error = null
    s.channel.start({
      inbound: (m) => void this.handle(s, m).catch((err) => this.log(id, `message from ${m.from.name}: ${(err as Error).message}`)),
      fatal: (message) => {
        s.error = message
        this.stopState(s)
        this.log(id, `stopped: ${message}`)
        this.opts.onFatal?.(id, message)
        this.changed()
      },
      log: (line) => this.log(id, line)
    })
    this.changed()
  }

  stop(id: ChannelId): void {
    const s = this.states.get(id)
    if (s) this.stopState(s)
    this.changed()
  }

  stopAll(): void {
    for (const s of this.states.values()) this.stopState(s)
  }

  private stopState(s: State): void {
    s.channel.stop()
    s.request = null
    s.code = null
    if (s.statusTimer) clearTimeout(s.statusTimer)
    s.statusTimer = null
  }

  // ---- owners and pairing

  owner(id: ChannelId): Owner | null {
    return this.states.get(id)?.owner ?? null
  }

  /** The open /start waiting for a yes on the Mac, on any channel. */
  get pairing(): PairRequest | null {
    for (const s of this.states.values()) if (s.request) return s.request
    return null
  }

  pairRequest(id: ChannelId): PairRequest | null {
    return this.states.get(id)?.request ?? null
  }

  /** The code channel: the code to send from the app, valid for a few minutes. Opening again gives a new one. */
  openPairing(id: ChannelId): string | null {
    const s = this.states.get(id)
    if (!s || s.channel.pairing !== 'code') return null
    s.code = code(6)
    s.codeUntil = this.now() + (this.opts.codeTtlMs ?? 10 * 60_000)
    s.wrongCodes.clear()
    this.log(id, 'pairing open: waiting for the code from the app')
    this.changed()
    return s.code
  }

  /** The open pairing code and when it stops working, while there is one. */
  pairingCode(id: ChannelId): { code: string; until: number } | null {
    const s = this.states.get(id)
    if (!s?.code) return null
    if (this.now() > s.codeUntil) {
      s.code = null
      return null
    }
    return { code: s.code, until: s.codeUntil }
  }

  closePairing(id: ChannelId): void {
    const s = this.states.get(id)
    if (s) s.code = null
    this.changed()
  }

  /** Forgets a channel's owner; the next one has to pair again. */
  unpair(id: ChannelId): void {
    const s = this.states.get(id)
    const stored = this.owners[id] ?? null
    this.owners[id] = null
    if (!s) {
      if (stored) this.opts.onPaired(id, null)
      this.changed()
      return
    }
    const was = s.owner ?? stored
    s.owner = null
    s.lastChat = null
    s.refused.clear()
    s.wrongCodes.clear()
    s.pairBlockedUntil = 0
    if (was) this.opts.onPaired(id, null)
    this.changed()
  }

  setAllowlist(id: ChannelId, handles: string[]): void {
    this.allow[id] = handles.map((h) => h.trim()).filter(Boolean)
    this.changed()
  }

  allowlist(id: ChannelId): string[] {
    return [...(this.allow[id] ?? [])]
  }

  /** Paired, or (allowlist) someone is on the list. */
  hasOwner(id: ChannelId): boolean {
    const s = this.states.get(id)
    if (!s) return false
    return s.channel.pairing === 'allowlist' ? true : Boolean(s.owner)
  }

  /** Where her lines go on a channel: the paired chat, or the chat the owner last wrote from. */
  private replyTo(s: State): Owner | null {
    return s.channel.pairing === 'allowlist' ? s.lastChat : s.owner
  }

  // ---- routing

  /** Any channel running with somewhere to send to. */
  reachable(): boolean {
    return this.preferred() !== null
  }

  /** The channel the owner used last (else the first one that can be reached), for what she says on her own. */
  preferred(): ChannelId | null {
    let best: State | null = null
    for (const id of CHANNEL_IDS) {
      const s = this.states.get(id)
      if (!s || !s.channel.running || !this.replyTo(s)) continue
      if (!best || s.lastUsed > best.lastUsed) best = s
    }
    return best?.channel.id ?? null
  }

  /** The channel the current work came from, if any. */
  get activeChannel(): ChannelId | null {
    const ctx = store.getStore()
    if (!ctx) return null
    const s = this.states.get(ctx.channel)
    const to = s && this.replyTo(s)
    return s?.channel.running && to && to.chat === ctx.chat ? ctx.channel : null
  }

  /** true while handling something that came from a channel, and in everything that work leads to */
  get active(): boolean {
    return this.activeChannel !== null
  }

  /** Runs fn as work for a channel's owner: what she says inside it goes there. */
  run<T>(id: ChannelId, fn: () => Promise<T>, voice = false): Promise<T> {
    const s = this.states.get(id)
    const to = s && this.replyTo(s)
    if (!to) return fn()
    return store.run({ channel: id, chat: to.chat, voice }, fn)
  }

  /** Runs fn for the preferred channel (or plainly, when none can be reached). */
  runPreferred<T>(fn: () => Promise<T>): Promise<T> {
    const id = this.preferred()
    return id ? this.run(id, fn) : fn()
  }

  // ---- what she says

  /** One of her lines, sent only while handling channel work; ask=true asks for a yes or no. */
  say(text: string, opts: { ask?: boolean } = {}): void {
    const ctx = store.getStore()
    const id = this.activeChannel
    if (!ctx || !id || !text.trim()) return
    const s = this.states.get(id)!
    const ch = s.channel
    // A line ends the current status message: the next step starts a new one below it.
    if (s.statusTimer) clearTimeout(s.statusTimer)
    s.statusTimer = null
    s.statusText = ''
    s.statusSent = ''
    s.statusId = null
    const parts = chunks(text, ch.limit)
    parts.forEach((part, i) => {
      const last = i === parts.length - 1
      const ask = last && Boolean(opts.ask)
      const clearAsk = last && !ask && s.askUp
      if (last) s.askUp = ask
      this.send(s, () => ch.sendText(ctx.chat, part, { ask, clearAsk }))
    })
    if (ctx.voice && this.opts.speak && !opts.ask) {
      this.send(s, async () => {
        const clip = await this.opts.speak!(text)
        if (clip) await ch.sendFile(ctx.chat, clip)
      })
    }
  }

  /** A step of the work ("opening Discord…"), gathered and shown as one message edited in place. Only on apps that
   * can edit a message; elsewhere "typing…" says she is on it. */
  status(text: string): void {
    const id = this.activeChannel
    if (!id || !text.trim()) return
    const s = this.states.get(id)!
    if (!s.channel.editText) return
    s.statusText = text.trim().slice(0, 300)
    if (s.statusTimer) return
    const chat = store.getStore()!.chat
    s.statusTimer = setTimeout(() => {
      s.statusTimer = null
      this.flushStatus(s, chat)
    }, this.opts.statusDelayMs ?? 1200)
  }

  /** A picture (her selfie, a screenshot) for the chat the work came from. */
  async photo(png: Uint8Array, caption?: string): Promise<void> {
    const ctx = store.getStore()
    const id = this.activeChannel
    if (!ctx || !id) return
    const s = this.states.get(id)!
    await this.send(s, () => s.channel.sendImage(ctx.chat, png, caption))
  }

  /** A file for the chat the work came from. Throws when it could not be sent, so the caller can say so. */
  async file(file: OutFile, caption?: string): Promise<void> {
    const ctx = store.getStore()
    const id = this.activeChannel
    if (!ctx || !id) throw new Error('not working on a message from a chat app')
    const s = this.states.get(id)!
    let failure: Error | null = null
    await this.send(s, () =>
      s.channel.sendFile(ctx.chat, file, caption).catch((err) => {
        failure = err as Error
        throw err
      })
    )
    if (failure) throw failure
  }

  private flushStatus(s: State, chat: string): void {
    const text = `… ${s.statusText}`
    if (!s.statusText || text === s.statusSent) return
    s.statusSent = text
    const id = s.statusId
    const ch = s.channel
    this.send(s, async () => {
      if (id !== null && ch.editText) {
        try {
          await ch.editText(chat, id, text)
          return
        } catch {
          // too old or gone: a new one below
        }
      }
      const sent = await ch.sendText(chat, text)
      // Only keep it as the status message if no line came in between.
      if (s.statusSent === text && typeof sent === 'string') s.statusId = sent
    })
  }

  private send(s: State, op: () => Promise<unknown>): Promise<void> {
    const next = s.queue.then(op).then(
      () => undefined,
      (err) => this.log(s.channel.id, `send failed: ${(err as Error).message}`)
    )
    s.queue = next
    return next
  }

  private reply(s: State, chat: string, text: string, opts: { clearAsk?: boolean } = {}): void {
    this.send(s, () => s.channel.sendText(chat, text, opts))
  }

  // ---- what comes in

  private async handle(s: State, m: Inbound): Promise<void> {
    const id = s.channel.id
    const label = CHANNEL_LABELS[id]
    if (!m.direct) {
      this.log(id, `ignored a group message from ${m.from.name}`)
      return
    }
    const text = m.text.trim()
    const ageSec = Math.round((this.now() - m.at) / 1000)
    const stale = ageSec > (this.opts.maxAgeSec ?? 120)
    const owner = this.ownerOf(s, m)

    if (!owner) {
      if (stale) return this.log(id, `ignored an old message from ${m.from.name}`)
      if (s.channel.pairing === 'ask' && !s.owner && /^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return this.askPair(s, m)
      if (s.channel.pairing === 'code' && !s.owner && this.pairingCode(id) && /^\d{6}$/.test(text.replace(/\s+/g, ''))) return this.tryCode(s, m, text.replace(/\s+/g, ''))
      return this.stranger(s, m)
    }

    if (stale) {
      const late = ageSec < 3600 ? `${Math.round(ageSec / 60)} min` : `${Math.round(ageSec / 3600)} h`
      this.log(id, `not acting on a message from ${late} ago`)
      this.reply(s, owner.chat, `"${(text || 'your voice note').slice(0, 80)}" reached me ${late} late, so I left it. Send it again if you still want it.`)
      return
    }
    s.lastUsed = this.now()
    if (s.channel.pairing === 'allowlist') s.lastChat = owner

    let message = text
    let voice = false
    if (m.voice) {
      const heard = await this.hear(s, owner, m)
      if (heard === null) return
      message = [text, heard].filter(Boolean).join('\n')
      voice = true
    }
    const command = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(message)
    const verb = command?.[1].toLowerCase()
    if (verb === 'start' || verb === 'help') {
      this.reply(s, owner.chat, HELP)
      return
    }
    if (verb === 'unpair') {
      if (s.channel.pairing === 'allowlist') {
        this.reply(s, owner.chat, `This chat is allowed in Setup on the Mac (${label}); take it off the list there.`)
        return
      }
      this.reply(s, owner.chat, `Unpaired. Pairing again takes ${s.channel.pairing === 'ask' ? 'a /start and a yes' : 'a new code from Setup'} on the Mac.`, { clearAsk: true })
      this.log(id, `unpaired ${owner.name} from the app`)
      this.unpair(id)
      return
    }
    if (verb === 'stop') message = 'stop'
    if (!message) return
    const typing = this.keepTyping(s, owner.chat)
    try {
      await store.run({ channel: id, chat: owner.chat, voice }, () => this.opts.onMessage(message, { channel: id, name: owner.name, voice }))
    } catch (err) {
      this.log(id, `handling "${message.slice(0, 40)}" failed: ${(err as Error).message}`)
      this.reply(s, owner.chat, `That went wrong on my side: ${(err as Error).message}`)
    } finally {
      typing()
    }
  }

  /** The owner this message is from, or null for anyone else. */
  private ownerOf(s: State, m: Inbound): Owner | null {
    if (s.channel.pairing === 'allowlist') {
      if (m.self) return { chat: m.chat, id: m.from.id, name: m.from.name || 'you' }
      if ((this.allow[s.channel.id] ?? []).some((h) => sameHandle(h, m.from.id))) return { chat: m.chat, id: m.from.id, name: m.from.name || m.from.id }
      return null
    }
    const o = s.owner
    return o && m.chat === o.chat && m.from.id === o.id ? o : null
  }

  private stranger(s: State, m: Inbound): void {
    const id = s.channel.id
    this.log(id, `ignored a message from ${m.from.name} (${m.from.id}): not the owner`)
    if (!s.channel.answersStrangers) return
    const last = s.strangerAt.get(m.from.id) ?? -Infinity
    if (this.now() - last < (this.opts.strangerGapMs ?? 24 * 3_600_000)) return
    // Not a way to fill memory: past a few hundred strangers, the oldest are forgotten.
    if (s.strangerAt.size > 500) s.strangerAt.delete(s.strangerAt.keys().next().value!)
    s.strangerAt.set(m.from.id, this.now())
    const how =
      s.channel.pairing === 'ask' && !s.owner ? ' To pair it, send /start and say yes on the Mac.' : s.channel.pairing === 'code' && !s.owner ? ' To pair it, send the code Setup shows on the Mac.' : ''
    this.reply(s, m.chat, `This is a private Deskmate and it only answers the person it is paired with.${how}`)
  }

  private askPair(s: State, m: Inbound): void {
    const id = s.channel.id
    const who = m.from.name
    if (this.pairing) return this.log(id, `ignored /start from ${who}: already asking the Mac about ${this.pairing.name}`)
    if ((s.refused.get(m.from.id) ?? 0) >= 2) return this.log(id, `ignored /start from ${who}: refused on the Mac twice`)
    if (this.now() < s.pairBlockedUntil) return this.log(id, `ignored /start from ${who}: the last pairing was just refused`)
    void this.pair(s, { channel: id, chat: m.chat, id: m.from.id, name: who, code: code(4) })
  }

  private async pair(s: State, req: PairRequest): Promise<void> {
    const id = s.channel.id
    s.request = req
    this.changed()
    this.log(id, `pairing request from ${req.name}, code ${req.code}`)
    this.reply(s, req.chat, `Hi! To let this chat control Deskmate, say yes on the Mac (or press Allow in Setup). The code on the Mac is ${req.code}.`)
    let yes = false
    try {
      yes = await this.opts.askToPair(req)
    } catch (err) {
      this.log(id, `pairing question failed: ${(err as Error).message}`)
    }
    if (s.request !== req) return // stopped meanwhile
    s.request = null
    if (yes && !s.owner) {
      this.setOwner(s, { chat: req.chat, id: req.id, name: req.name })
      this.reply(s, req.chat, `Paired. ${HELP}`)
    } else {
      s.refused.set(req.id, (s.refused.get(req.id) ?? 0) + 1)
      s.pairBlockedUntil = this.now() + (this.opts.pairCooldownMs ?? 60_000)
      this.log(id, `pairing with ${req.name} refused`)
      this.reply(s, req.chat, 'Not paired: nobody said yes on the Mac.')
    }
    this.changed()
  }

  private tryCode(s: State, m: Inbound, sent: string): void {
    const id = s.channel.id
    const wrong = s.wrongCodes.get(m.from.id) ?? 0
    if (wrong >= 3) return this.log(id, `ignored a code from ${m.from.name}: three wrong codes`)
    if (sent !== s.code) {
      s.wrongCodes.set(m.from.id, wrong + 1)
      this.log(id, `wrong pairing code from ${m.from.name}`)
      if (wrong + 1 < 3) this.reply(s, m.chat, 'That is not the code on the Mac.')
      return
    }
    s.code = null
    this.setOwner(s, { chat: m.chat, id: m.from.id, name: m.from.name })
    this.reply(s, m.chat, `Paired. ${HELP}`)
    this.changed()
  }

  private setOwner(s: State, owner: Owner): void {
    s.owner = owner
    this.owners[s.channel.id] = owner
    s.lastUsed = this.now()
    this.opts.onPaired(s.channel.id, owner)
    this.log(s.channel.id, `paired with ${owner.name}`)
  }

  /** The voice note as text, echoed back so they see what she heard; null when there is nothing to act on. */
  private async hear(s: State, owner: Owner, m: Inbound): Promise<string | null> {
    if (!this.opts.transcribe) {
      this.reply(s, owner.chat, "I can't listen to voice notes right now (my local speech-to-text is off). Type it?")
      return null
    }
    try {
      const audio = await m.voice!.fetch()
      if (audio.byteLength > 25 * 1024 * 1024) {
        this.reply(s, owner.chat, 'That voice note is too long for me. Keep it under a few minutes?')
        return null
      }
      const heard = await this.opts.transcribe(audio, m.voice!.mime)
      if (!heard) {
        this.reply(s, owner.chat, "I couldn't make that one out. Try again, or type it?")
        return null
      }
      this.reply(s, owner.chat, `🎤 "${heard.slice(0, 300)}"`)
      return heard
    } catch (err) {
      this.log(s.channel.id, `voice note: ${(err as Error).message}`)
      this.reply(s, owner.chat, "I couldn't listen to that voice note. Type it?")
      return null
    }
  }

  /** "typing…" while she works, renewed every few seconds; returns the stop. */
  private keepTyping(s: State, chat: string): () => void {
    const ch = s.channel
    if (!ch.typing) return () => undefined
    const once = (): void => void ch.typing!(chat).catch(() => undefined)
    once()
    const t = setInterval(once, 4500)
    t.unref?.()
    return () => clearInterval(t)
  }

  // ---- Setup and the tray

  /** One channel as Setup shows it. */
  state(id: ChannelId): { running: boolean; account: string | null; owner: string | null; request: { name: string; code: string } | null; code: { code: string; until: number } | null; error: string | null } | null {
    const s = this.states.get(id)
    if (!s) return null
    const owner = s.channel.pairing === 'allowlist' ? (s.lastChat?.name ?? null) : (s.owner?.name ?? null)
    return {
      running: s.channel.running,
      account: s.channel.account,
      owner,
      request: s.request ? { name: s.request.name, code: s.request.code } : null,
      code: this.pairingCode(id),
      error: s.error
    }
  }

  private changed(): void {
    this.opts.onChange?.()
  }

  private log(id: ChannelId, line: string): void {
    this.opts.log?.(`[${id}] ${line}`)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
