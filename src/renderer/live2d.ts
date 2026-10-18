import * as PIXI from 'pixi.js'
import '@pixi/unsafe-eval'
import { Cubism4ModelSettings, Live2DModel, MotionPriority } from 'pixi-live2d-display-lipsyncpatch/cubism4'
import type { CharacterConfig, Emotion } from '../shared/types'
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

  function hasMotions(group: string): boolean {
    if (!model) return false
    const defs = (model.internalModel.motionManager as unknown as { definitions: Record<string, unknown[] | undefined> }).definitions
    return Boolean(defs?.[group]?.length)
  }

  const avatar: Avatar = {
    kind: 'live2d',
    capabilities: { dance: false, outfits: false },

    async load() {
      model = await Live2DModel.from(resolveAsset(character.model), { autoHitTest: false, autoFocus: true })
      app.stage.addChild(model)
      avatar.layout()
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

    dance() {
      // Live2D rigs have no body animation of their own; a reaction motion is the closest thing.
      if (model && hasMotions(character.motions.react)) model.motion(character.motions.react, undefined, MotionPriority.NORMAL)
    },
    isDancing: () => false,
    nextOutfit: async () => null,

    destroy() {
      model?.destroy()
      app.destroy(false)
    }
  }
  return avatar
}
