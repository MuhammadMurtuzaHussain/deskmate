export type Emotion = 'neutral' | 'happy' | 'flirty' | 'surprised' | 'annoyed' | 'angry' | 'sad' | 'smug' | 'shy'
export const EMOTIONS: Emotion[] = ['neutral', 'happy', 'flirty', 'surprised', 'annoyed', 'angry', 'sad', 'smug', 'shy']

export interface Reply {
  say: string
  emotion: Emotion
  /** false = she looked and decided to stay quiet */
  speak: boolean
  remember: { text: string; importance: number }[]
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
  model: string
  expressions: Record<Emotion, string>
  motions: { idle: string; react: string }
  voice: CharacterVoice
  /** sway: idle body motion amplitude; bounce: impulse strength on taps/replies. Both feed the model's own physics rig. */
  physics?: { sway?: number; bounce?: number }
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
}

declare global {
  interface Window {
    deskmate: DeskmateApi
  }
}
