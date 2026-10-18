export type Emotion = 'neutral' | 'happy' | 'flirty' | 'surprised' | 'annoyed' | 'angry' | 'sad' | 'smug' | 'shy'
export const EMOTIONS: Emotion[] = ['neutral', 'happy', 'flirty', 'surprised', 'annoyed', 'angry', 'sad', 'smug', 'shy']

export type AvatarCommand = 'dance' | 'dance_slow' | 'spin' | 'stop_dancing' | 'next_outfit' | BodyCommand
/** Moves that take her window somewhere: the main process handles these, the renderer only animates them. */
export type BodyCommand = 'come_here' | 'go_home' | 'sit' | 'stand' | 'sleep' | 'wake' | 'wander' | 'stay'
export const BODY_COMMANDS: BodyCommand[] = ['come_here', 'go_home', 'sit', 'stand', 'sleep', 'wake', 'wander', 'stay']
export const AVATAR_COMMANDS: AvatarCommand[] = ['dance', 'dance_slow', 'spin', 'stop_dancing', 'next_outfit', ...BODY_COMMANDS]
export type DanceStyle = 'groove' | 'slow' | 'spin'

/**
 * Things she can do on the computer, beyond talking. `claude` hands a job to Claude Code (the coding agent
 * installed on the machine) in a project folder; `claude_resume` continues an earlier session there.
 */
export type ToolName = 'claude' | 'claude_resume' | 'open' | 'tasks' | 'cancel' | 'browse' | 'page' | 'chrome' | 'app' | 'computer' | 'find'
export const TOOL_NAMES: ToolName[] = ['claude', 'claude_resume', 'open', 'tasks', 'cancel', 'browse', 'page', 'chrome', 'app', 'computer', 'find']
/** Only a Claude brain may pick `computer` (a multi-step agent run across desktop apps); small models would overreach. */
export const CLAUDE_ONLY_TOOLS: ToolName[] = ['computer']
/** The ones her brain may pick. `chrome` (tab and page verbs) only ever comes from the spoken-command router. */
export const BRAIN_TOOLS: ToolName[] = ['claude', 'claude_resume', 'open', 'tasks', 'cancel', 'browse', 'page', 'app', 'find']
export interface ToolCall {
  name: ToolName
  /** the instruction for Claude, the browsing goal, the question about the page, the thing to open, a chrome verb,
   * or for `app` the request in their words ("Discord: tell sam I'm running late") */
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

/** What her body is doing on the desktop, beyond idle and dancing. */
export interface BodyState {
  mode: 'idle' | 'walk' | 'point' | 'sit' | 'sleep'
  /** walking direction on screen: -1 left, 1 right */
  facing?: -1 | 1
  /** what she points at, in CSS pixels relative to her window (may lie outside it) */
  target?: { x: number; y: number }
}

/** A short one-off movement played over whatever she is doing: getting up from a seat, or an idle touch. */
export interface Gesture {
  kind: 'stretch' | 'yawn' | 'glance'
  /** for a glance: where to look, in CSS pixels relative to her window */
  target?: { x: number; y: number }
}

/** Where parts of her are inside her window, in CSS pixels; the main process places the window by them. */
export interface Anchors {
  head: { x: number; y: number }
  shoulder: { x: number; y: number }
  hips: { x: number; y: number }
  feet: { x: number; y: number }
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
  /** zoom: 1 fits her whole body; above 1 frames her closer (she stays anchored at the head, the legs crop first) */
  camera?: { fov?: number; yOffset?: number; zoom?: number }
  idle?: { armsDown?: number }
  dance?: { bpm?: number }
  /** MMD only: emotion → morph names joined with '+' (defaults cover the usual Japanese and ARKit names) */
  morphs?: Partial<Record<Emotion | 'mouth' | 'blink', string>>
  /** shown in the character list and docs */
  license?: string
  /** 3D: meshes or materials to leave out at load, by name fragment (a rip's broken wings, a prop) */
  hide?: string[]
  /** Live2D: expressions that are really poses (VTube Studio toggles), layered on top of her emotion */
  poses?: { sit?: string; point?: string; sleep?: string; dance?: string[] }
}

export type BrainMode = 'gemini' | 'ollama' | 'anthropic' | 'demo'

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
  /** auto (default): the panel tucks away until you hover over her · always: it stays (DESKMATE_PANEL) */
  panel?: 'auto' | 'always'
  /** the global shortcut for the command bar, as registered (null when it could not be) */
  commandShortcut?: string | null
}

/** What the first-run window shows: her brain, her voice, and what macOS lets her do. */
export interface SetupState {
  platform: string
  brain: {
    mode: BrainMode
    modelName: string
    ollama: { running: boolean; models: string[]; current: string }
    geminiKey: boolean
    claude: { key: boolean; model: string; effort?: 'low' | 'medium' | 'high'; models: { id: string; name: string }[]; error?: string }
  }
  voice: { provider: 'local' | 'elevenlabs' | 'system'; localServer: boolean }
  /** granted / denied / not-determined / restricted / unknown, as macOS reports them; keys is null without the helper */
  permissions: { microphone: string; screen: string; keys: boolean | null }
  /** phone remote (Telegram); missing from an older main process */
  remote?: {
    token: boolean
    /** the token comes from DESKMATE_TELEGRAM_TOKEN in .env */
    fromEnv: boolean
    /** the bot's @name, once Telegram answered */
    bot: string | null
    on: boolean
    /** who controls her from their phone */
    paired: string | null
    /** a /start waiting for a yes on the Mac */
    request: { name: string; code: string } | null
    error: string | null
  }
}

export type RemoteAction = 'allow' | 'refuse' | 'forget' | 'on' | 'off'

export type PermissionKind = 'microphone' | 'screen' | 'keys'

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
  // Optional: a renderer hot-reloaded in development can run against an older preload that lacks these.
  /** command bar: close it */
  hideBar?(): void
  /** command bar: every line she says, while the bar is open */
  onLine?(cb: (say: string) => void): void
  /** first-run window */
  getSetup?(): Promise<SetupState>
  useOllama?(model: string): Promise<{ ok: boolean; error?: string }>
  useGemini?(key: string): Promise<{ ok: boolean; error?: string }>
  /** checks the key (when given), lists its models, and switches her brain to Claude with that model */
  useClaude?(key: string | null, model: string, effort?: 'low' | 'medium' | 'high'): Promise<{ ok: boolean; error?: string; models?: { id: string; name: string }[] }>
  allow?(kind: PermissionKind): Promise<void>
  finishSetup?(): Promise<void>
  openSetup?(): void
  /** her body on the desktop: walking, pointing, sitting, sleeping */
  onBody?(cb: (state: BodyState) => void): void
  /** a stretch, a yawn, a glance at the pointer */
  onGesture?(cb: (gesture: Gesture) => void): void
  reportAnchors?(anchors: Anchors): void
  /** phone remote: checks a bot token with Telegram and turns the remote on with it */
  useTelegram?(token: string): Promise<{ ok: boolean; error?: string; bot?: string }>
  remote?(action: RemoteAction): Promise<void>
  /** the setup window's state changed in the main process (a pairing request came in, say) */
  onSetupChanged?(cb: () => void): void
}

declare global {
  interface Window {
    deskmate: DeskmateApi
  }
}
