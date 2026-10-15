import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation'
import type { CharacterConfig, DanceStyle, Emotion, Outfit } from '../shared/types'
import { dancePose } from './dance'
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
  let baseRotY = 0 // Math.PI for VRM 0.x after rotateVRM0; our sway adds to it instead of replacing it
  let hipsRestY = 0 // the normalized hips node's rest offset; bounce is added to it, never written over it
  let modelHeight = 1.6
  let modelCenter = new THREE.Vector3(0, 0.8, 0)
  let frame = 0
  let running = true
  const clock = new THREE.Clock()
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
    const gltf = await loader.loadAsync(resolveAsset(url))
    const next = gltf.userData.vrm as VRM
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.rotateVRM0(next) // VRM 0.x faces -Z; after this both versions face the camera at +Z
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
        const g = await loader.loadAsync(resolveAsset(a.file))
        const anim = (g.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0]
        if (!anim) continue
        const clip = createVRMAnimationClip(anim, v)
        clip.name = a.name
        clips.push(clip)
      } catch (err) {
        console.warn('[vrm] animation failed', a.file, err)
      }
    }
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

  /** Arms down from the T-pose, plus breathing, weight shift and the damped impulse from taps. */
  function poseIdle(t: number, dt: number): void {
    let k = 0
    if (physics.impulse > 0) {
      const s = (performance.now() - physics.impulseAt) / 1000
      k = physics.impulse * Math.exp(-s * 2.4) * Math.sin(s * Math.PI * 2 * 2.2)
      if (s > 3) physics.impulse = 0
    }
    const sw = physics.sway
    const armDown = character.idle?.armsDown ?? 1.18
    const L = bone('leftUpperArm')
    const R = bone('rightUpperArm')
    const LL = bone('leftLowerArm')
    const RL = bone('rightLowerArm')
    const hips = bone('hips')
    const spine = bone('spine')
    const chest = bone('chest') ?? bone('upperChest')
    const neck = bone('neck')
    const head = bone('head')

    if (dancing) {
      danceT += dt
      const p = dancePose(danceStyle, danceT, character.dance?.bpm ?? (danceStyle === 'slow' ? 72 : 124))
      if (hips) {
        hips.position.y = hipsRestY + p.hipsY * modelHeight
        hips.rotation.set(p.hips.x, p.hips.y, p.hips.z)
      }
      if (spine) spine.rotation.set(p.spine.x, p.spine.y, p.spine.z)
      if (chest) chest.rotation.set(p.chest.x, p.chest.y, p.chest.z)
      if (neck) neck.rotation.set(p.neck.x, p.neck.y, p.neck.z)
      if (head) head.rotation.set(p.head.x, p.head.y, p.head.z)
      // VRM normalized arms hang at rotation.z = ∓armDown; "raise" brings them back up, "out" rotates around Y.
      if (L) L.rotation.set(p.armL.swing, p.armL.out, -(armDown - p.armL.raise))
      if (R) R.rotation.set(p.armR.swing, -p.armR.out, armDown - p.armR.raise)
      if (LL) LL.rotation.set(0, -p.elbowL, -0.2)
      if (RL) RL.rotation.set(0, p.elbowR, 0.2)
      if (vrm) vrm.scene.rotation.y = baseRotY + p.turn
      return
    }

    const breath = Math.sin(t * 1.4) * 0.5 + 0.5
    if (vrm) vrm.scene.rotation.y = baseRotY
    if (hips) {
      hips.position.y = hipsRestY
      hips.rotation.set(0, 0.03 * sw * Math.sin(t * 0.5), 0.025 * sw * Math.sin(t * 0.7) + 0.08 * k)
    }
    if (spine) spine.rotation.set(0.01 * breath + 0.05 * k, 0.02 * sw * Math.sin(t * 0.6 + 1), -0.02 * sw * Math.sin(t * 0.7) - 0.05 * k)
    if (chest) chest.rotation.set(0.025 * breath + 0.04 * k, 0, 0)
    if (neck) neck.rotation.set(0.02 * Math.sin(t * 0.9) + 0.06 * k, 0.05 * sw * Math.sin(t * 0.4 + 2), 0.02 * sw * Math.sin(t * 0.8))
    if (head) head.rotation.set(0.03 * Math.sin(t * 1.1 + 1), 0, 0.03 * sw * Math.sin(t * 0.9 + 1) + 0.05 * k)
    if (L) L.rotation.set(0.05 * Math.sin(t * 0.8), 0, -(armDown + 0.03 * Math.sin(t * 0.8)))
    if (R) R.rotation.set(0.05 * Math.sin(t * 0.8 + 1), 0, armDown + 0.03 * Math.sin(t * 0.8 + 1))
    if (LL) LL.rotation.set(0, -0.25 - 0.05 * breath, -0.05)
    if (RL) RL.rotation.set(0, 0.25 + 0.05 * breath, 0.05)
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
    if (blinkT >= 0) {
      blinkT += dt
      const v = blinkT < 0.08 ? blinkT / 0.08 : Math.max(0, 1 - (blinkT - 0.08) / 0.1)
      const blink = expressionName('blink')
      if (blink) em.setValue(blink, v)
      if (blinkT > 0.2) blinkT = -1
    }
    const m = speaker.level() || fakeMouth
    mouth += (m - mouth) * Math.min(1, dt * 18)
    const aa = expressionName('aa')
    if (aa) em.setValue(aa, mouth)
  }

  function tick(): void {
    if (!running) return
    requestAnimationFrame(tick)
    const dt = Math.min(0.05, clock.getDelta())
    const t = clock.elapsedTime
    if (vrm) {
      if (activeAction && mixer) {
        mixer.update(dt)
      } else {
        poseIdle(t, dt)
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
      tick()
    },

    layout() {
      const w = window.innerWidth
      const h = window.innerHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      // Fit the model's height into the band between the bubble and the panel.
      const band = Math.max(100, h - TOP - BOTTOM)
      const visibleHeight = modelHeight * (h / band) * 1.02
      const dist = visibleHeight / 2 / Math.tan((camera.fov * Math.PI) / 360)
      const centerShift = ((TOP - BOTTOM) / 2 / h) * visibleHeight
      const targetY = modelCenter.y + centerShift + (character.camera?.yOffset ?? 0)
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

    setFakeMouth(v: number) {
      fakeMouth = v
    },

    kick(strength: number) {
      physics.impulse = Math.min(1.5, strength * physics.bounce)
      physics.impulseAt = performance.now()
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
        danceT = 0
        // Prefer a real clip when the character ships one; cycle through them on repeated calls.
        if (mixer && clips.length) {
          clipIndex = (clipIndex + 1) % clips.length
          activeAction?.stop()
          activeAction = mixer.clipAction(clips[clipIndex])
          activeAction.reset().setLoop(THREE.LoopRepeat, Infinity).play()
          return
        }
      }
      if (!on && activeAction) {
        activeAction.stop()
        activeAction = null
        mixer?.stopAllAction()
      }
      if (!on && vrm) vrm.scene.rotation.y = baseRotY
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
