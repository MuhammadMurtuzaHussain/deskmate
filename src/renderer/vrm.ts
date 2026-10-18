import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation'
import type { Anchors, BodyState, CharacterConfig, DanceStyle, Emotion, Gesture, Outfit } from '../shared/types'
import { blendPose, dancePose, defaultBpm, idlePose, type Pose } from './dance'
import { loadRig } from './rig'
import { danglePose, gestureWeight, glancePose, pointPose, sitPose, sleepPose, stretchPose, walkPose, yawnPose } from './body'
import { loadMixamoAnimation } from './mixamo'
import { resolveAsset } from './assets'
import type { Avatar, Bounds } from './avatar'
import { createSpeaker } from './audio'

const TOP = 92 // clearance for the speech bubble
const BOTTOM = 100 // the panel

/** Emotion → VRM expression preset weights. Presets missing from a model are ignored by three-vrm. */
const EMOTION_WEIGHTS: Record<Emotion, Record<string, number>> = {
  neutral: {},
  happy: { happy: 1 },
  flirty: { happy: 0.55, relaxed: 0.7 },
  surprised: { surprised: 1 },
  annoyed: { angry: 0.45 },
  angry: { angry: 1 },
  sad: { sad: 1 },
  smug: { relaxed: 0.9, happy: 0.25 },
  shy: { happy: 0.35, sad: 0.25, relaxed: 0.3 }
}
const EXPRESSIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised']

/** World-space bounds that account for skinning (geometry boxes of skinned meshes are in bind pose). */
function skinnedBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3()
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh
    if (!m.isMesh) return
    if (m.isSkinnedMesh) {
      m.computeBoundingBox()
      if (m.boundingBox) box.union(m.boundingBox.clone().applyMatrix4(m.matrixWorld))
    } else {
      box.expandByObject(m)
    }
  })
  return box
}

/**
 * 3D (VRM) character on a transparent three.js canvas. Idle sway, taps and dancing are procedural on the
 * humanoid bones so no animation files are needed; `.vrma` clips play through an AnimationMixer when present.
 * Hair, skirt and chest movement come from the model's own spring bones reacting to the body motion.
 */
export function createVRMAvatar(canvas: HTMLCanvasElement, character: CharacterConfig): Avatar {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setClearColor(0x000000, 0)
  renderer.toneMapping = THREE.NoToneMapping
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(character.camera?.fov ?? 24, 1, 0.05, 2000)
  scene.add(new THREE.AmbientLight(0xffffff, 1.1))
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(1, 2.5, 3)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffe6f2, 0.8)
  fill.position.set(-2, 1, 1)
  scene.add(fill)
  const lookTarget = new THREE.Object3D()
  scene.add(lookTarget)

  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser))

  let vrm: VRM | null = null
  /** for a rig whose rest pose already has the arms part way down (A-pose), how much further they go */
  let rigArmsDown: number | null = null
  let baseRotY = 0 // Math.PI for VRM 0.x after rotateVRM0; our sway adds to it instead of replacing it
  let hipsRestY = 0 // the normalized hips node's rest offset; bounce is added to it, never written over it
  let modelHeight = 1.6
  let modelCenter = new THREE.Vector3(0, 0.8, 0)
  let frame = 0
  let running = true
  const timer = new THREE.Timer()
  const physics = { sway: character.physics?.sway ?? 1, bounce: character.physics?.bounce ?? 1.5, impulse: 0, impulseAt: 0 }

  // expression state (smoothed)
  const target: Record<string, number> = {}
  const current: Record<string, number> = {}
  let mouth = 0
  let fakeMouth = 0
  let blinkAt = 2 + Math.random() * 3
  let blinkT = -1

  const speaker = createSpeaker()

  // dance / animation
  let dancing = false
  let danceStyle: DanceStyle = 'groove'
  let danceT = 0
  let danceWeight = 0 // 0 = idle, 1 = full choreography; ramps so starts and stops are smooth
  let mixer: THREE.AnimationMixer | null = null
  let clips: THREE.AnimationClip[] = []
  let clipIndex = -1
  let activeAction: THREE.AnimationAction | null = null

  // outfits
  const outfits: Outfit[] = character.outfits ?? []
  let outfitIndex = -1
  const baseColors = new Map<THREE.Material, THREE.Color>()

  function bone(name: string): THREE.Object3D | null {
    return (vrm?.humanoid.getNormalizedBoneNode(name as never) as THREE.Object3D | null) ?? null
  }

  async function loadModel(url: string): Promise<void> {
    let next: VRM
    if (!/\.vrm$/i.test(url)) {
      // A rigged FBX / Collada / glTF character: its skeleton mapped onto a VRM humanoid (see rig.ts).
      const rig = await loadRig(resolveAsset(url), character.hide ?? [])
      if (!rig) throw new Error(`no humanoid skeleton found in ${url.split('/').pop()}`)
      next = rig.vrm
      rigArmsDown = rig.armsDown
    } else {
      const gltf = await loader.loadAsync(resolveAsset(url))
      next = gltf.userData.vrm as VRM
      VRMUtils.removeUnnecessaryVertices(gltf.scene)
      VRMUtils.combineSkeletons(gltf.scene)
      VRMUtils.rotateVRM0(next) // VRM 0.x faces -Z; after this both versions face the camera at +Z
      rigArmsDown = null
    }
    next.scene.traverse((o) => {
      o.frustumCulled = false
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          const c = (m as unknown as { color?: THREE.Color }).color
          if (c) baseColors.set(m, c.clone())
        }
      }
    })
    if (vrm) {
      scene.remove(vrm.scene)
      VRMUtils.deepDispose(vrm.scene)
      mixer = null
      clips = []
      activeAction = null
    }
    vrm = next
    resolved.clear()
    baseRotY = vrm.scene.rotation.y
    hipsRestY = vrm.humanoid.getNormalizedBoneNode('hips')?.position.y ?? 0
    if (vrm.lookAt) vrm.lookAt.target = lookTarget
    scene.add(vrm.scene)
    vrm.update(0)
    const box = skinnedBounds(vrm.scene)
    modelHeight = Math.max(0.5, box.max.y - box.min.y)
    modelCenter = box.getCenter(new THREE.Vector3())
    console.log(`[vrm] ${vrm.meta.metaVersion === '0' ? 'VRM0' : 'VRM1'} height ${modelHeight.toFixed(2)} center ${modelCenter.y.toFixed(2)} rotY ${baseRotY.toFixed(2)}`)
    avatar.layout()
    await loadAnimations()
  }

  async function loadAnimations(): Promise<void> {
    if (!vrm || !character.animations?.length) return
    const v = vrm
    mixer = new THREE.AnimationMixer(v.scene)
    clips = []
    for (const a of character.animations) {
      try {
        let clip: THREE.AnimationClip
        if (/\.fbx$/i.test(a.file)) {
          clip = await loadMixamoAnimation(resolveAsset(a.file), v) // Mixamo FBX retargeted onto the humanoid
        } else {
          const g = await loader.loadAsync(resolveAsset(a.file))
          const anim = (g.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0]
          if (!anim) continue
          clip = createVRMAnimationClip(anim, v)
        }
        clip.name = a.name
        clips.push(clip)
      } catch (err) {
        console.warn('[vrm] animation failed', a.file, err)
      }
    }
    if (clips.length) console.log(`[vrm] ${clips.length} dance clip(s) ready: ${clips.map((c) => c.name).join(', ')}`)
  }

  function applyOutfit(o: Outfit | null): void {
    if (!vrm) return
    // reset
    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.visible = true
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const base = baseColors.get(m)
        const c = (m as unknown as { color?: THREE.Color }).color
        if (base && c) c.copy(base)
      }
    })
    if (!o) return
    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const n = mesh.name.toLowerCase()
      const hidden = o.hide?.some((pat) => n.includes(pat.toLowerCase())) ?? false
      const shown = o.show?.some((pat) => n.includes(pat.toLowerCase())) ?? false
      if (hidden && !shown) mesh.visible = false
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const c = (m as unknown as { color?: THREE.Color }).color
        if (!c || !o.tint) continue
        for (const [pat, hex] of Object.entries(o.tint)) {
          if (m.name.toLowerCase().includes(pat.toLowerCase()) || mesh.name.toLowerCase().includes(pat.toLowerCase())) c.set(hex)
        }
      }
    })
  }

  /** Applies a neutral Pose to the normalized humanoid. Arms hang at ∓armDown from the T-pose. */
  function applyPose(p: Pose): void {
    const armDown = character.idle?.armsDown ?? rigArmsDown ?? 1.18
    // VRM 0.x models face -Z and are turned around (rotateVRM0), which mirrors their bones' X and Z axes: without
    // this, "arms down" put Victoria's arms straight up, and every lean went the wrong way.
    const f = vrm?.meta.metaVersion === '0' ? -1 : 1
    const set = (node: THREE.Object3D | null, x: number, y: number, z: number): void => {
      node?.rotation.set(f * x, y, f * z)
    }
    const hips = bone('hips')
    if (hips) {
      hips.position.y = hipsRestY + p.hipsY * modelHeight
      set(hips, p.hips.x, p.hips.y, p.hips.z)
    }
    set(bone('spine'), p.spine.x, p.spine.y, p.spine.z)
    set(bone('chest') ?? bone('upperChest'), p.chest.x, p.chest.y, p.chest.z)
    set(bone('neck'), p.neck.x, p.neck.y, p.neck.z)
    set(bone('head'), p.head.x, p.head.y, p.head.z)
    set(bone('leftUpperArm'), p.armL.swing, p.armL.out, -(armDown - p.armL.raise))
    set(bone('rightUpperArm'), p.armR.swing, -p.armR.out, armDown - p.armR.raise)
    set(bone('leftLowerArm'), 0, -p.elbowL, -0.2)
    set(bone('rightLowerArm'), 0, p.elbowR, 0.2)
    // Legs only when a pose asks for them; idle and dances leave them straight.
    const legs: [string, string, Pose['legL'], number][] = [
      ['leftUpperLeg', 'leftLowerLeg', p.legL, 1],
      ['rightUpperLeg', 'rightLowerLeg', p.legR, -1]
    ]
    for (const [upper, lower, leg, side] of legs) {
      set(bone(upper), leg?.thigh ?? 0, 0, side * (leg?.out ?? 0))
      set(bone(lower), leg?.knee ?? 0, 0, 0)
    }
    if (vrm) vrm.scene.rotation.y = baseRotY + p.turn
  }

  // body on the desktop: a target state, blended in over idle
  let body: BodyState = { mode: 'idle' }
  let bodyWeight = 0
  let bodyPose: Pose | null = null
  let carried: number | null = null
  let carrySway = 0
  let carryWeight = 0
  // a stretch, yawn or glance in progress: starts on the next frame, lasts `dur` seconds
  let gesture: (Gesture & { start: number; dur: number }) | null = null
  let gestureFace = { mouth: 0, eyes: 0 }
  let eyesHeld = 0
  const GESTURE_S: Record<Gesture['kind'], number> = { stretch: 2.6, yawn: 2.8, glance: 1.8 }

  function bodyFrame(t: number): Pose | null {
    const armDown = character.idle?.armsDown ?? rigArmsDown ?? 1.18
    switch (body.mode) {
      case 'walk':
        return walkPose(t, body.facing ?? 1)
      case 'point': {
        const a = avatar.anchors?.()
        const from = a?.shoulder ?? { x: window.innerWidth / 2, y: window.innerHeight * 0.3 }
        const to = body.target ?? { x: from.x + 100, y: from.y }
        return pointPose(t, to.x - from.x, from.y - to.y, armDown)
      }
      case 'sit':
        return sitPose(t)
      case 'sleep':
        return sleepPose(sleepOnSit ? sitPose(t) : idlePose(t, 0.3, 0), t)
      default:
        return null
    }
  }
  let sleepOnSit = false

  /** Idle, dance, or a blend of the two while a dance starts or stops. */
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
      lastPose = idle
      applyPose(idle)
      return
    }
    danceT += dt
    const dance = dancePose(danceStyle, danceT, character.dance?.bpm ?? defaultBpm(danceStyle))
    lastPose = blendPose(idle, dance, danceWeight)
    applyPose(lastPose)
  }
  let lastPose: Pose | null = null

  /** The body layer over whatever poseFrame produced: walking, pointing, sitting, sleeping, being carried. */
  function bodyLayer(t: number, dt: number, base: Pose): Pose {
    const want = body.mode === 'idle' ? null : bodyFrame(t)
    if (want) bodyPose = want
    bodyWeight += ((want ? 1 : 0) - bodyWeight) * Math.min(1, dt * 4)
    if (bodyWeight < 0.002) {
      bodyWeight = 0
      bodyPose = null
    }
    let out = bodyPose && bodyWeight > 0 ? blendPose(base, bodyPose, bodyWeight) : base
    gestureFace = { mouth: 0, eyes: 0 }
    if (gesture) {
      if (gesture.start < 0) gesture.start = t
      const k = (t - gesture.start) / gesture.dur
      if (k >= 1 || body.mode === 'walk' || body.mode === 'sleep') gesture = null
      else {
        const w = gestureWeight(k)
        if (gesture.kind === 'stretch') {
          out = blendPose(out, stretchPose(out, k), w)
          gestureFace.eyes = 0.7 * w
        } else if (gesture.kind === 'yawn') {
          out = blendPose(out, yawnPose(out, k), w)
          gestureFace = { mouth: 0.85 * w * Math.sin(Math.min(1, k * 1.25) * Math.PI), eyes: 0.75 * w }
        } else {
          const a = avatar.anchors?.()
          const from = a?.head ?? { x: window.innerWidth / 2, y: window.innerHeight * 0.2 }
          const to = gesture.target ?? from
          out = blendPose(out, glancePose(out, to.x - from.x, from.y - to.y), w)
        }
      }
    }
    // Carried: a damped pendulum driven by how fast the cursor moves her.
    const goal = carried === null ? 0 : Math.max(-0.6, Math.min(0.6, -carried / 1800))
    carrySway += (goal - carrySway) * Math.min(1, dt * 5)
    carryWeight += ((carried === null ? 0 : 1) - carryWeight) * Math.min(1, dt * 6)
    if (carryWeight > 0.002) out = blendPose(out, danglePose(t, carrySway), carryWeight)
    return out
  }

  // VRM 0.x models name presets differently ("Surprised" as a custom group, "fun" for relaxed); resolve once per model.
  const resolved = new Map<string, string | null>()
  function expressionName(wanted: string): string | null {
    if (!vrm?.expressionManager) return null
    const cached = resolved.get(wanted)
    if (cached !== undefined) return cached
    const names = vrm.expressionManager.expressions.map((e) => e.expressionName)
    const hit = names.find((n) => n === wanted) ?? names.find((n) => n.toLowerCase() === wanted.toLowerCase()) ?? null
    resolved.set(wanted, hit)
    return hit
  }

  function updateFace(dt: number): void {
    if (!vrm?.expressionManager) return
    const em = vrm.expressionManager
    for (const name of EXPRESSIONS) {
      const to = target[name] ?? 0
      const cur = current[name] ?? 0
      const nx = cur + (to - cur) * Math.min(1, dt * 8)
      current[name] = nx
      const actual = expressionName(name)
      if (actual) em.setValue(actual, nx)
    }
    // blink
    blinkAt -= dt
    if (blinkAt <= 0 && blinkT < 0) {
      blinkT = 0
      blinkAt = 2.5 + Math.random() * 4
    }
    if (body.mode === 'sleep') {
      const blink = expressionName('blink')
      if (blink) em.setValue(blink, 1)
      blinkT = -1
    } else if (blinkT >= 0) {
      blinkT += dt
      const v = blinkT < 0.08 ? blinkT / 0.08 : Math.max(0, 1 - (blinkT - 0.08) / 0.1)
      const blink = expressionName('blink')
      if (blink) em.setValue(blink, Math.max(v, gestureFace.eyes))
      if (blinkT > 0.2) blinkT = -1
    } else if (gestureFace.eyes > 0 || eyesHeld > 0) {
      // eyes squeezed half shut through a stretch or a yawn (and open again once, after)
      const blink = expressionName('blink')
      if (blink) em.setValue(blink, gestureFace.eyes)
      eyesHeld = gestureFace.eyes
    }
    const m = speaker.level() || fakeMouth || gestureFace.mouth
    mouth += (m - mouth) * Math.min(1, dt * 18)
    const aa = expressionName('aa')
    if (aa) em.setValue(aa, mouth)
  }

  function tick(): void {
    if (!running) return
    requestAnimationFrame(tick)
    timer.update()
    const dt = Math.min(0.05, timer.getDelta())
    const t = timer.getElapsed()
    if (vrm) {
      if (activeAction && mixer) {
        mixer.update(dt)
      } else {
        poseFrame(t, dt)
      }
      if (!activeAction && (body.mode !== 'idle' || bodyWeight > 0 || carried !== null || carryWeight > 0.002 || gesture)) {
        // poseFrame applied idle/dance; redo the frame with the body layer on top (cheap: a few bone writes).
        applyPose(bodyLayer(t, dt, lastPose ?? idlePose(t, physics.sway, 0)))
      }
      updateFace(dt)
      vrm.update(dt)
    }
    renderer.render(scene, camera)
    frame++
  }

  const avatar: Avatar = {
    kind: 'vrm',
    capabilities: { dance: true, outfits: outfits.length > 0 },

    async load() {
      await loadModel(character.model)
      window.addEventListener('resize', () => avatar.layout())
      timer.reset() // count from the first frame, as Clock did, not from construction
      tick()
    },

    layout() {
      const w = window.innerWidth
      const h = window.innerHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      // Fit the model's height into the band between the bubble and the panel.
      const band = Math.max(100, h - TOP - BOTTOM)
      // camera.zoom > 1 frames her closer; the aim moves up by the cropped amount so her face stays in view.
      const zoom = Math.max(0.5, character.camera?.zoom ?? 1)
      const visibleHeight = (modelHeight * (h / band) * 1.02) / zoom
      const dist = visibleHeight / 2 / Math.tan((camera.fov * Math.PI) / 360)
      const centerShift = ((TOP - BOTTOM) / 2 / h) * visibleHeight
      const targetY = modelCenter.y + centerShift + (character.camera?.yOffset ?? 0) + (modelHeight * (1 - 1 / zoom)) / 2
      camera.position.set(modelCenter.x, targetY + modelHeight * 0.02, modelCenter.z + dist)
      camera.lookAt(modelCenter.x, targetY, modelCenter.z)
      camera.updateProjectionMatrix()
      lookTarget.position.set(camera.position.x, camera.position.y - modelHeight * 0.1, camera.position.z)
    },

    getBounds(): Bounds | null {
      if (!vrm) return null
      const box = skinnedBounds(vrm.scene)
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
      // The box is generous (arms out, hair); tighten the width to feel like "her", not the air around her.
      const cx = (minX + maxX) / 2
      const halfW = ((maxX - minX) / 2) * 0.55
      return { x: cx - halfW, y: minY, width: halfW * 2, height: maxY - minY }
    },

    setExpression(emotion: Emotion) {
      const weights = EMOTION_WEIGHTS[emotion] ?? {}
      for (const name of EXPRESSIONS) target[name] = weights[name] ?? 0
    },

    speak: (url: string) => speaker.speak(url),
    interrupt: () => speaker.stop(),

    setFakeMouth(v: number) {
      fakeMouth = v
    },

    kick(strength: number) {
      physics.impulse = Math.min(1.5, strength * physics.bounce)
      physics.impulseAt = performance.now()
    },

    setBody(state: BodyState) {
      sleepOnSit = state.mode === 'sleep' && (body.mode === 'sit' || (body.mode === 'sleep' && sleepOnSit))
      body = state
      if (state.mode === 'point' && state.target) avatar.pointerMove(state.target.x, state.target.y)
      // Walking, sitting, sleeping or pointing ends a dance.
      if (state.mode !== 'idle' && dancing) avatar.dance(false)
    },

    setCarried(velocity: number | null) {
      carried = velocity
    },

    gesture(g: Gesture) {
      // Not over a dance, a motion clip, or while she walks or sleeps.
      if (dancing || activeAction || body.mode === 'walk' || body.mode === 'sleep') return
      gesture = { ...g, start: -1, dur: GESTURE_S[g.kind] }
      if (g.kind === 'glance' && g.target) avatar.pointerMove(g.target.x, g.target.y)
    },

    anchors(): Anchors | null {
      if (!vrm) return null
      const w = window.innerWidth
      const h = window.innerHeight
      const at = (name: string, fallbackY: number): { x: number; y: number } => {
        const node = bone(name)
        const p = new THREE.Vector3()
        if (node) node.getWorldPosition(p)
        else p.set(modelCenter.x, fallbackY, modelCenter.z)
        p.project(camera)
        return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h }
      }
      return {
        head: at('head', modelHeight * 0.9),
        shoulder: at(body.mode === 'point' && (body.target?.x ?? 0) < w / 2 ? 'rightUpperArm' : 'leftUpperArm', modelHeight * 0.8),
        hips: at('hips', modelHeight * 0.5),
        feet: at('leftFoot', 0)
      }
    },

    pointerMove(x: number, y: number) {
      // Eyes follow the pointer: map it to a point on a plane in front of her face.
      const nx = (x / window.innerWidth) * 2 - 1
      const ny = 1 - (y / window.innerHeight) * 2
      lookTarget.position.set(camera.position.x + nx * 0.6, camera.position.y + ny * 0.5 - modelHeight * 0.1, camera.position.z * 0.6)
    },

    dance(on: boolean, style: DanceStyle = 'groove') {
      dancing = on
      danceStyle = style
      if (on) {
        if (danceWeight === 0) danceT = 0
        // Motion-capture clips win when the character has them (slow asks for the slowest-looking one by name).
        if (mixer && clips.length) {
          const slowish = clips.map((c, i) => ({ c, i })).filter(({ c }) => /slow|rumba|waltz|belly|sens/i.test(c.name))
          const pool = style === 'slow' && slowish.length ? slowish.map((x) => x.i) : clips.map((_, i) => i)
          clipIndex = pool[(pool.indexOf(clipIndex) + 1) % pool.length]
          const nextAction = mixer.clipAction(clips[clipIndex])
          nextAction.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.5).play()
          if (activeAction && activeAction !== nextAction) activeAction.fadeOut(0.5)
          activeAction = nextAction
          return
        }
      }
      if (!on && activeAction) {
        activeAction.fadeOut(0.4)
        const ending = activeAction
        activeAction = null
        window.setTimeout(() => {
          ending.stop()
          mixer?.stopAllAction()
        }, 450)
      }
    },

    isDancing: () => dancing,

    async nextOutfit() {
      if (!outfits.length) return null
      outfitIndex = (outfitIndex + 1) % (outfits.length + 1)
      const o = outfitIndex === outfits.length ? null : outfits[outfitIndex]
      if (o?.model) {
        await loadModel(o.model)
      } else if (vrm && (vrm.scene.userData.loadedFrom ?? character.model) !== character.model) {
        await loadModel(character.model)
      }
      applyOutfit(o && !o.model ? o : null)
      return o ? o.name : 'default'
    },

    destroy() {
      running = false
      speaker.stop()
      if (vrm) VRMUtils.deepDispose(vrm.scene)
      renderer.dispose()
    }
  }
  void frame
  return avatar
}
