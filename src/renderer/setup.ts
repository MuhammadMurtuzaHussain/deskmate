import type { CharacterCard, CharacterDetails, DraftAction, JobSetupAction, LearnSetupState, McpSetupState, NoticePrefs, NoticeState, OnboardPermRow, OnboardState, ChannelKey, ChannelSetup, ScheduleSetupState, SetupState, SafetySetupState, SpendSetupState, PermLevel, PermOriginId } from '../shared/types'

const api = window.deskmate
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const brainChip = $<HTMLSpanElement>('brain-chip')
const brainMsg = $<HTMLDivElement>('brain-msg')
const ollamaOn = $<HTMLDivElement>('ollama-on')
const ollamaOff = $<HTMLDivElement>('ollama-off')
const modelSelect = $<HTMLSelectElement>('ollama-model')
const useOllama = $<HTMLButtonElement>('use-ollama')
const geminiForm = $<HTMLFormElement>('gemini')
const geminiKey = $<HTMLInputElement>('gemini-key')
const claudeForm = $<HTMLFormElement>('claude')
const claudeKey = $<HTMLInputElement>('claude-key')
const claudePick = $<HTMLDivElement>('claude-pick')
const claudeModel = $<HTMLSelectElement>('claude-model')
const useClaude = $<HTMLButtonElement>('use-claude')
const claudeEffort = $<HTMLSelectElement>('claude-effort')
const effortPick = (): 'low' | 'medium' | 'high' => claudeEffort.value as 'low' | 'medium' | 'high'

/** What each current model is good for here; anything else the key offers is listed after these. */
const CLAUDE_NOTES: Record<string, string> = {
  'claude-opus-5-5': 'best at getting things done',
  'claude-sonnet-5-5': 'quicker, cheaper',
  'claude-haiku-5-5': 'quickest, cheapest',
  'claude-fable-5-1': 'most capable, priciest'
}

function fillClaudeModels(models: { id: string; name: string }[], current: string): void {
  const order = Object.keys(CLAUDE_NOTES)
  const sorted = [...models].sort((a, b) => {
    const ia = order.indexOf(a.id)
    const ib = order.indexOf(b.id)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  const keep = claudeModel.value || current
  claudeModel.innerHTML = ''
  for (const m of sorted) {
    const opt = document.createElement('option')
    opt.value = m.id
    opt.textContent = CLAUDE_NOTES[m.id] ? `${m.name} · ${CLAUDE_NOTES[m.id]}` : m.name
    opt.selected = m.id === keep
    claudeModel.appendChild(opt)
  }
  claudePick.classList.toggle('hidden', !sorted.length)
}

/** Vision models first: she looks at your screen, and a text-only model cannot. */
function looksVisual(name: string): boolean {
  return /(?:-vl|vision|llava|gemma3|gemma4|minicpm-v|moondream)/i.test(name)
}

function chip(el: HTMLElement, text: string, kind: 'ok' | 'bad' | '' = ''): void {
  el.textContent = text
  el.className = `chip${kind ? ` ${kind}` : ''}`
}

function message(text: string, kind: 'good' | 'bad' | '' = ''): void {
  brainMsg.textContent = text
  brainMsg.className = `msg${kind ? ` ${kind}` : ''}`
}

function render(state: SetupState): void {
  const b = state.brain
  chip(brainChip, b.mode === 'demo' ? 'not set up' : `thinking with ${b.modelName}`, b.mode === 'demo' ? 'bad' : 'ok')
  ollamaOn.classList.toggle('hidden', !b.ollama.running)
  ollamaOff.classList.toggle('hidden', b.ollama.running)
  if (b.ollama.running) {
    const models = [...b.ollama.models].sort((x, y) => Number(looksVisual(y)) - Number(looksVisual(x)))
    const keep = modelSelect.value || b.ollama.current
    modelSelect.innerHTML = ''
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m
      opt.textContent = looksVisual(m) ? `${m}  · sees the screen` : m
      opt.selected = m === keep
      modelSelect.appendChild(opt)
    }
    if (!models.length) {
      ollamaOff.classList.remove('hidden')
      ollamaOn.classList.add('hidden')
    }
  }
  geminiKey.placeholder = b.geminiKey ? 'a key is saved; paste a new one to replace it' : 'paste your Gemini key'
  // An older main process (development hot reload) does not send this part.
  if (b.claude) {
    claudeKey.placeholder = b.claude.key ? 'a key is saved; paste a new one to replace it' : 'paste your Anthropic API key (sk-ant-…)'
    fillClaudeModels(b.claude.models, b.claude.model)
    if (b.claude.effort && document.activeElement !== claudeEffort) claudeEffort.value = b.claude.effort
    if (b.claude.error) message(`Claude: ${b.claude.error}`, 'bad')
  }

  const v = state.voice
  const voiceChip = $<HTMLSpanElement>('voice-chip')
  const voiceText = $<HTMLDivElement>('voice-text')
  if (v.provider === 'local') {
    chip(voiceChip, v.localServer ? 'local voice ready' : 'local voice starting…', v.localServer ? 'ok' : 'bad')
    voiceText.textContent = v.localServer
      ? 'She speaks and listens on this Mac (Kokoro + Whisper). Nothing you say leaves the computer.'
      : 'The local voice is not installed yet (or still starting). Install it below, or pick the system voice.'
  } else if (v.provider === 'elevenlabs') {
    chip(voiceChip, 'ElevenLabs', 'ok')
    voiceText.textContent = 'She speaks with ElevenLabs (your key). For a free local voice and ears, see docs/VOICES.md.'
  } else {
    chip(voiceChip, 'system voice')
    voiceText.textContent = 'She uses your computer\'s built-in voice for now. For a natural local voice and talking to her, see docs/VOICES.md (one script).'
  }

  $<HTMLElement>('perms').classList.toggle('hidden', state.platform !== 'darwin')
}

// ---- From your phone: one card per chat app, built once and updated in place (so what you type survives a refresh)

interface Field {
  key: string
  placeholder: string
  secret?: boolean
  multi?: boolean
}

const CHANNEL_HELP: Record<ChannelKey, { how: string; fields: Field[] }> = {
  telegram: {
    how: 'In Telegram, message <a href="https://t.me/BotFather" target="_blank">@BotFather</a>, send <code>/newbot</code>, and paste the token it gives you. Then send <code>/start</code> to your bot and say yes here.',
    fields: [{ key: 'token', placeholder: 'bot token (123456:ABC…)', secret: true }]
  },
  discord: {
    how: 'At <a href="https://discord.com/developers/applications" target="_blank">discord.com/developers</a>: New Application → Bot → Reset Token, and paste it. Installation → turn on User Install and open the install link, so you can DM the bot. Then press Pair and DM it the code.',
    fields: [{ key: 'token', placeholder: 'bot token', secret: true }]
  },
  imessage: {
    how: 'Your own phone number and Apple ID email (and any other number of yours), one per line. Text yourself from your iPhone to reach her; she answers in that chat. Nobody else is ever answered. Needs Full Disk Access to read Messages.',
    fields: [{ key: 'handles', placeholder: '+15551234567\nyou@icloud.com', multi: true }]
  },
  slack: {
    how: 'At <a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps</a>: Create New App → From a manifest (docs/CHANNELS.md has one), install it to your workspace, and paste the Bot token (xoxb-…) and an App-Level token with connections:write (xapp-…). Then press Pair and DM the app the code.',
    fields: [
      { key: 'bot', placeholder: 'bot token (xoxb-…)', secret: true },
      { key: 'app', placeholder: 'app-level token (xapp-…)', secret: true }
    ]
  },
  signal: {
    how: 'Needs <a href="https://github.com/AsamK/signal-cli" target="_blank">signal-cli</a> (<code>brew install signal-cli</code>), linked to your account as a second device: <code>signal-cli link -n Deskmate</code>, then scan the code in Signal → Settings → Linked devices. Message yourself (Note to Self) to reach her.',
    fields: [
      { key: 'number', placeholder: 'your Signal number (+15551234567)' },
      { key: 'handles', placeholder: 'other numbers of yours (optional), one per line', multi: true }
    ]
  },
  whatsapp: { how: '', fields: [] }
}

interface ChannelCard {
  root: HTMLDetailsElement
  chip: HTMLSpanElement
  who: HTMLSpanElement
  state: HTMLDivElement
  inputs: Record<string, HTMLInputElement | HTMLTextAreaElement>
  toggle: HTMLButtonElement
  pair: HTMLButtonElement
  forget: HTMLButtonElement
  msg: HTMLDivElement
  filled: boolean
}

const channelCards = new Map<ChannelKey, ChannelCard>()

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

function channelMessage(card: ChannelCard, text: string, kind: 'good' | 'bad' | '' = ''): void {
  card.msg.textContent = text
  card.msg.className = `msg${kind ? ` ${kind}` : ''}`
}

function buildCard(c: ChannelSetup): ChannelCard {
  const root = el('details', `chan${c.available ? '' : ' na'}`)
  const summary = el('summary')
  const title = el('b', '', c.label)
  const who = el('span', 'who')
  const chipEl = el('span', 'chip', '…')
  summary.append(title, who, chipEl)
  root.append(summary)
  const body = el('div', 'body')
  root.append(body)
  const help = CHANNEL_HELP[c.id]
  const card: ChannelCard = { root, chip: chipEl, who, state: el('div'), inputs: {}, toggle: el('button', 'link'), pair: el('button'), forget: el('button'), msg: el('div', 'msg'), filled: false }
  if (!c.available) {
    body.append(el('div', 'hint', c.why ?? 'Not available.'))
    summary.addEventListener('click', (e) => e.preventDefault())
    return card
  }
  const how = el('div', 'hint')
  how.innerHTML = help.how
  body.append(how)
  const form = el('form', 'sub flat')
  form.autocomplete = 'off'
  for (const f of help.fields) {
    const input = f.multi ? el('textarea') : el('input')
    if (input instanceof HTMLInputElement) input.type = f.secret ? 'password' : 'text'
    input.placeholder = f.placeholder
    input.spellcheck = false
    card.inputs[f.key] = input
    form.append(input)
  }
  const save = el('button', '', 'Check and use')
  save.type = 'submit'
  const row = el('div', 'row')
  row.append(save)
  form.append(row)
  body.append(form)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const data: Record<string, string> = {}
    for (const [k, input] of Object.entries(card.inputs)) data[k] = input.value.trim()
    if (help.fields.some((f) => f.secret) && Object.entries(data).every(([k, v]) => !v || !help.fields.find((f) => f.key === k)?.secret)) {
      channelMessage(card, 'Paste the token first.', 'bad')
      return
    }
    channelMessage(card, `Checking with ${c.label}…`)
    save.disabled = true
    const r = await api.channel?.(c.id, 'save', data)
    save.disabled = false
    if (r?.ok) for (const f of help.fields) if (f.secret) card.inputs[f.key].value = ''
    channelMessage(card, r?.ok ? `That works${r.account ? `: ${r.account}` : ''}. ${c.pairing === 'code' ? 'Press Pair and send the code from the app.' : c.pairing === 'ask' ? 'Send /start to your bot.' : 'Message yourself to reach her.'}` : (r?.error ?? 'That did not work.'), r?.ok ? 'good' : 'bad')
    await refresh()
  })
  body.append(card.state)
  const actions = el('div', 'row hint')
  const spacer = el('span', 'grow')
  card.pair.textContent = 'Pair'
  card.forget.textContent = 'Forget'
  actions.append(spacer, card.pair, card.forget, card.toggle)
  body.append(actions, card.msg)
  card.toggle.addEventListener('click', async () => {
    await api.channel?.(c.id, card.toggle.dataset.action === 'on' ? 'on' : 'off')
    channelMessage(card, '')
    await refresh()
  })
  card.pair.addEventListener('click', async () => {
    const r = await api.channel?.(c.id, 'pair')
    if (!r?.ok) channelMessage(card, r?.error ?? 'Could not start pairing.', 'bad')
    await refresh()
  })
  card.forget.addEventListener('click', async () => {
    await api.channel?.(c.id, 'forget')
    channelMessage(card, c.pairing === 'ask' ? 'Forgotten. A /start asks here again.' : 'Forgotten. Pair again with a new code.')
    await refresh()
  })
  return card
}

function updateCard(card: ChannelCard, c: ChannelSetup): void {
  if (!c.available) {
    chip(card.chip, 'not available')
    return
  }
  // Start open where something needs doing.
  if (!card.filled) {
    card.root.open = Boolean(c.request || c.code || c.blocker || c.error)
    if (card.inputs.handles && c.handles) card.inputs.handles.value = c.handles.join('\n')
    if (card.inputs.number && c.number) card.inputs.number.value = c.number
    card.filled = true
  }
  if (c.request || c.code) card.root.open = true
  for (const f of CHANNEL_HELP[c.id].fields) {
    if (f.secret) card.inputs[f.key].placeholder = c.configured ? (c.fromEnv ? 'using the token from .env; paste one to replace it' : 'saved; paste a new one to replace it') : f.placeholder
  }
  const paired = Boolean(c.owner) || (c.pairing === 'allowlist' && c.configured)
  if (c.error) chip(card.chip, 'stopped', 'bad')
  else if (!c.configured) chip(card.chip, 'not set up')
  else if (!c.on) chip(card.chip, 'off')
  else if (c.request) chip(card.chip, 'asking you', 'bad')
  else if (c.code) chip(card.chip, 'pairing', 'bad')
  else if (paired) chip(card.chip, 'on', 'ok')
  else chip(card.chip, 'not paired', 'bad')
  card.who.textContent = c.owner ? c.owner : c.account ?? ''
  card.state.replaceChildren()
  if (c.blocker) card.state.append(el('div', 'msg bad', c.blocker))
  if (c.error) card.state.append(el('div', 'msg bad', c.error))
  if (c.request) {
    const row = el('div', 'pair')
    const text = el('div')
    text.append(el('b', '', c.request.name), el('span', '', `wants to control her from ${c.label}. Code on the phone: ${c.request.code}`))
    const allow = el('button', 'primary', 'Allow')
    const refuse = el('button', '', 'Refuse')
    allow.addEventListener('click', async () => (await api.channel?.(c.id, 'allow'), refresh()))
    refuse.addEventListener('click', async () => (await api.channel?.(c.id, 'refuse'), refresh()))
    row.append(text, allow, refuse)
    card.state.append(row)
  }
  if (c.code) {
    const row = el('div', 'pair')
    const text = el('div')
    const mins = Math.max(1, Math.round((c.code.until - Date.now()) / 60_000))
    text.append(el('span', 'code', c.code.code), el('span', '', `DM this to ${c.account ?? 'the bot'} in ${c.label} in the next ${mins} min.`))
    const cancel = el('button', '', 'Cancel')
    cancel.addEventListener('click', async () => (await api.channel?.(c.id, 'pair-cancel'), refresh()))
    row.append(text, cancel)
    card.state.append(row)
  } else if (c.on && !c.owner && c.pairing !== 'allowlist' && !c.request) {
    card.state.append(el('div', 'hint', c.pairing === 'ask' ? `Send /start to ${c.account ?? 'your bot'} in Telegram; she asks here before it can control her.` : `Press Pair, then DM ${c.account ?? 'the bot'} the code.`))
  } else if (c.on && c.owner) {
    card.state.append(el('div', 'hint', `${c.owner} can message her through ${c.label}. Everyone else is ignored.`))
  }
  card.pair.classList.toggle('hidden', !(c.on && c.pairing === 'code' && !c.owner && !c.code))
  card.forget.classList.toggle('hidden', !(c.owner && c.pairing !== 'allowlist'))
  card.toggle.classList.toggle('hidden', !c.configured)
  card.toggle.textContent = c.on ? 'Turn off' : 'Turn on'
  card.toggle.dataset.action = c.on ? 'off' : 'on'
}

function renderRemote(state: SetupState): void {
  const ch = state.channels
  // An older main process (development hot reload) has no chat apps.
  $<HTMLElement>('remote').classList.toggle('hidden', !ch || !api.channel)
  if (!ch) return
  const list = $<HTMLDivElement>('channel-list')
  for (const c of ch.list) {
    let card = channelCards.get(c.id)
    if (!card) {
      card = buildCard(c)
      channelCards.set(c.id, card)
      list.append(card.root)
    }
    updateCard(card, c)
  }
  const on = ch.list.filter((c) => c.on)
  const remoteChip = $<HTMLSpanElement>('remote-chip')
  if (ch.list.some((c) => c.request || c.error)) chip(remoteChip, 'needs you', 'bad')
  else if (on.length) chip(remoteChip, on.map((c) => c.label).join(', '), 'ok')
  else chip(remoteChip, 'off')
  $<HTMLInputElement>('voice-replies').checked = ch.voiceReplies
  $<HTMLSpanElement>('voice-replies-note').textContent = ch.stt
    ? 'she always answers in text; this adds her voice (Kokoro) when you sent a voice note'
    : 'voice notes need her local speech-to-text (tts-local, docs/VOICES.md); it is not running now'
}

// ---- What she tells you about

const noticesMsg = $<HTMLDivElement>('notices-msg')
function noticesMessage(text: string, kind: 'good' | 'bad' | '' = ''): void {
  noticesMsg.textContent = text
  noticesMsg.className = `msg${kind ? ` ${kind}` : ''}`
}
const box = (id: string): HTMLInputElement => $<HTMLInputElement>(id)
const CHECKS: [string, keyof NoticePrefs][] = [
  ['n-jobs', 'jobs'],
  ['n-messages', 'messages'],
  ['n-read', 'readMessages'],
  ['n-calendar', 'calendar'],
  ['n-reminders', 'reminders'],
  ['n-scheduled', 'scheduled'],
  ['n-dnd', 'dnd']
]

function renderNotices(n: NoticeState | undefined): void {
  $<HTMLElement>('notices').classList.toggle('hidden', !n || !api.setNotices)
  if (!n) return
  const p = n.prefs
  for (const [id, key] of CHECKS) box(id).checked = Boolean(p[key])
  // Do not overwrite what they are typing.
  const typing = (el: HTMLInputElement): boolean => document.activeElement === el
  if (!typing(box('n-allow'))) box('n-allow').value = p.allowApps.join(', ')
  if (!typing(box('n-deny'))) box('n-deny').value = p.denyApps.join(', ')
  if (!typing(box('n-quiet'))) box('n-quiet').value = p.quietHours
  if (!typing(box('n-lead'))) box('n-lead').value = String(p.calendarLead)
  $<HTMLDivElement>('n-messages-more').classList.toggle('off', !p.messages)
  $<HTMLSpanElement>('n-quiet-note').textContent = n.quietFromEnv
    ? 'from DESKMATE_QUIET_HOURS in .env; type here to change it'
    : 'she keeps things to herself and tells you after'
  const note = $<HTMLSpanElement>('n-messages-note')
  note.textContent =
    n.accessibility === false
      ? 'needs Accessibility (section 3) to read the banners macOS shows'
      : 'who messaged you, on which app (Messages, Discord, Slack, WhatsApp, Mail…), from the banners macOS shows'
  const cal = $<HTMLSpanElement>('n-cal-chip')
  const allowCal = $<HTMLButtonElement>('n-cal-allow')
  const access = n.calendarAccess
  allowCal.classList.toggle('hidden', !(access === 'notDetermined' || access === 'denied' || access === 'writeOnly'))
  allowCal.textContent = access === 'notDetermined' ? 'Allow' : 'Open Settings'
  allowCal.dataset.access = access
  if (access === 'fullAccess') chip(cal, 'allowed', 'ok')
  else if (access === 'unavailable') chip(cal, 'needs the helper', 'bad')
  else if (access === 'notDetermined') chip(cal, 'not allowed yet', 'bad')
  else chip(cal, access === 'denied' ? 'denied' : access, 'bad')
  const chipEl = $<HTMLSpanElement>('notices-chip')
  if (p.dnd) chip(chipEl, 'do not disturb', 'bad')
  else if (n.quietNow) chip(chipEl, 'quiet hours now', 'bad')
  else chip(chipEl, 'on', 'ok')
}

async function saveNotices(patch: Partial<NoticePrefs>, said = 'Saved.'): Promise<void> {
  if (!api.setNotices) return
  const state = await api.setNotices(patch)
  renderNotices(state)
  noticesMessage(said, 'good')
}

for (const [id, key] of CHECKS) {
  box(id).addEventListener('change', () => void saveNotices({ [key]: box(id).checked } as Partial<NoticePrefs>))
}
const listOf = (el: HTMLInputElement): string[] => el.value.split(',').map((s) => s.trim()).filter(Boolean)
box('n-allow').addEventListener('change', () => void saveNotices({ allowApps: listOf(box('n-allow')) }))
box('n-deny').addEventListener('change', () => void saveNotices({ denyApps: listOf(box('n-deny')) }))
box('n-lead').addEventListener('change', () => {
  const n = Number(box('n-lead').value)
  if (n >= 1 && n <= 120) void saveNotices({ calendarLead: Math.round(n) })
  else noticesMessage('Between 1 and 120 minutes.', 'bad')
})
box('n-quiet').addEventListener('change', () => {
  const v = box('n-quiet').value.trim()
  // Same shapes the main process reads: "23-8", "22:30-7", "11pm-7am"; empty for none.
  if (v && !/^\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\s*(?:-|–|—|to|until)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?$/i.test(v)) {
    noticesMessage('Write it like 23-8 (from 11 pm to 8 am), or leave it empty.', 'bad')
    return
  }
  void saveNotices({ quietHours: v }, v ? `Quiet from ${v.replace(/\s*(?:-|–|—|to|until)\s*/i, ' to ')}.` : 'No quiet hours.')
})
$<HTMLButtonElement>('n-cal-allow').addEventListener('click', async (e) => {
  e.preventDefault()
  const button = e.currentTarget as HTMLButtonElement
  if (button.dataset.access !== 'notDetermined') {
    // Refused once: only System Settings can change it now.
    await api.allow?.('calendars')
    noticesMessage('Switch Deskmate (or Electron) on under Calendars, then come back here.')
    return
  }
  if (!api.calendarAccess) return
  noticesMessage('macOS is asking you…')
  const r = await api.calendarAccess()
  noticesMessage(r.granted ? 'She can see your calendar now.' : 'Not allowed. System Settings → Privacy & Security → Calendars switches it on.', r.granted ? 'good' : 'bad')
  await refresh()
})

// ---- Tool servers (MCP)

const mcpMsg = $<HTMLDivElement>('mcp-msg')
function mcpMessage(text: string, kind: 'good' | 'bad' | '' = ''): void {
  mcpMsg.textContent = text
  mcpMsg.className = `msg${kind ? ` ${kind}` : ''}`
}

function renderMcp(m: McpSetupState | undefined): void {
  $<HTMLElement>('mcp').classList.toggle('hidden', !m || !api.mcpToggle)
  if (!m) return
  const list = $<HTMLDivElement>('mcp-list')
  list.replaceChildren()
  for (const s of m.servers) {
    const row = document.createElement('label')
    row.className = 'toggle'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = s.enabled
    box.addEventListener('change', async () => {
      if (!api.mcpToggle) return
      mcpMessage(box.checked ? `Connecting to ${s.name}…` : `Closing ${s.name}…`)
      const next = await api.mcpToggle(s.name, box.checked)
      renderMcp(next)
      const now = next.servers.find((x) => x.name === s.name)
      if (now?.state === 'error') mcpMessage(`${s.name}: ${now.error ?? 'did not connect'}`, 'bad')
      else mcpMessage(box.checked ? `${s.name} is on.` : `${s.name} is off.`, 'good')
    })
    const text = document.createElement('div')
    const name = document.createElement('b')
    name.textContent = s.name
    const note = document.createElement('span')
    const state =
      s.state === 'ready' ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : s.state === 'error' ? `not connected: ${s.error ?? 'error'}` : s.state === 'connecting' ? 'connecting…' : 'off'
    note.textContent = `${s.target.length > 70 ? `${s.target.slice(0, 69)}…` : s.target} · ${state}`
    note.title = s.tools.join(', ')
    if (s.state === 'error') note.className = 'bad'
    text.append(name, note)
    row.append(box, text)
    list.append(row)
  }
  if (!m.servers.length) {
    const empty = document.createElement('div')
    empty.className = 'hint'
    empty.textContent = m.exists ? 'mcp.json lists no servers yet.' : 'No mcp.json yet: "Edit mcp.json…" makes one with an example to start from.'
    list.append(empty)
  }
  for (const e of m.errors) {
    const bad = document.createElement('div')
    bad.className = 'hint'
    bad.textContent = `⚠ ${e}`
    list.append(bad)
  }
  const ready = m.servers.filter((s) => s.state === 'ready')
  const tools = ready.reduce((n, s) => n + s.tools.length, 0)
  const chipEl = $<HTMLSpanElement>('mcp-chip')
  if (!m.agentCore && m.servers.length) chip(chipEl, 'needs Claude as her brain', 'bad')
  else if (ready.length) chip(chipEl, `${ready.length} on · ${tools} tools`, 'ok')
  else chip(chipEl, m.servers.length ? 'none connected' : 'none', m.servers.some((s) => s.state === 'error') ? 'bad' : '')
}

$<HTMLButtonElement>('mcp-open').addEventListener('click', async (e) => {
  e.preventDefault()
  await api.mcpOpenConfig?.()
  mcpMessage('Save the file, then press Reload.')
})
$<HTMLButtonElement>('mcp-reload').addEventListener('click', async (e) => {
  e.preventDefault()
  if (!api.mcpReload) return
  mcpMessage('Reading mcp.json and connecting…')
  const m = await api.mcpReload()
  renderMcp(m)
  mcpMessage(m.errors.length ? 'Loaded, with problems (see above).' : 'Loaded.', m.errors.length ? 'bad' : 'good')
})

// ---- Scheduled jobs, the heartbeat, the morning brief

const scheduleMsg = $<HTMLDivElement>('schedule-msg')

function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 90) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

function renderSchedule(sc: ScheduleSetupState | undefined): void {
  $<HTMLElement>('schedule').classList.toggle('hidden', !sc || !api.jobAction)
  if (!sc) return
  const act = (label: string, id: string, action: JobSetupAction, primary = false): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    if (primary) b.className = 'primary'
    b.addEventListener('click', async () => {
      if (!api.jobAction) return
      const next = await api.jobAction(id, action)
      renderSchedule(next)
      scheduleMsg.textContent = { pause: 'Paused.', resume: 'Back on.', delete: 'Deleted.', run: 'Running it now.', approve: 'Doing it now.', drop: 'Dropped.' }[action]
      scheduleMsg.className = 'msg good'
    })
    return b
  }
  const jobs = $<HTMLDivElement>('schedule-jobs')
  jobs.replaceChildren()
  if (!sc.jobs.length) {
    const row = document.createElement('div')
    row.className = 'hint dim'
    row.textContent = 'No scheduled jobs yet.'
    jobs.append(row)
  }
  for (const j of sc.jobs) {
    const row = document.createElement('div')
    row.className = 'pair'
    const text = document.createElement('div')
    const name = document.createElement('b')
    name.textContent = j.label
    const note = document.createElement('span')
    const last = j.last ? ` · last ${ago(j.last.at)}: ${j.last.status}` : ''
    note.textContent = `${j.rule}${j.mode === 'plan' ? ' (as a plan)' : ''} · ${j.paused ? 'paused' : j.next ? `next ${j.next}` : 'done'}${last}`
    note.title = j.last?.summary ?? j.task
    text.append(name, note)
    row.append(text, act('Run now', j.id, 'run'), act(j.paused ? 'Resume' : 'Pause', j.id, j.paused ? 'resume' : 'pause'), act('Delete', j.id, 'delete'))
    jobs.append(row)
  }
  const waiting = $<HTMLDivElement>('schedule-waiting')
  waiting.replaceChildren()
  for (const w of sc.waiting) {
    const row = document.createElement('div')
    row.className = 'pair'
    const text = document.createElement('div')
    const name = document.createElement('b')
    name.textContent = `Waiting for your yes (${w.label})`
    const note = document.createElement('span')
    note.textContent = `${w.what} · ${ago(w.at)}`
    text.append(name, note)
    row.append(text, act('Do it', w.id, 'approve', true), act('Drop', w.id, 'drop'))
    waiting.append(row)
  }
  const hb = sc.heartbeat
  const lastBeat = hb.last ? ` Last check ${ago(hb.last.at)}: ${hb.last.skipped ? `skipped (${hb.last.skipped})` : hb.last.said ? `"${hb.last.said}"` : 'nothing needed you'}${hb.last.tokens ? `, ${hb.last.tokens} tokens` : ''}.` : ''
  $<HTMLSpanElement>('hb-note').textContent = hb.minutes
    ? `${hb.minutes === 1 ? 'every minute' : `every ${hb.minutes} minutes`} she checks ${hb.items} thing${hb.items === 1 ? '' : 's'} from HEARTBEAT.md and stays quiet unless one needs you; skipped in quiet hours and overnight.${lastBeat}`
    : 'off (DESKMATE_HEARTBEAT_MINUTES=0)'
  box('brief-on').checked = sc.brief.on
  if (document.activeElement !== box('brief-after')) box('brief-after').value = sc.brief.after
  if (!sc.agentCore) {
    scheduleMsg.textContent = 'Jobs and the heartbeat need Claude as her brain (section 1); without it a job only tells you it is due.'
    scheduleMsg.className = 'msg'
  }
  chip($<HTMLSpanElement>('schedule-chip'), sc.waiting.length ? `${sc.waiting.length} waiting for you` : `${sc.jobs.length} job${sc.jobs.length === 1 ? '' : 's'}`, sc.waiting.length ? 'bad' : sc.jobs.length ? 'ok' : '')
}

$<HTMLButtonElement>('hb-open').addEventListener('click', (e) => {
  e.preventDefault()
  void api.openHeartbeat?.()
})
box('brief-on').addEventListener('change', async () => {
  if (!api.setBrief) return
  renderSchedule(await api.setBrief({ on: box('brief-on').checked }))
})
box('brief-after').addEventListener('change', async () => {
  if (!api.setBrief || !/^\d{2}:\d{2}$/.test(box('brief-after').value)) return
  renderSchedule(await api.setBrief({ after: box('brief-after').value }))
})

// ---- What she remembers and knows

const learnMsg = $<HTMLDivElement>('learn-msg')

function renderLearn(l: LearnSetupState | undefined): void {
  $<HTMLElement>('learn').classList.toggle('hidden', !l || !api.openMemory)
  if (!l) return
  const files = $<HTMLDivElement>('learn-files')
  files.replaceChildren()
  for (const f of l.files) {
    const row = document.createElement('div')
    row.className = 'hint'
    row.textContent = `${f.name}: ${f.entries} note${f.entries === 1 ? '' : 's'}, ${Math.round((100 * f.used) / f.cap)}% full`
    files.append(row)
  }
  const search = document.createElement('div')
  search.className = 'hint'
  search.textContent = l.searchable === null ? 'Search of the past is not working on this Mac.' : `${l.searchable} things from before she can search (chats, her day logs, plans).`
  files.append(search)

  const draftsEl = $<HTMLDivElement>('learn-drafts')
  draftsEl.replaceChildren()
  for (const d of l.drafts) {
    const row = document.createElement('div')
    row.className = 'pair'
    const text = document.createElement('div')
    const name = document.createElement('b')
    name.textContent = d.kind === 'update' ? `Better ${d.updates?.replace(/-/g, ' ')}` : `New skill: ${d.name.replace(/-/g, ' ')}`
    const note = document.createElement('span')
    note.textContent = d.why ?? d.description
    note.title = d.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    text.append(name, note)
    const act = (label: string, action: DraftAction, primary = false): HTMLButtonElement => {
      const b = document.createElement('button')
      b.textContent = label
      if (primary) b.className = 'primary'
      b.addEventListener('click', async () => {
        if (!api.draftAction) return
        const next = await api.draftAction(d.name, action)
        renderLearn(next)
        if (action !== 'show') {
          learnMsg.textContent = action === 'keep' ? (d.kind === 'update' ? `Updated ${d.updates ?? d.name}.` : `${d.name} is a skill now.`) : 'Thrown away.'
          learnMsg.className = 'msg good'
        }
      })
      return b
    }
    row.append(text, act(d.kind === 'update' ? 'Update it' : 'Keep it', 'keep', true), act('Show', 'show'), act('Throw away', 'discard'))
    draftsEl.append(row)
  }

  const list = $<HTMLDivElement>('learn-list')
  list.replaceChildren()
  for (const s of l.skills) {
    const row = document.createElement('div')
    row.className = 'hint'
    row.textContent = `${s.kind === 'routine' ? '⚙' : '📄'} ${s.name}${s.source === 'user' ? ' (yours)' : ''}: ${s.description}`
    list.append(row)
  }
  if (!l.skillCode) {
    const row = document.createElement('div')
    row.className = 'hint dim'
    row.textContent = "Scripts in your own skills don't run unless she was started with DESKMATE_SKILL_CODE=1 (each skill's scripts also need your yes)."
    list.append(row)
  }
  chip($<HTMLSpanElement>('learn-chip'), l.drafts.length ? `${l.drafts.length} skill${l.drafts.length === 1 ? '' : 's'} to look at` : `${l.skills.length} skills`, l.drafts.length ? 'bad' : 'ok')
}

$<HTMLButtonElement>('learn-memory').addEventListener('click', (e) => {
  e.preventDefault()
  void api.openMemory?.()
})
$<HTMLButtonElement>('learn-skills').addEventListener('click', (e) => {
  e.preventDefault()
  void api.openSkills?.()
})

async function refresh(): Promise<void> {
  if (!api.getSetup) return
  void refreshOnboard()
  const state = await api.getSetup()
  render(state)
  renderRemote(state)
  renderNotices(state.notices)
  renderMcp(state.mcp)
  renderLearn(state.learn)
  renderSchedule(state.schedule)
  renderSafety(state.safety)
  renderSpend(state.spend)
}

useOllama.addEventListener('click', async () => {
  const model = modelSelect.value
  if (!model || !api.useOllama) return
  useOllama.disabled = true
  message(`Trying ${model}…`)
  const result = await api.useOllama(model)
  useOllama.disabled = false
  message(result.ok ? `She thinks with ${model} now.` : (result.error ?? 'That did not work.'), result.ok ? 'good' : 'bad')
  await refresh()
})

geminiForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const key = geminiKey.value.trim()
  if (!key || !api.useGemini) return
  message('Checking the key…')
  const result = await api.useGemini(key)
  if (result.ok) geminiKey.value = ''
  message(result.ok ? 'Key works. She thinks with Gemini now.' : `Key problem: ${result.error ?? 'unknown'}`, result.ok ? 'good' : 'bad')
  await refresh()
})

claudeForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const key = claudeKey.value.trim()
  if (!key || !api.useClaude) return
  message('Checking the key…')
  const result = await api.useClaude(key, claudeModel.value || 'claude-opus-5-5', effortPick())
  if (result.models?.length) fillClaudeModels(result.models, claudeModel.value || 'claude-opus-5-5')
  if (result.ok) claudeKey.value = ''
  message(result.ok ? `Key works. She thinks with ${claudeModel.value} now.` : (result.error ?? 'That did not work.'), result.ok ? 'good' : 'bad')
  await refresh()
})

useClaude.addEventListener('click', async () => {
  if (!api.useClaude || !claudeModel.value) return
  useClaude.disabled = true
  message(`Switching to ${claudeModel.value}…`)
  const result = await api.useClaude(null, claudeModel.value, effortPick())
  useClaude.disabled = false
  message(result.ok ? `She thinks with ${claudeModel.value} at ${effortPick()} effort now.` : (result.error ?? 'That did not work.'), result.ok ? 'good' : 'bad')
  await refresh()
})

$<HTMLButtonElement>('recheck').addEventListener('click', () => void refresh())

$<HTMLInputElement>('voice-replies').addEventListener('change', async (e) => {
  await api.channel?.('telegram', 'voice-replies', { on: String((e.currentTarget as HTMLInputElement).checked) })
  await refresh()
})
// A pairing request comes in from a chat app while this window is open.
api.onSetupChanged?.(() => void refresh())


// ---- Characters: a card each, the one she is now highlighted; voice, zoom and personality for her; add and remove

const KIND: Record<CharacterCard['renderer'], string> = { live2d: 'Live2D', vrm: '3D · VRM', mmd: '3D · MMD', mesh: '3D · mesh' }
const charMsg = $<HTMLDivElement>('char-msg')
const editMsg = $<HTMLDivElement>('ce-msg')
function note(el: HTMLElement, text: string, kind: 'good' | 'bad' | '' = ''): void {
  el.textContent = text
  el.className = `msg${kind ? ` ${kind}` : ''}`
}
/** thumbnails already fetched this session (data: URLs), so a re-render does not ask again */
const thumbs = new Map<string, string | null>()
let editing: CharacterDetails | null = null

async function renderCharacters(): Promise<void> {
  if (!api.listCharacters) return
  $<HTMLElement>('characters').classList.remove('hidden')
  const cards = await api.listCharacters()
  const grid = $<HTMLDivElement>('char-grid')
  grid.innerHTML = ''
  for (const c of cards) {
    const card = document.createElement('button')
    card.className = `card${c.active ? ' active' : ''}`
    card.title = c.active ? `${c.name} is on your desk now` : `Switch to ${c.name}`
    const pic = document.createElement('div')
    pic.className = 'pic'
    const initial = document.createElement('span')
    initial.className = 'initial loading'
    initial.textContent = c.name.charAt(0).toUpperCase()
    pic.appendChild(initial)
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = c.name
    const kind = document.createElement('div')
    kind.className = 'kind'
    const chipOf = (text: string, cls = ''): HTMLSpanElement => {
      const el = document.createElement('span')
      el.className = `chip${cls ? ` ${cls}` : ''}`
      el.textContent = text
      return el
    }
    kind.appendChild(chipOf(KIND[c.renderer] ?? c.renderer))
    if (c.userAdded) kind.appendChild(chipOf('added', 'ok'))
    card.append(pic, name, kind)
    card.addEventListener('click', () => void pick(c))
    grid.appendChild(card)
    void showThumb(c.id, pic, initial)
  }
  const active = cards.find((c) => c.active)
  if (active && editing?.id !== active.id) await edit(active.id)
}

async function showThumb(id: string, pic: HTMLElement, initial: HTMLElement): Promise<void> {
  let url = thumbs.get(id)
  if (url === undefined) {
    url = (await api.characterThumb?.(id).catch(() => null)) ?? null
    thumbs.set(id, url)
  }
  initial.classList.remove('loading')
  if (!url) return
  const img = document.createElement('img')
  img.src = url
  img.alt = ''
  pic.replaceChildren(img)
}

async function pick(c: CharacterCard): Promise<void> {
  if (c.active) return
  note(charMsg, `Switching to ${c.name}…`)
  await api.setCharacter(c.id)
  note(charMsg, `${c.name} is on your desk now.`, 'good')
  editing = null
  await renderCharacters()
}

async function fillVoices(current: string): Promise<void> {
  const select = $<HTMLSelectElement>('ce-voice')
  const list = (await api.voices?.()) ?? { voices: [current], live: false }
  const voices = list.voices.includes(current) ? list.voices : [current, ...list.voices]
  select.innerHTML = ''
  for (const v of voices) {
    const opt = document.createElement('option')
    opt.value = v
    // af_ = American female, bm_ = British male …
    const who = `${v[0] === 'b' ? 'British' : 'American'} ${v[1] === 'm' ? 'male' : 'female'}`
    opt.textContent = `${v.slice(3).replace(/^\w/, (x) => x.toUpperCase())} · ${who}`
    opt.selected = v === current
    select.appendChild(opt)
  }
  select.title = list.live ? 'from the local voice server' : 'the local voice server is not running; these are the voices it comes with'
}

function showEditor(d: CharacterDetails): void {
  editing = d
  $<HTMLDivElement>('char-edit').classList.remove('hidden')
  $<HTMLElement>('ce-name').textContent = d.name
  $<HTMLElement>('ce-kind').textContent = KIND[d.renderer] ?? d.renderer
  $<HTMLInputElement>('ce-speed').value = String(d.speed)
  $<HTMLInputElement>('ce-zoom').value = String(d.zoom)
  $<HTMLElement>('ce-speed-v').textContent = `${d.speed.toFixed(2)}×`
  $<HTMLElement>('ce-zoom-v').textContent = `${d.zoom.toFixed(2)}×`
  $<HTMLTextAreaElement>('ce-persona').value = d.persona
  $<HTMLElement>('ce-license').textContent = d.license ? `Licence: ${d.license}` : "Licence: not stated. Check the creator's terms."
  const warn = $<HTMLDivElement>('ce-warn')
  warn.classList.toggle('hidden', !d.restricted)
  warn.textContent = d.restricted ? `${d.name}'s licence restricts this avatar to its author (or people they license). Only use her if that is you.` : ''
  $<HTMLButtonElement>('ce-remove').classList.toggle('hidden', !d.userAdded)
  $<HTMLButtonElement>('ce-reset').classList.toggle('hidden', !d.personaEdited)
  note(editMsg, '')
}

async function edit(id: string): Promise<void> {
  const d = await api.characterDetails?.(id)
  if (!d) return
  showEditor(d)
  await fillVoices(d.voice)
}

$<HTMLInputElement>('ce-speed').addEventListener('input', (e) => {
  $<HTMLElement>('ce-speed-v').textContent = `${Number((e.target as HTMLInputElement).value).toFixed(2)}×`
})
$<HTMLInputElement>('ce-zoom').addEventListener('input', (e) => {
  $<HTMLElement>('ce-zoom-v').textContent = `${Number((e.target as HTMLInputElement).value).toFixed(2)}×`
})

$<HTMLButtonElement>('ce-save').addEventListener('click', async () => {
  if (!editing || !api.saveCharacter) return
  const d = editing
  const voice = $<HTMLSelectElement>('ce-voice').value
  const speed = Number($<HTMLInputElement>('ce-speed').value)
  const zoom = Number($<HTMLInputElement>('ce-zoom').value)
  const persona = $<HTMLTextAreaElement>('ce-persona').value
  // Only what changed, so an untouched persona is not copied over the shipped one.
  const changed = {
    ...(voice !== d.voice ? { voice } : {}),
    ...(Math.abs(speed - d.speed) > 1e-6 ? { speed } : {}),
    ...(Math.abs(zoom - d.zoom) > 1e-6 ? { zoom } : {}),
    ...(persona !== d.persona ? { persona } : {})
  }
  if (!Object.keys(changed).length) {
    note(editMsg, 'Nothing changed.')
    return
  }
  const saved = await api.saveCharacter(d.id, changed)
  if (!saved) return note(editMsg, 'Could not save that.', 'bad')
  showEditor(saved)
  note(editMsg, `Saved. ${saved.name} uses it from her next line${'zoom' in changed ? '; her window reloaded for the zoom' : ''}.`, 'good')
})

$<HTMLButtonElement>('ce-reset').addEventListener('click', async () => {
  if (!editing || !api.saveCharacter) return
  const saved = await api.saveCharacter(editing.id, { persona: '' })
  if (saved) {
    showEditor(saved)
    note(editMsg, 'Back to her original personality.', 'good')
  }
})

$<HTMLButtonElement>('ce-remove').addEventListener('click', async () => {
  if (!editing?.userAdded || !api.removeCharacter) return
  const { id, name } = editing
  if (!window.confirm(`Remove ${name}? Her folder goes to the Trash, so you can still put it back.`)) return
  const r = await api.removeCharacter(id)
  if (!r.ok) return note(editMsg, r.error ?? 'Could not remove her.', 'bad')
  thumbs.delete(id)
  editing = null
  $<HTMLDivElement>('char-edit').classList.add('hidden')
  note(charMsg, `${name} is gone (her folder is in the Trash).`, 'good')
  await renderCharacters()
})

async function addCharacter(path?: string): Promise<void> {
  if (!api.addCharacter) return
  const button = $<HTMLButtonElement>('char-add')
  button.disabled = true
  note(charMsg, path ? 'Adding…' : 'Pick her model…')
  try {
    const r = await api.addCharacter(path)
    if (r.cancelled) return note(charMsg, '')
    if (!r.ok) return note(charMsg, r.error ?? 'That did not work.', 'bad')
    const extra = r.warnings?.length ? ` ${r.warnings.join(' ')}` : ''
    note(charMsg, `Added ${r.name}. Click her card to switch to her.${extra}`, r.restricted ? 'bad' : 'good')
    await renderCharacters()
  } finally {
    button.disabled = false
  }
}
$<HTMLButtonElement>('char-add').addEventListener('click', () => void addCharacter())

$<HTMLButtonElement>('done').addEventListener('click', () => void api.finishSetup?.())

// Permissions are switched on in System Settings; check again whenever they come back to this window.
window.addEventListener('focus', () => void refresh())

void api.getConfig().then((config) => {
  if (config.commandShortcut) {
    const key = config.commandShortcut.replace('CommandOrControl', '⌘').replace('Alt', '⌥').replace('Shift', '⇧').replace(/\+/g, '')
    $<HTMLSpanElement>('tip').textContent = `Tip: ${key} opens her command bar from anywhere.`
  }
})
void refresh()
void renderCharacters()

// ---- 9 · Permissions and safety, 10 · Spending

const safetyMsg = $<HTMLDivElement>('safety-msg')
function safetyMessage(text: string, kind: 'good' | 'bad' | '' = ''): void {
  safetyMsg.textContent = text
  safetyMsg.className = `msg${kind ? ` ${kind}` : ''}`
}
const ORIGIN_SHORT: Record<PermOriginId, string> = { voice: 'voice', typed: 'command bar', phone: 'chat apps', schedule: 'schedules', heartbeat: 'heartbeat' }
let safety: SafetySetupState | null = null

function levelSelect(current: PermLevel | null, def: PermLevel, onPick: (l: PermLevel | null) => void): HTMLSelectElement {
  const sel = document.createElement('select')
  const opts: [string, string][] = [
    ['', `default (${def})`],
    ['allow', 'allow'],
    ['ask', 'ask'],
    ['never', 'never']
  ]
  for (const [v, label] of opts) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    sel.append(o)
  }
  sel.value = current ?? ''
  sel.className = `lvl-${current ?? def}`
  sel.addEventListener('change', () => onPick((sel.value || null) as PermLevel | null))
  return sel
}

function renderSafety(s: SafetySetupState | undefined): void {
  $<HTMLElement>('safety').classList.toggle('hidden', !s || !api.setPermission)
  if (!s) return
  safety = s
  const chipEl = $<HTMLSpanElement>('safety-chip')
  if (s.halted) {
    chipEl.textContent = 'everything stopped · say "resume"'
    chipEl.className = 'chip stop'
  } else {
    const changed = s.tools.filter((t) => t.level || Object.keys(t.byOrigin).length).length
    chip(chipEl, changed ? `${changed} tool${changed === 1 ? '' : 's'} changed` : 'defaults', changed ? 'ok' : '')
  }
  const key = $<HTMLInputElement>('stop-key')
  if (document.activeElement !== key) key.value = s.stopShortcut
  key.classList.toggle('bad', s.stopShortcutTaken)
  $<HTMLSpanElement>('stop-note').textContent = s.stopShortcutTaken
    ? `${s.stopShortcut} could not be registered (another app has it, or it is not a valid shortcut); the tray item still works.`
    : 'stops what she is doing, plans, scheduled jobs, the heartbeat and chat apps; asks about Claude Code jobs. Say "resume" to turn them back on.'
  $<HTMLInputElement>('shell-on').checked = s.shell
  $<HTMLDivElement>('deny-apps').textContent = `Never, whatever is set: she does not work ${s.denyApps.length} apps that hold passwords, system settings or a shell (Keychain Access, 1Password, Bitwarden, System Settings, Terminal, iTerm, Warp, Ghostty).`
  $<HTMLDivElement>('secrets-note').textContent =
    s.secrets.store === 'keychain'
      ? `Your ${s.secrets.count} key${s.secrets.count === 1 ? '' : 's'} and token${s.secrets.count === 1 ? '' : 's'} are encrypted with a key kept in the ${s.secrets.name}, not in settings.json; anything key-shaped is blanked out of her logs, notes, activity and chat replies.`
      : `Your keys and tokens are in ${s.secrets.name}${s.secrets.name.includes('DESKMATE_SECRETS') ? '' : ': this computer has no keyring she can use'}. Anything key-shaped is still blanked out of her logs, notes, activity and chat replies.`

  const origins = $<HTMLDivElement>('origin-list')
  origins.replaceChildren()
  for (const o of s.origins) {
    const row = document.createElement('label')
    const name = document.createElement('span')
    name.textContent = o.label
    const sel = document.createElement('select')
    for (const [v, label] of [['', 'as each tool is set'], ['ask', 'always ask'], ['never', 'never']] as const) {
      const opt = document.createElement('option')
      opt.value = v
      opt.textContent = label
      sel.append(opt)
    }
    sel.value = o.floor ?? ''
    sel.addEventListener('change', async () => {
      if (!api.setOriginFloor) return
      renderSafety(await api.setOriginFloor(o.id, (sel.value || null) as 'ask' | 'never' | null))
      safetyMessage(sel.value ? `Risky tools from ${o.label.toLowerCase()}: ${sel.value === 'ask' ? 'she asks first' : 'never'}.` : `${o.label}: as each tool is set.`, 'good')
    })
    row.append(name, sel)
    origins.append(row)
  }
  renderPermList()
}

function renderPermList(): void {
  const s = safety
  if (!s) return
  const list = $<HTMLDivElement>('perm-list')
  const q = $<HTMLInputElement>('perm-filter').value.trim().toLowerCase()
  const onlyRisky = $<HTMLInputElement>('perm-risky').checked
  list.replaceChildren()
  const shown = s.tools.filter((t) => (!onlyRisky || t.risky || t.level || Object.keys(t.byOrigin).length) && (!q || `${t.name} ${t.about}`.toLowerCase().includes(q)))
  for (const t of shown) {
    const row = el('div', 'perm-row')
    const name = el('div', 'name', t.name)
    if (t.kind !== 'built-in') name.append(el('span', 'tag', t.kind === 'mcp' ? 'tool server' : 'skill'))
    if (t.risky) name.append(el('span', 'tag risky', 'risky'))
    const about = el('div', 'about', t.about)
    const ctl = el('div', 'ctl')
    ctl.append(
      levelSelect(t.level, t.defaultLevel, async (l) => {
        if (!api.setPermission) return
        renderSafety(await api.setPermission(t.name, l))
        safetyMessage(`${t.name}: ${l ?? `back to the default (${t.defaultLevel})`}.`, 'good')
      })
    )
    const over = el('div', 'over')
    for (const [o, l] of Object.entries(t.byOrigin) as [PermOriginId, PermLevel][]) {
      const b = el('button', '', `${ORIGIN_SHORT[o]}: ${l} ✕`)
      b.title = 'Remove this setting for one place'
      b.addEventListener('click', async () => {
        if (!api.setPermission) return
        renderSafety(await api.setPermission(t.name, null, o))
      })
      over.append(b)
    }
    const add = document.createElement('select')
    const first = document.createElement('option')
    first.value = ''
    first.textContent = '+ only from…'
    add.append(first)
    for (const o of s.origins) {
      for (const l of ['allow', 'ask', 'never'] as PermLevel[]) {
        const opt = document.createElement('option')
        opt.value = `${o.id}:${l}`
        opt.textContent = `${ORIGIN_SHORT[o.id]}: ${l}`
        add.append(opt)
      }
    }
    add.addEventListener('change', async () => {
      if (!add.value || !api.setPermission) return
      const [o, l] = add.value.split(':') as [PermOriginId, PermLevel]
      renderSafety(await api.setPermission(t.name, l, o))
      safetyMessage(`${t.name} from ${ORIGIN_SHORT[o]}: ${l}.`, 'good')
    })
    over.append(add)
    ctl.append(over)
    row.append(name, ctl, about)
    list.append(row)
  }
  if (!shown.length) list.append(el('div', 'hint', 'No tool matches.'))
}

$<HTMLInputElement>('perm-filter').addEventListener('input', () => renderPermList())
$<HTMLInputElement>('perm-risky').addEventListener('change', () => renderPermList())
$<HTMLInputElement>('shell-on').addEventListener('change', async (e) => {
  if (!api.setSafety) return
  const on = (e.target as HTMLInputElement).checked
  renderSafety(await api.setSafety({ shell: on }))
  safetyMessage(on ? 'She can run terminal commands now; each one asks you first.' : 'Terminal commands are off.', 'good')
})
$<HTMLInputElement>('stop-key').addEventListener('change', async (e) => {
  if (!api.setSafety) return
  const next = await api.setSafety({ stopShortcut: (e.target as HTMLInputElement).value })
  renderSafety(next)
  safetyMessage(next.stopShortcutTaken ? `${next.stopShortcut} did not work; try another.` : `${next.stopShortcut} now stops everything.`, next.stopShortcutTaken ? 'bad' : 'good')
})
$<HTMLButtonElement>('stop-now').addEventListener('click', async (e) => {
  e.preventDefault()
  await api.stopEverything?.()
  safetyMessage('Everything is stopped. Say "resume", or use the tray, to turn it back on.', 'good')
})
$<HTMLButtonElement>('activity-open').addEventListener('click', (e) => {
  e.preventDefault()
  api.openActivity?.()
})

const spendMsg = $<HTMLDivElement>('spend-msg')
function money(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(n < 100 ? 1 : 0)}`
}

function renderSpend(sp: SpendSetupState | undefined): void {
  $<HTMLElement>('spend').classList.toggle('hidden', !sp || !api.setBudget)
  if (!sp) return
  $<HTMLElement>('spend-today').textContent = money(sp.today)
  $<HTMLElement>('spend-month').textContent = sp.budget ? `${money(sp.month)} / ${money(sp.budget)}` : money(sp.month)
  $<HTMLElement>('spend-month-label').textContent = `in ${sp.monthName}${sp.overridden ? ' (you said to go past the budget)' : ''}`
  $<HTMLElement>('spend-calls').textContent = String(sp.calls)
  const list = $<HTMLDivElement>('spend-origins')
  list.replaceChildren()
  for (const o of sp.byOrigin) {
    const row = document.createElement('label')
    row.append(el('span', '', o.label), el('span', 'cost', money(o.cost)))
    list.append(row)
  }
  const cached = sp.tokens.cacheRead
  const all = sp.tokens.input + sp.tokens.cacheRead + sp.tokens.cacheWrite
  spendMsg.textContent = `${Math.round(all / 1000)}k tokens in (${all ? Math.round((100 * cached) / all) : 0}% from the cache), ${Math.round(sp.tokens.output / 1000)}k out this month${sp.unpriced ? ` · ${sp.unpriced} call${sp.unpriced === 1 ? '' : 's'} to a model with no price (counted as $0)` : ''}.`
  spendMsg.className = 'msg'
  const b = $<HTMLInputElement>('budget')
  if (document.activeElement !== b) b.value = sp.budget ? String(sp.budget) : ''
  const chipEl = $<HTMLSpanElement>('spend-chip')
  if (sp.state === 'over') chip(chipEl, sp.overridden ? 'over budget (you said go on)' : 'budget used up', 'bad')
  else if (sp.state === 'warn') chip(chipEl, `${Math.round((100 * sp.month) / sp.budget)}% of the budget`, 'bad')
  else chip(chipEl, sp.budget ? `${Math.round((100 * sp.month) / sp.budget)}% of the budget` : `${money(sp.month)} this month`, 'ok')
}

$<HTMLButtonElement>('budget-save').addEventListener('click', async (e) => {
  e.preventDefault()
  if (!api.setBudget) return
  const n = Number($<HTMLInputElement>('budget').value) || 0
  renderSpend(await api.setBudget(n))
  spendMsg.textContent = n ? `Budget set: ${money(n)} a month.` : 'No budget.'
  spendMsg.className = 'msg good'
})

// ---- The first-run tour: one step at a time (welcome, brain, character, voice, permissions, try me), Back / Next.
// Opened with ?tour=1 (first run, or tray → Welcome tour…); the same sections as the full page, shown one by one.

interface TourStep {
  id: string
  /** on the step pills */
  short: string
  title: string
  subtitle: string
}
const TOUR: TourStep[] = [
  { id: 'welcome', short: 'Welcome', title: 'Hi! Let\'s get her ready', subtitle: 'A few short steps. Nothing here is final: the menu-bar icon → Setup… changes any of it.' },
  { id: 'brain', short: 'Brain', title: 'Her brain', subtitle: 'What she thinks with. Claude works your apps best; Ollama is free and stays on this Mac; Gemini has a free key.' },
  { id: 'characters', short: 'Character', title: 'Pick her', subtitle: 'Who sits on your desk. Click one; you can add your own VRM, Live2D or MMD model later.' },
  { id: 'voice', short: 'Voice', title: 'Her voice', subtitle: 'A natural local voice with ears to hear you, or your computer\'s own voice for now.' },
  { id: 'perms', short: 'Permissions', title: 'What macOS lets her do', subtitle: 'Each one has a reason. The first three make her useful; the rest are for the things that use them.' },
  { id: 'tryme', short: 'Try me', title: 'Try me', subtitle: 'Thirty seconds: ask her something.' }
]
let tourOn = false
let tourAt = 0
let steps = TOUR
let onboard: OnboardState | null = null

function tourSteps(): TourStep[] {
  return TOUR.filter((t) => t.id !== 'perms' || !onboard || onboard.platform === 'darwin')
}

function showStep(i: number): void {
  steps = tourSteps()
  tourAt = Math.max(0, Math.min(i, steps.length - 1))
  const step = steps[tourAt]
  for (const sec of document.querySelectorAll('section')) sec.classList.toggle('current', sec.id === step.id)
  $<HTMLElement>('title').textContent = step.title
  $<HTMLElement>('subtitle').textContent = step.subtitle
  const dots = $<HTMLDivElement>('tour-steps')
  dots.replaceChildren(
    ...steps.map((t, n) => {
      return el('span', n === tourAt ? 'on' : n < tourAt ? 'done' : '', `${n + 1} · ${t.short}`)
    })
  )
  $<HTMLButtonElement>('tour-back').disabled = tourAt === 0
  $<HTMLButtonElement>('tour-next').textContent = tourAt === steps.length - 1 ? 'Finish' : tourAt === 0 ? "Let's go" : 'Next'
  if (step.id === 'characters') void renderCharacters()
  if (step.id === 'tryme') renderTry()
  void refreshOnboard()
  window.scrollTo(0, 0)
}

function startTour(): void {
  tourOn = true
  document.body.classList.add('tour')
  showStep(0)
}
function endTour(): void {
  tourOn = false
  document.body.classList.remove('tour')
  for (const sec of document.querySelectorAll('section')) sec.classList.remove('current')
  $<HTMLElement>('title').textContent = 'Set up Deskmate'
  $<HTMLElement>('subtitle').textContent = "Everything she can do, in one place. Come back any time: menu-bar icon → Setup…"
}
;(window as unknown as { startTour: () => void }).startTour = startTour

$<HTMLButtonElement>('tour-back').addEventListener('click', () => showStep(tourAt - 1))
$<HTMLButtonElement>('tour-next').addEventListener('click', async () => {
  if (tourAt < steps.length - 1) return showStep(tourAt + 1)
  await api.onboardDone?.()
  await api.finishSetup?.()
})
$<HTMLButtonElement>('tour-skip').addEventListener('click', () => endTour())

// ---- permissions, checked again every few seconds while they are on screen (they change in System Settings)

const PERM_TEXT: Record<OnboardPermRow['state'], [string, 'ok' | 'bad' | '']> = {
  granted: ['allowed', 'ok'],
  'not-asked': ['not yet', 'bad'],
  denied: ['off', 'bad'],
  'not-running': ['app not open', ''],
  'not-installed': ['not installed', ''],
  unknown: ['unknown', '']
}

const permRows = new Map<string, { root: HTMLDivElement; chip: HTMLSpanElement; act: HTMLButtonElement; open: HTMLButtonElement }>()

function renderPerms(rows: OnboardPermRow[]): void {
  const list = $<HTMLDivElement>('perm-rows')
  for (const r of rows) {
    let row = permRows.get(r.id)
    if (!row) {
      const root = el('div', 'perm')
      const text = el('div')
      const name = el('b', '', r.label)
      if (!r.needed) name.append(el('span', 'tag', 'optional'))
      text.append(name, el('span', '', r.why))
      const chipEl = el('span', 'chip')
      const acts = el('div', 'acts')
      const act = el('button', '', 'Allow')
      const open = el('button', 'link', 'Open System Settings')
      act.addEventListener('click', async () => {
        act.disabled = true
        try {
          const next = await api.onboardAllow?.(r.id)
          if (next) applyOnboard(next)
        } finally {
          act.disabled = false
        }
      })
      open.addEventListener('click', () => void api.onboardSettings?.(r.id))
      acts.append(act, open)
      text.append(acts)
      root.append(text, chipEl)
      list.append(root)
      row = { root, chip: chipEl, act, open }
      permRows.set(r.id, row)
    }
    const [text, kind] = PERM_TEXT[r.state]
    chip(row.chip, text, kind)
    row.act.textContent = r.action === 'launch' ? `Open ${r.label.replace('Automation: ', '')} and ask` : 'Allow'
    row.act.classList.toggle('hidden', r.action !== 'ask' && r.action !== 'launch')
    row.open.classList.toggle('hidden', r.state === 'granted' || r.state === 'not-installed')
    ;(row.act.parentElement as HTMLElement).classList.toggle('hidden', r.state === 'granted' || r.state === 'not-installed')
  }
  const needed = rows.filter((r) => r.needed)
  const ok = needed.filter((r) => r.state === 'granted').length
  chip($<HTMLSpanElement>('perm-chip'), ok === needed.length ? 'all set' : `${ok} of ${needed.length} needed`, ok === needed.length ? 'ok' : 'bad')
}

// ---- her voice: install Kokoro here (tts-local/setup.sh with a progress bar), or keep the system voice

function renderKokoro(o: OnboardState): void {
  const k = o.kokoro
  const box = $<HTMLDivElement>('kokoro')
  box.classList.toggle('hidden', o.platform === 'win32')
  const install = $<HTMLButtonElement>('kokoro-install')
  const use = $<HTMLButtonElement>('kokoro-use')
  const system = $<HTMLButtonElement>('voice-system')
  install.classList.toggle('hidden', k.installed || k.installing)
  install.textContent = k.error ? 'Try again' : 'Install the voice'
  use.classList.toggle('hidden', !k.installed || k.installing || (k.choice === 'local' && k.running))
  system.classList.toggle('hidden', k.installing || k.choice === 'system')
  $<HTMLDivElement>('kokoro-progress').classList.toggle('hidden', !k.installing && !(k.step && k.step === k.of && k.choice === 'local' && !k.running))
  $<HTMLSpanElement>('kokoro-bar').style.width = `${k.of ? Math.round((100 * Math.max(0.5, k.step ?? 0)) / k.of) : 5}%`
  $<HTMLDivElement>('kokoro-line').textContent = k.installing ? `Step ${k.step || 1} of ${k.of ?? 4}: ${k.line ?? ''}` : (k.line ?? '')
  $<HTMLDivElement>('kokoro-restart').classList.toggle('hidden', !(k.restartForEars && k.choice === 'local' && k.installed))
  const msg = $<HTMLDivElement>('kokoro-msg')
  if (k.error) note(msg, k.error, 'bad')
  else if (k.installing) note(msg, 'This takes a few minutes the first time. You can go on with the next steps meanwhile.')
  else if (k.choice === 'local' && k.running) note(msg, 'She speaks with Kokoro now.', 'good')
  else if (k.choice === 'local' && k.installed) note(msg, 'Installed. The voice is starting…')
  else if (k.choice === 'system') note(msg, "She uses your computer's voice. Install Kokoro any time from here.", 'good')
  else note(msg, '')
}

$<HTMLButtonElement>('kokoro-install').addEventListener('click', () => void api.installKokoro?.().then(refreshOnboard))
$<HTMLButtonElement>('kokoro-use').addEventListener('click', async () => applyOnboard((await api.chooseVoice?.('local')) ?? null))
$<HTMLButtonElement>('voice-system').addEventListener('click', async () => applyOnboard((await api.chooseVoice?.('system')) ?? null))
$<HTMLButtonElement>('restart-now').addEventListener('click', () => void api.restartApp?.())

// ---- try me: three examples and a box; her answer shows here (and she says it out loud)

let tried = 0
function renderTry(): void {
  const box = $<HTMLDivElement>('try-examples')
  if (!onboard || box.childElementCount) return
  for (const ex of onboard.examples) {
    const b = el('button', '', ex)
    b.addEventListener('click', () => void ask(ex))
    box.append(b)
  }
}

async function ask(text: string): Promise<void> {
  if (!api.tryRequest || !text.trim()) return
  const list = $<HTMLDivElement>('try-replies')
  list.append(el('div', 'you', text))
  const wait = el('div', 'her wait', '…')
  list.append(wait)
  try {
    const r = await api.tryRequest(text)
    wait.textContent = r.say || (r.speak ? '…' : '(she looked and kept quiet)')
    wait.classList.remove('wait')
  } catch (err) {
    wait.textContent = `That did not work: ${(err as Error).message}`
  }
  tried++
  $<HTMLDivElement>('try-more').textContent =
    tried === 1 ? `From anywhere: the command bar (${commandKey || '⌥Space'}), or talk to her once listening is on. Press Finish when you're done.` : ''
}

$<HTMLFormElement>('try-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = $<HTMLInputElement>('try-text')
  const text = input.value
  input.value = ''
  void ask(text)
})

let commandKey = ''
void api.getConfig().then((config) => {
  if (config.commandShortcut) commandKey = config.commandShortcut.replace('CommandOrControl', '⌘').replace('Alt', '⌥').replace('Shift', '⇧').replace(/\+/g, '')
})

function applyOnboard(o: OnboardState | null): void {
  if (!o) return
  onboard = o
  renderPerms(o.permissions)
  renderKokoro(o)
  const brainChipText = brainChip.textContent ?? ''
  $<HTMLDivElement>('try-hint').textContent = /not set up/.test(brainChipText)
    ? `She has no brain yet, so she can only say a few set lines. Go back to step 2 for real answers.`
    : `Pick one, or type your own. ${o.name} answers here and out loud.`
}

let onboardBusy = false
async function refreshOnboard(): Promise<void> {
  if (!api.onboard || onboardBusy) return
  onboardBusy = true
  try {
    applyOnboard(await api.onboard())
  } finally {
    onboardBusy = false
  }
}

api.onOnboardChanged?.(() => void refreshOnboard())
// Live check: every 3 s while the permission rows (or the install) are on screen.
setInterval(() => {
  const permsShown = tourOn ? steps[tourAt]?.id === 'perms' : document.hasFocus()
  if (permsShown || onboard?.kokoro.installing) void refreshOnboard()
}, 3000)

if (new URLSearchParams(location.search).get('tour') === '1') startTour()
else void refreshOnboard()
