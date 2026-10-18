export type Emotion = 'neutral' | 'happy' | 'flirty' | 'surprised' | 'annoyed' | 'angry' | 'sad' | 'smug' | 'shy'
export const EMOTIONS: Emotion[] = ['neutral', 'happy', 'flirty', 'surprised', 'annoyed', 'angry', 'sad', 'smug', 'shy']

export type AvatarCommand = 'dance' | 'dance_slow' | 'spin' | 'stop_dancing' | 'next_outfit' | BodyCommand
/** Moves that take her window somewhere: the main process handles these, the renderer only animates them. */
export type BodyCommand = 'come_here' | 'go_home' | 'sit' | 'lie' | 'peek' | 'stand' | 'sleep' | 'wake' | 'wander' | 'stay'
export const BODY_COMMANDS: BodyCommand[] = ['come_here', 'go_home', 'sit', 'lie', 'peek', 'stand', 'sleep', 'wake', 'wander', 'stay']
export const AVATAR_COMMANDS: AvatarCommand[] = ['dance', 'dance_slow', 'spin', 'stop_dancing', 'next_outfit', ...BODY_COMMANDS]
export type DanceStyle = 'groove' | 'slow' | 'spin'

/**
 * Things she can do on the computer, beyond talking. `claude` hands a job to Claude Code (the coding agent
 * installed on the machine) in a project folder; `claude_resume` continues an earlier session there.
 */
export type ToolName = 'claude' | 'claude_resume' | 'open' | 'tasks' | 'cancel' | 'browse' | 'page' | 'chrome' | 'app' | 'computer' | 'find' | 'plan' | 'remind'
export const TOOL_NAMES: ToolName[] = ['claude', 'claude_resume', 'open', 'tasks', 'cancel', 'browse', 'page', 'chrome', 'app', 'computer', 'find', 'plan', 'remind']
/** Only a Claude brain may pick `computer` (a multi-step agent run across desktop apps); small models would overreach. */
export const CLAUDE_ONLY_TOOLS: ToolName[] = ['computer']
/** The ones her brain may pick. `chrome` (tab and page verbs) only ever comes from the spoken-command router. */
export const BRAIN_TOOLS: ToolName[] = ['claude', 'claude_resume', 'open', 'tasks', 'cancel', 'browse', 'page', 'app', 'find', 'plan', 'remind']
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

/** Who does a step of a plan. */
export type PlanWorker = 'computer' | 'browse' | 'claude' | 'app' | 'skill' | 'find' | 'open' | 'say' | 'ask'

export interface PlanStep {
  /** short, shown on the plan card ("Find the March invoice") */
  text: string
  worker: PlanWorker
  /** the self-contained instruction that worker gets */
  input: string
  /** Claude Code: the project folder they named */
  dir?: string | null
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  /** what came of it, in a sentence or two */
  result?: string
}

/** A bigger goal broken into steps she works through one at a time, after a go. */
export interface Plan {
  id: string
  goal: string
  title: string
  steps: PlanStep[]
  status: 'draft' | 'running' | 'paused' | 'done' | 'stopped'
  /** index of the step running or next up */
  current: number
  createdAt: number
  /** why it paused, or how it ended */
  note?: string
  /** 'skill': not a plan but a skill she wrote, shown on the same card with Keep it / Throw away */
  /** skill: a skill she wrote, waiting for a yes · brief: the morning brief (it only closes) */
  kind?: 'skill' | 'brief'
}

/** What her body is doing on the desktop, beyond idle and dancing. */
export interface BodyState {
  /** lie: on her front along a window's top edge · peek: mostly off a screen edge, leaning back in */
  mode: 'idle' | 'walk' | 'point' | 'sit' | 'lie' | 'peek' | 'sleep'
  /** walking direction on screen: -1 left, 1 right; for peek, the edge she hides behind (-1 left, 1 right) */
  facing?: -1 | 1
  /** what she points at, in CSS pixels relative to her window (may lie outside it) */
  target?: { x: number; y: number }
  /** a Claude Code job has been running a while: she slumps, sighs and fidgets */
  bored?: boolean
}

/** A short one-off movement played over whatever she is doing: getting up from a seat, or an idle touch. */
export interface Gesture {
  /** swat: a quick reach for the pointer hovering by her head · sigh: a bored slump */
  kind: 'stretch' | 'yawn' | 'glance' | 'swat' | 'sigh'
  /** for a glance or a swat: where, in CSS pixels relative to her window */
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
  motions: { idle: string; react: string; /** Live2D: a motion group that loops while she walks */ walk?: string }
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
  poses?: { sit?: string; /** lying on a window (falls back to sit) */ lie?: string; point?: string; sleep?: string; dance?: string[]; /** always on (e.g. a model's own watermark-off toggle) */ base?: string[] }
  /** set by "Add a character": the file it came from, and when */
  imported?: { from: string; at: string }
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

/** A card in Setup → Characters. */
export interface CharacterCard {
  id: string
  name: string
  renderer: NonNullable<CharacterConfig['renderer']>
  /** added in Setup (lives under <user data>/character), so it can be removed */
  userAdded: boolean
  active: boolean
}

/** What Setup edits for one character. */
export interface CharacterDetails {
  id: string
  name: string
  renderer: NonNullable<CharacterConfig['renderer']>
  voice: string
  speed: number
  zoom: number
  persona: string
  license: string | null
  /** the licence keeps the avatar to its author (VRM metadata), as far as Deskmate can tell */
  restricted: boolean
  userAdded: boolean
  /** the persona shown is Setup's own copy (a shipped one can go back to its original) */
  personaEdited: boolean
}

export interface CharacterPatch {
  voice?: string
  speed?: number
  zoom?: number
  /** '' goes back to the character's own persona */
  persona?: string
}

export interface AppConfig {
  character: CharacterConfig
  characters: { id: string; name: string; renderer?: CharacterConfig['renderer']; userAdded?: boolean }[]
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
  /** the chat apps she can be reached through; missing from an older main process */
  channels?: ChannelsSetupState
  /** what she tells you about on her own; missing from an older main process */
  notices?: NoticeState
  /** tool servers from <user data>/mcp.json; missing from an older main process */
  mcp?: McpSetupState
  /** her notes, what she can search, her skills and the drafts waiting for a yes; missing from an older main process */
  learn?: LearnSetupState
  /** scheduled jobs, the heartbeat and the morning brief; missing from an older main process */
  schedule?: ScheduleSetupState
}

export interface ScheduleSetupState {
  jobs: { id: string; label: string; task: string; when: string; rule: string; next: string | null; paused: boolean; mode: 'agent' | 'plan'; last: { status: string; summary: string; at: number } | null }[]
  waiting: { id: string; label: string; what: string; at: number }[]
  heartbeat: { minutes: number; path: string; items: number; last: { at: number; said: string | null; tokens: number; skipped?: string } | null }
  brief: { on: boolean; after: string; lastDay: string | null }
  /** jobs run through the agent core: without a Claude brain they only announce themselves */
  agentCore: boolean
}

export type JobSetupAction = 'pause' | 'resume' | 'delete' | 'run' | 'approve' | 'drop'

export interface LearnSetupState {
  memoryDir: string
  files: { name: string; used: number; cap: number; entries: number }[]
  /** entries in the search index (chats, day logs, plans); null when search is not working */
  searchable: number | null
  skills: { name: string; description: string; kind: 'routine' | 'guide'; source: 'bundled' | 'user' }[]
  drafts: { name: string; kind: 'new' | 'update'; updates?: string; description: string; why?: string; steps: string[] }[]
  /** DESKMATE_SKILL_CODE=1: skills of yours may run their scripts (each after a yes) */
  skillCode: boolean
}

export type DraftAction = 'keep' | 'discard' | 'show'

export interface McpSetupState {
  configPath: string
  exists: boolean
  servers: { name: string; kind: 'stdio' | 'http'; target: string; enabled: boolean; state: 'off' | 'connecting' | 'ready' | 'error'; tools: string[]; error?: string }[]
  /** problems reading mcp.json */
  errors: string[]
  /** the tools reach her brain only through the agent core (a Claude brain) */
  agentCore: boolean
}

export type ChannelKey = 'telegram' | 'discord' | 'imessage' | 'slack' | 'signal' | 'whatsapp'

/** One chat app in Setup. */
export interface ChannelSetup {
  id: ChannelKey
  label: string
  /** false when it cannot be used here (WhatsApp; iMessage off a Mac); why says so */
  available: boolean
  why?: string
  /** has what it needs to start (a token, a number, a handle) */
  configured: boolean
  /** the token comes from .env */
  fromEnv?: boolean
  on: boolean
  /** ask: /start and a yes here; code: send the code shown here; allowlist: the handles listed here */
  pairing: 'ask' | 'code' | 'allowlist'
  /** her account there ("@my_bot") once connected */
  account: string | null
  /** who controls her from there */
  owner: string | null
  /** a /start waiting for a yes here */
  request: { name: string; code: string } | null
  /** the open pairing code and when it stops working */
  code: { code: string; until: number } | null
  /** allowlist channels: the handles that count as the user */
  handles?: string[]
  /** Signal: the user's number */
  number?: string
  /** what the Mac has to allow or have first (Full Disk Access, signal-cli) */
  blocker?: string | null
  error: string | null
}

export interface ChannelsSetupState {
  list: ChannelSetup[]
  /** a voice note gets a voice note back (Kokoro) */
  voiceReplies: boolean
  /** the local speech-to-text is up, so voice notes can be heard */
  stt: boolean
}

/** save: tokens, handles or a number (in data), checked and stored, and the channel switched on */
export type ChannelAction = 'save' | 'on' | 'off' | 'pair' | 'pair-cancel' | 'allow' | 'refuse' | 'forget' | 'voice-replies'

/** What she comes to tell you about on her own (Setup → "What she tells you about"; saved in settings.json). */
export interface NoticePrefs {
  /** a Claude Code job or a plan finished, failed, or needs you */
  jobs: boolean
  /** new message banners from chat apps (Messages, Discord, Slack, WhatsApp, …): who, on which app */
  messages: boolean
  /** and what the message says (off: only the app and the sender) */
  readMessages: boolean
  /** a nudge before an event on your calendar */
  calendar: boolean
  /** how many minutes before an event she nudges */
  calendarLead: number
  /** reminders and timers you set ("remind me in 20 minutes to stretch") */
  reminders: boolean
  /** what scheduled jobs found, the heartbeat's check-ins, and the morning brief */
  scheduled: boolean
  /** "23-8": she keeps quiet between these hours (reminders still ring); '' for none (DESKMATE_QUIET_HOURS) */
  quietHours: string
  /** do not disturb, from the tray: like quiet hours, until switched off */
  dnd: boolean
  /** other apps whose notifications she mentions too, by the name macOS shows */
  allowApps: string[]
  /** apps she never mentions, even chat apps */
  denyApps: string[]
}

export interface NoticeState {
  prefs: NoticePrefs
  /** quiet hours or do not disturb right now */
  quietNow: boolean
  /** the quiet hours come from DESKMATE_QUIET_HOURS in .env (nothing set in Setup) */
  quietFromEnv: boolean
  /** notDetermined / denied / fullAccess / …, or unavailable without the helper */
  calendarAccess: string
  /** reading notification banners needs Accessibility for the app running her */
  accessibility: boolean | null
}

export type PermissionKind = 'microphone' | 'screen' | 'keys' | 'calendars'

export interface DeskmateApi {
  /** with an id: that character in place of the active one (for her thumbnail) */
  getConfig(id?: string): Promise<AppConfig>
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
  /** Setup → chat apps: save a channel's tokens or handles, switch it, pair it */
  channel?(id: ChannelKey, action: ChannelAction, data?: Record<string, string>): Promise<{ ok: boolean; error?: string; account?: string; code?: string }>
  /** saves part of "What she tells you about" */
  setNotices?(patch: Partial<NoticePrefs>): Promise<NoticeState>
  /** asks macOS for read access to the calendars */
  calendarAccess?(): Promise<{ granted: boolean; status: string; error?: string }>
  /** Setup → Tool servers: switch one on or off, reread mcp.json, open it in an editor */
  mcpToggle?(name: string, on: boolean): Promise<McpSetupState>
  mcpReload?(): Promise<McpSetupState>
  mcpOpenConfig?(): Promise<void>
  openMemory?(): Promise<void>
  openSkills?(): Promise<void>
  draftAction?(name: string, action: DraftAction): Promise<LearnSetupState>
  /** Setup → Scheduled: a job (pause, resume, delete, run now) or a waiting step (approve, drop) */
  jobAction?(id: string, action: JobSetupAction): Promise<ScheduleSetupState>
  setBrief?(patch: { on?: boolean; after?: string }): Promise<ScheduleSetupState>
  openHeartbeat?(): Promise<void>
  /** the setup window's state changed in the main process (a pairing request came in, say) */
  onSetupChanged?(cb: () => void): void
  /** Setup → Characters */
  listCharacters?(): Promise<CharacterCard[]>
  /** a picture of her as a data: URL, made the first time it is asked for and kept in <user data>/thumbs */
  characterThumb?(id: string): Promise<string | null>
  characterDetails?(id: string): Promise<CharacterDetails | null>
  saveCharacter?(id: string, patch: CharacterPatch): Promise<CharacterDetails | null>
  /** picks a model (a dialog, or `path`) and imports it as a new character */
  addCharacter?(path?: string): Promise<{ ok: boolean; id?: string; name?: string; warnings?: string[]; restricted?: boolean; error?: string; cancelled?: boolean }>
  removeCharacter?(id: string): Promise<{ ok: boolean; error?: string }>
  /** Kokoro voices the local voice server offers (a fixed list when it is not running) */
  voices?(): Promise<{ voices: string[]; live: boolean }>
  /** characters were added or removed */
  onCharactersChanged?(cb: () => void): void
  /** plan card window */
  onPlan?(cb: (plan: Plan | null) => void): void
  planAction?(action: PlanAction): void
  planHeight?(px: number): void
}

export type PlanAction = 'go' | 'pause' | 'resume' | 'stop' | 'retry' | 'dismiss'

declare global {
  interface Window {
    deskmate: DeskmateApi
  }
}
