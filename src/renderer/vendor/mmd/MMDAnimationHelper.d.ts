// Minimal typings for the vendored three.js r170 MMDAnimationHelper.
import type { AnimationClip, AnimationMixer, Camera, SkinnedMesh } from 'three'

export class MMDAnimationHelper {
  constructor(params?: { sync?: boolean; afterglow?: number; resetPhysicsOnLoop?: boolean; pmxAnimation?: boolean })
  add(object: SkinnedMesh | Camera, params?: { animation?: AnimationClip | AnimationClip[]; physics?: boolean; warmup?: number; unitStep?: number; maxStepNum?: number; gravity?: unknown; delayTime?: number }): this
  remove(object: SkinnedMesh | Camera): this
  update(delta: number): this
  enable(key: 'animation' | 'ik' | 'grant' | 'physics' | 'cameraAnimation', enabled: boolean): this
  objects: WeakMap<object, { mixer?: AnimationMixer }>
}
