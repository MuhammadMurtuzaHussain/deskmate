import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { sameHandle } from './hub.ts'
import type { Channel, ChannelEvents, Inbound, OutFile } from './channel.ts'

// Signal, through signal-cli (github.com/AsamK/signal-cli) when it is installed: the user links it to their own
// Signal account as a second device (`signal-cli link`, scanned from the phone: Deskmate never does this for them),
// and Deskmate runs `signal-cli -a <number> jsonRpc`, reading incoming messages as JSON lines on its stdout and
// sending with JSON-RPC calls on its stdin. Like iMessage it is the user's own account, so the only messages that
// reach the hub are notes to self and messages from numbers on the allowlist; nobody else is ever answered.

/** Where signal-cli usually is: Homebrew on Apple silicon and Intel, a manual install, or on the PATH. */
export function findSignalCli(configured?: string): string | null {
  const candidates = [configured, '/opt/homebrew/bin/signal-cli', '/usr/local/bin/signal-cli', join(homedir(), '.local', 'bin', 'signal-cli')].filter((c): c is string => Boolean(c?.trim()))
  for (const c of candidates) if (existsSync(c)) return c
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = join(dir, 'signal-cli')
    if (dir && existsSync(p)) return p
  }
  return null
}

/** The running signal-cli, or a fake one in the tests. */
export interface SignalProcess {
  stdin: Writable
  stdout: Readable
  stderr?: Readable | null
  kill(): void
  on(event: 'exit', cb: (code: number | null) => void): unknown
}

export interface SignalDeps {
  /** the user's Signal number (+15551234567), the account signal-cli is linked to */
  account: string
  /** numbers that count as the user, besides the account itself */
  handles(): string[]
  /** starts signal-cli (the real one by default) */
  spawn?(): SignalProcess
  cli?: string
  /** where signal-cli keeps attachments it received */
  attachmentsDir?: string
  restartMs?: number
}

interface Attachment {
  contentType?: string
  id?: string
  filename?: string
  size?: number
  voiceNote?: boolean
}

interface Envelope {
  source?: string
  sourceNumber?: string | null
  sourceUuid?: string
  sourceName?: string
  timestamp?: number
  dataMessage?: { message?: string | null; timestamp?: number; attachments?: Attachment[]; groupInfo?: unknown; groupV2?: unknown }
  syncMessage?: { sentMessage?: { destination?: string | null; destinationNumber?: string | null; message?: string | null; timestamp?: number; attachments?: Attachment[]; groupInfo?: unknown; groupV2?: unknown } }
}

export class SignalChannel implements Channel {
  readonly id = 'signal' as const
  readonly pairing = 'allowlist' as const
  readonly answersStrangers = false
  readonly limit = 4000
  private readonly deps: SignalDeps
  private proc: SignalProcess | null = null
  private events: ChannelEvents | null = null
  private on = false
  private nextId = 1
  private readonly waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private backoff = 0

  constructor(deps: SignalDeps) {
    this.deps = deps
  }

  get running(): boolean {
    return this.on
  }

  get account(): string | null {
    return this.deps.account || null
  }

  start(events: ChannelEvents): void {
    if (this.on) return
    this.events = events
    if (!/^\+\d{6,15}$/.test(this.deps.account.trim())) {
      events.fatal('Put your Signal number in Setup first (with the country code, like +15551234567).')
      return
    }
    if (!this.deps.spawn && !findSignalCli(this.deps.cli)) {
      events.fatal('signal-cli is not installed. Install it (brew install signal-cli), link it to your account with `signal-cli link -n Deskmate`, then switch Signal on here.')
      return
    }
    this.on = true
    this.launch()
  }

  stop(): void {
    this.on = false
    const p = this.proc
    this.proc = null
    p?.kill()
    for (const w of this.waiting.values()) w.reject(new Error('signal-cli stopped'))
    this.waiting.clear()
  }

  private launch(): void {
    if (!this.on) return
    const proc =
      this.deps.spawn?.() ??
      (spawn(findSignalCli(this.deps.cli)!, ['-a', this.deps.account.trim(), 'jsonRpc'], { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as SignalProcess)
    this.proc = proc
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => (stderr = `${stderr}${String(d)}`.slice(-2000)))
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (this.proc === proc) this.line(line)
    })
    proc.on('exit', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      for (const w of this.waiting.values()) w.reject(new Error('signal-cli exited'))
      this.waiting.clear()
      if (!this.on) return
      if (/not registered|User .* is not registered|No local data/i.test(stderr)) {
        this.on = false
        this.events?.fatal('signal-cli is not linked to that number. Run `signal-cli link -n Deskmate` and scan the code with Signal on your phone (Settings → Linked devices).')
        return
      }
      this.backoff = Math.min(120_000, this.backoff ? this.backoff * 2 : (this.deps.restartMs ?? 3000))
      this.events?.log(`signal-cli exited (${code}); starting it again in ${Math.round(this.backoff / 1000)}s`)
      setTimeout(() => this.launch(), this.backoff).unref?.()
    })
  }

  private line(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { envelope?: Envelope; result?: { envelope?: Envelope } } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (typeof msg.id === 'number' && this.waiting.has(msg.id)) {
      const w = this.waiting.get(msg.id)!
      this.waiting.delete(msg.id)
      if (msg.error) w.reject(new Error(msg.error.message ?? 'signal-cli error'))
      else w.resolve(msg.result)
      return
    }
    if (msg.method !== 'receive') return
    this.backoff = 0
    const env = msg.params?.envelope ?? msg.params?.result?.envelope
    const m = env && this.inbound(env)
    if (m) this.events?.inbound(m)
  }

  /** The envelope as a message for the hub, or null when it is not the user's own. */
  inbound(env: Envelope): Inbound | null {
    const account = this.deps.account.trim()
    const handles = [account, ...this.deps.handles()]
    const mine = (h: string | null | undefined): boolean => Boolean(h) && handles.some((x) => sameHandle(x, h!))
    const sent = env.syncMessage?.sentMessage
    let text: string
    let attachments: Attachment[] | undefined
    let self = false
    let from: string
    if (sent) {
      // Something the user sent from their phone: only a note to self counts.
      if (sent.groupInfo || sent.groupV2 || !sameHandle(sent.destinationNumber ?? sent.destination ?? '', account)) return null
      text = sent.message ?? ''
      attachments = sent.attachments
      self = true
      from = account
    } else if (env.dataMessage) {
      const d = env.dataMessage
      if (d.groupInfo || d.groupV2) return null
      const number = env.sourceNumber ?? env.source ?? ''
      if (!mine(number)) return null
      text = d.message ?? ''
      attachments = d.attachments
      from = number
    } else return null
    const clip = attachments?.find((a) => a.contentType?.startsWith('audio/'))
    if (!text.trim() && !clip) return null
    const dir = this.deps.attachmentsDir ?? join(homedir(), '.local', 'share', 'signal-cli', 'attachments')
    return {
      chat: self ? account : from,
      from: { id: from, name: self ? 'you (note to self)' : env.sourceName || from },
      text,
      voice: clip?.id ? { mime: clip.contentType ?? 'audio/aac', fetch: async () => new Uint8Array(readFileSync(join(dir, basename(clip.id!)))) } : undefined,
      at: env.timestamp ?? Date.now(),
      direct: true,
      self
    }
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const proc = this.proc
    if (!proc) return Promise.reject(new Error('signal-cli is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`signal-cli did not answer ${method}`))
      }, 60_000)
      t.unref?.()
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e))
      })
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params, id })}\n`)
    })
  }

  private to(chat: string): Record<string, unknown> {
    return sameHandle(chat, this.deps.account) ? { noteToSelf: true } : { recipient: [chat] }
  }

  async sendText(chat: string, text: string, opts: { ask?: boolean } = {}): Promise<void> {
    await this.rpc('send', { ...this.to(chat), message: opts.ask ? `${text} (yes / no)` : text })
  }

  async sendImage(chat: string, png: Uint8Array, caption?: string): Promise<void> {
    await this.sendFile(chat, { name: 'deskmate.png', bytes: png, mime: 'image/png' }, caption)
  }

  async sendFile(chat: string, file: OutFile, caption?: string): Promise<void> {
    // signal-cli sends attachments from a path: a private temp folder, removed after.
    const dir = mkdtempSync(join(tmpdir(), 'deskmate-signal-'))
    const path = join(dir, basename(file.name) || 'file')
    writeFileSync(path, file.bytes, { mode: 0o600 })
    try {
      await this.rpc('send', { ...this.to(chat), message: caption ?? '', attachments: [path] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async typing(chat: string): Promise<void> {
    if (sameHandle(chat, this.deps.account)) return
    await this.rpc('sendTyping', { recipient: [chat] })
  }
}
