import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRM, VRMExpression, VRMExpressionManager, VRMExpressionMorphTargetBind, VRMHumanoid, type VRMHumanBones } from '@pixiv/three-vrm'

/**
 * A rigged model that is not a VRM (an FBX, Collada or glTF character, as Sketchfab and game rips come) turned into a
 * VRM object, so everything built for VRM characters works on it: the humanoid is mapped from the skeleton's bone names
 * (3ds Max Biped, Mixamo, Unreal, Blender rigify-style), face morphs are wired to VRM expressions when they exist, and a
 * model that faces away from the camera is marked like a VRM 0.x one. Returns null when the skeleton cannot be mapped.
 */

type Role = keyof VRMHumanBones

/** Bone names that are helpers, not the body: twist and corrective bones, IK targets, end nubs. */
const NOT_BODY = /twist|shape|corrective|helper|_end$|nub|roll|^ik|_ik|ctrl|target|pole|bn_|dummy|socket|weapon|prop/i

function core(name: string): { core: string; side: 'left' | 'right' | null } {
  const lower = name.toLowerCase()
  const side = /left|(^|[_.\s:-])l([_.\s:-]|$)|\.l$/.test(lower) ? 'left' : /right|(^|[_.\s:-])r([_.\s:-]|$)|\.r$/.test(lower) ? 'right' : null
  const c = lower
    .replace(/^(?:mixamorig\d*:|bip0*1|bip|j_bip_[clr]_|def-|cc_base_|rig_|armature[|:])/, '')
    .replace(/left|right/g, '')
    .replace(/(^|[_.\s:-])[lr](?=[_.\s:-]|$)/g, '$1')
    .replace(/[_.\s:-]+/g, '')
  return { core: c, side }
}

const ROLES: [RegExp, string][] = [
  [/^(?:pelvis|hips?)$/, 'hips'],
  [/^neck\d*$/, 'neck'],
  [/^head$/, 'head'],
  [/^(?:clavicle|shoulder)$/, 'Shoulder'],
  [/^(?:upperarm|arm|uparm)$/, 'UpperArm'],
  [/^(?:forearm|lowerarm)$/, 'LowerArm'],
  [/^hand$/, 'Hand'],
  [/^(?:thigh|upleg|upperleg)$/, 'UpperLeg'],
  [/^(?:calf|leg|lowerleg|shin)$/, 'LowerLeg'],
  [/^foot$/, 'Foot'],
  [/^toes?\d*$/, 'Toes']
]

function depth(o: THREE.Object3D): number {
  let d = 0
  for (let p = o.parent; p; p = p.parent) d++
  return d
}

/** Maps the skeleton to VRM human bones; the shallowest match wins when a name repeats. */
export function mapHumanoid(root: THREE.Object3D): VRMHumanBones | null {
  const found: Partial<Record<Role, THREE.Object3D>> = {}
  const spines: THREE.Object3D[] = []
  const bones: THREE.Object3D[] = []
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone || o.type === 'Bone') bones.push(o)
  })
  bones.sort((a, b) => depth(a) - depth(b))
  for (const b of bones) {
    if (NOT_BODY.test(b.name)) continue
    const { core: c, side } = core(b.name)
    if (/^(?:spine\d*|chest|upperchest)$/.test(c)) {
      spines.push(b)
      continue
    }
    for (const [re, role] of ROLES) {
      if (!re.test(c)) continue
      const key = (role[0] === role[0].toUpperCase() ? (side ? `${side}${role}` : null) : role) as Role | null
      if (key && !found[key]) found[key] = b
      break
    }
  }
  // Spine chain between the hips and the neck, in order: spine, chest, upper chest.
  const hips = found.hips
  const chain = spines.filter((s) => {
    for (let p = s.parent; p; p = p.parent) if (p === hips) return true
    return false
  })
  if (chain[0]) found.spine = chain[0]
  if (chain[1]) found.chest = chain[1]
  if (chain.length >= 3) found.upperChest = chain[chain.length - 1]
  const required: Role[] = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']
  const missing = required.filter((r) => !found[r])
  if (missing.length) {
    console.warn(`[rig] could not map: ${missing.join(', ')}`)
    return null
  }
  const out: Partial<VRMHumanBones> = {}
  for (const [k, node] of Object.entries(found)) (out as Record<string, { node: THREE.Object3D }>)[k] = { node: node as THREE.Object3D }
  console.log(`[rig] mapped ${Object.keys(out).length} bones: ${Object.entries(found).map(([k, n]) => `${k}=${(n as THREE.Object3D).name}`).join(' ')}`)
  return out as VRMHumanBones
}

/** Face morphs, by the names rips and Sketchfab models tend to use, as VRM expression names. */
const MORPHS: [string, RegExp][] = [
  ['blink', /^(?:blink|eyes?_?close|eyeclose|both_?eyes?_?close|eye_?blink)$/i],
  ['aa', /^(?:aa?|mouth_?open|jaw_?open|mouth_?a|vrc\.v_aa|viseme_?aa|あ)$/i],
  ['happy', /^(?:smile|happy|joy|mouth_?smile|fun)$/i],
  ['angry', /^(?:angry|anger|mad)$/i],
  ['sad', /^(?:sad|sorrow|cry)$/i],
  ['surprised', /^(?:surprised?|shock)$/i]
]

function expressionsFrom(root: THREE.Object3D): VRMExpressionManager | undefined {
  const manager = new VRMExpressionManager()
  const meshes: THREE.Mesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.morphTargetDictionary) meshes.push(m)
  })
  let any = false
  for (const [expr, re] of MORPHS) {
    const binds: { mesh: THREE.Mesh; index: number }[] = []
    for (const m of meshes) for (const [name, index] of Object.entries(m.morphTargetDictionary ?? {})) if (re.test(name)) binds.push({ mesh: m, index })
    if (!binds.length) continue
    const e = new VRMExpression(expr)
    for (const b of binds) e.addBind(new VRMExpressionMorphTargetBind({ primitives: [b.mesh], index: b.index, weight: 1 }))
    manager.registerExpression(e)
    any = true
  }
  if (meshes.length) console.log(`[rig] face morphs: ${any ? manager.expressions.map((e) => e.expressionName).join(', ') : 'none usable'} (${meshes.reduce((n, m) => n + Object.keys(m.morphTargetDictionary ?? {}).length, 0)} morphs)`)
  return any ? manager : undefined
}

/** Texture paths inside FBX and Collada files point at the author's disk; look for the same file name in textures/. */
function manager(base: string): THREE.LoadingManager {
  const m = new THREE.LoadingManager()
  m.setURLModifier((url) => {
    if (!/\.(png|jpe?g|tga|bmp|webp|dds|tiff?)$/i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url
    const file = decodeURIComponent(url.split(/[\\/]/).pop() ?? url)
    return `${base}textures/${encodeURIComponent(file.replace(/\.(tga|dds|bmp|tiff?)$/i, '.png'))}`
  })
  // FBXLoader skips .tga / .dds unless a loader is registered for them; the URL above already points at the PNG.
  const png = new THREE.TextureLoader(m)
  m.addHandler(/\.(tga|dds|bmp|tiff?)$/i, png)
  return m
}

export async function loadRig(url: string, hide: string[] = []): Promise<{ vrm: VRM; armsDown: number; jaw: THREE.Object3D | null } | null> {
  // Models come as <id>/source/model.fbx with <id>/textures/; or flat, with textures/ beside the file.
  const base = url.replace(/[^/]*$/, '').replace(/source\/$/, '')
  const mgr = manager(base)
  // Textures keep loading after the model resolves; material fixes below need their sizes.
  const texturesDone = new Promise<void>((resolve) => {
    mgr.onLoad = () => resolve()
    setTimeout(resolve, 10_000)
  })
  let loaded: THREE.Object3D
  if (/\.fbx$/i.test(url)) loaded = await new FBXLoader(mgr).loadAsync(url)
  else if (/\.dae$/i.test(url)) loaded = (await new ColladaLoader(mgr).loadAsync(url))?.scene as unknown as THREE.Object3D
  else loaded = (await new GLTFLoader(mgr).loadAsync(url)).scene
  // A clean parent: Z-up files come with their root rotated upright, and turning that root toward where she walks
  // would roll her over instead.
  const scene = new THREE.Group()
  scene.add(loaded)
  // Parts named in character.json → hide (a rip's broken wings, a prop) never show, and do not count for framing.
  if (hide.length) {
    const doomed: THREE.Object3D[] = []
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => x.name)
      if (hide.some((h) => [m.name, ...mats].some((n) => n.toLowerCase().includes(h.toLowerCase())))) doomed.push(m)
    })
    for (const d of doomed) d.removeFromParent()
    console.log(`[rig] hid ${doomed.length} part(s): ${doomed.map((d) => d.name).join(', ')}`)
  }
  await texturesDone
  // Lace, hair and lashes are textures with transparent holes; drawn solid, the holes smear into stripes. Cut them out
  // where the texture is see-through (opaque textures are unaffected), from both sides for thin shells.
  scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
      // A placeholder colour texture (a few pixels, as rips sometimes ship for hair) would cut the whole part away.
      const img = mat.map?.image as { width?: number } | undefined
      if (mat.map && mat.alphaMap && img?.width !== undefined && img.width <= 64) mat.map = null
      if (/lace|stocking|tights|sheer|veil/i.test(mat.name)) {
        // Sheer fabric: see-through, not a solid painted layer (solid, its pattern reads as stripes).
        mat.transparent = true
        mat.opacity = 0.45
        mat.depthWrite = false
        mat.alphaTest = 0.05
        mat.side = THREE.DoubleSide
        mat.needsUpdate = true
        continue
      }
      if (!mat.map && !mat.alphaMap) continue
      mat.alphaTest = 0.4
      mat.transparent = false
      if (mat.alphaMap || /lace|hair|lash|brow|glass|cover|veil|fur/i.test(mat.name)) mat.side = THREE.DoubleSide
      mat.needsUpdate = true
    }
  })
  scene.updateMatrixWorld(true)
  const bones = mapHumanoid(scene)
  if (!bones) return null

  // Which way does it face? A VRM 1 model faces +Z with its left arm at +X; one that faces away is turned around
  // and posed with mirrored axes, as VRM 0.x models are.
  const p = (r: Role): THREE.Vector3 => ((bones[r] as { node: THREE.Object3D }).node as THREE.Object3D).getWorldPosition(new THREE.Vector3())
  const facesAway = p('leftUpperArm').x < p('rightUpperArm').x
  // How far the arms already hang in the rest pose (A-pose rips), so "arms down" does not push them into the body.
  const dir = p('leftLowerArm').sub(p('leftUpperArm'))
  const restDown = Math.atan2(-dir.y, Math.abs(dir.x) + 1e-6)
  const armsDown = Math.max(0.05, 1.18 - restDown)

  const humanoid = new VRMHumanoid(bones, { autoUpdateHumanBones: true })
  scene.add(humanoid.normalizedHumanBonesRoot)
  const meta = { metaVersion: facesAway ? '0' : '1', name: url.split('/').pop() ?? 'model' } as unknown as VRM['meta']
  const vrm = new VRM({ scene, meta, humanoid, expressionManager: expressionsFrom(scene) })
  if (facesAway) scene.rotation.y = Math.PI
  let jaw: THREE.Object3D | null = null
  scene.traverse((o) => {
    o.frustumCulled = false
    if (!jaw && /jaw/i.test(o.name) && !NOT_BODY.test(o.name)) jaw = o
  })
  console.log(`[rig] faces ${facesAway ? 'away (turned around)' : 'the camera'}, arms rest ${(restDown * 57.3).toFixed(0)}° down${jaw ? `, jaw ${(jaw as THREE.Object3D).name}` : ''}`)
  return { vrm, armsDown, jaw }
}
