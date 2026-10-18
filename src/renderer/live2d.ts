import * as PIXI from 'pixi.js'
import '@pixi/unsafe-eval'
import { Cubism4ModelSettings, Live2DModel, MotionPriority } from 'pixi-live2d-display-lipsyncpatch/cubism4'
import type { Anchors, BodyState, CharacterConfig, Emotion } from '../shared/types'
import type { Avatar, Bounds } from './avatar'
import { resolveAsset } from './assets'

// Pixi 7 builds shader code with `new Function`; importing @pixi/unsafe-eval self-installs a CSP-safe path.
// pixi-live2d-display finds the Pixi ticker through the global.
;(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI

// pixi-live2d-display resolves every file named in a model3.json with Pixi 7's utils.url.resolve, which Pixi deprecated
// in 7.3 and reports with a stack trace on every model load. Same resolution through the native URL API instead; the
// settings URL is always absolute here (resolveAsset output or an https URL), so this returns the same strings.
Cubism4ModelSettings.prototype.resolveURL = function (this: Cubism4ModelSettings, path: string): string {
  return new URL(path, new URL(this.url, location.href)).href
}

const TOP = 92 // clearance for the speech bubble
const BOTTOM = 100 // the panel

type Core = {
  setParameterValueById(id: string, v: number): void
  addParameterValueById(id: string, v: number, weight?: number): void
}

/**
 * Live2D character on a PixiJS stage. Physics excitation: Live2D rigs (hair, chest, skirt) are driven by
 * input parameters such as the body and head angles; we add a slow idle sway plus a damped impulse on taps
 * and replies so a rigged model keeps moving. Amplitudes come from character.json → physics.
 */
export function createLive2DAvatar(canvas: HTMLCanvasElement, character: CharacterConfig): Avatar {
  const app = new PIXI.Application({
    view: canvas,
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1
  })
  let model: Live2DModel | null = null
  let fakeMouth = 0
  let settleSpeak: ((ok: boolean) => void) | null = null
  const sway = { amount: character.physics?.sway ?? 1, bounce: character.physics?.bounce ?? 1.5, impulse: 0, impulseAt: 0 }

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

  // ---- her body on the desktop, in 2D: no limbs to move, so it is lean, bob, gaze, and the model's own pose toggles
  let body: BodyState = { mode: 'idle' }
  let carried: number | null = null
  let carrySway = 0
  let dancing = false
  let danceStart = 0
  let baseY = 0
  let lastNow = 0
  /** pose toggles (VTube Studio expressions such as "sitting") as parameter lists, layered over her emotion */
  const poseParams = new Map<string, { id: string; value: number; blend: string }[]>()
  const poseWeight = new Map<string, number>()
  let savedBlink: unknown = undefined
  let sleptSitting = false

  async function loadPoses(): Promise<void> {
    if (!model || !character.poses) return
    const settings = model.internalModel.settings as unknown as { url: string; expressions?: { Name: string; File: string }[] }
    const wanted = new Set([character.poses.sit, character.poses.point, character.poses.sleep, ...(character.poses.dance ?? []), ...(character.poses.base ?? [])].filter(Boolean) as string[])
    for (const e of settings.expressions ?? []) {
      if (!wanted.has(e.Name)) continue
      try {
        const res = await fetch(new URL(e.File, new URL(settings.url, location.href)).href)
        const json = (await res.json()) as { Parameters?: { Id: string; Value: number; Blend?: string }[] }
        poseParams.set(e.Name, (json.Parameters ?? []).map((p) => ({ id: p.Id, value: p.Value, blend: p.Blend ?? 'Add' })))
      } catch (err) {
        console.warn('[pose]', e.Name, err)
      }
    }
  }

  /** Which pose toggle is on right now, if any. */
  function activePose(beats: number): string | null {
    const p = character.poses ?? {}
    if (body.mode === 'sit' || (body.mode === 'sleep' && sleptSitting)) return p.sit ?? null
    if (body.mode === 'point') return p.point ?? null
    if (body.mode === 'sleep') return p.sleep ?? null
    if (dancing && p.dance?.length) return p.dance[Math.floor(beats / 4) % p.dance.length]
    return null
  }

  /** Runs inside the model's update, before physics, so lean and bob also swing hair and skirt. */
  function bodyFrame(core: Core, now: number): void {
    if (!model) return
    const dt = Math.min(0.05, lastNow ? (now - lastNow) / 1000 : 0.016)
    lastNow = now
    const t = now / 1000
    const bpm = character.dance?.bpm ?? 118
    const beats = dancing ? ((now - danceStart) / 1000) * (bpm / 60) : 0
    let offsetY = 0
    const facing = body.facing ?? 1
    if (body.mode === 'walk') {
      const step = Math.sin(t * Math.PI * 2 * 1.6)
      offsetY = -Math.abs(step) * 8
      core.addParameterValueById('ParamBodyAngleZ', -facing * 6 + step * 2)
      core.addParameterValueById('ParamAngleX', facing * 18)
      core.addParameterValueById('ParamBodyAngleX', facing * 8)
    } else if (body.mode === 'point' && body.target) {
      const a = avatar.anchors?.()
      const from = a?.head ?? { x: app.screen.width / 2, y: app.screen.height * 0.2 }
      const nx = Math.max(-1, Math.min(1, (body.target.x - from.x) / 250))
      const ny = Math.max(-1, Math.min(1, (from.y - body.target.y) / 250))
      model.internalModel.focusController.focus(nx, ny)
      core.addParameterValueById('ParamBodyAngleX', nx * 10)
    } else if (body.mode === 'sleep') {
      core.addParameterValueById('ParamAngleY', -22)
      core.addParameterValueById('ParamAngleZ', 10)
      core.addParameterValueById('ParamBodyAngleY', -6 + Math.sin(t * 0.8) * 2)
      core.setParameterValueById('ParamEyeLOpen', 0)
      core.setParameterValueById('ParamEyeROpen', 0)
    } else if (body.mode === 'sit') {
      core.addParameterValueById('ParamAngleZ', Math.sin(t * 0.6) * 4)
    }
    if (dancing) {
      const b = beats * Math.PI
      offsetY += -Math.abs(Math.sin(b)) * 12
      core.addParameterValueById('ParamBodyAngleX', Math.sin(b) * 9)
      core.addParameterValueById('ParamBodyAngleZ', Math.sin(b / 2) * 8)
      core.addParameterValueById('ParamAngleZ', Math.sin(b / 2 + 0.6) * 9)
      core.addParameterValueById('ParamAngleX', Math.sin(b / 4) * 12)
    }
    // Pose toggles fade in and out instead of popping.
    const pose = activePose(beats)
    for (const name of poseParams.keys()) {
      const prev = poseWeight.get(name) ?? 0
      const on = name === pose || (character.poses?.base ?? []).includes(name)
      const w = prev + ((on ? 1 : 0) - prev) * Math.min(1, dt * 6)
      poseWeight.set(name, w)
      if (w < 0.01) continue
      for (const p of poseParams.get(name) ?? []) {
        if (p.blend === 'Overwrite') {
          if (w > 0.5) core.setParameterValueById(p.id, p.value)
        } else if (p.blend === 'Add') core.addParameterValueById(p.id, p.value * w)
      }
    }
    // Carried: she swings from the top of her head (the model's anchor), as if held there.
    const goal = carried === null ? 0 : Math.max(-0.5, Math.min(0.5, -carried / 2500))
    carrySway += (goal - carrySway) * Math.min(1, dt * 6)
    model.rotation = carrySway
    model.y = baseY + offsetY
  }

  function hasMotions(group: string): boolean {
    if (!model) return false
    const defs = (model.internalModel.motionManager as unknown as { definitions: Record<string, unknown[] | undefined> }).definitions
    return Boolean(defs?.[group]?.length)
  }

  const avatar: Avatar = {
    kind: 'live2d',
    capabilities: { dance: true, outfits: false },

    async load() {
      model = await Live2DModel.from(resolveAsset(character.model), { autoHitTest: false, autoFocus: true })
      app.stage.addChild(model)
      avatar.layout()
      void loadPoses()
      const manager = model.internalModel.motionManager as unknown as { update: (core: Core, now: number) => boolean }
      const original = manager.update.bind(manager)
      manager.update = (core, now) => {
        const r = original(core, now)
        // Runs before physics evaluate, so these offsets excite the model's physics rig.
        bodyFrame(core, now)
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
    },

    layout() {
      if (!model) return
      const ow = model.internalModel.originalWidth
      const oh = model.internalModel.originalHeight
      const availH = app.screen.height - TOP - BOTTOM
      // camera.zoom > 1 frames her closer: anchored at the top, so the legs crop first and her face stays in view.
      const zoom = Math.max(0.5, character.camera?.zoom ?? 1)
      const scale = Math.min(availH / oh, (app.screen.width - 20) / ow) * zoom
      model.scale.set(scale)
      model.anchor.set(0.5, 0)
      baseY = TOP
      model.x = app.screen.width / 2
      model.y = TOP
    },

    getBounds(): Bounds | null {
      if (!model) return null
      const b = model.getBounds()
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    },

    setExpression(emotion: Emotion) {
      if (!model) return
      const name = character.expressions[emotion] ?? character.expressions.neutral
      try {
        if (!name) {
          // Empty mapping = plain face. (model.expression() with no name would pick a random one.)
          model.internalModel.motionManager.expressionManager?.resetExpression()
          return
        }
        void model.expression(name)
      } catch (err) {
        console.warn('[expression]', name, err)
      }
    },

    speak(url: string): Promise<boolean> {
      if (!model) return Promise.resolve(false)
      const m = model
      return new Promise((resolve) => {
        let settled = false
        const done = (ok: boolean): void => {
          if (!settled) {
            settled = true
            if (settleSpeak === done) settleSpeak = null
            resolve(ok)
          }
        }
        settleSpeak = done
        const options = {
          volume: 1,
          resetExpression: false,
          onFinish: () => done(true),
          onError: (err: unknown) => {
            console.warn('[speak] error', err)
            done(false)
          }
        }
        // The lip-sync fork drives ParamMouthOpenY from the audio volume while it plays. If the model has a
        // reaction motion group, play the gesture with our speech as its sound (one call, no audio race).
        const react = character.motions.react
        const started = hasMotions(react)
          ? m.motion(react, undefined, MotionPriority.FORCE, { sound: url, ...options })
          : m.speak(url, options)
        void started.then((ok) => {
          if (!ok) done(false)
        })
      })
    },

    interrupt() {
      // stopSpeaking() drops the audio element and its listeners, so onFinish never fires: settle the promise here.
      model?.internalModel.motionManager.stopSpeaking()
      settleSpeak?.(true)
    },

    setFakeMouth(v: number) {
      fakeMouth = v
    },

    kick(strength: number) {
      sway.impulse = Math.min(1.5, strength * sway.bounce)
      sway.impulseAt = performance.now()
    },

    pointerMove() {
      // pixi-live2d-display's autoFocus already follows the pointer.
    },

    dance(on: boolean) {
      // No limbs to dance with: a beat-driven sway and bounce, cycling her pose toggles (character.json → poses.dance).
      if (on && !dancing) danceStart = performance.now()
      dancing = on
    },
    isDancing: () => dancing,

    setBody(state: BodyState) {
      sleptSitting = state.mode === 'sleep' && (body.mode === 'sit' || (body.mode === 'sleep' && sleptSitting))
      // Eyes stay shut while asleep: the blink controller would open them every frame.
      const internal = model?.internalModel as unknown as { eyeBlink?: unknown } | undefined
      if (internal) {
        if (state.mode === 'sleep' && body.mode !== 'sleep') {
          savedBlink = internal.eyeBlink
          internal.eyeBlink = undefined
        } else if (state.mode !== 'sleep' && body.mode === 'sleep') internal.eyeBlink = savedBlink
      }
      // Walking, sitting, sleeping or pointing ends a dance.
      if (state.mode !== 'idle') dancing = false
      // A model with its own walk motion (character.json → motions.walk) loops it as her idle while she walks.
      const walkGroup = character.motions.walk
      if (model && walkGroup && hasMotions(walkGroup) && (state.mode === 'walk') !== (body.mode === 'walk')) {
        const mm = model.internalModel.motionManager as unknown as { groups: { idle: string }; stopAllMotions(): void }
        mm.groups.idle = state.mode === 'walk' ? walkGroup : character.motions.idle
        mm.stopAllMotions()
      }
      body = state
    },

    setCarried(velocity: number | null) {
      carried = velocity
    },

    anchors(): Anchors | null {
      if (!model) return null
      const b = model.getBounds()
      const at = (f: number): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height * f })
      return { head: at(0.1), shoulder: at(0.2), hips: at(0.5), feet: at(1) }
    },
    nextOutfit: async () => null,

    destroy() {
      model?.destroy()
      app.destroy(false)
    }
  }
  return avatar
}
