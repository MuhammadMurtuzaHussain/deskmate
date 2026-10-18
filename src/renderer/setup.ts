import type { NoticePrefs, NoticeState, PermissionKind, RemoteAction, SetupState } from '../shared/types'

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
      : 'The local voice server is starting or not installed yet. In the project folder run tts-local/setup.sh once.'
  } else if (v.provider === 'elevenlabs') {
    chip(voiceChip, 'ElevenLabs', 'ok')
    voiceText.textContent = 'She speaks with ElevenLabs (your key). For a free local voice and ears, see docs/VOICES.md.'
  } else {
    chip(voiceChip, 'system voice')
    voiceText.textContent = 'She uses your computer\'s built-in voice for now. For a natural local voice and talking to her, see docs/VOICES.md (one script).'
  }

  const mac = state.platform === 'darwin'
  $<HTMLElement>('perms').classList.toggle('hidden', !mac)
  for (const row of document.querySelectorAll<HTMLDivElement>('.perm')) {
    const kind = row.dataset.kind as Exclude<PermissionKind, 'calendars'>
    const value = kind === 'keys' ? (state.permissions.keys === null ? 'unavailable' : state.permissions.keys ? 'granted' : 'denied') : state.permissions[kind]
    const ok = value === 'granted'
    chip(row.querySelector('.chip') as HTMLElement, ok ? 'allowed' : value === 'unavailable' ? 'not built' : 'not yet', ok ? 'ok' : 'bad')
    const btn = row.querySelector('button') as HTMLButtonElement
    btn.classList.toggle('hidden', ok || value === 'unavailable')
  }
}

const remoteMsg = $<HTMLDivElement>('remote-msg')
function remoteMessage(text: string, kind: 'good' | 'bad' | '' = ''): void {
  remoteMsg.textContent = text
  remoteMsg.className = `msg${kind ? ` ${kind}` : ''}`
}

function renderRemote(state: SetupState): void {
  const r = state.remote
  // An older main process (development hot reload) has no phone remote.
  $<HTMLElement>('remote').classList.toggle('hidden', !r || !api.useTelegram)
  if (!r) return
  const bot = r.bot ? `@${r.bot}` : 'your bot'
  const remoteChip = $<HTMLSpanElement>('remote-chip')
  if (r.error) chip(remoteChip, 'token rejected', 'bad')
  else if (!r.token) chip(remoteChip, 'not set up')
  else if (!r.on) chip(remoteChip, 'off')
  else if (r.paired) chip(remoteChip, 'paired', 'ok')
  else if (r.request) chip(remoteChip, 'asking you', 'bad')
  else chip(remoteChip, 'waiting for /start', 'bad')
  $<HTMLInputElement>('telegram-token').placeholder = r.token
    ? r.fromEnv
      ? 'using the token from .env; paste one to replace it'
      : 'a token is saved; paste a new one to replace it'
    : 'paste your bot token (123456:ABC…)'
  $<HTMLDivElement>('remote-request').classList.toggle('hidden', !r.request)
  if (r.request) {
    $<HTMLElement>('remote-request-name').textContent = r.request.name
    $<HTMLElement>('remote-request-code').textContent = r.request.code
  }
  $<HTMLDivElement>('remote-paired').classList.toggle('hidden', !r.paired)
  if (r.paired) $<HTMLElement>('remote-paired-name').textContent = r.paired
  const text = $<HTMLSpanElement>('remote-text')
  const toggle = $<HTMLButtonElement>('remote-toggle')
  $<HTMLDivElement>('remote-row').classList.toggle('hidden', !r.token)
  if (r.error) text.textContent = r.error
  else if (!r.on) text.textContent = 'The phone remote is off; messages to the bot wait in Telegram.'
  else if (r.request) text.textContent = 'Check the code matches the one on the phone, then allow it (or say yes to her).'
  else if (r.paired) text.textContent = `Message ${bot} in Telegram. Only this account can; everyone else is ignored.`
  else text.textContent = `On your phone, open ${bot} in Telegram and send /start. She asks here before it can control her.`
  toggle.textContent = r.on ? 'Turn off' : 'Turn on'
  toggle.dataset.action = r.on ? 'off' : 'on'
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

async function refresh(): Promise<void> {
  if (!api.getSetup) return
  const state = await api.getSetup()
  render(state)
  renderRemote(state)
  renderNotices(state.notices)
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

$<HTMLFormElement>('telegram').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $<HTMLInputElement>('telegram-token')
  const token = input.value.trim()
  if (!token || !api.useTelegram) return
  remoteMessage('Asking Telegram…')
  const result = await api.useTelegram(token)
  if (result.ok) input.value = ''
  remoteMessage(
    result.ok ? `That works. On your phone, open @${result.bot} in Telegram and send /start.` : (result.error ?? 'That did not work.'),
    result.ok ? 'good' : 'bad'
  )
  await refresh()
})

const remoteAction = (id: string, action: RemoteAction): void => {
  $<HTMLButtonElement>(id).addEventListener('click', async () => {
    await api.remote?.(action)
    if (action === 'allow') remoteMessage('Paired. Message her from your phone.', 'good')
    else if (action === 'refuse') remoteMessage('Refused. That account was told no.')
    else if (action === 'forget') remoteMessage('Forgotten. A /start from your phone asks here again.')
    await refresh()
  })
}
remoteAction('remote-allow', 'allow')
remoteAction('remote-refuse', 'refuse')
remoteAction('remote-forget', 'forget')
$<HTMLButtonElement>('remote-toggle').addEventListener('click', async (e) => {
  await api.remote?.((e.currentTarget as HTMLButtonElement).dataset.action as RemoteAction)
  remoteMessage('')
  await refresh()
})
// A pairing request comes in from Telegram while this window is open.
api.onSetupChanged?.(() => void refresh())

for (const row of document.querySelectorAll<HTMLDivElement>('.perm')) {
  row.querySelector('button')?.addEventListener('click', async () => {
    await api.allow?.(row.dataset.kind as PermissionKind)
    await refresh()
  })
}

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
