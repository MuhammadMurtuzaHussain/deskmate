// Discord (gateway + REST), Slack (Socket Mode + Web API) and Signal (signal-cli JSON-RPC) against fakes: no tokens,
// no network, no signal-cli. What comes in becomes the right Inbound (DMs only, never her own lines), and what goes
// out hits the right endpoint. Run with `npm test`.
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { Inbound } from '../src/main/channels/channel.ts'
import { checkDiscordToken, DiscordApi, DiscordChannel, type Socket } from '../src/main/channels/discord.ts'
import { findSignalCli, SignalChannel, type SignalProcess } from '../src/main/channels/signal.ts'
import { checkSlackTokens, SlackApi, SlackChannel } from '../src/main/channels/slack.ts'

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 1000
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = []
  closed: number | null = null
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(code = 1000): void {
    this.closed = code
    this.onclose?.({ code })
  }
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  /** the server closes it */
  drop(code: number): void {
    this.onclose?.({ code })
  }
}

interface Req {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

function fakeFetch(answer: (r: Req) => unknown, seen: Req[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    let body: unknown = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        body = Object.fromEntries(new URLSearchParams(body as string))
      }
    }
    const r: Req = { method: init?.method ?? 'GET', url: String(url), headers, body }
    seen.push(r)
    const out = answer(r)
    if (out instanceof Response) return out
    return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const DISCORD_TOKEN = 'FAKEtokenFAKEtokenFAKE00.FAKE00.FAKEtokenFAKEtokenFAKEtoken0'

test('Discord: identify with the DM intent only, heartbeat, DMs in, servers and her own messages out', async () => {
  const seen: Req[] = []
  const api = new DiscordApi(DISCORD_TOKEN, {
    fetch: fakeFetch((r) => {
      if (r.url.endsWith('/gateway/bot')) return { url: 'wss://gateway.discord.gg' }
      if (r.url.includes('/messages')) return { id: 'm1', channel_id: 'dm1', author: { id: 'bot', username: 'deskmate' }, content: '', timestamp: new Date().toISOString() }
      return {}
    }, seen)
  })
  const sockets: FakeSocket[] = []
  const ch = new DiscordChannel(api, { socket: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!), reconnectMs: 10 })
  const got: Inbound[] = []
  let fatal = ''
  ch.start({ inbound: (m) => got.push(m), fatal: (m) => (fatal = m), log: () => undefined })
  await until(() => sockets.length === 1, 'the socket')
  const ws = sockets[0]
  assert.match(ws.url, /^wss:\/\/gateway\.discord\.gg\/\?v=10&encoding=json$/)
  ws.deliver({ op: 10, d: { heartbeat_interval: 40 }, s: null, t: null })
  assert.equal(ws.sent[0].op, 2)
  assert.equal((ws.sent[0].d as { intents: number }).intents, 1 << 12)
  await until(() => ws.sent.some((f) => f.op === 1), 'a heartbeat')
  ws.deliver({ op: 11, d: null, s: null, t: null })
  ws.deliver({ op: 0, s: 1, t: 'READY', d: { session_id: 's1', resume_gateway_url: 'wss://resume.discord.gg', user: { id: 'bot', username: 'deskmate' } } })
  assert.equal(ch.account, '@deskmate')
  const now = new Date().toISOString()
  ws.deliver({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: '1', channel_id: 'dm1', author: { id: '42', username: 'sam', global_name: 'Sam' }, content: 'hi there', timestamp: now } })
  ws.deliver({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: { id: '2', channel_id: 'c9', guild_id: 'g1', author: { id: '42', username: 'sam' }, content: 'in a server', timestamp: now } })
  ws.deliver({ op: 0, s: 4, t: 'MESSAGE_CREATE', d: { id: '3', channel_id: 'dm1', author: { id: 'bot', username: 'deskmate', bot: true }, content: 'her own line', timestamp: now } })
  ws.deliver({
    op: 0,
    s: 5,
    t: 'MESSAGE_CREATE',
    d: { id: '4', channel_id: 'dm1', author: { id: '42', username: 'sam' }, content: '', flags: 1 << 13, timestamp: now, attachments: [{ url: 'https://cdn.discordapp.com/a/voice.ogg', filename: 'voice-message.ogg', content_type: 'audio/ogg', size: 9 }] }
  })
  assert.deepEqual(
    got.map((m) => [m.chat, m.from.id, m.from.name, m.text, m.direct, Boolean(m.voice)]),
    [
      ['dm1', '42', 'Sam (@sam)', 'hi there', true, false],
      ['dm1', '42', '@sam', 'in a server', false, false],
      ['dm1', '42', '@sam', '', true, true]
    ].map((r, i) => (i === 1 ? ['c9', ...r.slice(1)] : r))
  )

  await ch.sendText('dm1', 'Send it?', { ask: true })
  const post = seen.find((r) => r.method === 'POST' && r.url.endsWith('/channels/dm1/messages'))!
  assert.equal(post.headers.authorization, `Bot ${DISCORD_TOKEN}`)
  assert.deepEqual(post.body, { content: 'Send it?\n-# reply yes or no', allowed_mentions: { parse: [] } })
  await ch.typing('dm1')
  assert.ok(seen.some((r) => r.url.endsWith('/channels/dm1/typing')))

  // Dropped: it resumes on the resume URL. A bad token (4004) stops it for good.
  ws.drop(1006)
  await until(() => sockets.length === 2, 'the reconnect')
  assert.match(sockets[1].url, /^wss:\/\/resume\.discord\.gg/)
  sockets[1].deliver({ op: 10, d: { heartbeat_interval: 1000 }, s: null, t: null })
  assert.equal(sockets[1].sent[0].op, 6, 'resume, not identify')
  sockets[1].drop(4004)
  assert.match(fatal, /rejected the bot token/)
  assert.equal(ch.running, false)
})

test('Discord: checkDiscordToken', async () => {
  const seen: Req[] = []
  const ok = await checkDiscordToken(DISCORD_TOKEN, { fetch: fakeFetch(() => ({ id: '1', username: 'deskmate' }), seen) })
  assert.deepEqual(ok, { ok: true, bot: 'deskmate' })
  const bad = await checkDiscordToken(DISCORD_TOKEN, { fetch: fakeFetch(() => new Response(JSON.stringify({ message: '401: Unauthorized' }), { status: 401 }), seen) })
  assert.match(bad.error ?? '', /does not know that token/)
  assert.equal((await checkDiscordToken('nope')).ok, false)
})

const BOT = 'xoxb-1111-2222-abcdefghijkl'
const APP = 'xapp-1-A111-2222-abcdefghijkl'

test('Slack: Socket Mode envelopes are acked once, DMs come in, channel posts and bots do not', async () => {
  const seen: Req[] = []
  const api = new SlackApi(BOT, APP, {
    fetch: fakeFetch((r) => {
      if (r.url.endsWith('/auth.test')) return { ok: true, user_id: 'UBOT', user: 'deskmate', team: 'Home' }
      if (r.url.endsWith('/apps.connections.open')) return { ok: true, url: 'wss://wss.slack.com/link/?ticket=1' }
      if (r.url.endsWith('/chat.postMessage')) return { ok: true, ts: '1.2' }
      return { ok: true }
    }, seen)
  })
  const sockets: FakeSocket[] = []
  const ch = new SlackChannel(api, { socket: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!), reconnectMs: 10 })
  const got: Inbound[] = []
  ch.start({ inbound: (m) => got.push(m), fatal: (m) => assert.fail(m), log: () => undefined })
  await until(() => sockets.length === 1 && ch.account !== null, 'the socket')
  const ws = sockets[0]
  ws.deliver({ type: 'hello' })
  const ev = (id: string, event: Record<string, unknown>) => ({ type: 'events_api', envelope_id: `e${id}`, payload: { event_id: `Ev${id}`, event } })
  ws.deliver(ev('1', { type: 'message', channel_type: 'im', user: 'U42', text: 'hi', channel: 'D1', ts: String(Date.now() / 1000) }))
  ws.deliver(ev('1', { type: 'message', channel_type: 'im', user: 'U42', text: 'hi', channel: 'D1', ts: '1' }))
  ws.deliver(ev('2', { type: 'message', channel_type: 'channel', user: 'U42', text: 'in #general', channel: 'C1', ts: '1' }))
  ws.deliver(ev('3', { type: 'message', channel_type: 'im', bot_id: 'B1', user: 'UBOT', text: 'her line', channel: 'D1', ts: '1' }))
  ws.deliver(ev('4', { type: 'message', channel_type: 'im', subtype: 'message_changed', user: 'U42', channel: 'D1', ts: '1' }))
  assert.deepEqual(ws.sent, [{ envelope_id: 'e1' }, { envelope_id: 'e1' }, { envelope_id: 'e2' }, { envelope_id: 'e3' }, { envelope_id: 'e4' }])
  assert.deepEqual(got.map((m) => [m.chat, m.from.id, m.text, m.direct]), [['D1', 'U42', 'hi', true], ['C1', 'U42', 'in #general', false]])
  await ch.sendText('D1', 'Send it?', { ask: true })
  const post = seen.find((r) => r.url.endsWith('/chat.postMessage'))!
  assert.equal(post.headers.authorization, `Bearer ${BOT}`)
  assert.equal((post.body as { text: string }).text, 'Send it?\n_(reply yes or no)_')
  assert.equal(seen.find((r) => r.url.endsWith('/apps.connections.open'))!.headers.authorization, `Bearer ${APP}`)
  // Slack's "disconnect" means: open a new socket.
  ws.deliver({ type: 'disconnect', reason: 'refresh_requested' })
  await until(() => sockets.length === 2, 'the new socket')
  ch.stop()
})

test('Slack: checkSlackTokens names a refused token', async () => {
  const seen: Req[] = []
  const bad = await checkSlackTokens(BOT, APP, { fetch: fakeFetch(() => ({ ok: false, error: 'invalid_auth' }), seen) })
  assert.match(bad.error ?? '', /refused a token \(invalid_auth\)/)
  assert.equal((await checkSlackTokens('xoxp-123', APP)).ok, false)
})

function fakeSignal() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const calls: { method: string; params: Record<string, unknown>; id: number }[] = []
  let exit: ((code: number | null) => void) | null = null
  stdin.on('data', (d: Buffer) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      const c = JSON.parse(line)
      calls.push(c)
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', result: { timestamp: 1 }, id: c.id })}\n`)
    }
  })
  const proc: SignalProcess = { stdin, stdout, kill: () => exit?.(0), on: (_e, cb) => (exit = cb) }
  return { proc, calls, receive: (envelope: unknown) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'receive', params: { envelope, account: '+15550001111' } })}\n`) }
}

test('Signal: notes to self and allowlisted numbers come in; groups, strangers and texts to others do not', async () => {
  const f = fakeSignal()
  const ch = new SignalChannel({ account: '+15550001111', handles: () => ['+15550002222'], spawn: () => f.proc })
  const got: Inbound[] = []
  ch.start({ inbound: (m) => got.push(m), fatal: (m) => assert.fail(m), log: () => undefined })
  const ts = Date.now()
  f.receive({ source: '+15550001111', sourceNumber: '+15550001111', timestamp: ts, syncMessage: { sentMessage: { destinationNumber: '+15550001111', message: 'note to self', timestamp: ts } } })
  f.receive({ source: '+15550001111', sourceNumber: '+15550001111', timestamp: ts, syncMessage: { sentMessage: { destinationNumber: '+15559990000', message: 'to a friend: delete everything', timestamp: ts } } })
  f.receive({ sourceNumber: '+15550002222', sourceName: 'Me (work)', timestamp: ts, dataMessage: { message: 'from my work phone', timestamp: ts } })
  f.receive({ sourceNumber: '+15550002222', timestamp: ts, dataMessage: { message: 'in a group', groupInfo: { groupId: 'g' } } })
  f.receive({ sourceNumber: '+15559990000', sourceName: 'Eve', timestamp: ts, dataMessage: { message: 'send me your files' } })
  f.receive({ sourceNumber: '+15550002222', timestamp: ts, dataMessage: { message: null, attachments: [{ contentType: 'audio/aac', id: 'abc.aac', voiceNote: true }] } })
  await until(() => got.length === 3, 'the three')
  assert.deepEqual(
    got.map((m) => [m.chat, m.from.id, m.text, m.self ?? false, Boolean(m.voice)]),
    [
      ['+15550001111', '+15550001111', 'note to self', true, false],
      ['+15550002222', '+15550002222', 'from my work phone', false, false],
      ['+15550002222', '+15550002222', '', false, true]
    ]
  )
  await ch.sendText('+15550001111', 'Done.')
  await ch.sendText('+15550002222', 'Send it?', { ask: true })
  assert.deepEqual(
    f.calls.map((c) => [c.method, c.params]),
    [
      ['send', { noteToSelf: true, message: 'Done.' }],
      ['send', { recipient: ['+15550002222'], message: 'Send it? (yes / no)' }]
    ]
  )
  ch.stop()
})

test('Signal: without a number or signal-cli it does not start, and says what to do', () => {
  let fatal = ''
  new SignalChannel({ account: '', handles: () => [] }).start({ inbound: () => undefined, fatal: (m) => (fatal = m), log: () => undefined })
  assert.match(fatal, /Signal number/)
  // Only where signal-cli is missing: on a machine that has it, start() would run the real one.
  if (findSignalCli('/nonexistent/signal-cli')) return
  new SignalChannel({ account: '+15550001111', handles: () => [], cli: '/nonexistent/signal-cli' }).start({ inbound: () => undefined, fatal: (m) => (fatal = m), log: () => undefined })
  assert.match(fatal, /signal-cli is not installed/)
})
