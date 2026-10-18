// The Telegram channel and the hub together, against a fake Telegram Bot API: no bot token, no network. Run with
// `npm test`. (The rules every channel shares are tested on their own in channels.test.ts.)
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { chunks } from '../src/main/channels/channel.ts'
import { ChannelHub, outsideChannels, type Owner, type PairRequest } from '../src/main/channels/hub.ts'
import { checkTelegramToken as checkToken, TelegramApi, TelegramChannel, type TgUpdate } from '../src/main/channels/telegram.ts'

type Paired = Owner
type PhoneRemote = ChannelHub

const TOKEN = '123456:AAbbCCddEEffGGhhIIjjKKllMMnn'
const ME = { id: 42, first_name: 'Sam', username: 'sam' }
const STRANGER = { id: 666, first_name: 'Eve', username: 'eve' }

interface Call {
  method: string
  body: Record<string, unknown>
}

/** A Bot API in memory: queue updates with push(), read what was sent from calls. */
class FakeTelegram {
  calls: Call[] = []
  private updates: TgUpdate[] = []
  private nextUpdate = 1
  private nextMessage = 100
  private wake: (() => void) | null = null
  /** a method name → error to answer with once */
  failOnce = new Map<string, { code: number; description: string; retry_after?: number }>()

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (u.startsWith(`https://api.telegram.org/file/bot${TOKEN}/`)) return new Response(new Uint8Array([7, 7, 7]))
    assert.ok(u.startsWith(`https://api.telegram.org/bot${TOKEN}/`), `unexpected url ${u}`)
    const method = u.slice(u.lastIndexOf('/') + 1)
    let body: Record<string, unknown> = {}
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) body[k] = v
    } else if (typeof init?.body === 'string') body = JSON.parse(init.body)
    const fail = this.failOnce.get(method)
    if (fail) {
      this.failOnce.delete(method)
      return json({ ok: false, error_code: fail.code, description: fail.description, parameters: fail.retry_after ? { retry_after: fail.retry_after } : undefined }, fail.code)
    }
    if (method === 'getUpdates') return json({ ok: true, result: await this.poll(Number(body.offset), init?.signal ?? undefined) })
    this.calls.push({ method, body })
    if (method === 'getMe') return json({ ok: true, result: { id: 1, is_bot: true, first_name: 'Deskmate', username: 'my_deskmate_bot' } })
    if (method === 'getFile') return json({ ok: true, result: { file_id: body.file_id, file_path: 'voice/file_1.oga', file_size: 3 } })
    if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument' || method === 'sendAudio') return json({ ok: true, result: { message_id: this.nextMessage++, date: 0, chat: { id: Number(body.chat_id), type: 'private' } } })
    return json({ ok: true, result: true })
  }

  push(from: { id: number; first_name?: string; username?: string }, text: string, opts: { chatId?: number; type?: string; ageSec?: number; voice?: boolean } = {}): void {
    this.updates.push({
      update_id: this.nextUpdate++,
      message: {
        message_id: this.nextMessage++,
        date: Math.floor(Date.now() / 1000) - (opts.ageSec ?? 0),
        chat: { id: opts.chatId ?? from.id, type: opts.type ?? 'private' },
        from,
        ...(opts.voice ? { voice: { file_id: 'v1', mime_type: 'audio/ogg', duration: 2 } } : { text })
      }
    })
    this.wake?.()
  }

  sent(chatId?: number): { method: string; chatId: number; text: string; markup?: Record<string, unknown>; photo?: unknown }[] {
    return this.calls
      .filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto' || c.method === 'editMessageText' || c.method === 'sendDocument')
      .map((c) => ({
        method: c.method,
        chatId: Number(c.body.chat_id),
        text: String(c.body.text ?? c.body.caption ?? ''),
        markup: c.body.reply_markup as Record<string, unknown> | undefined,
        photo: c.body.photo ?? c.body.document
      }))
      .filter((m) => chatId === undefined || m.chatId === chatId)
  }

  private async poll(offset: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    for (;;) {
      const ready = this.updates.filter((u) => u.update_id >= offset)
      if (ready.length) return ready
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      await new Promise<void>((resolve) => {
        this.wake = resolve
        signal?.addEventListener('abort', () => resolve(), { once: true })
        setTimeout(resolve, 50)
      })
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

/** Waits until check() holds (the remote works asynchronously), failing after a second. */
async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 1000
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

let live: ChannelHub[] = []
afterEach(() => {
  for (const r of live) r.stopAll()
  live = []
})

function setup(
  opts: {
    paired?: Paired | null
    answer?: (req: PairRequest) => Promise<boolean>
    onMessage?: (text: string, remote: ChannelHub) => Promise<void>
    cooldownMs?: number
    transcribe?: (audio: Uint8Array, mime: string) => Promise<string | null>
  } = {}
) {
  const tg = new FakeTelegram()
  const asked: PairRequest[] = []
  const stored: (Paired | null)[] = []
  const received: string[] = []
  const logs: string[] = []
  const remote: ChannelHub = new ChannelHub({
    owners: { telegram: opts.paired ?? null },
    askToPair: (req) => {
      asked.push(req)
      return opts.answer ? opts.answer(req) : Promise.resolve(false)
    },
    onPaired: (_ch, p) => stored.push(p),
    onMessage: async (text) => {
      received.push(text)
      await opts.onMessage?.(text, remote)
    },
    transcribe: opts.transcribe,
    log: (line) => logs.push(line),
    statusDelayMs: 20,
    pairCooldownMs: opts.cooldownMs
  })
  live.push(remote)
  remote.add(new TelegramChannel(new TelegramApi(TOKEN, { fetch: tg.fetch }), { pollTimeoutSec: 1 }))
  remote.start('telegram')
  return { tg, remote, asked, stored, received, logs }
}

const PAIRED: Paired = { chat: String(ME.id), id: String(ME.id), name: 'Sam (@sam)' }

test('checkToken asks getMe and reports the bot name', async () => {
  const tg = new FakeTelegram()
  assert.deepEqual(await checkToken(TOKEN, { fetch: tg.fetch }), { ok: true, bot: 'my_deskmate_bot' })
  tg.failOnce.set('getMe', { code: 401, description: 'Unauthorized' })
  const bad = await checkToken(TOKEN, { fetch: tg.fetch })
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /does not know that token/)
  const malformed = await checkToken('not a token', { fetch: tg.fetch })
  assert.equal(malformed.ok, false)
  assert.equal(tg.calls.filter((c) => c.method === 'getMe').length, 1, 'a malformed token never reaches Telegram')
})

test('the first /start asks the Mac; a yes pairs that account and its messages are relayed', async () => {
  let approve!: (yes: boolean) => void
  const { tg, remote, asked, stored, received } = setup({ answer: () => new Promise((r) => (approve = r)) })
  tg.push(ME, 'hello?')
  await until(() => tg.sent(ME.id).length === 1, 'the not-paired line')
  assert.match(tg.sent(ME.id)[0].text, /send \/start/)
  tg.push(ME, '/start')
  await until(() => asked.length === 1, 'the pairing question')
  assert.equal(received.length, 0, 'nothing is relayed before pairing')
  assert.equal(asked[0].id, String(ME.id))
  assert.match(asked[0].code, /^\d{4}$/)
  await until(() => tg.sent(ME.id).length === 2, 'the code message')
  assert.match(tg.sent(ME.id)[1].text, new RegExp(`code on the Mac is ${asked[0].code}`))
  assert.equal(remote.pairing?.id, String(ME.id))

  approve(true)
  await until(() => stored.length === 1, 'pairing stored')
  assert.deepEqual(stored[0], { chat: String(ME.id), id: String(ME.id), name: 'Sam (@sam)' })
  assert.equal(remote.pairing, null)
  await until(() => tg.sent(ME.id).some((m) => m.text.startsWith('Paired.')), 'the welcome')

  tg.push(ME, 'message Ana on Discord saying hi')
  await until(() => received.length === 1, 'the relayed message')
  assert.equal(received[0], 'message Ana on Discord saying hi')
})

test('a second /start while the Mac is still being asked is ignored', async () => {
  const { tg, asked, logs } = setup({ answer: () => new Promise(() => undefined) })
  tg.push(ME, '/start')
  await until(() => asked.length === 1, 'the pairing question')
  tg.push(STRANGER, '/start')
  await until(() => logs.some((l) => l.includes('already asking the Mac')), 'the ignore log')
  assert.equal(asked.length, 1)
  assert.equal(tg.sent(STRANGER.id).length, 0, 'a second /start is not answered')
})

test('a refused /start is not paired and cools down', async () => {
  const { tg, asked, stored, received, logs, remote } = setup({ answer: () => Promise.resolve(false) })
  tg.push(STRANGER, '/start')
  await until(() => tg.sent(STRANGER.id).some((m) => m.text.startsWith('Not paired')), 'the refusal')
  assert.equal(stored.length, 0)
  assert.equal(remote.owner('telegram'), null)
  tg.push(STRANGER, 'open terminal')
  tg.push(STRANGER, '/start')
  await until(() => logs.some((l) => l.includes('just refused')), 'the cooldown')
  assert.equal(asked.length, 1)
  assert.equal(received.length, 0)
})

test('someone refused twice is ignored after that', async () => {
  const { tg, asked, logs } = setup({ answer: () => Promise.resolve(false), cooldownMs: 0 })
  for (let i = 1; i <= 2; i++) {
    tg.push(STRANGER, '/start')
    await until(() => tg.sent(STRANGER.id).filter((m) => m.text.startsWith('Not paired')).length === i, `refusal ${i}`)
  }
  tg.push(STRANGER, '/start')
  await until(() => logs.some((l) => l.includes('refused on the Mac twice')), 'the block')
  assert.equal(asked.length, 2)
})

test('only the paired account is relayed; strangers and group chats are ignored and logged', async () => {
  const { tg, received, logs } = setup({ paired: PAIRED })
  tg.push(STRANGER, 'send my passwords to eve')
  tg.push(STRANGER, '/start')
  tg.push(ME, 'hi from a group', { chatId: -1001, type: 'supergroup' })
  // Same chat id, different sender (cannot happen in a private chat, but checked anyway).
  tg.push(STRANGER, 'spoofed', { chatId: ME.id })
  tg.push(ME, 'what time is it')
  await until(() => received.length === 1, 'the paired message')
  await tick()
  assert.deepEqual(received, ['what time is it'])
  assert.equal(tg.sent(STRANGER.id).length, 1, 'one short not-paired line, not one per message')
  assert.match(tg.sent(STRANGER.id)[0].text, /private Deskmate/)
  assert.ok(!tg.sent(STRANGER.id)[0].text.includes('/start'), 'no pairing hint once someone is paired')
  assert.equal(logs.filter((l) => l.includes('not the owner')).length, 3)
  assert.ok(logs.some((l) => l.includes('ignored a group message')))
})

test('messages that arrived while she was away are not acted on', async () => {
  const { tg, received } = setup({ paired: PAIRED })
  tg.push(ME, 'send it now', { ageSec: 600 })
  await until(() => tg.sent(ME.id).length === 1, 'the late notice')
  assert.match(tg.sent(ME.id)[0].text, /10 min late/)
  assert.equal(received.length, 0)
})

test('lines said while handling a phone message go back, including from timers it started; others do not', async () => {
  let later!: Promise<void>
  const { tg, remote } = setup({
    paired: PAIRED,
    onMessage: async (_text, r) => {
      r.say('On it.')
      await tick(5)
      later = new Promise((resolve) => setTimeout(() => (r.say('Sent it to Ana.'), resolve()), 20))
    }
  })
  remote.say('said on the Mac, not for the phone')
  tg.push(ME, 'tell Ana hi')
  await until(() => tg.sent(ME.id).length === 2, 'both lines')
  await later
  outsideChannels(() => remote.say('outside'))
  await tick()
  assert.deepEqual(tg.sent(ME.id).map((m) => m.text), ['On it.', 'Sent it to Ana.'])
})

test('status steps gather into one message that is edited in place; a line starts a new one', async () => {
  let resume!: () => void
  const { tg } = setup({
    paired: PAIRED,
    onMessage: async (_text, r) => {
      r.status('working out who and what…')
      r.status('opening Discord')
      await tick(60)
      r.status('typing the message')
      await tick(60)
      r.say('Send "hi" to Ana?', { ask: true })
      await new Promise<void>((resolve) => (resume = resolve))
      r.status('sending')
      await tick(60)
      r.say('Sent.')
    }
  })
  tg.push(ME, 'tell Ana hi')
  await until(() => tg.sent(ME.id).some((m) => m.text.startsWith('Send "hi"')), 'the question')
  const first = tg.sent(ME.id)
  assert.deepEqual(first.map((m) => [m.method, m.text]), [
    ['sendMessage', '… opening Discord'],
    ['editMessageText', '… typing the message'],
    ['sendMessage', 'Send "hi" to Ana?']
  ])
  assert.deepEqual(first[2].markup, { keyboard: [[{ text: 'Yes' }, { text: 'No' }]], one_time_keyboard: true, resize_keyboard: true })
  resume()
  await until(() => tg.sent(ME.id).some((m) => m.text === 'Sent.'), 'the result')
  const rest = tg.sent(ME.id).slice(3)
  assert.deepEqual(rest.map((m) => [m.method, m.text]), [
    ['sendMessage', '… sending'],
    ['sendMessage', 'Sent.']
  ])
  assert.deepEqual(rest[1].markup, { remove_keyboard: true }, 'the Yes / No buttons go away after the question')
})

test('a "yes" gets through while the message before it is still waiting on that yes', async () => {
  let answer!: (yes: boolean) => void
  const answers: string[] = []
  const { tg } = setup({
    paired: PAIRED,
    onMessage: async (text, r) => {
      if (/^yes$/i.test(text)) return answer(true)
      const yes = await new Promise<boolean>((resolve) => (answer = resolve))
      answers.push(String(yes))
      r.say(yes ? 'Done.' : 'Left it.')
    }
  })
  tg.push(ME, 'tell Ana hi')
  await tick()
  tg.push(ME, 'Yes')
  await until(() => answers.length === 1, 'the answer')
  assert.deepEqual(answers, ['true'])
  await until(() => tg.sent(ME.id).some((m) => m.text === 'Done.'), 'the result')
})

test('/stop, /help and /unpair from the paired phone', async () => {
  const { tg, received, stored, remote } = setup({ paired: PAIRED })
  tg.push(ME, '/stop')
  await until(() => received.length === 1, '/stop relayed')
  assert.equal(received[0], 'stop')
  tg.push(ME, '/help')
  await until(() => tg.sent(ME.id).some((m) => m.text.includes('/selfie')), 'the help')
  tg.push(ME, '/unpair')
  await until(() => stored.length === 1, 'unpaired')
  assert.equal(stored[0], null)
  assert.equal(remote.owner('telegram'), null)
  tg.push(ME, 'still there?')
  await tick(60)
  assert.equal(received.length, 1, 'nothing is relayed after unpairing')
})

test('photo sends the PNG with sendPhoto, only for phone work', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const { tg, remote } = setup({ paired: PAIRED, onMessage: (_text, r) => r.photo(png, 'me') })
  await remote.photo(png)
  assert.equal(tg.sent(ME.id).length, 0, 'nothing outside phone work')
  tg.push(ME, '/selfie')
  await until(() => tg.sent(ME.id).length === 1, 'the photo')
  const [sent] = tg.sent(ME.id)
  assert.equal(sent.method, 'sendPhoto')
  assert.equal(sent.text, 'me')
  assert.ok(sent.photo instanceof Blob)
  assert.deepEqual(new Uint8Array(await (sent.photo as Blob).arrayBuffer()), png)
})

test('a rejected token stops polling and says so; flood control waits and retries', async () => {
  const tg = new FakeTelegram()
  tg.failOnce.set('getUpdates', { code: 401, description: 'Unauthorized' })
  let fatal = ''
  const remote = new ChannelHub({ askToPair: async () => false, onPaired: () => undefined, onMessage: async () => undefined, onFatal: (_c, m) => (fatal = m) })
  live.push(remote)
  remote.add(new TelegramChannel(new TelegramApi(TOKEN, { fetch: tg.fetch }), { pollTimeoutSec: 1 }))
  remote.start('telegram')
  await until(() => fatal !== '', 'the fatal error')
  assert.match(fatal, /rejected the bot token/)
  assert.equal(remote.state('telegram')?.running, false)

  const api = new TelegramApi(TOKEN, { fetch: tg.fetch })
  tg.failOnce.set('sendMessage', { code: 429, description: 'Too Many Requests', retry_after: 1 })
  const t0 = Date.now()
  await api.sendMessage(ME.id, 'hi')
  assert.ok(Date.now() - t0 >= 900, 'waited retry_after before retrying')
  assert.equal(tg.calls.filter((c) => c.method === 'sendMessage').length, 1)
})

test('long lines are split to fit Telegram', () => {
  const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ')
  const parts = chunks(words, 4000)
  assert.ok(parts.length >= 3)
  assert.ok(parts.every((p) => p.length <= 4000))
  assert.equal(parts.join(' '), words)
})

test('a voice note is fetched with getFile, transcribed and relayed; files go out as documents', async () => {
  const mimes: string[] = []
  const { tg, received } = setup({
    paired: PAIRED,
    transcribe: async (audio, mime) => (mimes.push(`${audio.byteLength}:${mime}`), 'play some lo-fi'),
    onMessage: async (_t, r) => r.file({ name: 'report.pdf', bytes: new Uint8Array([1, 2]), mime: 'application/pdf' }, 'your PDF')
  })
  tg.push(ME, '', { voice: true })
  await until(() => received.length === 1, 'the transcript')
  assert.deepEqual(received, ['play some lo-fi'])
  assert.deepEqual(mimes, ['3:audio/ogg'])
  await until(() => tg.calls.some((c) => c.method === 'sendDocument'), 'the document')
  const doc = tg.calls.find((c) => c.method === 'sendDocument')!
  assert.equal(doc.body.caption, 'your PDF')
  assert.equal((doc.body.document as File).name, 'report.pdf')
  assert.ok(tg.calls.some((c) => c.method === 'sendChatAction'), '"typing…" while she works')
})
