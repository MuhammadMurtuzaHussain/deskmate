import type { PermissionKind, SetupState } from '../shared/types'

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
    const kind = row.dataset.kind as PermissionKind
    const value = kind === 'keys' ? (state.permissions.keys === null ? 'unavailable' : state.permissions.keys ? 'granted' : 'denied') : state.permissions[kind]
    const ok = value === 'granted'
    chip(row.querySelector('.chip') as HTMLElement, ok ? 'allowed' : value === 'unavailable' ? 'not built' : 'not yet', ok ? 'ok' : 'bad')
    const btn = row.querySelector('button') as HTMLButtonElement
    btn.classList.toggle('hidden', ok || value === 'unavailable')
  }
}

async function refresh(): Promise<void> {
  if (!api.getSetup) return
  render(await api.getSetup())
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
  const result = await api.useClaude(key, claudeModel.value || 'claude-opus-5-5')
  if (result.models?.length) fillClaudeModels(result.models, claudeModel.value || 'claude-opus-5-5')
  if (result.ok) claudeKey.value = ''
  message(result.ok ? `Key works. She thinks with ${claudeModel.value} now.` : (result.error ?? 'That did not work.'), result.ok ? 'good' : 'bad')
  await refresh()
})

useClaude.addEventListener('click', async () => {
  if (!api.useClaude || !claudeModel.value) return
  useClaude.disabled = true
  message(`Switching to ${claudeModel.value}…`)
  const result = await api.useClaude(null, claudeModel.value)
  useClaude.disabled = false
  message(result.ok ? `She thinks with ${claudeModel.value} now.` : (result.error ?? 'That did not work.'), result.ok ? 'good' : 'bad')
  await refresh()
})

$<HTMLButtonElement>('recheck').addEventListener('click', () => void refresh())

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
