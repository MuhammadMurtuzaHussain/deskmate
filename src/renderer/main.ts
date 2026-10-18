import type { AppConfig, AvatarCommand, BodyState, Emotion, Gesture, ReplyPayload, Touch } from '../shared/types'
import type { Avatar } from './avatar'
import { createMic } from './mic'

const api = window.deskmate
const canvas = document.getElementById('stage') as HTMLCanvasElement
const bubble = document.getElementById('bubble') as HTMLDivElement
const statusEl = document.getElementById('status') as HTMLDivElement
const panel = document.getElementById('panel') as HTMLDivElement
const grip = document.getElementById('grip') as HTMLDivElement
const form = document.getElementById('chat') as HTMLFormElement
const input = document.getElementById('input') as HTMLInputElement
const lookBtn = document.getElementById('look') as HTMLButtonElement
const watchBtn = document.getElementById('watch') as HTMLButtonElement
const micBtn = document.getElementById('mic') as HTMLButtonElement
const characterSelect = document.getElementById('character') as HTMLSelectElement
const keyForm = document.getElementById('keyform') as HTMLFormElement
const keyInput = document.getElementById('key') as HTMLInputElement
const zzz = document.getElementById('zzz') as HTMLDivElement | null

let config: AppConfig
let avatar: Avatar | null = null
let bubbleTimer: number | undefined
let listening = false

function setStatus(text: string): void {
  statusEl.textContent = text
  island.peek(text)
}

// ---- the panel tucks itself away (an "island" that comes back when you reach for it): it shows while the pointer is
// over her or the bottom of the window, while you type, and briefly as a status line when something happens.
const island = (() => {
  const REACH = 150 // px from the bottom of the window that count as reaching for the panel
  let shown = true
  let tuckTimer: number | undefined
  let peekTimer: number | undefined
  const enabled = (): boolean => (config?.panel ?? 'auto') === 'auto'
  const busy = (): boolean => document.activeElement === input || document.activeElement === keyInput || Boolean(input.value) || !keyForm.classList.contains('hidden')
  const set = (on: boolean): void => {
    shown = on
    document.body.classList.toggle('tucked', !on)
  }
  const tuckLater = (ms = 1500): void => {
    window.clearTimeout(tuckTimer)
    tuckTimer = window.setTimeout(() => {
      if (enabled() && !busy()) set(false)
    }, ms)
  }
  return {
    pointer(x: number, y: number, overHer: boolean): void {
      if (!enabled()) return
      if (overHer || y > window.innerHeight - REACH || overUi(x, y)) {
        window.clearTimeout(tuckTimer)
        if (!shown) set(true)
      } else if (shown) tuckLater()
    },
    leave(): void {
      if (enabled()) tuckLater()
    },
    /** Something happened: show just the status line for a few seconds if the panel is tucked away. */
    peek(text: string): void {
      if (!enabled() || shown || /^(?:idle|watching|not listening|listening\b)/.test(text)) return
      document.body.classList.add('peek')
      window.clearTimeout(peekTimer)
      peekTimer = window.setTimeout(() => document.body.classList.remove('peek'), 4000)
    },
    start(): void {
      if (enabled()) tuckLater(4000)
      input.addEventListener('blur', () => tuckLater())
    }
  }
})()

function idleStatus(): string {
  return listening ? 'listening' : config?.watching ? 'watching' : 'idle'
}

function showBubble(text: string, ms = 9000): void {
  bubble.textContent = text
  bubble.classList.remove('hidden')
  window.clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => bubble.classList.add('hidden'), ms)
}

// ---- ears: the mic feeds whole utterances to the main process. While she talks it either closes (DESKMATE_BARGE_IN=0)
// or stays open behind a higher bar, so that talking over her for a moment stops her and becomes the next utterance.
let userTalking = false
const mic = createMic({
  onUtterance: (wav, ms, bargedIn) => void api.heard(wav, ms, bargedIn),
  onLevel: (_rms, speaking) => {
    userTalking = speaking
    micBtn.classList.toggle('hot', speaking)
  },
  onBargeIn: () => interrupt('they talked over her'),
  onError: (message) => setStatus(`mic: ${message}`)
})

// ---- speech: lines arrive faster than she can say them; queue instead of dropping. One pump plays them in order,
// never starts a line while they are talking, and lets interrupt() cut the current one short.
const speechQueue: ReplyPayload[] = []
let speaking = false
let pumping = false
let speechGen = 0 // bumped by interrupt(): a line from an older generation is over and keeps its hands off the queue
let browserUtter: { stop(): void } | null = null
let micTimer: number | undefined

function enqueue(payload: ReplyPayload): void {
  if (!payload.reply.speak || !payload.reply.say) {
    if (payload.reply.action) runAction(payload.reply.action)
    return
  }
  speechQueue.push(payload)
  if (speechQueue.length > 3) speechQueue.shift()
  pump()
}

function pump(): void {
  if (pumping) return
  pumping = true
  void (async () => {
    try {
      let waited = 0
      while (speechQueue.length) {
        if (userTalking && waited < 2500) {
          // Their turn: wait for the pause, when the mic ships their utterance anyway. A room that never pauses (a
          // video, a call) must not keep her quiet for good.
          await new Promise((r) => window.setTimeout(r, 100))
          waited += 100
          continue
        }
        waited = 0
        const payload = speechQueue.shift() as ReplyPayload
        setSpeaking(true)
        await perform(payload)
      }
    } finally {
      setSpeaking(false)
      pumping = false
    }
  })()
}

/** She is talking, or not: the main process hears about it, and the mic closes or ducks accordingly. */
function setSpeaking(on: boolean): void {
  if (speaking === on) return
  speaking = on
  // A renderer hot-reloaded in dev may run against an older main process that does not know this message.
  api.speaking?.(on)
  window.clearTimeout(micTimer)
  if (on) {
    if (config.bargeIn) mic.setDucked(true)
    else mic.setBlocked(true)
  } else {
    // Her own voice must not come back in as a question; the mic hears everything again a beat after she stops.
    micTimer = window.setTimeout(
      () => {
        mic.setDucked(false)
        mic.setBlocked(false)
      },
      config.bargeIn ? 250 : 350
    )
  }
}

/** Stops her mid-sentence: the line, its lip sync and whatever was queued behind it. */
function interrupt(why: string): void {
  if (!speaking) return
  speechGen++
  speechQueue.length = 0
  avatar?.interrupt()
  browserUtter?.stop()
  console.log(`[speak] interrupted: ${why}`)
  setStatus(idleStatus())
}

/** Fallback when there is no audio: browser voice + a fake mouth wobble. Resolves when the line ends or is cut. */
function browserVoice(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      resolve()
      return
    }
    const utter = new SpeechSynthesisUtterance(text)
    utter.rate = 1.05
    let wobble: number | undefined
    let done = false
    const stop = (): void => {
      if (done) return
      done = true
      window.clearInterval(wobble)
      avatar?.setFakeMouth(0)
      if (browserUtter === handle) browserUtter = null
      resolve()
    }
    const handle = {
      stop: () => {
        speechSynthesis.cancel()
        stop()
      }
    }
    browserUtter = handle
    utter.onstart = () => {
      wobble = window.setInterval(() => avatar?.setFakeMouth(0.15 + Math.random() * 0.75), 90)
    }
    utter.onend = stop
    utter.onerror = stop
    speechSynthesis.cancel()
    speechSynthesis.speak(utter)
  })
}

async function perform(payload: ReplyPayload): Promise<void> {
  const { reply, audio } = payload
  const gen = speechGen
  showBubble(reply.say)
  avatar?.setExpression(reply.emotion)
  avatar?.kick(1)
  if (reply.action) runAction(reply.action)

  let ok = false
  if (audio && avatar) {
    const url = URL.createObjectURL(new Blob([audio.bytes as BlobPart], { type: audio.mime }))
    console.log('[speak] start', audio.mime, audio.bytes.byteLength, 'bytes')
    ok = await avatar.speak(url, audio.mime)
    URL.revokeObjectURL(url)
    console.log('[speak]', gen !== speechGen ? 'cut short' : ok ? 'finished' : 'rejected')
  }
  if (gen !== speechGen) return // interrupted: interrupt() has already tidied up
  if (!ok) await browserVoice(reply.say)
  if (gen !== speechGen) return
  window.setTimeout(() => avatar?.setExpression('neutral'), 2500)
  setStatus(idleStatus())
}

function runAction(command: AvatarCommand): void {
  if (!avatar) return
  switch (command) {
    case 'dance':
    case 'dance_slow':
    case 'spin': {
      if (!avatar.capabilities.dance) return
      const style = command === 'dance' ? 'groove' : command === 'dance_slow' ? 'slow' : 'spin'
      avatar.dance(true, style)
      setStatus(`dancing (${style}) · say "stop" or type /stop`)
      break
    }
    case 'stop_dancing':
      avatar.dance(false)
      setStatus(idleStatus())
      break
    case 'next_outfit':
      if (!avatar.capabilities.outfits) return
      setStatus('changing…')
      void avatar.nextOutfit().then((name) => setStatus(name ? `outfit: ${name}` : idleStatus()))
      break
  }
}

// ---- pointer: click-through everywhere except over her and the panel; taps and drags on her
function overUi(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y)
  return Boolean(el && (panel.contains(el) || bubble.contains(el) || grip.contains(el)))
}

function overModel(x: number, y: number): boolean {
  const b = avatar?.getBounds()
  return Boolean(b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height)
}

/** Which part of her was touched, from where the pointer sits inside her bounds. */
function touchArea(y: number): Touch['area'] {
  const b = avatar?.getBounds()
  if (!b) return 'body'
  const rel = (y - b.y) / Math.max(1, b.height)
  if (rel < 0.22) return 'head'
  if (rel < 0.42) return 'chest'
  if (rel < 0.62) return 'body'
  return 'legs'
}

function wirePointer(): void {
  let ignoring = false
  const setIgnore = (ignore: boolean): void => {
    if (ignore !== ignoring) {
      ignoring = ignore
      api.setIgnoreMouse(ignore)
    }
  }
  let drag: { lastX: number; lastY: number; moved: number; area: Touch['area']; lastKick: number; lastAt?: number; vx?: number } | null = null
  window.addEventListener('mousemove', (e) => {
    avatar?.pointerMove(e.clientX, e.clientY)
    if (drag) return
    const overHer = overModel(e.clientX, e.clientY)
    island.pointer(e.clientX, e.clientY, overHer)
    setIgnore(!(overUi(e.clientX, e.clientY) || overHer))
  })
  window.addEventListener('mouseleave', () => {
    island.leave()
    if (!drag) setIgnore(true)
  })
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || overUi(e.clientX, e.clientY) || !overModel(e.clientX, e.clientY)) return
    drag = { lastX: e.screenX, lastY: e.screenY, moved: 0, area: touchArea(e.clientY), lastKick: 0 }
    e.preventDefault()
  })
  window.addEventListener('pointermove', (e) => {
    if (!drag) return
    const dx = e.screenX - drag.lastX
    const dy = e.screenY - drag.lastY
    drag.lastX = e.screenX
    drag.lastY = e.screenY
    drag.moved += Math.hypot(dx, dy)
    // Carried by the cursor: she dangles, swinging against the direction she is moved.
    const nowMs = performance.now()
    const vx = (dx / Math.max(8, nowMs - (drag.lastAt ?? nowMs - 16))) * 1000
    drag.lastAt = nowMs
    drag.vx = (drag.vx ?? 0) * 0.7 + vx * 0.3
    if (drag.moved > 6) avatar?.setCarried?.(drag.vx)
    if (drag.moved > 6) {
      if (!document.body.classList.contains('dragging')) {
        document.body.classList.add('dragging')
        avatar?.setExpression('surprised')
      }
      api.moveBy(dx, dy)
      const now = performance.now()
      if (now - drag.lastKick > 140) {
        drag.lastKick = now
        avatar?.kick(0.5 + Math.min(1, Math.hypot(dx, dy) / 25))
      }
    }
  })
  const release = (e: PointerEvent): void => {
    if (!drag) return
    const d = drag
    drag = null
    document.body.classList.remove('dragging')
    avatar?.setCarried?.(null)
    avatar?.kick(1.2)
    if (d.moved > 6) {
      void api.react({ kind: 'drag', area: d.area })
    } else {
      const quick: Emotion[] = d.area === 'head' ? ['happy', 'shy'] : d.area === 'chest' ? ['surprised', 'shy', 'angry'] : ['surprised', 'flirty']
      avatar?.setExpression(quick[Math.floor(Math.random() * quick.length)])
      void api.react({ kind: 'tap', area: d.area })
    }
    setIgnore(!(overUi(e.clientX, e.clientY) || overModel(e.clientX, e.clientY)))
  }
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', release)
}

// ---- UI
const LOCAL_COMMANDS: Record<string, AvatarCommand> = {
  '/dance': 'dance',
  '/slow': 'dance_slow',
  '/spin': 'spin',
  '/stop': 'stop_dancing',
  '/outfit': 'next_outfit'
}

function applyListening(on: boolean): void {
  listening = on
  micBtn.classList.toggle('on', on)
  micBtn.textContent = on ? 'listening' : 'mic'
  if (on) {
    mic.start().catch(() => void api.setListening(false))
  } else {
    mic.stop()
    micBtn.classList.remove('hot')
  }
}

function wireUi(): void {
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    const local = LOCAL_COMMANDS[text.toLowerCase()]
    if (local) {
      runAction(local)
      return
    }
    if (text.toLowerCase() === '/listen') {
      void api.setListening(!listening)
      return
    }
    setStatus('thinking…')
    try {
      await api.send(text)
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`)
    }
  })
  lookBtn.addEventListener('click', () => void api.lookNow())
  watchBtn.addEventListener('click', async () => {
    config.watching = await api.toggleWatch()
    watchBtn.classList.toggle('on', config.watching)
  })
  micBtn.addEventListener('click', () => void api.setListening(!listening))
  characterSelect.addEventListener('change', () => {
    setStatus(`switching to ${characterSelect.options[characterSelect.selectedIndex].text}…`)
    void api.setCharacter(characterSelect.value)
  })
  keyForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const key = keyInput.value.trim()
    if (!key) return
    setStatus('checking key…')
    const result = await api.setKey(key)
    if (result.ok) {
      keyInput.value = ''
      keyForm.classList.add('hidden')
      config.mode = 'gemini'
      showBubble('There we go. Now I can actually think. Hi.')
    } else {
      setStatus(`key problem: ${result.error ?? 'unknown'}`)
    }
  })
  api.onReply(enqueue)
  api.onStatus(setStatus)
  api.onCommand(runAction)
  api.onListen(applyListening)
}

/** Her body on the desktop: the main process walks her window around and tells her what to do with herself. */
function wireBody(): void {
  let lastAnchors = ''
  const report = (): void => {
    const a = avatar?.anchors?.()
    if (!a) return
    const key = JSON.stringify(a)
    if (key !== lastAnchors) {
      lastAnchors = key
      api.reportAnchors?.(a)
    }
  }
  window.setInterval(report, 500)
  api.onBody?.((state: BodyState) => {
    avatar?.setBody?.(state)
    zzz?.classList.toggle('hidden', state.mode !== 'sleep')
    if (state.mode === 'sleep') setStatus('asleep · talk to me or poke me to wake me')
    else if (state.mode === 'idle' || state.mode === 'sit') setStatus(idleStatus())
    window.setTimeout(report, 300)
  })
  api.onGesture?.((g: Gesture) => avatar?.gesture?.(g))
}

function fillCharacterSelect(): void {
  characterSelect.innerHTML = ''
  for (const c of config.characters) {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.name
    opt.selected = c.id === config.character.id
    characterSelect.appendChild(opt)
  }
  characterSelect.classList.toggle('hidden', config.characters.length < 2)
}

async function createAvatar(): Promise<Avatar> {
  const kind = config.character.renderer ?? 'live2d'
  if (kind === 'vrm') {
    const { createVRMAvatar } = await import('./vrm')
    return createVRMAvatar(canvas, config.character)
  }
  if (kind === 'mmd') {
    const { createMMDAvatar } = await import('./mmd')
    return createMMDAvatar(canvas, config.character)
  }
  if (kind === 'mesh') {
    const { createMeshAvatar } = await import('./mesh')
    return createMeshAvatar(canvas, config.character)
  }
  const { createLive2DAvatar } = await import('./live2d')
  return createLive2DAvatar(canvas, config.character)
}

async function main(): Promise<void> {
  config = await api.getConfig()
  wireUi()
  fillCharacterSelect()
  micBtn.classList.toggle('hidden', !config.ears)
  if (config.wakeWord) micBtn.title = `she answers after "${config.wakeWord}"; click to mute or unmute her ears`
  setStatus(`loading ${config.character.name}…`)
  try {
    avatar = await createAvatar()
    await avatar.load()
  } catch (err) {
    console.error(err)
    setStatus(`could not load model: ${(err as Error).message}`)
    return
  }
  wirePointer()
  island.start()
  wireBody()
  watchBtn.classList.toggle('on', config.watching)
  keyForm.classList.toggle('hidden', config.mode !== 'demo')
  if (config.listening) applyListening(true)
  const extras = [config.ears ? (config.wakeWord ? `say "${config.wakeWord}"` : 'mic') : '', config.hands ? `Claude in ${config.project?.name ?? '…'}` : ''].filter(Boolean).join(' · ')
  setStatus(
    config.mode === 'demo'
      ? `${config.character.name} is here. She needs a Gemini key to think.`
      : `${config.character.name} is here · ${config.modelName}${config.watchDir ? ` · watching ${config.watchDir}` : ''}${extras ? ` · ${extras}` : ''}`
  )
}

void main()
