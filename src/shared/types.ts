export type Emotion = 'neutral' | 'happy' | 'flirty' | 'surprised' | 'annoyed' | 'angry' | 'sad' | 'smug' | 'shy'
export const EMOTIONS: Emotion[] = ['neutral', 'happy', 'flirty', 'surprised', 'annoyed', 'angry', 'sad', 'smug', 'shy']

export type AvatarCommand = 'dance' | 'dance_slow' | 'spin' | 'stop_dancing' | 'next_outfit'
export const AVATAR_COMMANDS: AvatarCommand[] = ['dance', 'dance_slow', 'spin', 'stop_dancing', 'next_outfit']
export type DanceStyle = 'groove' | 'slow' | 'spin'

/**
 * Things she can do on the computer, beyond talking. `claude` hands a job to Claude Code (the coding agent
 * installed on the machine) in a project folder; `claude_resume` continues an earlier session there.
 */
export type ToolName = 'claude' | 'claude_resume' | 'open' | 'tasks' | 'cancel' | 'browse' | 'page' | 'chrome'
export const TOOL_NAMES: ToolName[] = ['claude', 'claude_resume', 'open', 'tasks', 'cancel', 'browse', 'page', 'chrome']
/** The ones her brain may pick. `chrome` (tab and page verbs) only ever comes from the spoken-command router. */
export const BRAIN_TOOLS: ToolName[] = ['claude', 'claude_resume', 'open', 'tasks', 'cancel', 'browse', 'page']
export interface ToolCall {
  name: ToolName
  /** the instruction for Claude, the browsing goal, the question about the page, the thing to open, or a chrome verb */
  input: string
  /** project or folder they named ("the vlog", "deskmate", a path), if any */
  dir?: string | null
}

export interface Reply {
  say: string
  emotion: Emotion
  /** false = she looked and decided to stay quiet */
  speak: boolean
  remember: { text: string; importance: number }[]
  /** something she decided to do with her body (3D characters) */
  action?: AvatarCommand
  /** something she decided to do on the computer */
  tool?: ToolCall
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
  source: 'chat' | 'observe' | 'touch' | 'task'
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

/** A job she handed to Claude Code. */
export interface TaskInfo {
  id: string
  title: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  cwd: string
  startedAt: number
  endedAt?: number
  /** Claude Code session id, so the job can be resumed */
  sessionId?: string
  /** full transcript of the run, for the curious */
  logPath: string
}

export interface ProjectInfo {
  name: string
  path: string
}

export interface AppConfig {
  character: CharacterConfig
  characters: { id: string; name: string }[]
  mode: BrainMode
  modelName: string
  watchDir: string | null
  watching: boolean
  watchIntervalSec: number
  /** hands-free listening is on */
  listening: boolean
  /** a local speech-to-text server is configured (DESKMATE_STT) */
  ears: boolean
  /** Claude Code was found on this machine */
  hands: boolean
  /** the folder Claude jobs run in unless they name another */
  project: ProjectInfo | null
  /** the mic stays open while she talks, and talking over her stops her (DESKMATE_BARGE_IN, default on) */
  bargeIn: boolean
  /** the name she waits for before she answers (DESKMATE_WAKE_MODE=word), or null when she answers everything */
  wakeWord: string | null
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
  /** hands-free listening on/off; resolves to the new state (false when the mic was refused) */
  setListening(on: boolean): Promise<boolean>
  /** one utterance from the mic, 16 kHz mono 16-bit WAV; bargedIn when it began while she was talking */
  heard(wav: ArrayBuffer, ms: number, bargedIn?: boolean): Promise<void>
  /** she started or stopped talking (the main process times her attention window from it) */
  speaking(on: boolean): void
  onReply(cb: (payload: ReplyPayload) => void): void
  onStatus(cb: (text: string) => void): void
  onCommand(cb: (command: AvatarCommand) => void): void
  onListen(cb: (on: boolean) => void): void
}

declare global {
  interface Window {
    deskmate: DeskmateApi
  }
}
