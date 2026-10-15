export type Emotion = 'neutral' | 'happy' | 'flirty' | 'surprised' | 'annoyed' | 'angry' | 'sad' | 'smug' | 'shy'
export const EMOTIONS: Emotion[] = ['neutral', 'happy', 'flirty', 'surprised', 'annoyed', 'angry', 'sad', 'smug', 'shy']

export type AvatarCommand = 'dance' | 'dance_slow' | 'spin' | 'stop_dancing' | 'next_outfit'
export const AVATAR_COMMANDS: AvatarCommand[] = ['dance', 'dance_slow', 'spin', 'stop_dancing', 'next_outfit']
export type DanceStyle = 'groove' | 'slow' | 'spin'

export interface Reply {
  say: string
  emotion: Emotion
  /** false = she looked and decided to stay quiet */
  speak: boolean
  remember: { text: string; importance: number }[]
  /** something she decided to do with her body (3D characters) */
  action?: AvatarCommand
}

/** An outfit is another model file, and/or parts to hide, and/or materials to recolour. */
export interface Outfit {
  name: string
  model?: string
  /** material/mesh name fragments to hide … */
  hide?: string[]
  /** … except these (applied after hide) */
  show?: string[]
  tint?: Record<string, string>
}

export interface Audio {
  bytes: Uint8Array
  mime: string
}

export interface ReplyPayload {
  reply: Reply
  audio: Audio | null
  source: 'chat' | 'observe' | 'touch'
}

export interface CharacterVoice {
  /** Kokoro preset for the local server (af_heart, af_bella, ...) */
  kokoro?: string
  speed?: number
  /** ElevenLabs voice id */
  elevenlabs?: string
  /** macOS `say` voice */
  say?: string
}

export interface CharacterConfig {
  id: string
  name: string
  /** live2d (default): .model3.json · vrm: .vrm · mmd: .pmx · mesh: static .obj/.glb (no animation) */
  renderer?: 'live2d' | 'vrm' | 'mmd' | 'mesh'
  model: string
  expressions: Record<Emotion, string>
  motions: { idle: string; react: string }
  voice: CharacterVoice
  /** sway: idle body motion amplitude; bounce: impulse strength on taps/replies. Both feed the model's own physics rig. */
  physics?: { sway?: number; bounce?: number; simulate?: boolean }
  /** 3D only */
  outfits?: Outfit[]
  /** 3D only: .vrma (VRM) or .vmd (MMD) clips she can dance to; without any she uses the built-in groove */
  animations?: { name: string; file: string }[]
  camera?: { fov?: number; yOffset?: number }
  idle?: { armsDown?: number }
  dance?: { bpm?: number }
  /** MMD only: emotion → morph names joined with '+' (defaults cover the usual Japanese and ARKit names) */
  morphs?: Partial<Record<Emotion | 'mouth' | 'blink', string>>
  /** shown in the character list and docs */
  license?: string
}

export type BrainMode = 'gemini' | 'ollama' | 'demo'

export interface Touch {
  kind: 'tap' | 'drag'
  area: 'head' | 'chest' | 'body' | 'legs'
}

export interface AppConfig {
  character: CharacterConfig
  characters: { id: string; name: string }[]
  mode: BrainMode
  modelName: string
  watchDir: string | null
  watching: boolean
  watchIntervalSec: number
}

export interface DeskmateApi {
  getConfig(): Promise<AppConfig>
  send(text: string): Promise<Reply>
  lookNow(): Promise<void>
  toggleWatch(): Promise<boolean>
  setIgnoreMouse(ignore: boolean): void
  moveBy(dx: number, dy: number): void
  react(touch: Touch): Promise<void>
  setKey(key: string): Promise<{ ok: boolean; error?: string }>
  setCharacter(id: string): Promise<void>
  onReply(cb: (payload: ReplyPayload) => void): void
  onStatus(cb: (text: string) => void): void
  onCommand(cb: (command: AvatarCommand) => void): void
}

declare global {
  interface Window {
    deskmate: DeskmateApi
  }
}
