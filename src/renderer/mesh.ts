import * as THREE from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { CharacterConfig, DanceStyle, Emotion } from '../shared/types'
import { resolveAsset } from './assets'
import type { Avatar, Bounds } from './avatar'
import { createSpeaker } from './audio'

const TOP = 92
const BOTTOM = 100

/**
 * A static 3D model (.obj with .mtl, or .glb/.gltf) as a companion: no skeleton, no face, so she moves as a
 * whole (idle bob and sway, a bouncing spin for "dance") and speech is bubble plus voice only.
 */
export function createMeshAvatar(canvas: HTMLCanvasElement, character: CharacterConfig): Avatar {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setClearColor(0x000000, 0)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(character.camera?.fov ?? 24, 1, 0.05, 5000)
  scene.add(new THREE.AmbientLight(0xffffff, 1.2))
  const key = new THREE.DirectionalLight(0xffffff, 2.0)
  key.position.set(1, 2.5, 3)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffe6f2, 0.7)
  fill.position.set(-2, 1, 1)
  scene.add(fill)
  const root = new THREE.Group()
  scene.add(root)
  const speaker = createSpeaker()
  const timer = new THREE.Timer()
  let modelHeight = 1
  let modelCenter = new THREE.Vector3()
  let baseY = 0 // moves her so her centre sits on the origin
  let running = true
  let dancing = false
  let danceT = 0
  let fakeMouth = 0
  const physics = { sway: character.physics?.sway ?? 1, bounce: character.physics?.bounce ?? 1.2, impulse: 0, impulseAt: 0 }

  async function load(url: string): Promise<THREE.Object3D> {
    if (/\.(glb|gltf)$/i.test(url)) {
      const gltf = await new GLTFLoader().loadAsync(url)
      return gltf.scene
    }
    const base = url.slice(0, url.lastIndexOf('/') + 1)
    const mtlUrl = url.replace(/\.obj$/i, '.mtl')
    const objLoader = new OBJLoader()
    try {
      const materials = await new MTLLoader().setResourcePath(base).setPath(base).loadAsync(mtlUrl.slice(base.length))
      materials.preload()
      objLoader.setMaterials(materials)
    } catch (err) {
      console.warn('[mesh] no .mtl, using default material', err)
    }
    return objLoader.loadAsync(url)
  }

  function tick(): void {
    if (!running) return
    requestAnimationFrame(tick)
    timer.update()
    const dt = Math.min(0.05, timer.getDelta())
    const t = timer.getElapsed()
    let k = 0
    if (physics.impulse > 0) {
      const s = (performance.now() - physics.impulseAt) / 1000
      k = physics.impulse * Math.exp(-s * 2.4) * Math.sin(s * Math.PI * 2 * 2.2)
      if (s > 3) physics.impulse = 0
    }
    if (dancing) {
      danceT += dt
      const bps = (character.dance?.bpm ?? 120) / 60
      const beat = danceT * bps * Math.PI
      root.position.y = baseY + Math.abs(Math.sin(beat)) * modelHeight * 0.04
      root.rotation.set(0.04 * Math.sin(beat), danceT * 1.2, 0.08 * Math.sin(beat / 2))
    } else {
      root.position.y = baseY + Math.sin(t * 1.2) * modelHeight * 0.004 * physics.sway
      root.rotation.set(0.01 * Math.sin(t * 0.9) + 0.03 * k, 0.06 * physics.sway * Math.sin(t * 0.5) + 0.1 * k, 0.015 * Math.sin(t * 0.7) + 0.04 * k)
    }
    renderer.render(scene, camera)
  }

  const avatar: Avatar = {
    kind: 'mesh',
    capabilities: { dance: true, outfits: false },
    async load() {
      const obj = await load(resolveAsset(character.model))
      obj.traverse((o) => {
        o.frustumCulled = false
        const m = o as THREE.Mesh
        if (m.isMesh) {
          const mats = Array.isArray(m.material) ? m.material : [m.material]
          for (const mat of mats) (mat as THREE.MeshStandardMaterial).side = THREE.DoubleSide
        }
      })
      const box = new THREE.Box3().setFromObject(obj)
      modelHeight = Math.max(0.01, box.max.y - box.min.y)
      modelCenter = box.getCenter(new THREE.Vector3())
      // Centre her on the origin so the group can rotate around her.
      obj.position.sub(new THREE.Vector3(modelCenter.x, 0, modelCenter.z))
      root.add(obj)
      baseY = -modelCenter.y
      root.position.y = baseY
      modelCenter = new THREE.Vector3(0, 0, 0)
      console.log(`[mesh] height ${modelHeight.toFixed(2)} baseY ${baseY.toFixed(2)}`)
      avatar.layout()
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
      const targetY = centerShift + (character.camera?.yOffset ?? 0) * modelHeight
      camera.position.set(0, targetY, dist)
      camera.lookAt(0, targetY, 0)
      camera.updateProjectionMatrix()
    },
    getBounds(): Bounds | null {
      const box = new THREE.Box3().setFromObject(root)
      if (box.isEmpty()) return null
      const w = window.innerWidth
      const h = window.innerHeight
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      const v = new THREE.Vector3()
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        v.set(x, y, z).project(camera)
        const sx = ((v.x + 1) / 2) * w
        const sy = ((1 - v.y) / 2) * h
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy)
      }
      const cx = (minX + maxX) / 2
      const halfW = ((maxX - minX) / 2) * 0.55
      return { x: cx - halfW, y: minY, width: halfW * 2, height: maxY - minY }
    },
    setExpression(_emotion: Emotion) {
      /* no face */
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
      /* nothing to aim */
    },
    dance(on: boolean, _style: DanceStyle = 'groove') {
      dancing = on
      if (on) danceT = 0
      else root.rotation.set(0, 0, 0)
    },
    isDancing: () => dancing,
    nextOutfit: async () => null,
    destroy() {
      running = false
      speaker.stop()
      renderer.dispose()
    }
  }
  void fakeMouth
  return avatar
}
