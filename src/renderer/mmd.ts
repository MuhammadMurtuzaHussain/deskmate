import * as THREE from 'three'
import { MMDLoader } from './vendor/mmd/MMDLoader.js'
import { MMDAnimationHelper } from './vendor/mmd/MMDAnimationHelper.js'
import type { CharacterConfig, DanceStyle, Emotion, Outfit } from '../shared/types'
import { blendPose, dancePose, defaultBpm, idlePose, type Pose } from './dance'
import { resolveAsset } from './assets'
import type { Avatar, Bounds } from './avatar'
import { createSpeaker } from './audio'

const TOP = 92
const BOTTOM = 100

/** Standard MMD bone names (Japanese, with the usual English exports) for the bones we move. */
const BONES = {
  center: ['センター', 'center', 'Center'],
  lower: ['下半身', 'lower body', 'LowerBody', 'lowerbody'],
  upper: ['上半身', 'upper body', 'UpperBody', 'upperbody'],
  upper2: ['上半身2', 'upper body2', 'UpperBody2', 'upperbody2'],
  neck: ['首', 'neck', 'Neck'],
  head: ['頭', 'head', 'Head'],
  armL: ['左腕', 'arm_L', 'LeftArm', 'left arm', 'arm.L'],
  armR: ['右腕', 'arm_R', 'RightArm', 'right arm', 'arm.R'],
  elbowL: ['左ひじ', 'elbow_L', 'LeftElbow', 'left elbow', 'elbow.L'],
  elbowR: ['右ひじ', 'elbow_R', 'RightElbow', 'right elbow', 'elbow.R']
} as const
type BoneKey = keyof typeof BONES

/**
 * Default morph combinations per emotion: each entry is morph names joined with '+'; the first entry with at
 * least one existing morph is used. Covers the standard Japanese MMD names and ARKit-style English names.
 */
const MORPHS: Record<Emotion | 'mouth' | 'blink', string[]> = {
  mouth: ['あ', 'a', 'A', 'jawOpen', 'mouth_a', 'MouthOpen'],
  blink: ['まばたき', 'blink', 'Blink', 'eyeBlinkLeft+eyeBlinkRight', 'eyes_close'],
  neutral: [],
  happy: ['笑い+mouthSmileLeft+mouthSmileRight', '笑い', 'にこり', 'smile', 'joy', 'happy', 'mouthSmileLeft+mouthSmileRight'],
  flirty: ['ウィンク+mouthSmileLeft+mouthSmileRight', 'ウィンク', 'wink', '笑い', 'mouthSmileLeft+mouthSmileRight'],
  surprised: ['びっくり', 'はちゅ目+eyeWideLeft+eyeWideRight', 'surprise', 'surprised', 'eyeWideLeft+eyeWideRight+browInnerUp'],
  annoyed: ['困る', 'browDownLeft+browDownRight+mouthFrownLeft', 'troubled', 'annoyed'],
  angry: ['怒り+browDownLeft+browDownRight', '怒り', '怒', 'anger', 'angry', 'browDownLeft+browDownRight+mouthFrownLeft+mouthFrownRight'],
  sad: ['悲しい', '涙+mouthFrownLeft+mouthFrownRight', '困る', 'sad', 'sorrow', 'mouthFrownLeft+mouthFrownRight+browInnerUp'],
  smug: ['にやり', 'なごみ+mouthSmileLeft+mouthSmileRight', 'smirk', 'にこり'],
  shy: ['照れ+mouthSmileLeft+mouthSmileRight', '照れ', 'blush', 'shy']
}

/**
 * MMD (PMX) character on a transparent three.js canvas. Expressions and lip sync use the model's morphs, idle
 * sway and the built-in dance move its standard bones, `.vmd` motions play through the MMD helper, and the
 * model's own rigid-body physics (hair, skirt) runs when Ammo is available and `physics.simulate` is on.
 */
export function createMMDAvatar(canvas: HTMLCanvasElement, character: CharacterConfig): Avatar {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setClearColor(0x000000, 0)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(character.camera?.fov ?? 24, 1, 0.1, 5000)
  scene.add(new THREE.AmbientLight(0xffffff, 1.0))
  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.set(1, 2.5, 3)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffe6f2, 0.6)
  fill.position.set(-2, 1, 1)
  scene.add(fill)

  const loader = new MMDLoader()
  const helper = new MMDAnimationHelper({ afterglow: 2.0 })
  const speaker = createSpeaker()
  const timer = new THREE.Timer()

  let mesh: THREE.SkinnedMesh | null = null
  let modelHeight = 20
  let modelCenter = new THREE.Vector3()
  let running = true
  let simulate = false
  const physics = { sway: character.physics?.sway ?? 1, bounce: character.physics?.bounce ?? 1.5, impulse: 0, impulseAt: 0 }
  const rest = new Map<THREE.Bone, THREE.Quaternion>()
  const bones: Partial<Record<BoneKey, THREE.Bone>> = {}
  const morphIndex = new Map<string, number>()
  const target = new Map<number, number>()
  const current = new Map<number, number>()
  let mouthIdx: number[] = []
  let blinkIdx: number[] = []
  let mouth = 0
  let fakeMouth = 0
  let blinkAt = 2 + Math.random() * 3
  let blinkT = -1
  let dancing = false
  let danceStyle: DanceStyle = 'groove'
  let danceT = 0
  let danceWeight = 0
  let clips: THREE.AnimationClip[] = []
  let clipIndex = -1
  let playingClip = false
  const outfits: Outfit[] = character.outfits ?? []
  let outfitIndex = -1
  let centerRestY = 0

  function findBone(names: readonly string[]): THREE.Bone | undefined {
    if (!mesh) return undefined
    for (const n of names) {
      const b = mesh.skeleton.bones.find((x) => x.name === n)
      if (b) return b
    }
    return undefined
  }

  /** Resolves "a+b+c" (or a list of candidates) to the morph indices that exist on this model. */
  function resolveMorphs(candidates: string[]): number[] {
    for (const combo of candidates) {
      const idx = combo
        .split('+')
        .map((n) => morphIndex.get(n.trim()))
        .filter((i): i is number => i !== undefined)
      if (idx.length) return idx
    }
    return []
  }

  function emotionMorphs(e: Emotion | 'mouth' | 'blink'): number[] {
    const override = character.morphs?.[e]
    const fromOverride = override ? resolveMorphs([override]) : []
    return fromOverride.length ? fromOverride : resolveMorphs(MORPHS[e])
  }

  /** Loads Ammo (bullet physics) as a classic script so its UMD wrapper finds `window`; MMDPhysics reads the global. */
  async function loadAmmo(): Promise<void> {
    const g = globalThis as unknown as { Ammo?: ((target?: unknown) => Promise<unknown>) & { btVector3?: unknown } }
    if (g.Ammo?.btVector3) return
    if (typeof g.Ammo !== 'function') {
      await new Promise<void>((res, rej) => {
        const el = document.createElement('script')
        el.src = resolveAsset('/vendor/ammo/ammo.wasm.js')
        el.onload = () => res()
        el.onerror = () => rej(new Error('could not load ammo.wasm.js'))
        document.head.appendChild(el)
      })
    }
    const factory = g.Ammo as (target?: unknown) => Promise<unknown>
    await factory(factory) // populates the API onto the global function object, which is what MMDPhysics expects
  }

  async function enablePhysics(m: THREE.SkinnedMesh): Promise<boolean> {
    if (character.physics?.simulate === false) return false
    try {
      await loadAmmo()
      helper.add(m, { physics: true, warmup: 30 })
      return true
    } catch (err) {
      console.warn('[mmd] physics unavailable, hair and skirt will be stiff:', err)
      helper.add(m, { physics: false })
      return false
    }
  }

  async function loadModel(url: string): Promise<void> {
    const next = await loader.loadAsync(resolveAsset(url))
    next.traverse((o) => {
      o.frustumCulled = false
    })
    if (mesh) {
      scene.remove(mesh)
      helper.remove(mesh)
    }
    mesh = next
    scene.add(mesh)
    rest.clear()
    for (const b of mesh.skeleton.bones) rest.set(b, b.quaternion.clone())
    for (const k of Object.keys(BONES) as BoneKey[]) bones[k] = findBone(BONES[k])
    centerRestY = bones.center?.position.y ?? 0
    morphIndex.clear()
    for (const [name, i] of Object.entries(mesh.morphTargetDictionary ?? {})) morphIndex.set(name, i)
    mouthIdx = emotionMorphs('mouth')
    blinkIdx = emotionMorphs('blink')
    console.log(
      '[mmd] bones:',
      (Object.keys(bones) as BoneKey[]).filter((k) => bones[k]).join(' '),
      '| morphs:',
      morphIndex.size,
      '| mouth',
      mouthIdx,
      'blink',
      blinkIdx
    )
    mesh.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(mesh)
    modelHeight = Math.max(1, box.max.y - box.min.y)
    modelCenter = box.getCenter(new THREE.Vector3())
    avatar.layout()
    simulate = await enablePhysics(mesh)
    await loadAnimations()
  }

  async function loadAnimations(): Promise<void> {
    clips = []
    if (!mesh || !character.animations?.length) return
    const m = mesh
    for (const a of character.animations) {
      try {
        const clip = await new Promise<THREE.AnimationClip>((res, rej) => loader.loadAnimation(resolveAsset(a.file), m, res, undefined, rej))
        clip.name = a.name
        clips.push(clip)
      } catch (err) {
        console.warn('[mmd] animation failed', a.file, err)
      }
    }
  }

  const euler = new THREE.Euler()
  const quat = new THREE.Quaternion()
  function setBone(key: BoneKey, x: number, y: number, z: number): void {
    const b = bones[key]
    const r = b && rest.get(b)
    if (!b || !r) return
    euler.set(x, y, z)
    b.quaternion.copy(r).multiply(quat.setFromEuler(euler))
  }

  /** Applies a neutral Pose to the MMD skeleton (rest pose is an A-pose; armsDown is how far below it the arms hang). */
  function applyPose(p: Pose): void {
    const armsDown = character.idle?.armsDown ?? 0.55
    const c = bones.center
    if (c) c.position.y = centerRestY + p.hipsY * modelHeight
    setBone('lower', p.hips.x, p.hips.y, p.hips.z)
    setBone('upper', p.spine.x, p.spine.y, p.spine.z)
    setBone('upper2', p.chest.x, p.chest.y, p.chest.z)
    setBone('neck', p.neck.x, p.neck.y, p.neck.z)
    setBone('head', p.head.x, p.head.y, p.head.z)
    setBone('armL', p.armL.swing, p.armL.out, -(armsDown - p.armL.raise))
    setBone('armR', p.armR.swing, -p.armR.out, armsDown - p.armR.raise)
    setBone('elbowL', 0, -p.elbowL, -0.15)
    setBone('elbowR', 0, p.elbowR, 0.15)
    if (mesh) mesh.rotation.y = p.turn
  }

  function poseFrame(t: number, dt: number): void {
    let k = 0
    if (physics.impulse > 0) {
      const s = (performance.now() - physics.impulseAt) / 1000
      k = physics.impulse * Math.exp(-s * 2.4) * Math.sin(s * Math.PI * 2 * 2.2)
      if (s > 3) physics.impulse = 0
    }
    danceWeight += ((dancing ? 1 : 0) - danceWeight) * Math.min(1, dt * 3)
    if (danceWeight < 0.002) danceWeight = 0
    const idle = idlePose(t, physics.sway, k)
    if (danceWeight === 0) {
      applyPose(idle)
      return
    }
    danceT += dt
    applyPose(blendPose(idle, dancePose(danceStyle, danceT, character.dance?.bpm ?? defaultBpm(danceStyle)), danceWeight))
  }

  function updateFace(dt: number): void {
    if (!mesh?.morphTargetInfluences) return
    const inf = mesh.morphTargetInfluences
    for (const [i, to] of target) {
      const cur = current.get(i) ?? 0
      const nx = cur + (to - cur) * Math.min(1, dt * 8)
      current.set(i, nx)
      inf[i] = nx
      if (Math.abs(nx) < 0.001 && to === 0) {
        target.delete(i)
        current.delete(i)
        inf[i] = 0
      }
    }
    blinkAt -= dt
    if (blinkAt <= 0 && blinkT < 0) {
      blinkT = 0
      blinkAt = 2.5 + Math.random() * 4
    }
    if (blinkT >= 0) {
      blinkT += dt
      const v = blinkT < 0.08 ? blinkT / 0.08 : Math.max(0, 1 - (blinkT - 0.08) / 0.1)
      for (const i of blinkIdx) inf[i] = v
      if (blinkT > 0.2) {
        blinkT = -1
        for (const i of blinkIdx) inf[i] = 0
      }
    }
    const m = speaker.level() || fakeMouth
    mouth += (m - mouth) * Math.min(1, dt * 18)
    for (const i of mouthIdx) inf[i] = mouth
  }

  function tick(): void {
    if (!running) return
    requestAnimationFrame(tick)
    timer.update()
    const dt = Math.min(0.05, timer.getDelta())
    const t = timer.getElapsed()
    if (mesh) {
      if (!playingClip) poseFrame(t, dt)
      updateFace(dt)
      // The helper runs IK, grants and physics on top of whatever posed the bones.
      if (playingClip || simulate) helper.update(dt)
    }
    renderer.render(scene, camera)
  }

  function applyOutfit(o: Outfit | null): void {
    if (!mesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) m.visible = true
    if (!o) return
    for (const m of mats) {
      const n = m.name.toLowerCase()
      const hidden = o.hide?.some((pat) => n.includes(pat.toLowerCase())) ?? false
      const shown = o.show?.some((pat) => n.includes(pat.toLowerCase())) ?? false
      if (hidden && !shown) m.visible = false
    }
  }

  const avatar: Avatar = {
    kind: 'mmd',
    capabilities: { dance: true, outfits: outfits.length > 0 },

    async load() {
      await loadModel(character.model)
      // Start in the first outfit when outfits are defined; "(Hide)" parts need it.
      if (outfits.length) {
        outfitIndex = 0
        applyOutfit(outfits[0])
      }
      window.addEventListener('resize', () => avatar.layout())
      timer.reset() // count from the first frame, as Clock did, not from construction
      tick()
    },

    layout() {
      const w = window.innerWidth
      const h = window.innerHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      const band = Math.max(100, h - TOP - BOTTOM)
      const visibleHeight = modelHeight * (h / band) * 1.02
      const dist = visibleHeight / 2 / Math.tan((camera.fov * Math.PI) / 360)
      const centerShift = ((TOP - BOTTOM) / 2 / h) * visibleHeight
      const targetY = modelCenter.y + centerShift + (character.camera?.yOffset ?? 0) * modelHeight
      camera.position.set(modelCenter.x, targetY + modelHeight * 0.02, modelCenter.z + dist)
      camera.lookAt(modelCenter.x, targetY, modelCenter.z)
      camera.updateProjectionMatrix()
    },

    getBounds(): Bounds | null {
      if (!mesh) return null
      const box = new THREE.Box3().setFromObject(mesh)
      const w = window.innerWidth
      const h = window.innerHeight
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      const v = new THREE.Vector3()
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            v.set(x, y, z).project(camera)
            const sx = ((v.x + 1) / 2) * w
            const sy = ((1 - v.y) / 2) * h
            minX = Math.min(minX, sx)
            maxX = Math.max(maxX, sx)
            minY = Math.min(minY, sy)
            maxY = Math.max(maxY, sy)
          }
        }
      }
      const cx = (minX + maxX) / 2
      const halfW = ((maxX - minX) / 2) * 0.55
      return { x: cx - halfW, y: minY, width: halfW * 2, height: maxY - minY }
    },

    setExpression(emotion: Emotion) {
      for (const i of target.keys()) target.set(i, 0)
      if (emotion === 'neutral') return
      const weight = emotion === 'annoyed' || emotion === 'shy' ? 0.6 : 1
      for (const i of emotionMorphs(emotion)) {
        if (!mouthIdx.includes(i) && !blinkIdx.includes(i)) target.set(i, weight)
      }
    },

    speak: (url: string) => speaker.speak(url),
    setFakeMouth: (v: number) => {
      fakeMouth = v
    },

    kick(strength: number) {
      physics.impulse = Math.min(1.5, strength * physics.bounce)
      physics.impulseAt = performance.now()
    },

    pointerMove() {
      /* MMD models have no look-at rig; the head sway stands in */
    },

    dance(on: boolean, style: DanceStyle = 'groove') {
      dancing = on
      danceStyle = style
      if (on) {
        if (danceWeight === 0) danceT = 0
        if (mesh && clips.length) {
          clipIndex = (clipIndex + 1) % clips.length
          helper.remove(mesh)
          helper.add(mesh, { animation: clips[clipIndex], physics: simulate })
          playingClip = true
          return
        }
      }
      if (!on && mesh && playingClip) {
        helper.remove(mesh)
        playingClip = false
        for (const b of mesh.skeleton.bones) {
          const r = rest.get(b)
          if (r) b.quaternion.copy(r)
        }
        helper.add(mesh, { physics: simulate })
      }
      if (!on && mesh) mesh.rotation.y = 0
    },
    isDancing: () => dancing,

    async nextOutfit() {
      if (!outfits.length) return null
      outfitIndex = (outfitIndex + 1) % outfits.length
      const o = outfits[outfitIndex]
      if (o.model) await loadModel(o.model)
      applyOutfit(o)
      return o.name
    },

    destroy() {
      running = false
      speaker.stop()
      renderer.dispose()
    }
  }
  return avatar
}
