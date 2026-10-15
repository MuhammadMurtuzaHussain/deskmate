// Minimal typings for the vendored three.js r170 MMDLoader.
import type { AnimationClip, Camera, Loader, LoadingManager, SkinnedMesh } from 'three'

export class MMDLoader extends Loader<SkinnedMesh> {
  constructor(manager?: LoadingManager)
  setAnimationPath(path: string): this
  load(url: string, onLoad: (mesh: SkinnedMesh) => void, onProgress?: (e: ProgressEvent) => void, onError?: (e: unknown) => void): void
  loadAsync(url: string, onProgress?: (e: ProgressEvent) => void): Promise<SkinnedMesh>
  loadAnimation(url: string | string[], object: SkinnedMesh | Camera, onLoad: (clip: AnimationClip) => void, onProgress?: (e: ProgressEvent) => void, onError?: (e: unknown) => void): void
}
