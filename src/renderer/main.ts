import * as PIXI from 'pixi.js'
import '@pixi/unsafe-eval'
import { Live2DModel, MotionPriority } from 'pixi-live2d-display-lipsyncpatch/cubism4'
import type { AppConfig, Emotion, ReplyPayload, Touch } from '../shared/types'

// Pixi 7 builds shader code with `new Function`; importing @pixi/unsafe-eval self-installs a CSP-safe path.
// pixi-live2d-display finds the Pixi ticker through the global.
;(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI

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
const characterSelect = document.getElementById('character') as HTMLSelectElement
const keyForm = document.getElementById('keyform') as HTMLFormElement
const keyInput = document.getElementById('key') as HTMLInputElement

const app = new PIXI.Application({
  view: canvas,
  backgroundAlpha: 0,
  resizeTo: window,
  antialias: true,
  autoDensity: true,
  resolution: window.devicePixelRatio || 1
})

let config: AppConfig
let model: Live2DModel | null = null
let bubbleTimer: number | undefined
let fakeMouth = 0

// Physics excitation. Live2D physics (hair, chest, skirt) are driven by input parameters such as the
// body and head angles; we add a slow idle sway plus a damped impulse on taps and replies so a rigged
// model keeps moving. Amplitudes come from character.json → physics.
const sway = { amount: 1, bounce: 1.5, impulse: 0, impulseAt: 0 }
function kick(strength = 1): void {
  sway.impulse = Math.min(1.5, strength * sway.bounce)
  sway.impulseAt = performance.now()
}
function swayOffsets(now: number): { x: number; y: number; z: number } {
  const t = now / 1000
  const idleX = Math.sin(t * 0.9) * 3 * sway.amount
  const idleY = Math.sin(t * 0.7 + 2) * 2 * sway.amount
  const idleZ = Math.sin(t * 1.3 + 1) * 2 * sway.amount
  let k = 0
  if (sway.impulse > 0) {
    const dt = (now - sway.impulseAt) / 1000
    k = sway.impulse * Math.exp(-dt * 2.6) * Math.sin(dt * Math.PI * 2 * 2.4)
    if (dt > 3) sway.impulse = 0
  }
  // Vertical bounce is what chest and hair rigs respond to most; X/Z add the sway.
  return { x: idleX + k * 8, y: idleY + k * 12, z: idleZ + k * 6 }
}

function setStatus(text: string): void {
  statusEl.textContent = text
}

function showBubble(text: string, ms = 9000): void {
  bubble.textContent = text
  bubble.classList.remove('hidden')
  window.clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => bubble.classList.add('hidden'), ms)
}

function layout(): void {
  if (!model) return
  const internal = model.internalModel
  const ow = internal.originalWidth
  const oh = internal.originalHeight
  const TOP = 92 // clearance for the speech bubble
  const BOTTOM = 100 // the panel
  const availH = app.screen.height - TOP - BOTTOM
  const scale = Math.min(availH / oh, (app.screen.width - 20) / ow)
  model.scale.set(scale)
  model.anchor.set(0.5, 0)
  model.x = app.screen.width / 2
  model.y = TOP
}

async function setExpression(emotion: Emotion): Promise<void> {
  if (!model) return
  const name = config.character.expressions[emotion] ?? config.character.expressions.neutral
  try {
    if (!name) {
      // Empty mapping = plain face. (model.expression() with no name would pick a random one.)
      model.internalModel.motionManager.expressionManager?.resetExpression()
      return
    }
    await model.expression(name)
  } catch (err) {
    console.warn('[expression]', name, err)
  }
}

function hasMotions(group: string): boolean {
  if (!model) return false
  const defs = (model.internalModel.motionManager as unknown as { definitions: Record<string, unknown[] | undefined> }).definitions
  return Boolean(defs?.[group]?.length)
}

/** Fallback when there is no audio: browser voice + a fake mouth wobble driven straight into ParamMouthOpenY. */
function browserVoice(text: string, onDone: () => void): void {
  if (!('speechSynthesis' in window)) {
    onDone()
    return
  }
  const utter = new SpeechSynthesisUtterance(text)
  utter.rate = 1.05
  let wobble: number | undefined
  utter.onstart = () => {
    wobble = window.setInterval(() => {
      fakeMouth = 0.15 + Math.random() * 0.75
    }, 90)
  }
  const stop = (): void => {
    window.clearInterval(wobble)
    fakeMouth = 0
    onDone()
  }
  utter.onend = stop
  utter.onerror = stop
  speechSynthesis.cancel()
  speechSynthesis.speak(utter)
}

// Lines arrive faster than she can say them (a look while a tap reply is playing); queue instead of dropping.
const speechQueue: ReplyPayload[] = []
let speaking = false

function enqueue(payload: ReplyPayload): void {
  if (!payload.reply.speak || !payload.reply.say) return
  speechQueue.push(payload)
  if (speechQueue.length > 3) speechQueue.shift() // never let a backlog build up
  if (!speaking) void next()
}

async function next(): Promise<void> {
  const payload = speechQueue.shift()
  if (!payload) {
    speaking = false
    return
  }
  speaking = true
  await perform(payload)
}

async function perform(payload: ReplyPayload): Promise<void> {
  const { reply, audio } = payload
  showBubble(reply.say)
  void setExpression(reply.emotion)
  kick(1)

  const finish = (): void => {
    window.setTimeout(() => void setExpression('neutral'), 2500)
    setStatus(config.watching ? 'watching' : 'idle')
    void next()
  }

  if (audio && model) {
    const blob = new Blob([audio.bytes as BlobPart], { type: audio.mime })
    const url = URL.createObjectURL(blob)
    console.log('[speak] start', audio.mime, audio.bytes.byteLength, 'bytes')
    const speakOptions = {
      volume: 1,
      resetExpression: false,
      onFinish: () => {
        console.log('[speak] finished')
        URL.revokeObjectURL(url)
        finish()
      },
      onError: (err: unknown) => {
        console.warn('[speak] error', err)
        URL.revokeObjectURL(url)
        browserVoice(reply.say, finish)
      }
    }
    // The lip-sync fork drives ParamMouthOpenY from the audio volume while it plays. If the model has a
    // reaction motion group, play the gesture with our speech as its sound (one call, no audio race);
    // otherwise just speak.
    const react = config.character.motions.react
    const ok = hasMotions(react)
      ? await model.motion(react, undefined, MotionPriority.FORCE, { sound: url, ...speakOptions })
      : await model.speak(url, speakOptions)
    console.log('[speak] accepted:', ok)
    if (!ok) {
      URL.revokeObjectURL(url)
      browserVoice(reply.say, finish)
    }
  } else {
    if (model && hasMotions(config.character.motions.react)) {
      model.motion(config.character.motions.react, undefined, MotionPriority.NORMAL)
    }
    browserVoice(reply.say, finish)
  }
}

function overUi(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y)
  return Boolean(el && (panel.contains(el) || bubble.contains(el) || grip.contains(el)))
}

function overModel(x: number, y: number): boolean {
  return Boolean(model && model.getBounds().contains(x, y))
}

/** Which part of her was touched, from where the pointer sits inside the model's bounds. */
function touchArea(y: number): Touch['area'] {
  if (!model) return 'body'
  const b = model.getBounds()
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

  // Click-through everywhere except over her and the panel.
  let drag: { lastX: number; lastY: number; moved: number; area: Touch['area']; lastKick: number } | null = null
  window.addEventListener('mousemove', (e) => {
    if (drag) return
    setIgnore(!(overUi(e.clientX, e.clientY) || overModel(e.clientX, e.clientY)))
  })
  window.addEventListener('mouseleave', () => {
    if (!drag) setIgnore(true)
  })

  // Press on her: either a tap (release without moving) or a drag that carries the window around.
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
    if (drag.moved > 6) {
      if (!document.body.classList.contains('dragging')) {
        document.body.classList.add('dragging')
        void setExpression('surprised')
      }
      api.moveBy(dx, dy)
      // Keep her hair and body swinging while she is carried.
      const now = performance.now()
      if (now - drag.lastKick > 140) {
        drag.lastKick = now
        kick(0.5 + Math.min(1, Math.hypot(dx, dy) / 25))
      }
    }
  })
  const release = (e: PointerEvent): void => {
    if (!drag) return
    const d = drag
    drag = null
    document.body.classList.remove('dragging')
    if (d.moved > 6) {
      kick(1.2)
      void api.react({ kind: 'drag', area: d.area })
    } else {
      // Instant feedback before the brain answers.
      kick(1.2)
      const quick: Emotion[] = d.area === 'head' ? ['happy', 'shy'] : d.area === 'chest' ? ['surprised', 'shy', 'angry'] : ['surprised', 'flirty']
      void setExpression(quick[Math.floor(Math.random() * quick.length)])
      void api.react({ kind: 'tap', area: d.area })
    }
    setIgnore(!(overUi(e.clientX, e.clientY) || overModel(e.clientX, e.clientY)))
  }
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', release)
}

function wireUi(): void {
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
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
  characterSelect.addEventListener('change', () => {
    setStatus(`switching to ${characterSelect.options[characterSelect.selectedIndex].text}…`)
    void api.setCharacter(characterSelect.value)
  })
  api.onReply(enqueue)
  api.onStatus(setStatus)
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

async function main(): Promise<void> {
  config = await api.getConfig()
  wireUi()
  fillCharacterSelect()
  setStatus(`loading ${config.character.name}…`)
  try {
    model = await Live2DModel.from(config.character.model, { autoHitTest: false, autoFocus: true })
  } catch (err) {
    console.error(err)
    setStatus(`could not load model: ${(err as Error).message}`)
    return
  }
  app.stage.addChild(model)
  layout()
  window.addEventListener('resize', layout)

  // Let the no-audio fallback move the mouth: patch in after the motion manager's own update.
  sway.amount = config.character.physics?.sway ?? 1
  sway.bounce = config.character.physics?.bounce ?? 1.5
  type Core = {
    setParameterValueById(id: string, v: number): void
    addParameterValueById(id: string, v: number, weight?: number): void
  }
  const manager = model.internalModel.motionManager as unknown as { update: (core: Core, now: number) => boolean }
  const original = manager.update.bind(manager)
  manager.update = (core, now) => {
    const r = original(core, now)
    // Runs before physics evaluate, so these offsets excite the model's physics rig.
    const o = swayOffsets(now)
    core.addParameterValueById('ParamBodyAngleX', o.x)
    core.addParameterValueById('ParamBodyAngleY', o.y)
    core.addParameterValueById('ParamBodyAngleZ', o.z)
    core.addParameterValueById('ParamAngleX', o.x * 0.6)
    core.addParameterValueById('ParamAngleY', o.y * 0.6)
    core.addParameterValueById('ParamAngleZ', o.z * 0.5)
    // Some VTube Studio rigs feed the body chain from these "push" angles instead of ParamBodyAngle*.
    core.addParameterValueById('ParamAnglePX', o.x * 0.8)
    core.addParameterValueById('ParamAnglePY', o.y * 0.8)
    if (fakeMouth > 0) core.setParameterValueById('ParamMouthOpenY', fakeMouth)
    return r
  }
  wirePointer()
  watchBtn.classList.toggle('on', config.watching)
  keyForm.classList.toggle('hidden', config.mode !== 'demo')
  setStatus(
    config.mode === 'demo'
      ? `${config.character.name} is here. She needs a Gemini key to think.`
      : `${config.character.name} is here · ${config.modelName}${config.watchDir ? ` · watching ${config.watchDir}` : ''}`
  )
}

void main()
