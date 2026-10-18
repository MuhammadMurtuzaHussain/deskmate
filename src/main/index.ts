import { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, powerMonitor, protocol, screen, shell, systemPreferences, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Agent, type Task } from './agent'
import { callClaude, ClaudeError, replyText, toClaudeError } from './anthropic'
import { runAgentTurn, runOneTool } from './core'
import { fastRoute, FILEISH, RE_FIND } from './fastpath'
import { McpHub } from './mcp'
import { buildTools, type Origin, type ToolCtx, type ToolOutcome, type ToolSpec, type WorkerHost } from './tools'
import { untrusted } from './untrusted'
import { APP_PLAN_SCHEMA, APP_PLAN_SYSTEM, APPS, fromPlan, handsMessage, parseAppRequest, runApp, sendToMessagesChat, type AppRequest } from './apps'
import { ACKNOWLEDGEMENTS, Brain, type Stimulus, type TaskReport } from './brain'
import { browse } from './browse'
import * as chrome from './chrome'
import { routeCommand } from './commands'
import { loadDotEnv } from './env'
import { Memory } from './memory'
import { MemoryFiles } from './memfiles'
import { describeHits, PastIndex, type PastCategory } from './past'
import { describeGuide, findGuide, guideIndex, guidePath, loadGuides, scriptsHash, type Guide } from './skillmd'
import { draftAnswer, draftFromTurn, draftLine, learnPlan, SkillDrafts, type Draft } from './learn'
import { CHANNEL_IDS, CHANNEL_LABELS, mimeFor, type Channel, type ChannelId, type OutFile } from './channels/channel'
import { DiscordApi, DiscordChannel, checkDiscordToken } from './channels/discord'
import { ChannelHub, outsideChannels, type Owner, type PairRequest } from './channels/hub'
import { CHAT_DB, ChatDb, IMessageChannel, chatDbAccess } from './channels/imessage'
import { megabytes, resolveFile } from './channels/sendfile'
import { SignalChannel, findSignalCli } from './channels/signal'
import { SlackApi, SlackChannel, checkSlackTokens } from './channels/slack'
import { TelegramApi, TelegramChannel, checkTelegramToken } from './channels/telegram'
import { WHATSAPP_REASON } from './channels/whatsapp'
import { mentionedProject, Projects, type Project } from './projects'
import { Settings, type SettingsData } from './settings'
import { cleanTranscript, localSttSelected, sttHealthy, sttUrl, transcribe, wavDurationMs, wavHead } from './stt'
import { autostartLocalTts, localTtsSelected, synthesize } from './tts'
import { CommandBar } from './bar'
import { characterFile, importCharacter, resolveCharacterAssets } from './characters'
import { Body } from './body'
import { agendaLine, dueEvents, eventLine, type CalendarEvent } from './calendar'
import { appAllowed, BannerWatch, messageLine } from './inbox'
import { Journal } from './journal'
import { NoticeCenter, noticePrefs, parseQuietHours, type Notice } from './notice'
import { changeJob, jobsLine, nextText, resolveSchedule, ruleText, ScheduleStore, scheduledLine, type Job } from './schedule'
import { Scheduler, type Ask, type RunResult } from './scheduler'
import { beatRequest, HEARTBEAT_TEMPLATE, items as heartbeatItems, parseBeat, skipReason, Told, usageRecord } from './heartbeat'
import { briefDue, briefLines, briefPrefs, briefSpoken, dayKey, noteForToday } from './brief'
import { dueLine, listLine, parseReminder, parseWhen, ReminderStore, setLine, timeIn, timerName, toSecondPerson, whenText, type Reminder, type ReminderIntent } from './reminders'
import { planCommand, planSummary, plannerSystem, PLAN_SCHEMA, PlanStore, reviseSystem, toPlan, type PlanCommand } from './plan'
import { PlanCard } from './planwin'
import { runComputerTask } from './computer'
import { Hands, HandsError, type DesktopHands } from './hands'
import { WinHands } from './hands-win'
import { loadSkills, matchSkill, runSkill, skillsForPlanner, type Skill, type SkillMatch } from './skills'
import { newerRelease, updateCheckEnabled, type Release } from './updates'
import { createWakeMatcher } from './wake'
import { ProjectWatcher } from './watcher'
import { BODY_COMMANDS, type CharacterCard, type CharacterDetails, type CharacterPatch, type NoticePrefs, type NoticeState, type Plan, type PlanAction, type PlanWorker, type AppConfig, type Audio, type AvatarCommand, type BodyCommand, type CharacterConfig, type Emotion, type PermissionKind, type ChannelAction, type ChannelSetup, type ChannelsSetupState, type Reply, type ReplyPayload, type ScheduleSetupState, type JobSetupAction, type SetupState, type ToolCall, type Touch } from '../shared/types'

// In development everything is in the project; packaged, characters/tts-local/icons ship as extraResources.
const ROOT = app.getAppPath()
const RESOURCES = app.isPackaged ? process.resourcesPath : ROOT
const USER_DATA = app.getPath('userData')
const REPO_URL = 'https://github.com/MuhammadMurtuzaHussain/deskmate'
loadDotEnv(USER_DATA, ROOT)

// Characters live in character/<id>/{character.json, persona.md}. Each has her own persona, voice and memory file.
// Two roots: the user's own under <user data>/character (added in Setup; editable, survives updates), and the ones
// shipped with the app. Setup's changes to a shipped character (voice, zoom, personality) go to
// <user data>/character/<id>/local.json and persona.md, beside nothing else.
const USER_CHARACTERS = join(USER_DATA, 'character')
const CHARACTER_DIRS = [USER_CHARACTERS, join(RESOURCES, 'character')]
function characterDir(id: string): string | null {
  return CHARACTER_DIRS.find((d) => existsSync(join(d, id, 'character.json'))) ?? null
}
type CharacterEntry = { id: string; name: string; renderer: NonNullable<CharacterConfig['renderer']>; userAdded: boolean }
function listCharacters(): CharacterEntry[] {
  const seen = new Map<string, CharacterEntry>()
  for (const root of CHARACTER_DIRS) {
    if (!existsSync(root)) continue
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || seen.has(d.name) || !existsSync(join(root, d.name, 'character.json'))) continue
      try {
        const cfg = JSON.parse(readFileSync(join(root, d.name, 'character.json'), 'utf8')) as CharacterConfig
        seen.set(d.name, { id: d.name, name: cfg.name, renderer: cfg.renderer ?? 'live2d', userAdded: root === USER_CHARACTERS })
      } catch (err) {
        console.warn(`[character] skipping ${d.name}: ${(err as Error).message}`)
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
}
/** Objects in character.json that a local.json changes a part of (a voice speed keeps the voice's other fields). */
const MERGED_KEYS = ['voice', 'camera', 'physics', 'idle', 'dance'] as const
function overlay(character: CharacterConfig, local: Partial<CharacterConfig>): CharacterConfig {
  const out = { ...character, ...local } as CharacterConfig
  for (const k of MERGED_KEYS) {
    if (local[k] && character[k]) (out as unknown as Record<string, unknown>)[k] = { ...character[k], ...local[k] }
  }
  return out
}
/** The local.json files that apply to a character: the one beside its character.json, then Setup's in user data. */
function localFiles(id: string): string[] {
  const dir = join(characterDir(id) as string, id)
  return [...new Set([join(dir, 'local.json'), join(USER_CHARACTERS, id, 'local.json')])]
}
function readCharacter(id: string): { character: CharacterConfig; persona: string } {
  const dir = join(characterDir(id) as string, id)
  let character = { ...(JSON.parse(readFileSync(join(dir, 'character.json'), 'utf8')) as CharacterConfig), id }
  // local.json (gitignored) overlays private tweaks: your own dance clips, voice, outfits, model path; Setup's last.
  for (const localPath of localFiles(id)) {
    if (!existsSync(localPath)) continue
    try {
      character = { ...overlay(character, JSON.parse(readFileSync(localPath, 'utf8')) as Partial<CharacterConfig>), id }
    } catch (err) {
      console.warn(`[character] ${localPath} ignored: ${(err as Error).message}`)
    }
  }
  const ownPersona = join(USER_CHARACTERS, id, 'persona.md')
  const persona = readFileSync(existsSync(ownPersona) ? ownPersona : join(dir, 'persona.md'), 'utf8')
  // Paths relative to the character's folder (an added character's model/…) load through deskmate://.
  return { character: resolveCharacterAssets(character, `deskmate://character/${encodeURIComponent(id)}`), persona }
}

// Models under <user data> reach the renderer (the dev server or file://) through deskmate://character/<id>/<path>.
protocol.registerSchemesAsPrivileged([{ scheme: 'deskmate', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
async function serveCharacterFile(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const [, rawId, ...rest] = url.pathname.split('/')
  let id = ''
  try {
    id = decodeURIComponent(rawId ?? '')
  } catch {
    // a malformed id is just not found
  }
  const root = url.hostname === 'character' && id && !/[\\/]|^\.\.?$/.test(id) ? characterDir(id) : null
  const file = root ? characterFile(join(root, id), rest.join('/')) : null
  if (!file || !existsSync(file) || !statSync(file).isFile()) return new Response('not found', { status: 404 })
  const res = await net.fetch(pathToFileURL(file).href)
  const headers = new Headers(res.headers)
  headers.set('access-control-allow-origin', '*')
  return new Response(res.body, { status: res.status, headers })
}

const settings = new Settings(join(app.getPath('userData'), 'settings.json'))
let characters = listCharacters()
if (characters.length === 0) throw new Error('no characters found under character/<id>/character.json')
const requested = process.env.DESKMATE_CHARACTER?.trim() || settings.get().activeCharacter || 'mika'
let activeId = characters.some((c) => c.id === requested) ? requested : characters[0].id
let { character, persona } = readCharacter(activeId)
// Her notes (USER.md, MEMORY.md) are about the user, so every character shares them; the small talk that fades and
// the recent turns are each character's own. Every turn also goes into the chat archive that search_past reads.
const MEMORY_DIR = join(USER_DATA, 'memory')
const memFiles = new MemoryFiles(MEMORY_DIR)
const CHATS_DIR = join(USER_DATA, 'chats')
const memoryFor = (id: string): Memory => new Memory(join(USER_DATA, `memory-${id}.json`), { files: memFiles, archiveDir: CHATS_DIR })
let memory = memoryFor(activeId)
moveFactsToFiles()
const brain = new Brain(memory, persona, settings)

// Her hands and ears: Claude Code jobs, the folders they run in, her Chrome, and hands-free listening.
const agent = new Agent(join(USER_DATA, 'tasks'))
const projects = new Projects(settings, join(USER_DATA, 'projects.json'))
let hands = Boolean(agent.findBinary())
const ears = localSttSelected()
let listening = false
const LISTEN_SHORTCUT = process.env.DESKMATE_LISTEN_SHORTCUT?.trim() || 'CommandOrControl+Shift+Space'
const WAKE_NAME = /^(1|true|yes|on)$/i.test(process.env.DESKMATE_WAKE_NAME?.trim() || '')
/** off (default): while listening is on she answers everything · word: her ears are on from launch and she answers only
 * after her name ("Mika, …", or "Mika?" and then the question). DESKMATE_WAKE_NAME=1 is the older switch: the same
 * gate, with listening still started by hand. */
const WAKE_MODE = (process.env.DESKMATE_WAKE_MODE?.trim().toLowerCase() || 'off') === 'word' ? 'word' : 'off'
const WAKE_GATE = WAKE_MODE === 'word' || WAKE_NAME
/** the mic stays open while she talks and talking over her stops her; 0 closes the mic while she talks, as before */
const BARGE_IN = !/^(0|false|no|off)$/i.test(process.env.DESKMATE_BARGE_IN?.trim() || '')
/** how long she listens for the question after "Mika?" and her "yes?" */
const ATTEND_MS = 8000
/** a long utterance that is not for her is only transcribed this far, to look for her name at the start */
const WAKE_HEAD_S = 3.5
let wake = createWakeMatcher(character.name)
/** always | voice (default) | never: whether she repeats a job back and waits for a yes before Claude starts */
const CONFIRM_JOBS = (process.env.DESKMATE_CONFIRM_JOBS?.trim().toLowerCase() || 'voice') as 'always' | 'voice' | 'never'
/** always (default) | voice | never: whether a Discord or Slack message is read back and waits for a yes before it goes */
const CONFIRM_SENDS = (process.env.DESKMATE_CONFIRM_SENDS?.trim().toLowerCase() || 'always') as 'always' | 'voice' | 'never'

// Her hands in desktop apps: the native helper on macOS that launches apps, presses keys and reads window titles;
// PowerShell and UI Automation on Windows (experimental).
const appHands: DesktopHands = process.platform === 'win32' ? new WinHands() : new Hands(Hands.locate(RESOURCES, ROOT))
// From a checkout, the helper asks macOS for Calendars itself (see Hands.calendarDisclaim).
appHands.calendarDisclaim = !app.isPackaged
/** Accessibility granted to the app that runs her (null until checked); without it macOS drops her key presses. */
let appTrusted: boolean | null = null
const SELF_IDS = ['com.github.Electron', 'com.murtuza.deskmate']

// Her body on the desktop: walking, pointing, sitting on windows, sleeping, wandering.
const body = new Body({
  win: () => win ?? null,
  hands: appHands,
  selfIds: SELF_IDS,
  log: (line) => console.log(`[body] ${line}`),
  busy: () => acting || browsing || herSpeaking || hearing,
  onSwat: () => void swatLine()
})

/** Now and then a word about the pointer she just went for; most swats are silent, and never more than one in 5 min. */
const SWAT_LINES: [string, Emotion][] = [
  ['Hey! Missed it.', 'annoyed'],
  ['Almost had it!', 'happy'],
  ["Stop teasing me with that thing.", 'flirty'],
  ['Gotcha. Okay, no I didn\'t.', 'smug'],
  ["Is that for me?", 'happy'],
  ['Too slow? Me? Never.', 'smug']
]
let lastSwatLine = 0
async function swatLine(): Promise<void> {
  const now = Date.now()
  if (now - lastSwatLine < 5 * 60_000 || Math.random() > 0.35 || pending || touching) return
  lastSwatLine = now
  const [say, emotion] = SWAT_LINES[Math.floor(Math.random() * SWAT_LINES.length)]
  // After the swing lands, not on top of it.
  await new Promise((r) => setTimeout(r, 700))
  if (herSpeaking || hearing || acting || browsing) return
  await deliver({ say, emotion, speak: true, remember: [] }, 'touch')
}
// Skills: app routines (skill.json) and instructions in the open SKILL.md format, from skills/ in the app and
// <user data>/skills (see docs/SKILLS.md). Drafts she wrote herself wait in <user data>/skills/drafts.
let skills: Skill[] = []
let guides: Guide[] = []
const USER_SKILLS = join(USER_DATA, 'skills')
const SKILL_CODE = process.env.DESKMATE_SKILL_CODE?.trim() === '1'

/** Once: the facts worth keeping from every character's JSON memory move into USER.md / MEMORY.md. */
function moveFactsToFiles(): void {
  try {
    memFiles.ensure()
    let moved = 0
    for (const f of readdirSync(USER_DATA).filter((n) => /^memory-[\w-]+\.json$/.test(n))) {
      const m = f === `memory-${activeId}.json` ? memory : new Memory(join(USER_DATA, f), { files: memFiles })
      moved += m.moveToFiles()
    }
    if (moved) console.log(`[memory] moved ${moved} fact(s) into ${MEMORY_DIR}`)
  } catch (err) {
    console.warn('[memory] could not set up her notes:', (err as Error).message)
  }
}

async function reloadSkills(): Promise<void> {
  const loaded = await loadSkills(
    [
      { dir: join(RESOURCES, 'skills'), source: 'bundled' },
      { dir: USER_SKILLS, source: 'user' }
    ],
    { allowUserCode: SKILL_CODE }
  )
  skills = loaded.skills
  console.log(`[skills] ${skills.length ? skills.map((s) => `${s.name}${s.source === 'user' ? ' (yours)' : ''}`).join(', ') : 'none'}`)
  for (const p of loaded.problems) console.warn(`[skills] ${p.dir} not loaded: ${p.errors.join('; ')}`)
  const md = loadGuides([
    { dir: join(RESOURCES, 'skills'), source: 'bundled' },
    { dir: USER_SKILLS, source: 'user' }
  ])
  guides = md.guides
  console.log(`[skills] SKILL.md: ${guides.length ? guides.map((g) => `${g.name}${g.source === 'user' ? ' (yours)' : ''}`).join(', ') : 'none'}`)
  for (const p of md.problems) console.warn(`[skills] ${p.dir}: ${p.errors.join('; ')}`)
  refreshTray()
  setupChanged()
}

// What she did, by day ("what did you do today?"), and the plan she is showing or working through.
const journal = new Journal(join(USER_DATA, 'log'))
const plans = new PlanStore(join(USER_DATA, 'plans'))
/** Full-text search over the chat archive, the day logs and the plans (a cache beside them, rebuilt when missing). */
const past = new PastIndex(join(USER_DATA, 'past.db'), { chats: CHATS_DIR, journal: join(USER_DATA, 'log'), plans: join(USER_DATA, 'plans') })
/** Skills she wrote herself, waiting for the user's yes. */
const drafts = new SkillDrafts(USER_SKILLS)
let plan: Plan | null = null
let planRunning = false
/** set to end the running step early (stop), or to pause after it (pause) */
let planHalt: 'pause' | 'stop' | null = null
/** Claude Code jobs a plan started: their end is a step result, not something to announce */
const planJobs = new Set<string>()
/** 1 = run a plan as soon as it is made, without waiting for a go (DESKMATE_PLAN_AUTO) */
const PLAN_AUTO = /^(1|true|yes|on)$/i.test(process.env.DESKMATE_PLAN_AUTO?.trim() || '')

/** minutes without anything happening before she nods off; 0 keeps her awake (DESKMATE_SLEEP_AFTER) */
const SLEEP_AFTER_MIN = Number(process.env.DESKMATE_SLEEP_AFTER ?? 10)
let lastActivity = Date.now()
/** Something happened (a message, a poke, her ears): wake her if she dozed off. */
function activity(): void {
  lastActivity = Date.now()
  if (body.mode === 'sleep') body.wake()
  body.noticed()
}

/** Something she is waiting on an answer for: a job she read back, or a risky browser action. */
type Pending =
  | { kind: 'job'; call: ToolCall; project: Project; at: number }
  | { kind: 'confirm'; at: number; resolve: (yes: boolean) => void }
  /** a skill she just wrote (or a better version of one): yes keeps it */
  | { kind: 'skill'; at: number; name: string }
let pending: Pending | null = null

// The chat apps she can be reached through; see the "chat apps" section below.
const channels: ChannelHub = new ChannelHub({
  owners: Object.fromEntries(CHANNEL_IDS.map((id) => [id, storedOwner(id)])),
  allowlist: { imessage: channelPrefs().imessage?.handles ?? [], signal: channelPrefs().signal?.handles ?? [] },
  askToPair,
  onPaired: (id, owner) => {
    saveOwner(id, owner)
    console.log(owner ? `[channels] ${id}: paired with ${owner.name}` : `[channels] ${id}: unpaired`)
    status(owner ? `${CHANNEL_LABELS[id]} paired · ${owner.name}` : `${CHANNEL_LABELS[id]} unpaired`)
  },
  onMessage: channelMessage,
  // Voice notes go through the same local Whisper as the microphone; nothing leaves the Mac for them.
  transcribe: async (audio, mime) => cleanTranscript(await transcribe(audio, mime)),
  speak: async (text) => {
    if (!channelPrefs().voiceReplies) return null
    const audio = await synthesize(text, character.voice).catch(() => null)
    if (!audio) return null
    const ext = audio.mime.includes('mpeg') ? 'mp3' : audio.mime.includes('ogg') ? 'ogg' : 'wav'
    return { name: `${character.name}.${ext}`, bytes: audio.bytes, mime: audio.mime }
  },
  onFatal: (id, message) => status(`${CHANNEL_LABELS[id]}: ${message}`),
  onChange: () => {
    refreshTray()
    setupChanged()
  },
  log: (line) => console.log(`[channels] ${line}`)
})

/** answers the open pairing question (her read-back on the Mac, or Allow / Refuse in Setup) */
let pairAnswer: ((yes: boolean) => void) | null = null
/** Claude Code jobs started from a chat app: their end is reported there too */
const phoneJobs = new Map<string, ChannelId>()

function switchCharacter(id: string): void {
  if (!characters.some((c) => c.id === id)) return
  activeId = id
  trayDancing = false
  if (pending?.kind === 'confirm') pending.resolve(false)
  pending = null
  ;({ character, persona } = readCharacter(id))
  wake = createWakeMatcher(character.name)
  memory = memoryFor(id)
  brain.setCharacter(memory, persona)
  settings.set({ activeCharacter: id })
  win?.setTitle(character.name)
  refreshTray()
  console.log(`[character] switched to ${character.name} (${id})`)
}

// ---- tray / menu bar icon: the app lives there; the window is just her.
let tray: Tray | null = null
let quitting = false

function trayImage(): Electron.NativeImage {
  const dir = join(RESOURCES, 'build')
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(join(dir, 'trayTemplate.png'))
    img.setTemplateImage(true)
    return img
  }
  return nativeImage.createFromPath(join(dir, process.platform === 'win32' ? 'tray.ico' : 'tray.png'))
}

function toggleWindow(): void {
  if (!win) return
  if (win.isVisible()) win.hide()
  else {
    win.show()
    win.setAlwaysOnTop(true, 'floating')
  }
  refreshTray()
}

let trayDancing = false
function sendCommand(command: AvatarCommand): void {
  if (command === 'dance' || command === 'dance_slow' || command === 'spin') trayDancing = true
  if (command === 'stop_dancing') trayDancing = false
  win?.webContents.send('avatar:command', command)
  refreshTray()
}

function shortcutLabel(): string {
  return shortcutText(LISTEN_SHORTCUT)
}

function shortcutText(accelerator: string): string {
  const mac = process.platform === 'darwin'
  return accelerator
    .replace('CommandOrControl', mac ? '⌘' : 'Ctrl')
    .replace('Shift', mac ? '⇧' : 'Shift')
    .replace(/\b(?:Alt|Option)\b/, mac ? '⌥' : 'Alt')
    .replace(/\+/g, mac ? '' : '+')
}

function jobsMenu(): Electron.MenuItemConstructorOptions[] {
  const tasks = agent.list()
  if (!tasks.length) return [{ label: 'No jobs yet: say "ask Claude to …"', enabled: false }]
  const running = tasks.filter((t) => t.status === 'running')
  const past = tasks.filter((t) => t.status !== 'running').slice(-6).reverse()
  const mark: Record<Task['status'], string> = { running: '●', done: '✓', failed: '✗', cancelled: '■' }
  return [
    ...running.map((t) => ({ label: `Stop: ${t.title}`, click: () => void cancelJob(t.id) })),
    ...(running.length && past.length ? [{ type: 'separator' as const }] : []),
    ...past.map((t) => ({ label: `${mark[t.status]} ${t.title}  (open log)`, click: () => void shell.openPath(t.logPath) }))
  ]
}

function projectsMenu(): Electron.MenuItemConstructorOptions[] {
  const current = projects.current()
  const known = projects.list().slice(0, 12)
  return [
    ...known.map((p) => ({
      label: p.name,
      type: 'radio' as const,
      checked: current?.path === p.path,
      toolTip: p.path,
      click: () => {
        projects.setCurrent(p.path)
        status(`Claude works in ${p.name}`)
        refreshTray()
      }
    })),
    ...(known.length ? [{ type: 'separator' as const }] : []),
    { label: 'Choose folder…', click: () => void chooseProject() }
  ]
}

async function chooseProject(): Promise<void> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Folder Claude works in' })
  const dir = result.filePaths[0]
  if (result.canceled || !dir) return
  projects.setCurrent(dir)
  status(`Claude works in ${basename(dir)}`)
  refreshTray()
}

function buildTrayMenu(): Menu {
  const loginItem = app.getLoginItemSettings().openAtLogin
  const threeD = character.renderer === 'vrm' || character.renderer === 'mmd'
  const running = agent.running().length
  const next = update
  return Menu.buildFromTemplate([
    { label: `${character.name} · ${brain.modelName}`, enabled: false },
    { type: 'separator' },
    { label: win?.isVisible() ? 'Hide her' : 'Show her', click: toggleWindow },
    { label: `Command bar${commandShortcut ? `  ${shortcutText(commandShortcut)}` : ''}`, click: () => bar.show() },
    ...(plan && plan.status !== 'done' && plan.status !== 'stopped'
      ? [
          {
            label: `Plan: ${plan.title}`,
            submenu: [
              { label: 'Show the plan', click: () => plan && planCard.show(plan) },
              ...(plan.status === 'draft' ? [{ label: 'Go', click: () => void planDo({ kind: 'go' }) }] : []),
              ...(plan.status === 'paused' ? [{ label: 'Resume', click: () => void planDo({ kind: 'resume' }) }] : []),
              ...(plan.status === 'running' ? [{ label: 'Pause after this step', click: () => void planDo({ kind: 'pause' }) }] : []),
              { label: 'Stop the plan', click: () => void planDo({ kind: 'stop' }) }
            ]
          }
        ]
      : []),
    {
      label: 'Her body',
      submenu: [
        { label: 'Come here', click: () => void runBodyCommand('come_here') },
        { label: 'Sit on the front window', enabled: appHands.available, click: () => void runBodyCommand('sit') },
        { label: 'Lie down on the front window', enabled: appHands.available, click: () => void runBodyCommand('lie') },
        { label: 'Peek-a-boo', click: () => void runBodyCommand('peek', { boo: true }) },
        { label: 'Back to her spot', click: () => void runBodyCommand('go_home') },
        { label: body.mode === 'sleep' ? 'Wake her' : 'Let her nap', click: () => void runBodyCommand(body.mode === 'sleep' ? 'wake' : 'sleep') },
        { label: 'Walk around on her own', type: 'checkbox', checked: body.wandering, click: () => void runBodyCommand(body.wandering ? 'stay' : 'wander') }
      ]
    },
    ...remindersMenu(),
    ...scheduledMenu(),
    {
      label: notices.quiet() && !noticeSettings().dnd ? 'Do not disturb (quiet hours now)' : 'Do not disturb',
      type: 'checkbox',
      checked: noticeSettings().dnd,
      toolTip: 'She keeps what comes up to herself (reminders still ring) and tells you after',
      click: () => setNoticePrefs({ dnd: !noticeSettings().dnd })
    },
    { label: 'Look at my screen now', click: () => void observe(true) },
    { label: watching ? 'Stop watching' : 'Watch my screen', type: 'checkbox', checked: watching, click: () => void setWatching(!watching) },
    {
      label: `${listening ? 'Stop listening' : WAKE_GATE ? `Listen for "${character.name}"` : 'Listen hands-free'}  ${shortcutLabel()}`,
      type: 'checkbox',
      checked: listening,
      enabled: ears,
      toolTip: ears ? 'Talk to her; she talks back' : 'Needs the local voice server: DESKMATE_STT=local (docs/VOICES.md)',
      click: () => void setListening(!listening)
    },
    ...(threeD
      ? [
          ...(trayDancing
            ? [{ label: 'Stop dancing', click: () => sendCommand('stop_dancing') }]
            : [
                { label: 'Dance', click: () => sendCommand('dance') },
                { label: 'Dance slow', click: () => sendCommand('dance_slow') },
                { label: 'Spin', click: () => sendCommand('spin') }
              ]),
          ...(character.outfits?.length ? [{ label: 'Next outfit', click: () => sendCommand('next_outfit') }] : [])
        ]
      : []),
    { type: 'separator' },
    {
      label: `Claude works in: ${projects.current()?.name ?? 'pick a folder'}`,
      enabled: hands,
      toolTip: hands ? 'The folder jobs run in unless you name another' : 'Claude Code is not installed on this computer (docs/AGENT.md)',
      submenu: projectsMenu()
    },
    { label: running ? `Claude jobs (${running} running)` : 'Claude jobs', enabled: hands, submenu: jobsMenu() },
    ...(browsing ? [{ label: 'Stop browsing', click: () => void cancelJob() }] : []),
    ...(acting ? [{ label: 'Stop what she is doing in the app', click: () => void cancelJob() }] : []),
    ...(appHands.available && appTrusted === false
      ? [{ label: 'Let her use your apps (Accessibility)…', toolTip: 'Discord, Slack and Claude app control need Accessibility', click: askForAccessibility }]
      : []),
    channelsMenu(),
    {
      label: 'Character',
      submenu: characters.map((c) => ({
        label: c.name,
        type: 'radio' as const,
        checked: c.id === activeId,
        click: () => {
          switchCharacter(c.id)
          win?.webContents.reload()
        }
      }))
    },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: loginItem,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { label: 'Characters…', click: () => openSetup('characters') },
    { label: 'Setup…', click: () => openSetup() },
    { label: 'Open settings folder', click: () => void shell.openPath(USER_DATA) },
    { label: 'Open her memory', toolTip: 'USER.md and MEMORY.md: what she knows about you, in plain text you can edit', click: openMemoryFolder },
    { label: 'Open characters folder', click: () => void shell.openPath(CHARACTER_DIRS[1]) },
    {
      label: `Skills (${skills.length + guides.filter((g) => !g.routine).length})${drafts.list().length ? ' · new' : ''}`,
      submenu: [
        ...skills.map((s) => ({ label: `${s.title} · ${s.app.name}${s.source === 'user' ? ' (yours)' : ''}`, enabled: false })),
        ...guides.filter((g) => !g.routine).map((g) => ({ label: `${g.name.replace(/-/g, ' ')}${g.source === 'user' ? ' (yours)' : ''}`, toolTip: g.description, click: () => void shell.openPath(join(g.dir, 'SKILL.md')) })),
        ...draftsMenu(),
        ...(skills.length || guides.length ? [{ type: 'separator' as const }] : []),
        {
          label: 'Open my skills folder',
          click: () => {
            mkdirSync(USER_SKILLS, { recursive: true })
            void shell.openPath(USER_SKILLS)
          }
        },
        { label: 'Reload skills', click: () => void reloadSkills() },
        { label: 'How to write a skill', click: () => void shell.openExternal(`${REPO_URL}/blob/main/docs/SKILLS.md`) }
      ]
    },
    { label: 'Help and docs', click: () => void shell.openExternal(REPO_URL) },
    ...(next ? [{ label: `Update available: v${next.version}`, click: () => void shell.openExternal(next.url) }] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
}

// ---- update check: a tray item and one status line when a newer release is on GitHub (DESKMATE_UPDATE_CHECK=0: off).
let update: Release | null = null
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000

async function checkForUpdate(): Promise<void> {
  const found = await newerRelease(app.getVersion())
  if (!found || found.version === update?.version) return
  update = found
  console.log(`[update] Deskmate ${found.version} is out (running ${app.getVersion()}): ${found.url}`)
  refreshTray()
  if (settings.get().updateNotified === found.version) return
  settings.set({ updateNotified: found.version })
  status(`Deskmate ${found.version} is out · tray menu → Update available`)
}

function refreshTray(): void {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())
  tray.setToolTip(`${character.name} · deskmate`)
}

function createTray(): void {
  try {
    tray = new Tray(trayImage())
    refreshTray()
    tray.on('click', () => {
      // Left click toggles her on Windows/Linux; macOS opens the menu (default behaviour).
      if (process.platform !== 'darwin') toggleWindow()
    })
  } catch (err) {
    console.warn('[tray] could not create tray icon:', (err as Error).message)
  }
}

const watchDir = process.env.DESKMATE_WATCH_DIR?.trim() || null
const watcher = watchDir ? new ProjectWatcher(watchDir) : null
const watchIntervalSec = Math.max(10, Number(process.env.DESKMATE_WATCH_INTERVAL) || 60)
let watching = false
let watchTimer: NodeJS.Timeout | null = null
let observing = false

/** Loads one of the renderer pages (index, bar, setup): from the dev server in development, from disk when built. */
function loadPage(target: BrowserWindow, page: string): void {
  if (process.env.ELECTRON_RENDERER_URL) void target.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page === 'index' ? '' : `${page}.html`}`)
  else void target.loadFile(join(__dirname, `../renderer/${page}.html`))
}
const PRELOAD = join(__dirname, '../preload/index.js')

const COMMAND_SHORTCUT = process.env.DESKMATE_COMMAND_SHORTCUT?.trim() || 'Alt+Space'
let commandShortcut: string | null = null
const bar = new CommandBar(PRELOAD, loadPage)
const planCard = new PlanCard(PRELOAD, loadPage, () => win ?? null)
/** auto (default): her panel tucks away until you hover over her · always: it stays */
const PANEL = process.env.DESKMATE_PANEL?.trim().toLowerCase() === 'always' ? 'always' : 'auto'

const WIN_W = 440
const WIN_H = 760
let win: BrowserWindow
let debugSayFired = false

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay()
  const height = Math.min(WIN_H, workArea.height - 24)
  win = new BrowserWindow({
    width: WIN_W,
    height,
    x: workArea.x + workArea.width - WIN_W - 16,
    y: workArea.y + workArea.height - height - 8,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // macOS keeps windows below the menu bar unless told otherwise; sitting on a window near the top needs her
    // window to reach above it.
    enableLargerThanScreen: true,
    title: character.name,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  // Sit above everything, on every Space, like the overlay in the reel.
  win.setAlwaysOnTop(true, 'floating')
  // The plan card stays beside her wherever she goes.
  win.on('move', () => planCard.place())
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Closing hides her; the tray keeps the app alive. Quit from the tray menu.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
      refreshTray()
    }
  })

  loadPage(win, 'index')

  // Debug aids: mirror renderer console to stdout; DESKMATE_DEBUG_SHOT=<png path> captures the window after load.
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`)
  })
  const shot = process.env.DESKMATE_DEBUG_SHOT
  const debugSay = process.env.DESKMATE_DEBUG_SAY
  const debugWav = process.env.DESKMATE_DEBUG_WAV
  const debugTouch = process.env.DESKMATE_DEBUG_TOUCH as Touch['area'] | undefined
  const debugCommand = process.env.DESKMATE_DEBUG_COMMAND as AvatarCommand | undefined
  if (debugCommand) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => sendCommand(debugCommand), 12000)
    })
  }
  if (process.env.DESKMATE_DEBUG_LOOK) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => void observe(true), 10000)
    })
  }
  if (debugTouch) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => void react({ kind: 'tap', area: debugTouch }), 10000)
    })
  }
  if (debugSay && !debugSayFired) {
    debugSayFired = true
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const reply = await handleChat(debugSay)
        console.log('[debug] reply', JSON.stringify(reply))
      }, 10000)
    })
  }
  if (debugWav && !debugSayFired) {
    // Feeds WAV files (';'-separated) through the same path as the microphone, one after another: transcription,
    // wake word, routing, reply. The next one goes in a few seconds after she has dealt with the last.
    debugSayFired = true
    const files = debugWav.split(';').map((f) => f.trim()).filter(Boolean)
    let i = 0
    const feedNext = (): void => {
      if (i >= files.length) return
      if (hearing) {
        setTimeout(feedNext, 500)
        return
      }
      const file = files[i++]
      try {
        void onUtterance(new Uint8Array(readFileSync(file)), 0).finally(() => setTimeout(feedNext, 5000))
      } catch (err) {
        console.error('[debug] could not read DESKMATE_DEBUG_WAV', file, err)
        setTimeout(feedNext, 500)
      }
    }
    win.webContents.once('did-finish-load', () => setTimeout(feedNext, 10000))
  }
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.capturePage()
          writeFileSync(shot, image.toPNG())
          console.log(`[debug] window captured to ${shot}`)
        } catch (err) {
          console.error('[debug] capture failed', err)
        }
      }, debugSay || debugWav || debugTouch || debugCommand || process.env.DESKMATE_DEBUG_LOOK ? 16000 : 8000)
    })
  }
}

/** Lines in the status row that are not steps of the work, so the phone does not get them. */
const IDLE_STATUS = /^(?:idle|…|not listening|listening ·)/

function status(text: string): void {
  win?.webContents.send('status', text)
  bar.status(text)
  if (!IDLE_STATUS.test(text)) channels.status(text)
}

/**
 * Greys out her own window in a capture, so she does not read herself as part of the screen. This replaced hiding the
 * window while capturing, which made her blink out on every message with the local brain (it looks each time).
 */
function maskOwnWindow(bmp: Buffer, size: Electron.Size, display: Electron.Display): void {
  if (!win?.isVisible()) return
  const b = win.getBounds()
  const d = display.bounds
  const sx = size.width / d.width
  const sy = size.height / d.height
  const x0 = Math.max(0, Math.floor((b.x - d.x) * sx))
  const y0 = Math.max(0, Math.floor((b.y - d.y) * sy))
  const x1 = Math.min(size.width, Math.ceil((b.x + b.width - d.x) * sx))
  const y1 = Math.min(size.height, Math.ceil((b.y + b.height - d.y) * sy))
  const stride = bmp.length / size.height
  for (let y = y0; y < y1; y++) {
    const row = y * stride
    for (let x = x0; x < x1; x++) {
      const i = row + x * 4
      bmp[i] = bmp[i + 1] = bmp[i + 2] = 128
      bmp[i + 3] = 255
    }
  }
}

/**
 * A picture of her as she is on screen right now: her panel, bubble and grip hidden for a frame, the window captured
 * with its transparency, empty edges trimmed. Saved as a PNG in ~/Pictures/Deskmate (Messages sends attachments from
 * there without trouble) and put on the clipboard. Returns the file's path.
 */
async function portrait(): Promise<string> {
  if (!win || !win.isVisible()) throw new Error('show me first (menu-bar icon → Show her), then ask again')
  await win.webContents.executeJavaScript(
    "document.body.classList.add('portrait'); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"
  )
  let image: Electron.NativeImage
  try {
    image = await win.webContents.capturePage()
  } finally {
    void win.webContents.executeJavaScript("document.body.classList.remove('portrait')")
  }
  image = trimTransparent(image)
  const dir = join(app.getPath('pictures'), 'Deskmate')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${character.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`)
  const png = image.toPNG()
  writeFileSync(file, png)
  // Electron 44's clipboard takes W3C-style items.
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]).catch((err) => console.warn('[portrait] clipboard:', (err as Error).message))
  return file
}

/** A capture trimmed to what is not transparent (her, without the empty window around her). */
function trimTransparent(image: Electron.NativeImage): Electron.NativeImage {
  // The bitmap is in device pixels (BGRA); crop() takes points.
  const size = image.getSize()
  const bmp = image.toBitmap()
  const scale = Math.sqrt(bmp.length / 4 / (size.width * size.height)) || 1
  const pw = Math.round(size.width * scale)
  const ph = Math.round(size.height * scale)
  let x0 = pw
  let y0 = ph
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < ph; y += 2) {
    for (let x = 0; x < pw; x += 2) {
      if (bmp[(y * pw + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 > x0 && y1 > y0) {
    const pad = 6 * scale
    const x = Math.max(0, Math.floor((x0 - pad) / scale))
    const y = Math.max(0, Math.floor((y0 - pad) / scale))
    return image.crop({
      x,
      y,
      width: Math.min(size.width - x, Math.ceil((x1 - x0 + 2 * pad) / scale)),
      height: Math.min(size.height - y, Math.ceil((y1 - y0 + 2 * pad) / scale))
    })
  }
  return image
}

// ---- Setup → Characters: thumbnails, voice / zoom / personality, adding and removing characters

const THUMBS = join(USER_DATA, 'thumbs')
const THUMB_H = 360
let thumbQueue: Promise<unknown> = Promise.resolve()

/** When anything that changes her look last changed: character.json and the local.json overlays. */
function lookChangedAt(id: string): number {
  const dir = characterDir(id)
  if (!dir) return 0
  return Math.max(...[join(dir, id, 'character.json'), ...localFiles(id)].map((f) => (existsSync(f) ? statSync(f).mtimeMs : 0)))
}

/**
 * Her picture for a card, as a data: URL. Made once, the same way as portrait(): she is loaded on her own in an
 * offscreen copy of her window, captured with her transparency and trimmed; kept in <user data>/thumbs until her
 * character.json or local.json changes. One at a time; null when her model does not load.
 */
function thumbnail(id: string): Promise<string | null> {
  const file = join(THUMBS, `${id}.png`)
  if (existsSync(file) && statSync(file).mtimeMs > lookChangedAt(id)) return Promise.resolve(`data:image/png;base64,${readFileSync(file).toString('base64')}`)
  const job = thumbQueue.then(async () => {
    const image = await renderThumb(id).catch((err) => {
      console.warn(`[thumbs] ${id}: ${(err as Error).message}`)
      return null
    })
    if (!image) return null
    const sized = image.getSize().height > THUMB_H ? image.resize({ height: THUMB_H, quality: 'good' }) : image
    mkdirSync(THUMBS, { recursive: true })
    const png = sized.toPNG()
    writeFileSync(file, png)
    console.log(`[thumbs] ${id}: ${sized.getSize().width}x${sized.getSize().height}`)
    return `data:image/png;base64,${png.toString('base64')}`
  })
  thumbQueue = job
  return job
}

async function renderThumb(id: string): Promise<Electron.NativeImage | null> {
  const w = new BrowserWindow({
    width: WIN_W,
    height: Math.min(WIN_H, 760),
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { preload: PRELOAD, sandbox: false, offscreen: true }
  })
  try {
    w.webContents.setFrameRate(30)
    if (process.env.ELECTRON_RENDERER_URL) await w.loadURL(`${process.env.ELECTRON_RENDERER_URL}/?thumb=${encodeURIComponent(id)}`)
    else await w.loadFile(join(__dirname, '../renderer/index.html'), { query: { thumb: id } })
    // The page says when her model is in and posed (or that it could not load it).
    const until = Date.now() + 45_000
    let state = ''
    while (Date.now() < until) {
      state = String(await w.webContents.executeJavaScript('window.__thumb ?? ""').catch(() => ''))
      if (state) break
      await new Promise((r) => setTimeout(r, 300))
    }
    if (state !== 'ready') throw new Error(state ? `the model did not load (${state})` : 'timed out loading the model')
    return trimTransparent(await w.webContents.capturePage())
  } finally {
    w.destroy()
  }
}

/** Kokoro presets, in the local voice server's order, for when it is not running to ask. */
const KOKORO_VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'af_aoede', 'af_kore', 'af_sarah', 'af_nova', 'af_sky', 'af_alloy', 'af_jessica', 'af_river',
  'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily', 'am_michael', 'am_fenrir', 'am_puck', 'am_echo', 'am_eric', 'am_liam', 'am_onyx',
  'am_adam', 'am_santa', 'bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'
]

async function kokoroVoices(): Promise<{ voices: string[]; live: boolean }> {
  const speech = process.env.DESKMATE_TTS_URL?.trim() || 'http://127.0.0.1:8880/v1/audio/speech'
  try {
    const res = await fetch(speech.replace(/\/v1\/audio\/speech\/?$/, '/v1/voices'), { signal: AbortSignal.timeout(1500) })
    const body = (await res.json()) as { voices?: unknown }
    if (res.ok && Array.isArray(body.voices) && body.voices.length) return { voices: body.voices.map(String), live: true }
  } catch {
    // not running: the bundled list
  }
  return { voices: KOKORO_VOICES, live: false }
}

function characterDetails(id: string): CharacterDetails | null {
  const entry = characters.find((c) => c.id === id)
  if (!entry) return null
  const { character: c, persona: p } = readCharacter(id)
  return {
    id,
    name: c.name,
    renderer: c.renderer ?? 'live2d',
    voice: c.voice?.kokoro ?? 'af_heart',
    speed: c.voice?.speed ?? 1,
    zoom: c.camera?.zoom ?? 1,
    persona: p,
    license: c.license ?? null,
    restricted: /avatar use: (?:the author only|only people the author licenses)/.test(c.license ?? ''),
    userAdded: entry.userAdded,
    personaEdited: !entry.userAdded && existsSync(join(USER_CHARACTERS, id, 'persona.md'))
  }
}

/** Saves Setup's changes to <user data>/character/<id>/local.json and persona.md; she picks them up straight away. */
function saveCharacter(id: string, patch: CharacterPatch): CharacterDetails | null {
  if (!characters.some((c) => c.id === id)) return null
  const dir = join(USER_CHARACTERS, id)
  mkdirSync(dir, { recursive: true })
  const localPath = join(dir, 'local.json')
  let local: Partial<CharacterConfig> = {}
  try {
    if (existsSync(localPath)) local = JSON.parse(readFileSync(localPath, 'utf8')) as Partial<CharacterConfig>
  } catch {
    local = {}
  }
  const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined)
  const voice = typeof patch.voice === 'string' && /^[a-z]{2}_[a-z]+$/i.test(patch.voice) ? patch.voice : undefined
  const speed = num(patch.speed, 0.6, 1.5)
  const zoom = num(patch.zoom, 0.5, 2.5)
  if (voice || speed !== undefined) local.voice = { ...local.voice, ...(voice ? { kokoro: voice } : {}), ...(speed !== undefined ? { speed: Math.round(speed * 100) / 100 } : {}) }
  if (zoom !== undefined) local.camera = { ...local.camera, zoom: Math.round(zoom * 100) / 100 }
  if (voice || speed !== undefined || zoom !== undefined) writeFileSync(localPath, JSON.stringify(local, null, 2) + '\n')
  const ownPersona = join(dir, 'persona.md')
  const userAdded = characters.find((c) => c.id === id)?.userAdded
  if (typeof patch.persona === 'string') {
    const text = patch.persona.replace(/\r\n/g, '\n').slice(0, 20_000)
    // Empty: a shipped character goes back to her own persona (an added one keeps hers; it is the only one).
    if (text.trim()) writeFileSync(ownPersona, text.endsWith('\n') ? text : text + '\n')
    else if (!userAdded && existsSync(ownPersona)) rmSync(ownPersona)
  }
  console.log(`[character] saved ${id}: ${JSON.stringify({ ...patch, persona: patch.persona === undefined ? undefined : `${patch.persona.length} chars` })}`)
  if (id === activeId) {
    switchCharacter(id)
    // Her zoom is the renderer's; voice and personality apply from her next line.
    if (zoom !== undefined) win?.webContents.reload()
  }
  return characterDetails(id)
}

function charactersChanged(): void {
  characters = listCharacters()
  win?.webContents.send('characters:changed')
  refreshTray()
}

ipcMain.handle('characters:list', (): CharacterCard[] => characters.map((c) => ({ ...c, active: c.id === activeId })))
ipcMain.handle('characters:thumb', (_event, id: string) => (characters.some((c) => c.id === id) ? thumbnail(String(id)) : null))
ipcMain.handle('characters:details', (_event, id: string) => characterDetails(String(id)))
ipcMain.handle('characters:save', (_event, id: string, patch: CharacterPatch) => saveCharacter(String(id), patch ?? {}))
ipcMain.handle('characters:voices', () => kokoroVoices())
ipcMain.handle('characters:add', async (event, given?: string) => {
  let path = typeof given === 'string' && given ? given : null
  if (!path) {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Add a character',
      buttonLabel: 'Add',
      message: 'Pick a .vrm, a Live2D .model3.json (or its folder), a .pmx, a rigged .fbx, or a .zip with one inside',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: [{ name: 'Characters', extensions: ['vrm', 'json', 'pmx', 'fbx', 'glb', 'gltf', 'dae', 'zip'] }]
    }
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true }
    path = picked.filePaths[0]
  }
  try {
    const result = importCharacter(path, { root: USER_CHARACTERS, taken: (id) => characters.some((c) => c.id === id) })
    console.log(`[character] added ${result.config.name} (${result.id}, ${result.config.renderer}) from ${basename(path)}${result.warnings.length ? `; ${result.warnings.join('; ')}` : ''}`)
    charactersChanged()
    return { ok: true, id: result.id, name: result.config.name, warnings: result.warnings, restricted: result.restricted }
  } catch (err) {
    console.warn(`[character] could not add ${basename(path)}: ${(err as Error).message}`)
    return { ok: false, error: (err as Error).message }
  }
})
ipcMain.handle('characters:remove', async (_event, raw: string) => {
  const id = String(raw)
  const entry = characters.find((c) => c.id === id)
  if (!entry?.userAdded) return { ok: false, error: 'Only characters you added can be removed.' }
  if (characters.length < 2) return { ok: false, error: 'She is the only one left.' }
  if (id === activeId) {
    switchCharacter((characters.find((c) => c.id !== id) as CharacterEntry).id)
    win?.webContents.reload()
  }
  // To the Trash, not gone for good: a mistake can be put back.
  await shell.trashItem(join(USER_CHARACTERS, id)).catch((err) => console.warn(`[character] trash ${id}: ${(err as Error).message}`))
  if (existsSync(join(USER_CHARACTERS, id, 'character.json'))) return { ok: false, error: 'Could not move her folder to the Trash.' }
  rmSync(join(THUMBS, `${id}.png`), { force: true })
  console.log(`[character] removed ${id} (moved to the Trash)`)
  charactersChanged()
  return { ok: true }
})

/** One downscaled JPEG of the primary display, with her own window greyed out. */
async function captureScreen(): Promise<Stimulus['screenshot']> {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    console.warn(`[screen] access status: ${systemPreferences.getMediaAccessStatus('screen')} (needs Screen Recording permission)`)
    status('I cannot see your screen yet. System Settings → Privacy & Security → Screen Recording → allow Deskmate (or Electron in dev), then restart me.')
  }
  const display = screen.getPrimaryDisplay()
  const width = 1280
  const height = Math.round((display.size.height / display.size.width) * width)
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) {
      // macOS says "granted" but hands back nothing after the app binary changed (dev reinstall, update):
      // the permission has to be toggled off and on again for this app.
      console.warn(`[screen] capture came back empty (${sources.length} source(s)); Screen Recording permission is probably stale`)
      status('My eyes are off: screen capture returned nothing. System Settings → Privacy & Security → Screen Recording → switch Deskmate (or Electron) off and on, then restart me.')
      return undefined
    }
    // A stale Screen Recording grant (after an app update or a dev reinstall) yields a black frame, not an error.
    const bmp = source.thumbnail.toBitmap()
    let sum = 0
    const step = 4 * 97 // sample every 97th pixel
    for (let i = 0; i < bmp.length; i += step) sum += bmp[i] + bmp[i + 1] + bmp[i + 2]
    const mean = sum / (3 * Math.ceil(bmp.length / step))
    if (mean < 2) {
      console.warn('[screen] capture is black; Screen Recording permission is stale for this build of the app')
      status('My eyes are off: the screen comes back black. System Settings → Privacy & Security → Screen Recording → switch Deskmate (or Electron) off and on again, then restart me.')
      return undefined
    }
    const size = source.thumbnail.getSize()
    maskOwnWindow(bmp, size, display)
    const jpeg = nativeImage.createFromBitmap(bmp, size).toJPEG(60)
    if (process.env.DESKMATE_DEBUG_SAVE_CAPTURE) writeFileSync(process.env.DESKMATE_DEBUG_SAVE_CAPTURE, jpeg)
    return { data: jpeg.toString('base64'), mediaType: 'image/jpeg' }
  } catch (err) {
    console.warn(`[screen] capture failed: ${(err as Error).message}`)
    return undefined
  }
}

async function deliver(reply: Reply, source: ReplyPayload['source'], ready?: Audio | null): Promise<void> {
  if (!reply.speak || !reply.say) return
  console.log(`[say:${source}] ${reply.say.slice(0, 90)}`)
  bar.line(reply.say)
  // Work that came from a chat app gets her lines there; while she waits on a yes, with Yes / No buttons.
  if (source !== 'observe' && source !== 'touch') channels.say(reply.say, { ask: Boolean(pending) })
  const audio = ready !== undefined ? ready : await synthesize(reply.say, character.voice)
  const payload: ReplyPayload = { reply, audio, source }
  win.webContents.send('reply', payload)
}

async function observe(manual = false): Promise<void> {
  if (observing) return
  const cooldown = brain.cooldownSeconds()
  if (cooldown > 0) {
    status(`Gemini quota exhausted · looks paused for ${Math.ceil(cooldown / 60)} min`)
    return
  }
  observing = true
  try {
    status('looking…')
    const screenshot = await captureScreen()
    const fileEvents = watcher?.drain() ?? []
    const reply = await brain.respond({ kind: 'observe', screenshot, fileEvents, manual })
    if (process.env.DESKMATE_DEBUG_LOOK) console.log('[debug] look reply', JSON.stringify(reply), 'via', brain.mode)
    if (reply.speak && reply.say) {
      await deliver(reply, 'observe')
    } else {
      status(watching ? `watching · nothing to say · next look in ${watchIntervalSec}s` : 'looked, nothing to say')
    }
  } catch (err) {
    console.error('[observe]', err)
    status(`look failed: ${(err as Error).message}`)
  } finally {
    observing = false
  }
}

async function setWatching(on: boolean): Promise<boolean> {
  watching = on
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  if (on) {
    watcher?.start()
    // A timer started from a phone message would otherwise send every look to the phone.
    watchTimer = outsideChannels(() => setInterval(() => void observe(), watchIntervalSec * 1000))
    status(`watching${watchDir ? ` ${watchDir}` : ''} · every ${watchIntervalSec}s`)
    void observe()
  } else {
    await watcher?.stop()
    status('not watching')
  }
  refreshTray()
  return watching
}

ipcMain.handle(
  'config:get',
  (_event, id?: string): AppConfig => ({
    // a thumbnail window asks for the character it pictures
    character: typeof id === 'string' && characters.some((c) => c.id === id) ? readCharacter(id).character : character,
    characters,
    mode: brain.mode,
    modelName: brain.modelName,
    watchDir,
    watching,
    watchIntervalSec,
    listening,
    ears,
    hands,
    project: (() => {
      const p = projects.current()
      return p ? { name: p.name, path: p.path } : null
    })(),
    bargeIn: BARGE_IN,
    wakeWord: WAKE_GATE ? character.name : null,
    panel: PANEL,
    commandShortcut
  })
)

ipcMain.handle('character:set', (_event, id: string) => {
  switchCharacter(String(id))
  // The renderer reloads itself to load the new model; config:get then returns the new character.
  win.webContents.reload()
})

ipcMain.handle('chat:send', (_event, rawText: string): Promise<Reply> => handleChat(String(rawText)))

// ---- what she can do with her hands

const QUIET: Reply = { say: '', emotion: 'neutral', speak: false, remember: [] }

/** A plain line in her voice's place: for mechanics (nothing running, no folder) that no model needs to phrase. */
async function sayPlain(say: string, emotion: Emotion = 'neutral'): Promise<Reply> {
  const reply: Reply = { say, emotion, speak: true, remember: [] }
  await deliver(reply, 'task')
  return reply
}

/** Lets her tell the user about a job in her own words (or plain words when no model is available). */
async function report(task: TaskReport): Promise<Reply> {
  const reply = await brain.respond({ kind: 'task', task })
  await deliver(reply, 'task')
  return reply
}

function yesNo(text: string): 'yes' | 'no' | null {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim()
  if (/^(?:yes|yeah|yep|yup|sure|ok|okay|go|go ahead|do it|send it|send|please|yes please|confirm|affirmative|run it|ship it|click it|type it)\b/.test(t)) return 'yes'
  if (/^(?:no|nope|nah|don't|do not|cancel|stop|never mind|nevermind|forget it|wait|hold on|not now)\b/.test(t)) return 'no'
  return null
}

/** "Hey Mika, …" → "…": her name is how they get her attention, not part of the message. */
function stripName(text: string): string {
  const name = character.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`^(?:hey|hi|ok|okay|yo|hello|so)?[\\s,]*${name}[\\s,:!.?-]+`, 'i'), '').replace(new RegExp(`[\\s,]+${name}[.!?]*$`, 'i'), '').trim() || text
}

/** Reads a risky action back to the user and waits up to a minute for a yes; anything else is a no. */
function confirm(question: string): Promise<boolean> {
  return ask(question).then((yes) => yes === true)
}

/** A yes-or-no question: true, false, or null when no answer came in time (a scheduled job then waits instead). */
function ask(question: string, timeoutMs = 60_000): Promise<boolean | null> {
  if (pending?.kind === 'confirm') pending.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const done = (yes: boolean | null): void => {
      if (settled) return
      settled = true
      if (pending?.kind === 'confirm' && pending.resolve === done) pending = null
      resolve(yes)
    }
    pending = { kind: 'confirm', at: Date.now(), resolve: done }
    setTimeout(() => done(null), timeoutMs).unref()
    void sayPlain(question)
  })
}

function jobTitle(call: ToolCall): string {
  if (call.name === 'claude_resume') return call.input ? `continue, then: ${call.input}` : 'continue the last session'
  return call.input
}

async function cancelJob(id?: string): Promise<Reply> {
  if (planRunning && !id) {
    stopPlan()
    return sayPlain('Plan stopped.')
  }
  if (acting) {
    actStop = true
    if (pending?.kind === 'confirm') pending.resolve(false)
    return sayPlain('Stopping.')
  }
  if (browsing) {
    browseStop = true
    return sayPlain('Stopping. One second.')
  }
  const task = agent.cancel(id)
  refreshTray()
  if (!task) return sayPlain("Nothing's running right now.")
  return report({ phase: 'cancelled', title: task.title, folder: basename(task.cwd) })
}

async function startJob(call: ToolCall, project: Project, acknowledged: boolean): Promise<Reply> {
  let task: Task
  try {
    const resume = call.name === 'claude_resume' ? agent.latestFor(project.path)?.sessionId ?? 'last' : undefined
    task = agent.run({ prompt: call.input, cwd: project.path, resume })
  } catch (err) {
    return sayPlain(`I couldn't start Claude: ${(err as Error).message}`, 'sad')
  }
  console.log(`[hands] job ${task.id} in ${project.path}: ${task.title}`)
  if (channels.activeChannel) phoneJobs.set(task.id, channels.activeChannel)
  status(`Claude · ${task.title} · starting…`)
  refreshTray()
  if (acknowledged) return QUIET
  return report({ phase: 'started', title: task.title, folder: project.name })
}

/** Opens a website, a known project folder, a path, or an application by name. */
async function openThing(raw: string): Promise<Reply> {
  const r = await openTarget(raw)
  return sayPlain(r.line, r.ok ? 'neutral' : 'sad')
}

/** openThing without the line said: what was opened, for her brain or a plan step. */
async function openTarget(raw: string): Promise<{ ok: boolean; line: string }> {
  const input = raw
    .trim()
    .replace(/^(?:the |my )/i, '')
    .replace(/\s+(?:folder|project|directory|repo|app|website|site)$/i, '')
  if (/^(?:https?:\/\/|www\.)/i.test(input) || /^[\w-]+\.(?:com|org|net|io|dev|app|ai|co|uk|ie|de|fr)(?:\/|$)/i.test(input)) {
    await shell.openExternal(/^https?:/i.test(input) ? input : `https://${input}`)
    return { ok: true, line: `Opening ${input}.` }
  }
  const project = projects.resolve(input)
  if (project) {
    await shell.openPath(project.path)
    return { ok: true, line: `Opening ${project.name}.` }
  }
  const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input
  if (existsSync(expanded)) {
    await shell.openPath(expanded)
    return { ok: true, line: `Opening ${basename(expanded)}.` }
  }
  if (await openApp(input)) return { ok: true, line: `Opening ${input}.` }
  if (/^[\w-]+$/.test(input)) {
    // Not an app, one word: most likely a site ("open youtube").
    await shell.openExternal(`https://${input.toLowerCase()}.com`)
    return { ok: true, line: `Opening ${input.toLowerCase()}.com.` }
  }
  return { ok: false, line: `I couldn't find anything called ${input} to open.` }
}

function openApp(name: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', ['-a', name]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', name]]
        : ['gtk-launch', [name]]
  return new Promise((resolve) => execFile(cmd, args, { timeout: 10_000 }, (err) => resolve(!err)))
}

function chromeMessage(err: unknown): string {
  return err instanceof chrome.ChromeError ? err.message : `Chrome gave me trouble: ${(err as Error).message}`
}

/** Tab, navigation and page verbs from the spoken-command router: fast, no model involved. */
async function chromeVerb(input: string): Promise<Reply> {
  const r = await chromeAct(input)
  if (r.quiet) {
    status(r.line)
    return QUIET
  }
  return sayPlain(r.line, r.ok ? 'neutral' : /can't see/.test(r.line) ? 'annoyed' : 'sad')
}

/** chromeVerb without speaking: `quiet` lines only go to the status row. */
async function chromeAct(input: string): Promise<{ ok: boolean; line: string; quiet?: boolean }> {
  const colon = input.indexOf(':')
  const verb = colon >= 0 ? input.slice(0, colon) : input
  const arg = colon >= 0 ? input.slice(colon + 1).trim() : ''
  const quiet = (line: string): { ok: boolean; line: string; quiet: boolean } => ({ ok: true, line, quiet: true })
  try {
    switch (verb) {
      case 'next_tab':
        return quiet(`tab: ${await chrome.switchTab(1)}`)
      case 'prev_tab':
        return quiet(`tab: ${await chrome.switchTab(-1)}`)
      case 'close_tab':
        await chrome.closeTab()
        return quiet('closed the tab')
      case 'back':
      case 'forward':
      case 'reload':
        await chrome.navigate(verb)
        return quiet(verb)
      case 'scroll_down':
      case 'scroll_up':
        await chrome.scroll(verb === 'scroll_down' ? 'down' : 'up')
        return quiet(verb.replace('_', ' '))
      case 'search':
        await chrome.open(chrome.searchUrl(arg))
        return { ok: true, line: `Searching for ${arg}.` }
      case 'click': {
        const result = await chrome.clickText(arg)
        if (result === 'missing') return { ok: false, line: `I can't see anything called "${arg}" to click on this page.` }
        return quiet(result)
      }
      case 'find':
        if (await chrome.find(arg)) return quiet(`found "${arg}"`)
        return { ok: false, line: `"${arg}" isn't on this page.` }
      default:
        return { ok: false, line: `I don't know how to ${verb} in Chrome.` }
    }
  } catch (err) {
    return { ok: false, line: chromeMessage(err) }
  }
}

/** A question about the page open in Chrome: she reads its text instead of squinting at a screenshot. */
async function answerAboutPage(question: string, voice?: boolean): Promise<Reply> {
  let page: Awaited<ReturnType<typeof chrome.pageText>>
  try {
    page = await chrome.pageText(6000)
  } catch (err) {
    if (err instanceof chrome.ChromeError && (err.code === 'no_window' || err.code === 'not_running' || err.code === 'unsupported')) {
      // Not a Chrome page then; her eyes will do.
      const screenshot = await captureScreen().catch(() => undefined)
      const reply = await brain.respond({ kind: 'chat', text: question, screenshot, blind: !screenshot, voice })
      await deliver(reply, 'chat')
      return reply
    }
    return sayPlain(chromeMessage(err), 'sad')
  }
  status(`reading ${page.title.slice(0, 40) || page.url}…`)
  const reply = await brain.respond({ kind: 'chat', text: question, voice, page: { url: page.url, title: page.title, text: page.text } })
  await deliver(reply, 'chat')
  return reply
}

let browsing = false
let browseStop = false

/** A browsing goal: her brain runs the look-decide-act loop in the active Chrome tab, then she reports back. */
async function runBrowse(goal: string, acknowledged: boolean): Promise<Reply> {
  if (!chrome.chromeAvailable()) return sayPlain('I can only drive Chrome on a Mac for now. Ask Claude to do it instead.', 'sad')
  if (!brain.canThink) return sayPlain('I need a brain for that: paste a Gemini key or start Ollama.', 'sad')
  if (browsing) return sayPlain("I'm already in the middle of something in Chrome. Say \"stop\" first.", 'annoyed')
  if (!goal.trim()) return sayPlain('Browse for what?')
  browsing = true
  browseStop = false
  refreshTray()
  mkdirSync(join(USER_DATA, 'tasks'), { recursive: true })
  const logPath = join(USER_DATA, 'tasks', `browse-${Date.now().toString(36)}.log`)
  const log = (line: string): void => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      // not her problem
    }
  }
  if (!acknowledged) void report({ kind: 'browse', phase: 'started', title: goal })
  status(`browsing · ${goal.slice(0, 40)}`)
  try {
    const result = await browse(goal, {
      plan: (system, user, schema) => brain.plan(system, user, schema),
      confirm,
      onStep: status,
      log,
      stopped: () => browseStop
    })
    console.log(`[browse] ${result.ok ? 'done' : 'stopped'} after ${result.steps} step(s): ${result.answer.slice(0, 120)}`)
    return report({ kind: 'browse', phase: result.ok ? 'done' : 'failed', title: goal, detail: result.answer })
  } catch (err) {
    console.error('[browse]', err)
    return sayPlain(chromeMessage(err), 'sad')
  } finally {
    browsing = false
    refreshTray()
    status(listening ? listeningStatus() : 'idle')
  }
}

let acting = false
let actStop = false

/** The message itself asks her to do something in an app (not a question about the screen, not small talk). */
const ACTION_REQUEST = /\b(?:text|message|msg|dm|send|tell|reply|post|open|launch|go to|play|pause|add|write|type|call|search|find|create|make|start|book|order|share|forward|turn on|turn off)\b/i

/** Asks macOS for Accessibility for whoever runs her and opens the right page of System Settings. */
function askForAccessibility(): void {
  if (process.platform !== 'darwin') return
  systemPreferences.isTrustedAccessibilityClient(true)
  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
}

async function checkAppTrust(): Promise<boolean> {
  const was = appTrusted
  appTrusted = (await appHands.permissions().catch(() => null))?.keys ?? false
  if (was !== appTrusted) refreshTray()
  return appTrusted
}

/** The deps a skill runs with: her hands, her read-back, her status line, a log in <user data>/tasks. */
function skillDeps(log: (line: string) => void, stopped: () => boolean, confirmSends: boolean): Parameters<typeof runSkill>[2] {
  return {
    hands: appHands,
    platform: process.platform,
    confirm,
    confirmSends,
    onStep: status,
    log,
    stopped
  }
}

/** A phrase that matched a skill's trigger: run the skill, like an app routine. */
async function runSkillTool(hit: SkillMatch, said: string, opts: { voice?: boolean }): Promise<Reply> {
  if (!appHands.available) return sayPlain(handsMessage(new HandsError('', 'unavailable')), 'sad')
  if (acting) return sayPlain("I'm already doing something in an app. Say \"stop\" first.", 'annoyed')
  if (!(await checkAppTrust())) {
    askForAccessibility()
    return sayPlain('I need Accessibility to press keys for you. Turn it on in the window I just opened, then ask me again.', 'sad')
  }
  acting = true
  actStop = false
  refreshTray()
  const log = taskLogger(`skill-${hit.skill.name}`)
  console.log(`[skills] ${hit.skill.name} ${JSON.stringify(hit.slots).slice(0, 120)}`)
  try {
    // Read-backs follow DESKMATE_CONFIRM_SENDS, as for Discord and Slack messages.
    const confirmSends = CONFIRM_SENDS === 'always' || (CONFIRM_SENDS === 'voice' && Boolean(opts.voice))
    const result = await runSkill(hit.skill, hit.slots, skillDeps(log, () => actStop || quitting, confirmSends), said)
    console.log(`[skills] ${result.ok ? 'done' : 'not done'}: ${result.summary}`)
    journal.add('app', result.summary)
    memory.addTurn('user', `[${hit.skill.app.name}: ${result.ok ? result.say : `not done: ${result.say}`}]`)
    return sayPlain(result.say, result.ok ? 'happy' : 'sad')
  } finally {
    acting = false
    refreshTray()
    status(listening ? listeningStatus() : 'idle')
  }
}

/** Something to do inside a desktop app: a Discord or Slack message, a chat to open, a prompt for the Claude app. */
async function runAppTool(input: string, opts: { voice?: boolean; acknowledged?: boolean }): Promise<Reply> {
  // A skill names its app in its triggers, so it goes first ("message sam on whatsapp…" is not a Messages text).
  const skillHit = matchSkill(skills, input)
  if (skillHit) return runSkillTool(skillHit, input, opts)
  if (!appHands.available) return sayPlain(handsMessage(new HandsError('', 'unavailable')), 'sad')
  if (acting) return sayPlain("I'm already doing something in an app. Say \"stop\" first.", 'annoyed')
  let req: AppRequest | null = parseAppRequest(input)
  if (!req && brain.canThink) {
    status('working out who and what…')
    req = fromPlan(await brain.plan(APP_PLAN_SYSTEM, input, APP_PLAN_SCHEMA).catch(() => ({})))
  }
  if (!req && brain.claudeForAgent && ACTION_REQUEST.test(input)) {
    // Another app (Messages, WhatsApp, Notes, …): that is the agent's job.
    return runComputer(input, opts)
  }
  if (!req) return sayPlain('On my own I can message people on Discord and Slack, and ask the Claude app things. Pick Claude as my brain in Setup for other apps.')
  // Messages and Spotify go through their AppleScript dictionaries (macOS asks for Automation itself); no keys pressed.
  const scripted = req.app === 'messages' || req.app === 'spotify'
  if (!scripted && !(await checkAppTrust())) {
    askForAccessibility()
    const who = app.isPackaged ? 'Deskmate' : 'the app you started me from (Electron, or your terminal)'
    return sayPlain(`I need Accessibility to press keys for you. Turn it on for ${who} in the window I just opened, then ask me again.`, 'sad')
  }
  acting = true
  actStop = false
  refreshTray()
  mkdirSync(join(USER_DATA, 'tasks'), { recursive: true })
  const logPath = join(USER_DATA, 'tasks', `app-${req.app}-${Date.now().toString(36)}.log`)
  const log = (line: string): void => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      // not her problem
    }
  }
  log(`request: ${JSON.stringify(req)} (from ${JSON.stringify(input)})`)
  console.log(`[apps] ${req.app} ${req.action}${req.to ? ` → ${req.to}` : ''}${req.text ? `: ${req.text.slice(0, 60)}` : ''}`)
  const confirmFor = (policy: 'always' | 'voice' | 'never'): boolean => policy === 'always' || (policy === 'voice' && Boolean(opts.voice))
  try {
    if (req.app === 'spotify' && req.action === 'play_query' && brain.claudeForAgent) {
      // Picking the right song out of the search results is a job for the agent.
      acting = false
      return await runComputer(`In Spotify, find and play ${req.text}.`, opts)
    }
    const result = await runApp(req, {
      hands: appHands,
      confirm,
      confirmMessages: confirmFor(CONFIRM_SENDS),
      confirmPrompts: confirmFor(CONFIRM_JOBS),
      onStep: status,
      log,
      stopped: () => actStop || quitting,
      portrait
    })
    console.log(`[apps] ${result.ok ? 'done' : 'not done'}: ${result.summary}`)
    journal.add('app', result.summary)
    memory.addTurn('user', `[${APPS[req.app].name}: ${result.summary}]`)
    return sayPlain(result.say, result.ok ? 'happy' : 'sad')
  } finally {
    acting = false
    refreshTray()
    status(listening ? listeningStatus() : 'idle')
  }
}

/**
 * A multi-step goal on this Mac, worked by Claude through her hands (Claude brain only): it opens apps, reads their
 * windows, clicks, types and checks, asking before anything that sends, posts, deletes or pays.
 */
async function runComputer(goal: string, opts: { voice?: boolean; acknowledged?: boolean }): Promise<Reply> {
  const agentBrain = brain.claudeForAgent
  if (!agentBrain) return sayPlain('That needs Claude as my brain. Pick it in Setup, from my menu, with your Anthropic key.', 'sad')
  if (!appHands.available) return sayPlain(handsMessage(new HandsError('', 'unavailable')), 'sad')
  if (acting) return sayPlain("I'm already doing something on your Mac. Say \"stop\" first.", 'annoyed')
  if (!goal.trim()) return sayPlain('Do what on your Mac?')
  if (!(await checkAppTrust())) {
    askForAccessibility()
    return sayPlain('I need Accessibility to work your apps. Turn it on in the window I just opened, then ask me again.', 'sad')
  }
  const confirmJobs = CONFIRM_JOBS === 'always' || (CONFIRM_JOBS === 'voice' && Boolean(opts.voice))
  // A misheard sentence must not start a run on the computer.
  if (confirmJobs && !(await confirm(`On your Mac: ${goal}. Go ahead?`))) return sayPlain('Okay, leaving it.')
  acting = true
  actStop = false
  refreshTray()
  const log = taskLogger('computer')
  try {
    const result = await agentGoal(goal, log, () => actStop || quitting)
    console.log(`[computer] ${result.ok ? 'done' : 'not done'} after ${result.steps} step(s): ${result.answer.slice(0, 160)}`)
    memory.addTurn('user', `[On the Mac, "${goal}": ${result.answer.slice(0, 300)}]`)
    journal.add('mac', `${goal} → ${result.answer.slice(0, 200)}`)
    return sayPlain(result.answer, result.ok ? 'happy' : 'sad')
  } finally {
    acting = false
    refreshTray()
    status(listening ? listeningStatus() : 'idle')
  }
}

/** A log file in <user data>/tasks for one run. */
function taskLogger(prefix: string): (line: string) => void {
  mkdirSync(join(USER_DATA, 'tasks'), { recursive: true })
  const logPath = join(USER_DATA, 'tasks', `${prefix}-${Date.now().toString(36)}.log`)
  return (line: string): void => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      // not her problem
    }
  }
}

/** The agent's loop with her hands and eyes, for "do X on my Mac" and for plan steps. Needs a Claude brain. */
async function agentGoal(goal: string, log: (line: string) => void, stopped: () => boolean): Promise<{ ok: boolean; answer: string; steps: number }> {
  const agentBrain = brain.claudeForAgent
  if (!agentBrain) return { ok: false, answer: 'That needs Claude as my brain (Setup, from my menu).', steps: 0 }
  log(`goal: ${goal} (model ${agentBrain.model}, effort ${agentBrain.effort})`)
  console.log(`[computer] ${agentBrain.model}: ${goal.slice(0, 120)}`)
  {
    const result = await runComputerTask(goal, {
      client: agentBrain.client,
      model: agentBrain.model,
      effort: agentBrain.effort,
      hands: appHands,
      confirm,
      screenshot: () => captureScreen().catch(() => undefined),
      runApp: (req) =>
        runApp(req, { hands: appHands, confirm, confirmMessages: CONFIRM_SENDS !== 'never', confirmPrompts: false, onStep: status, log, stopped, portrait }),
      portrait,
      pointAt: (rect) => body.pointAt(rect),
      openUrl: async (url) => {
        if (chrome.chromeAvailable()) await chrome.open(url)
        else await shell.openExternal(url)
      },
      readWebPage: async () => {
        const page = await chrome.pageText(8000)
        return `${page.title}\n${page.url}\n\n${page.text}`
      },
      onStep: (text) => status(`on your Mac · ${text}`),
      log,
      stopped,
      selfBundleIds: ['com.github.Electron', 'com.murtuza.deskmate'],
      skills,
      runSkill: (skill, slots) => runSkill(skill, slots, skillDeps(log, stopped, CONFIRM_SENDS !== 'never')),
      maxSteps: Math.max(5, Number(process.env.DESKMATE_AGENT_STEPS) || 25)
    })
    return result
  }
}

/** Body moves: from her brain's "action", or from a phrase. Returns a line to say, or null to stay quiet. */
async function runBodyCommand(command: BodyCommand, opts: { boo?: boolean } = {}): Promise<string | null> {
  switch (command) {
    case 'come_here':
      await body.comeToCursor()
      return null
    case 'go_home':
      await body.goHome()
      return null
    case 'sit':
    case 'lie': {
      if (!appHands.available) return `I need my hands helper to find a window to ${command} on.`
      const app = await body.sitOnTopWindow({ seat: command })
      if (app === 'too_high') return "That window's right up at the top of the screen, there's no room for me on it. Move it down a bit?"
      return app ? null : `There's no window here I can ${command} on.`
    }
    case 'peek':
      // "hide" stays hidden until called back; peek-a-boo pops out and comes back after a bit.
      void body.peek({ boo: opts.boo, ms: opts.boo ? 25_000 : Infinity })
      return null
    case 'stand':
      body.stand()
      return null
    case 'sleep':
      body.sleep()
      return null
    case 'wake':
      body.wake()
      return null
    case 'wander':
      body.wander(true, () => !acting && !browsing && !herSpeaking)
      refreshTray()
      return null
    case 'stay':
      body.wander(false, () => false)
      refreshTray()
      return null
  }
}

/** Phrases for her body that need no model: "come here", "sit on this window", "go to sleep", "walk around". */
const BODY_PHRASES: [RegExp, BodyCommand][] = [
  [/^(?:come (?:here|over(?: here)?|to me)|over here)\b/i, 'come_here'],
  [/^(?:go (?:home|back to your (?:spot|corner|place))|back to your (?:spot|corner|place))\b/i, 'go_home'],
  [/^(?:sit(?: down)?(?: on (?:this|the|my|that) window| here)?|have a seat|take a seat)[.!]?$/i, 'sit'],
  [/^(?:lie|lay)(?: (?:down|back))?(?: on (?:top of )?(?:this|the|my|that) window| here| on (?:top|it))?[.!]?$/i, 'lie'],
  [/^(?:hide|go hide|hide (?:somewhere|from me)|(?:let's |wanna )?play (?:peek[- ]?a[- ]?boo|hide and seek)|peek[- ]?a[- ]?boo|peekaboo|hide and seek)[.!]?$/i, 'peek'],
  [/^(?:come out(?: now)?|(?:i )?found you|you can come out(?: now)?)[.!]?$/i, 'go_home'],
  [/^(?:stand up|get up|get down)[.!]?$/i, 'stand'],
  [/^(?:go to sleep|take a nap|nap time|sleep)[.!]?$/i, 'sleep'],
  [/^(?:wake up)[.!]?$/i, 'wake'],
  [/^(?:walk around|wander(?: around)?|go explore|explore|roam(?: around)?)[.!]?$/i, 'wander'],
  [/^(?:stay(?: put| there| here)?|stop (?:walking|wandering)(?: around)?)[.!]?$/i, 'stay']
]

const FIND_STOP = new Set(['my', 'the', 'a', 'an', 'file', 'files', 'document', 'doc', 'folder', 'that', 'this', 'from', 'with', 'of', 'for', 'and', 'on', 'in', 'mac', 'computer'])
const EXTENSIONS: Record<string, string[]> = {
  pdf: ['.pdf'],
  word: ['.doc', '.docx'],
  docx: ['.docx'],
  excel: ['.xls', '.xlsx'],
  spreadsheet: ['.xls', '.xlsx', '.numbers', '.csv'],
  photo: ['.jpg', '.jpeg', '.png', '.heic'],
  picture: ['.jpg', '.jpeg', '.png', '.heic'],
  image: ['.jpg', '.jpeg', '.png', '.heic', '.gif'],
  screenshot: ['.png'],
  video: ['.mp4', '.mov'],
  zip: ['.zip'],
  slides: ['.key', '.pptx', '.ppt'],
  presentation: ['.key', '.pptx', '.ppt']
}

/** Spotlight search for a file or folder by name words, newest first; skips app internals and libraries. */
function findFiles(query: string): Promise<string[]> {
  const words = query.toLowerCase().replace(/[^\p{L}\p{N}\s.'-]+/gu, ' ').split(/\s+/).filter((w) => w && !FIND_STOP.has(w))
  const exts = words.flatMap((w) => EXTENSIONS[w] ?? (w.startsWith('.') ? [w] : []))
  const names = words.filter((w) => !EXTENSIONS[w] && !w.startsWith('.'))
  if (!names.length) return Promise.resolve([])
  const key = [...names].sort((a, b) => b.length - a.length)[0]
  return new Promise((resolve) => {
    execFile('mdfind', ['-onlyin', homedir(), '-name', key], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve([])
      const hits = stdout
        .split('\n')
        .filter(Boolean)
        .filter((p) => !/\/Library\/|\/\.|node_modules|\.app\/|\/\.Trash\//.test(p))
        .filter((p) => {
          const base = basename(p).toLowerCase()
          return base.includes(key) && (!exts.length || exts.some((e) => base.endsWith(e)))
        })
        .slice(0, 300)
      const scored = hits.map((p) => {
        let mtime = 0
        try {
          mtime = statSync(p).mtimeMs
        } catch {
          // gone since Spotlight indexed it
        }
        const stem = basename(p).toLowerCase().replace(/\.[^.]+$/, '')
        // Every other word they said that is in the name counts for more than any amount of recency.
        const matched = names.filter((n) => stem.includes(n)).length
        return { p, score: matched * 1e14 + (stem === names.join(' ') ? 1e13 : 0) + mtime }
      })
      resolve(scored.sort((a, b) => b.score - a.score).map((x) => x.p))
    })
  })
}

/** "Where's my resume?": find it, show it in Finder, walk over and point at it. */
/** Finds it, shows it in Finder and points at it; null when nothing matched. */
async function findAndReveal(what: string): Promise<{ name: string; where: string; path: string; more: number } | null> {
  status(`looking for ${what}…`)
  const found = await findFiles(what)
  if (!found.length) return null
  const file = found[0]
  const name = basename(file)
  const where = basename(join(file, '..'))
  console.log(`[find] ${what} → ${file}${found.length > 1 ? ` (+${found.length - 1} more)` : ''}`)
  // Finder selects it in a window; then she finds that row on screen and points at it.
  await new Promise<void>((resolve) => execFile('open', ['-R', file], () => resolve()))
  let rect = null
  if (appHands.available) {
    for (let i = 0; i < 6 && !rect; i++) {
      await new Promise((r) => setTimeout(r, 400))
      rect = await appHands.locate('com.apple.finder', name).catch(() => null)
    }
  }
  if (rect) void body.pointAt(rect)
  journal.add('find', `${what} → ${file}`)
  return { name, where, path: file, more: found.length - 1 }
}

/** "Where's my resume?": find it, show it in Finder, walk over and point at it. */
async function findAndShow(query: string): Promise<Reply> {
  const what = query.trim()
  if (!what) return sayPlain('Find what?')
  const hit = await findAndReveal(what)
  if (!hit) return sayPlain(`I couldn't find anything called ${what} on this Mac.`, 'sad')
  const more = hit.more > 0 ? ` There ${hit.more === 1 ? 'is one more' : `are ${hit.more} more`} with that name.` : ''
  return sayPlain(`Here: ${hit.name}, in ${hit.where}.${more}`, 'happy')
}

// ---- plans: a bigger goal as steps, a card beside her, run after a go

/** Which workers a plan may use right now. */
function planWorkers(): PlanWorker[] {
  const w: PlanWorker[] = []
  if (brain.claudeForAgent && appHands.available) w.push('computer')
  if (chrome.chromeAvailable()) w.push('browse')
  if (hands) w.push('claude')
  w.push('app')
  if (skills.length && appHands.available) w.push('skill')
  w.push('find', 'open', 'say', 'ask')
  return w
}

function showPlan(): void {
  if (!plan) return
  plans.save(plan)
  planCard.show(plan)
  refreshTray()
}

async function makePlan(goal: string): Promise<Reply> {
  const r = await planFor(goal)
  return sayPlain(r.line, r.emotion)
}

/** Makes the plan and shows the card; the line about it is for the caller to say (or for her brain to read). */
async function planFor(goal: string): Promise<{ ok: boolean; line: string; emotion: Emotion }> {
  const line = (text: string, emotion: Emotion = 'neutral'): { ok: boolean; line: string; emotion: Emotion } => ({ ok: emotion === 'neutral', line: text, emotion })
  const what = goal.trim()
  if (!what) return line('A plan for what?')
  if (!brain.canThink) return line('I need a brain to plan with. Pick one in Setup, from my menu.', 'sad')
  if (planRunning) return line('I\'m in the middle of a plan. Say "stop the plan" first.', 'annoyed')
  status('planning…')
  const workers = planWorkers()
  let obj: Record<string, unknown>
  try {
    obj = await brain.plan(plannerSystem(workers, skillsForPlanner(skills)), `Goal: ${what}`, PLAN_SCHEMA)
  } catch (err) {
    return line(`I couldn't plan that: ${(err as Error).message.slice(0, 120)}`, 'sad')
  }
  const next = toPlan(what, obj, workers)
  if (!next) return line("I couldn't break that into steps. Say it another way?", 'sad')
  plan = next
  console.log(`[plan] ${next.title}: ${next.steps.map((s) => `${s.worker}: ${s.text}`).join(' | ')}`)
  journal.add('plan', `planned "${next.title}" (${next.steps.length} steps)`)
  showPlan()
  if (PLAN_AUTO) {
    void runPlan()
    return line(`On it: ${next.title}.`)
  }
  return line(planSummary(next))
}

/** "Change step 3 to …", "add a step …": the planner rewrites the steps not yet done. */
async function revisePlan(instruction: string): Promise<Reply> {
  if (!plan) return QUIET
  const p = plan
  const done = p.steps.slice(0, p.current).filter((s) => s.status === 'done' || s.status === 'skipped')
  const rest = p.steps.slice(done.length).filter((s) => s.status !== 'skipped')
  status('changing the plan…')
  const workers = planWorkers()
  let obj: Record<string, unknown>
  try {
    obj = await brain.plan(
      reviseSystem(workers, skillsForPlanner(skills)),
      `Goal: ${p.goal}\nPlan: ${JSON.stringify({ title: p.title, steps: rest.map(({ text, worker, input, dir }) => ({ text, worker, input, dir: dir ?? null })) })}\nChange: ${instruction}`,
      PLAN_SCHEMA
    )
  } catch (err) {
    return sayPlain(`I couldn't change it: ${(err as Error).message.slice(0, 120)}`, 'sad')
  }
  const revised = toPlan(p.goal, obj, workers, p.id)
  if (!revised) return sayPlain("I couldn't work that change in. Say it another way?")
  p.steps = [...done, ...revised.steps]
  p.current = done.length
  p.title = revised.title || p.title
  showPlan()
  return sayPlain(planSummary(p))
}

/** Waits for a Claude Code job to end. */
function jobEnded(id: string): Promise<Task> {
  return new Promise((resolve) => {
    const on = (t: Task): void => {
      if (t.id !== id) return
      agent.off('end', on)
      resolve(t)
    }
    agent.on('end', on)
  })
}

/** One step through its worker. Earlier results ride along so later steps can use them. */
async function runStep(step: Plan['steps'][number], earlier: string): Promise<{ ok: boolean; result: string }> {
  const context = earlier ? `\n\nWhat the earlier steps found or did:\n${earlier}` : ''
  const stopped = (): boolean => planHalt === 'stop' || quitting
  const log = taskLogger(`plan-${step.worker}`)
  log(`step: ${step.text} · ${step.input}`)
  switch (step.worker) {
    case 'computer': {
      if (!brain.claudeForAgent) return { ok: false, result: 'that needs Claude as my brain' }
      if (!(await checkAppTrust())) {
        askForAccessibility()
        return { ok: false, result: 'I need Accessibility to work your apps' }
      }
      const r = await agentGoal(step.input + context, log, stopped)
      return { ok: r.ok, result: r.answer }
    }
    case 'browse': {
      if (!chrome.chromeAvailable()) return { ok: false, result: 'I can only drive Chrome on a Mac' }
      browsing = true
      browseStop = false
      try {
        const r = await browse(step.input + context, { plan: (sys, user, schema) => brain.plan(sys, user, schema), confirm, onStep: status, log, stopped: () => browseStop || stopped() })
        return { ok: r.ok, result: r.answer }
      } finally {
        browsing = false
      }
    }
    case 'claude': {
      if (!hands) return { ok: false, result: "Claude Code isn't installed here" }
      const project = projects.resolve(step.dir) ?? mentionedProject(projects.list(), step.input) ?? projects.current()
      if (!project) return { ok: false, result: 'I need to know which project folder (pick one under "Claude works in")' }
      const task = agent.run({ prompt: step.input + context, cwd: project.path })
      planJobs.add(task.id)
      status(`Claude · ${task.title}`)
      const end = await jobEnded(task.id)
      return { ok: end.status === 'done', result: (end.result || end.lastText || end.error || '').slice(0, 600) }
    }
    case 'skill': {
      let hit = matchSkill(skills, step.input)
      if (!hit && brain.canThink && skills.length) {
        // The planner wrote the step its own way: one call picks the skill and fills its slots.
        const names = [...new Set(skills.flatMap((s) => s.slots.map((x) => x.name)))]
        const picked = await brain
          .plan(
            `Pick the app routine for this step and fill in its slots exactly as the step says them. Routines:\n${skills.map((s) => `- "${s.name}": ${s.description} (slots: ${s.slots.map((x) => `${x.name} = ${x.description}`).join('; ')})`).join('\n')}\nReply with ONE JSON object: {"skill": string, ${names.map((n) => `"${n}": string`).join(', ')}}; "skill" is "none" when no routine fits, and a slot the routine does not have is "".`,
            step.input,
            { type: 'object', properties: { skill: { type: 'string', enum: [...skills.map((s) => s.name), 'none'] }, ...Object.fromEntries(names.map((n) => [n, { type: 'string' }])) }, required: ['skill', ...names] }
          )
          .catch(() => null)
        const skill = skills.find((s) => s.name === picked?.skill)
        if (skill && picked) hit = { skill, slots: Object.fromEntries(skill.slots.map((x) => [x.name, String(picked[x.name] ?? '').trim()])) }
      }
      if (!hit) return runStep({ ...step, worker: 'app' }, earlier)
      if (!(await checkAppTrust())) {
        askForAccessibility()
        return { ok: false, result: 'I need Accessibility to work your apps' }
      }
      const r = await runSkill(hit.skill, hit.slots, skillDeps(log, stopped, CONFIRM_SENDS !== 'never'), step.input)
      return { ok: r.ok, result: r.ok ? r.say : r.summary }
    }
    case 'app': {
      const skillHit = matchSkill(skills, step.input)
      if (skillHit) return runStep({ ...step, worker: 'skill' }, earlier)
      let req = parseAppRequest(step.input)
      if (!req && brain.canThink) req = fromPlan(await brain.plan(APP_PLAN_SYSTEM, step.input, APP_PLAN_SCHEMA).catch(() => ({})))
      if (!req) {
        if (brain.claudeForAgent) return runStep({ ...step, worker: 'computer' }, earlier)
        return { ok: false, result: "I couldn't tell which app or who" }
      }
      if (req.app !== 'messages' && req.app !== 'spotify' && !(await checkAppTrust())) {
        askForAccessibility()
        return { ok: false, result: 'I need Accessibility to work your apps' }
      }
      const r = await runApp(req, { hands: appHands, confirm, confirmMessages: CONFIRM_SENDS !== 'never', confirmPrompts: false, onStep: status, log, stopped, portrait })
      return { ok: r.ok, result: r.summary }
    }
    case 'find': {
      const hit = await findAndReveal(step.input)
      return hit ? { ok: true, result: `${hit.name}, in ${hit.where}` } : { ok: false, result: `nothing called ${step.input}` }
    }
    case 'open':
      await openThing(step.input)
      return { ok: true, result: `opened ${step.input}` }
    case 'say': {
      const skipped = (plan?.steps ?? []).filter((s) => s.status === 'skipped' || s.status === 'failed').map((s) => s.text).join('; ')
      let say = earlier ? earlier.split('\n').slice(-3).join(' ') : step.input
      if (brain.canThink) {
        const r = await brain
          .plan(
            'You tell the user what was done or found, out loud, as their companion: two or three short spoken sentences. Say only what the results below show, with names and numbers exact. Steps listed as skipped or failed did not happen: never say they did, even if the request mentions them. Reply with ONE JSON object: {"say": string}',
            `Request: ${step.input}\n\nResults (the only things that happened):\n${earlier || '(none)'}${skipped ? `\n\nSkipped, did not happen: ${skipped}` : ''}`,
            { type: 'object', properties: { say: { type: 'string' } }, required: ['say'] }
          )
          .catch(() => null)
        if (r?.say) say = String(r.say)
      }
      await sayPlain(say, 'happy')
      return { ok: true, result: say }
    }
    case 'ask': {
      const yes = await confirm(step.input)
      return yes ? { ok: true, result: 'you said yes' } : { ok: false, result: 'you said no' }
    }
  }
}

/** Works through the plan from where it is: one step at a time, pausing on a failure or a "pause". */
async function runPlan(): Promise<void> {
  if (!plan || planRunning) return
  const p = plan
  planRunning = true
  planHalt = null
  p.status = 'running'
  p.note = undefined
  showPlan()
  journal.add('plan', `started "${p.title}"`)
  try {
    while (p.current < p.steps.length) {
      const step = p.steps[p.current]
      if (step.status === 'skipped' || step.status === 'done') {
        if (step.status === 'skipped') journal.add('step', `skipped (not done): ${step.text}`)
        p.current++
        continue
      }
      if (planHalt) break
      const n = p.current + 1
      step.status = 'running'
      step.result = undefined
      showPlan()
      status(`plan · step ${n} of ${p.steps.length} · ${step.text}`)
      const earlier = p.steps
        .filter((s) => s.status === 'done' && s.result)
        .map((s) => `- ${s.text}: ${s.result}`)
        .join('\n')
      let out: { ok: boolean; result: string }
      try {
        out = await runStep(step, earlier)
      } catch (err) {
        out = { ok: false, result: (err as Error).message }
      }
      if (planHalt === 'stop') {
        step.status = 'pending'
        break
      }
      step.result = out.result.slice(0, 600)
      step.status = out.ok ? 'done' : 'failed'
      journal.add('step', `${out.ok ? 'done' : 'failed'}: ${step.text}${out.result ? ` → ${out.result.slice(0, 200)}` : ''}`)
      showPlan()
      if (!out.ok) {
        p.status = 'paused'
        p.note = `Step ${n} didn't work: ${out.result.slice(0, 160)}`
        showPlan()
        // It needs them: she comes over to say so (or tells them after quiet time).
        const line = `Step ${n}, ${step.text.toLowerCase()}, didn't work: ${out.result.slice(0, 160)}. Say retry, skip step ${n}, or stop the plan.`
        notices.post({
          kind: 'plan',
          key: `plan:${p.id}:failed:${n}:${Date.now()}`,
          text: line,
          brief: `step ${n} of the plan "${p.title}" didn't work`,
          important: true,
          log: false,
          speak: () => sayPlain(line, 'sad').then(() => undefined)
        })
        return
      }
      p.current++
    }
    if (planHalt === 'stop') return
    if (planHalt === 'pause') {
      p.status = 'paused'
      p.note = 'Paused. Say resume when you want me to carry on.'
      showPlan()
      await sayPlain('Paused. Say resume when you want me to carry on.')
      return
    }
    p.status = 'done'
    showPlan()
    const did = p.steps.filter((s) => s.status === 'done').map((s) => s.text).join('; ')
    const skippedSteps = p.steps.filter((s) => s.status === 'skipped').map((s) => s.text).join('; ')
    journal.add('plan', `finished "${p.title}": did ${did || 'nothing'}${skippedSteps ? `; skipped (not done) ${skippedSteps}` : ''}`)
    memory.addTurn('user', `[Plan "${p.title}" done: ${p.steps.filter((s) => s.status === 'done').map((s) => s.text).join('; ')}]`)
    // A plan that ends with a "say" step has already said what came of it; she still comes over.
    const said = p.steps.at(-1)?.worker === 'say'
    notices.post({
      kind: 'plan',
      key: `plan:${p.id}:done`,
      text: `Done: ${p.title}.`,
      brief: `the plan "${p.title}" is done`,
      important: true,
      log: false,
      speak: said ? async () => undefined : () => sayPlain(`Done: ${p.title}.`, 'happy').then(() => undefined)
    })
  } finally {
    planRunning = false
    planHalt = null
    refreshTray()
    status(listening ? listeningStatus() : 'idle')
  }
}

function stopPlan(): Reply | null {
  if (!plan || plan.status === 'done' || plan.status === 'stopped') return null
  const running = planRunning
  plan.status = 'stopped'
  plan.note = 'Stopped.'
  planHalt = 'stop'
  // Cut the step that is running short, whatever worker has it.
  actStop = true
  browseStop = true
  for (const id of planJobs) agent.cancel(id)
  if (pending?.kind === 'confirm') pending.resolve(false)
  journal.add('plan', `stopped "${plan.title}"`)
  showPlan()
  void running
  return null
}

/** What they said or clicked about the plan. */
async function planDo(cmd: PlanCommand | { kind: 'dismiss' }): Promise<Reply> {
  if (!plan) return QUIET
  switch (cmd.kind) {
    case 'go':
    case 'resume':
      if (planRunning) return QUIET
      void runPlan()
      return sayPlain(cmd.kind === 'go' ? 'Going.' : 'Carrying on.')
    case 'retry': {
      if (planRunning || plan.status !== 'paused') return QUIET
      const step = plan.steps[plan.current]
      if (step) step.status = 'pending'
      void runPlan()
      return sayPlain('Trying that step again.')
    }
    case 'pause':
      if (!planRunning) return QUIET
      planHalt = 'pause'
      return sayPlain("I'll pause after this step.")
    case 'stop':
      stopPlan()
      return sayPlain('Plan stopped.')
    case 'skip': {
      const step = plan.steps[cmd.index]
      if (!step || step.status === 'done') return sayPlain("That one's already done.")
      if (step.status === 'running') return sayPlain("That one's running right now. Say stop the plan if you want it cut short.")
      step.status = 'skipped'
      showPlan()
      if (plan.status === 'paused' && cmd.index === plan.current) return sayPlain(`Skipped step ${cmd.index + 1}. Say resume to carry on.`)
      return sayPlain(`Skipped step ${cmd.index + 1}.`)
    }
    case 'revise':
      return revisePlan(cmd.instruction)
    case 'dismiss':
      if (plan.status === 'draft' || plan.status === 'paused') stopPlan()
      planCard.hide()
      return QUIET
  }
}

/** Runs one tool call, from the router (explicit) or from her brain (she already said she is on it). */
async function runTool(call: ToolCall, opts: { voice?: boolean; acknowledged?: boolean; said?: string }): Promise<Reply> {
  switch (call.name) {
    case 'tasks':
      return report({ phase: 'status', title: 'status', detail: agent.describe() })
    case 'cancel':
      return cancelJob()
    case 'open':
      return openThing(call.input)
    case 'page':
      return answerAboutPage(call.input, opts.voice)
    case 'browse':
      return runBrowse(call.input, Boolean(opts.acknowledged))
    case 'chrome':
      return chromeVerb(call.input)
    case 'app':
      return runAppTool(call.input, opts)
    case 'computer':
      return runComputer(call.input, opts)
    case 'find':
      return findAndShow(call.input)
    case 'plan':
      return makePlan(call.input)
    case 'remind':
      return remindTool(call.input, opts.said)
    case 'claude':
    case 'claude_resume': {
      if (!hands) return sayPlain("I can't find Claude Code on this computer. Install it and log in once, then ask me again.", 'sad')
      const project =
        projects.resolve(call.dir) ??
        mentionedProject(projects.list(), call.input) ??
        projects.current() ??
        (call.name === 'claude_resume' ? lastJobProject() : null)
      if (!project) return sayPlain('Which folder? Pick one under "Claude works in" in my menu, or say it: "in the vlog".')
      if (call.name === 'claude' && !call.input.trim()) return sayPlain('Tell me what Claude should do.')
      const busy = agent.running().find((t) => t.cwd === project.path)
      if (busy) return sayPlain(`Claude is still busy in ${project.name} with "${busy.title}". Say "stop the task", or wait.`, 'annoyed')
      const needsYes = CONFIRM_JOBS === 'always' || (CONFIRM_JOBS === 'voice' && Boolean(opts.voice))
      if (needsYes) {
        // A misheard sentence must never start a job: she reads it back and waits for a yes.
        pending = { kind: 'job', call, project, at: Date.now() }
        return report({ phase: 'confirm', title: jobTitle(call), folder: project.name })
      }
      return startJob(call, project, Boolean(opts.acknowledged))
    }
  }
}

function lastJobProject(): Project | null {
  const last = agent.list().at(-1)
  return last ? { name: basename(last.cwd), path: last.cwd, source: 'folder' } : null
}

/** One path for typed chat, the microphone and the debug hook: commands first, then the brain, then any tool she chose. */
async function handleChat(rawText: string, opts: { voice?: boolean } = {}): Promise<Reply> {
  const text = rawText.slice(0, 2000).trim()
  activity()
  if (text.toLowerCase() === '/forget') {
    memory.clear()
    memFiles.reset()
    journal.add('memory', 'forgot everything (/forget); the old notes are in USER.md.bak and MEMORY.md.bak')
    const reply: Reply = { say: 'Clean slate. Who are you again, sweetheart?', emotion: 'smug', speak: true, remember: [] }
    await deliver(reply, 'chat')
    return reply
  }
  if (/^(?:\/(?:selfie|portrait)|(?:take|send|give me|show me) (?:a |an )?(?:selfie|photo of you(?:rself)?|picture of you(?:rself)?|pic of you(?:rself)?))[.!]?$/i.test(stripName(text))) {
    try {
      if (channels.active) {
        // From the phone: the picture goes there. If she is hidden, she shows herself for the moment it takes.
        const hidden = !win.isVisible()
        if (hidden) {
          win.showInactive()
          await new Promise((r) => setTimeout(r, 700))
        }
        let file: string
        try {
          file = await portrait()
        } finally {
          if (hidden) win.hide()
        }
        console.log(`[portrait] ${file} (to the phone)`)
        await channels.photo(readFileSync(file))
        return sayPlain('There you go.', 'happy')
      }
      const file = await portrait()
      return sayPlain(`Copied a picture of me, paste it anywhere. It's also in Pictures, Deskmate folder.`, 'happy').then((r) => {
        console.log(`[portrait] ${file}`)
        return r
      })
    } catch (err) {
      return sayPlain(`I couldn't take a picture of myself: ${(err as Error).message}`, 'sad')
    }
  }
  if (text.toLowerCase() === '/listen') {
    await setListening(!listening)
    return QUIET
  }
  // Something is waiting on a yes or no.
  if (pending) {
    const answer = yesNo(stripName(text))
    if (pending.kind === 'confirm') {
      const p = pending
      pending = null
      p.resolve(answer === 'yes')
      if (answer) return QUIET
      // Not an answer: that is a no for the risky action, and a normal message otherwise.
    } else if (pending.kind === 'skill') {
      const p = pending
      pending = null
      const answer = Date.now() - p.at < 5 * 60_000 ? draftAnswer(stripName(text)) : null
      if (answer === 'later') return sayPlain("Okay, it'll wait in my tray menu under Skills.")
      if (answer) return sayPlain(await settleDraft(p.name, answer === 'keep'), answer === 'keep' ? 'happy' : 'neutral')
      // Anything else ("cancel my reminders") is a new message; the draft waits in the tray and in Setup.
    } else if (Date.now() - pending.at > 90_000) {
      pending = null
    } else {
      if (answer === 'yes') {
        const p = pending
        pending = null
        return startJob(p.call, p.project, false)
      }
      if (answer === 'no') {
        pending = null
        return sayPlain('Dropped. Not sending that.')
      }
      // Anything else is a new message; the question lapses.
      pending = null
    }
  }
  // "stop" while something runs always means stop that.
  if (/^(?:stop|stop it|cancel|that's enough|enough)[.!]?$/i.test(stripName(text)) && (planRunning || acting || browsing || agent.running().length)) return cancelJob()

  // The plan on the card: "go", "skip step 2", "change step 3 to …", "pause", "stop the plan".
  const plainSaid = stripName(text).replace(/^(?:can you |could you |please )+/i, '')
  if (plan && (plan.status === 'draft' || plan.status === 'paused' || plan.status === 'running')) {
    const cmd = planCommand(plainSaid, plan)
    if (cmd) return planDo(cmd)
  }
  // "Make a plan to …", "/plan …"; "what did you do today?"
  const planAsk = /^(?:\/plan\s+|(?:make|draw up|put together|come up with|give me) a plan (?:to|for)\s+|plan (?:out |how to )?)(.+)$/i.exec(plainSaid)
  if (planAsk) return makePlan(planAsk[1])
  const dayAsk = /^(?:what (?:did|have) you (?:do|done|been doing|get done)|what have you been up to|recap)(?: for me)?(?: (today|yesterday))?[?.!]*$/i.exec(plainSaid)
  if (dayAsk) {
    const when = dayAsk[1]?.toLowerCase() === 'yesterday' ? 'yesterday' : 'today'
    return report({ kind: 'day', phase: 'status', title: when, detail: journal.describe(when === 'yesterday' ? -1 : 0) })
  }

  // The answer to "when should I remind you?": "in 10 minutes", "at 6".
  if (reminderAsk && Date.now() - reminderAsk.at < 120_000) {
    const ask = reminderAsk
    const when = parseWhen(plainSaid)
    reminderAsk = null
    if (when) {
      const ms = when.ms
      if (ask.timer && !ms) return sayPlain('For how long? Say it like "5 minutes".')
      const r = reminderStore.add({ text: ask.text || (ask.timer && ms ? timerName(ms) : ''), at: when.at, timer: ask.timer, ...(ms ? { ms } : {}) })
      journal.add('reminder', `set: ${r.text} ${whenText(r.at, Date.now())}`)
      refreshTray()
      return sayPlain(setLine(r, Date.now()), 'happy')
    }
  }
  // "What's on my calendar today?", "what's next on my calendar?"
  const calAsk = /^(?:what(?:'s| is| do i have| have i got)(?: on)?(?: my)? (?:calendar|schedule|agenda)|(?:do i have|have i got|any) (?:any )?(?:meetings|events|calls|appointments))(?: (?:for |on )?(today|tomorrow))?[?.!]*$/i.exec(plainSaid)
  if (calAsk) return calendarAnswer(calAsk[1]?.toLowerCase() === 'tomorrow' ? 'tomorrow' : 'today')
  if (/^(?:when(?:'s| is) my next (?:meeting|event|call|appointment)|what(?:'s| is) (?:next|coming up) on my (?:calendar|schedule)|what(?:'s| is) my next (?:meeting|event|call|appointment))[?.!]*$/i.test(plainSaid)) {
    return calendarAnswer('next')
  }

  // Her body: "come here", "sit on this window", "go to sleep", "walk around", "where's my resume?".
  const said = stripName(text).replace(/^(?:can you |could you |please )+/i, '').replace(/[.!]+$/, '')
  const move = BODY_PHRASES.find(([re]) => re.test(said))
  if (move) {
    const line = await runBodyCommand(move[1], { boo: /boo|seek/i.test(said) })
    return line ? sayPlain(line) : QUIET
  }
  // With a Claude brain the agent core takes it from here: a shortcut for an unambiguous command, else one tool-use
  // turn with every worker as a tool. Null means Claude could not be reached; the routing below answers instead.
  if (useAgentCore()) {
    const handled = await agentDispatch(text, opts)
    if (handled) return handled
  }
  const lookFor = RE_FIND.exec(said)
  if (lookFor && !/\b(?:page|tab|website|site|screen|error|bug|flight|price|cheapest|best|weather)\b/i.test(lookFor[1])) {
    // "where's my …" is about a place on this Mac; "find the …" only when it names a file-like thing.
    if (/^where/i.test(said) || FILEISH.test(lookFor[1]) || FILEISH.test(said)) return findAndShow(lookFor[1])
  }

  // Skills: "message sam on whatsapp: running late", "make a note saying …" (their triggers name the app).
  const skillHit = matchSkill(skills, stripName(text))
  if (skillHit) return runSkillTool(skillHit, text, { voice: opts.voice })

  const routed = routeCommand(stripName(text))
  if (routed) return runTool(routed, { voice: opts.voice })

  // Let her see the screen when she answers, so "what's this error" works. Always on the local brain (free);
  // on Gemini only when the message sounds like it is about the screen, to save quota.
  const aboutScreen = /\b(this|that|these|here|screen|error|tab|page|what am i|what i'm|see|look|fix|why)\b/i.test(text)
  const wantsScreen = brain.mode === 'ollama' || aboutScreen
  const screenshot = wantsScreen ? await captureScreen().catch(() => undefined) : undefined
  // Without a capture she must not guess what is on screen; that is where invented "screens" came from.
  const reply = await brain.respond({ kind: 'chat', text, screenshot, blind: aboutScreen && !screenshot, voice: opts.voice })
  const job = reply.tool && (reply.tool.name === 'claude' || reply.tool.name === 'claude_resume')
  const confirmFirst = job && (CONFIRM_JOBS === 'always' || (CONFIRM_JOBS === 'voice' && opts.voice))
  if (reply.tool && confirmFirst) {
    // Her "on it" would be a lie until they say yes; the read-back replaces it.
    return runTool(reply.tool, { voice: opts.voice })
  }
  if (reply.tool?.name === 'remind') {
    // Her own line about a reminder can get the time wrong (a small model said "3:15" for one at 3:37); the exact
    // confirmation is the line.
    return runTool(reply.tool, { voice: opts.voice, said: text })
  }
  if (reply.tool?.name === 'app' && !matchSkill(skills, reply.tool.input) && !/\b(?:discord|slack|claude|messages?|imessages?|imsg|texts?|texting|spotify|music|song|track)\b/i.test(text)) {
    // The quick routines only cover Discord, Slack and the Claude app. A request for another app ("text Notepad on
    // Messages") is real work for the agent when Claude is her brain. Otherwise it is either a small model replaying an
    // old request from memory ("what's on my screen?" once re-sent a Discord message), or something she cannot do yet.
    const asked = ACTION_REQUEST.test(text)
    if (asked && brain.claudeForAgent) {
      console.log(`[apps] not a Discord/Slack/Claude request; the agent takes it: ${text.slice(0, 80)}`)
      reply.tool = { name: 'computer', input: text, dir: null }
    } else {
      console.log(`[apps] ignored an app action the message did not ask for: ${reply.tool.input}`)
      reply.tool = undefined
      // Her line was about that action; never leave a direct message unanswered, and say why.
      if (/\b(?:send|sending|sent|telling|texting|messag\w*|on it)\b/i.test(reply.say)) {
        reply.say = asked
          ? 'I can only work Discord, Slack and the Claude app on my own. Pick Claude as my brain in Setup and I can do other apps too.'
          : 'Sorry, I got muddled. Say that again?'
      }
    }
  }
  await deliver(reply, 'chat')
  // (a peek she decides on is peek-a-boo, back after a bit; a typed "hide" waits to be found)
  if (reply.action && (BODY_COMMANDS as string[]).includes(reply.action)) void runBodyCommand(reply.action as BodyCommand, { boo: reply.action === 'peek' })
  if (reply.tool) void runTool(reply.tool, { voice: opts.voice, acknowledged: true })
  return reply
}

// Jobs report back in her voice when they finish.
let lastProgressAt = 0
agent.on('progress', (task: Task) => {
  const now = Date.now()
  if (now - lastProgressAt < 2000) return
  lastProgressAt = now
  status(`Claude · ${task.title} · ${task.lastTool ?? 'working'}`)
})
agent.on('end', (task: Task) => {
  refreshTray()
  // She got bored waiting (and may have dozed off): awake again, and back to work before she reports.
  const wasBored = boredStage > 0 && !agent.running().length
  if (wasBored) endBoredom()
  const folder = basename(task.cwd)
  const secs = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)
  console.log(`[hands] job ${task.id} ${task.status} after ${secs}s${task.costUsd ? ` ($${task.costUsd.toFixed(2)})` : ''}: ${task.error ?? (task.result ?? '').slice(0, 120)}`)
  journal.add('claude', `${task.status}: ${task.title} in ${folder}`)
  // A job a plan started is that step's result; the plan says what came of it.
  if (planJobs.delete(task.id)) return
  if (task.status !== 'done' && task.status !== 'failed') return
  const tell = async (): Promise<void> => {
    if (task.status === 'done') await report({ phase: 'done', title: task.title, folder, detail: (task.result || task.lastText || '').slice(0, 1500) })
    else await report({ phase: 'failed', title: task.title, folder, detail: task.error })
  }
  // A job started from the phone reports there, however long it took: they asked from there.
  const askedFrom = phoneJobs.get(task.id)
  phoneJobs.delete(task.id)
  if (askedFrom && channels.state(askedFrom)?.running) {
    void channels.run(askedFrom, tell)
    return
  }
  const speak = async (): Promise<void> => {
    if (wasBored) await sayPlain('Okay, back to work.', 'happy')
    await tell()
  }
  // Otherwise it is news: she comes over and tells them (or tells them after quiet time).
  const short = task.title.length > 60 ? `${task.title.slice(0, 57)}…` : task.title
  notices.post({
    kind: 'job',
    key: `job:${task.id}`,
    text: task.status === 'done' ? `Claude finished "${short}" in ${folder}.` : `Claude couldn't finish "${short}" in ${folder}.`,
    brief: task.status === 'done' ? `Claude finished "${short}"` : `Claude's job "${short}" failed`,
    important: true,
    log: false,
    speak
  })
})

// ---- bored while Claude works: after a few minutes of a job she yawns and slumps, then sits on the terminal (or
// the Claude app) if it is in front, then dozes off. The job's end wakes her (see agent.on('end') above).

/** minutes a Claude Code job runs before she gets bored with it; 0 = never (DESKMATE_BORED_MINUTES) */
const BORED_MIN = Number(process.env.DESKMATE_BORED_MINUTES ?? 3)
/** windows she will sit on while she waits: terminals, editors with a terminal, the Claude app */
const WORK_APPS = /terminal|iterm|warp|ghostty|kitty|alacritty|wezterm|hyper|tabby|claude|code|cursor|windsurf|zed|xcode|jetbrains|intellij|pycharm|webstorm/i
let boredStage = 0
let lastBoredFidget = 0

function endBoredom(): void {
  boredStage = 0
  body.setBored(false)
  if (body.mode === 'sleep') body.wake()
}

async function boredTick(): Promise<void> {
  const jobs = agent.running()
  if (!jobs.length) {
    if (boredStage > 0) endBoredom()
    return
  }
  if (BORED_MIN <= 0 || acting || browsing || herSpeaking || hearing || pending || !win?.isVisible()) return
  // They are talking to her: she is not bored right now.
  if (Date.now() - lastActivity < 60_000) return
  const minutes = (Date.now() - Math.min(...jobs.map((j) => j.startedAt))) / 60_000
  if (boredStage === 0 && minutes >= BORED_MIN) {
    boredStage = 1
    lastBoredFidget = Date.now()
    console.log(`[body] bored: Claude has been at it ${minutes.toFixed(1)} min`)
    body.setBored(true)
    body.gesture({ kind: 'yawn' })
  } else if (boredStage === 1 && minutes >= BORED_MIN + 1) {
    boredStage = 2
    if (!body.seat && body.mode !== 'sleep' && appHands.available) {
      const sat = await body.sitOnTopWindow({ only: (top) => WORK_APPS.test(`${top.app} ${top.bundleId}`) })
      if (sat && sat !== 'too_high') console.log(`[body] bored: sitting on ${sat} while Claude works`)
    }
  } else if (boredStage === 2 && minutes >= BORED_MIN + 3) {
    boredStage = 3
    console.log('[body] bored: dozing off')
    body.sleep()
  } else if (boredStage > 0 && body.mode !== 'sleep' && Date.now() - lastBoredFidget > 40_000) {
    lastBoredFidget = Date.now()
    body.gesture({ kind: Math.random() < 0.6 ? 'sigh' : 'yawn' })
  }
}

// ---- left alone a long while (not asleep yet), she finds something to do: lies down on the window in front, or hides
// behind the edge of the screen and peeks out for a bit (DESKMATE_IDLE_MOVES=0 turns this off).
const IDLE_MOVES = !/^(0|false|no|off)$/i.test(process.env.DESKMATE_IDLE_MOVES?.trim() || '')
/** minutes without anything happening before she gets restless */
const RESTLESS_MIN = Math.max(1, Number(process.env.DESKMATE_RESTLESS_MINUTES ?? 4))
let lastIdleMove = Date.now()

async function restlessTick(): Promise<void> {
  if (!IDLE_MOVES || body.mode !== 'idle' || body.wandering || boredStage > 0 || agent.running().length) return
  if (acting || browsing || herSpeaking || hearing || pending || !win?.isVisible()) return
  const now = Date.now()
  if (now - lastActivity < RESTLESS_MIN * 60_000 || now - lastIdleMove < RESTLESS_MIN * 2 * 60_000) return
  lastIdleMove = now
  if (appHands.available && Math.random() < 0.5) {
    const lay = await body.sitOnTopWindow({ seat: 'lie' })
    if (lay && lay !== 'too_high') {
      console.log(`[body] restless: lying on ${lay}`)
      return
    }
  }
  console.log('[body] restless: peeking from the edge of the screen')
  void body.peek({ ms: 30_000 + Math.random() * 30_000 })
}

// ---- notices: what she comes to tell you about on her own (notice.ts): jobs, messages, calendar, reminders

function noticeSettings(): NoticePrefs {
  return noticePrefs(settings.get().notices)
}

/** After she walks over for something, she goes back to her spot once nobody has needed her for a couple of minutes. */
let homeTimer: NodeJS.Timeout | null = null
function approach(): void {
  if (!win?.isVisible()) return
  void body.comeToCursor()
  if (homeTimer) clearTimeout(homeTimer)
  const at = Date.now()
  homeTimer = setTimeout(() => {
    homeTimer = null
    if (lastActivity <= at + 1000 && body.mode === 'idle' && !body.wandering && !acting && !browsing && !herSpeaking) void body.goHome()
  }, 120_000)
  homeTimer.unref()
}

const notices = new NoticeCenter({
  prefs: noticeSettings,
  say: async (n: Notice) => {
    const speak = async (): Promise<void> => {
      if (n.speak) await n.speak()
      else await sayPlain(n.text)
    }
    // With a chat app paired and on, what she tells you on her own goes there too (the one used last).
    if (channels.reachable()) await channels.runPreferred(speak)
    else await speak()
  },
  show: (text) => status(text),
  wake: () => activity(),
  approach,
  log: (kind, text) => journal.add(kind, text),
  busy: () => herSpeaking || hearing || Boolean(pending) || touching,
  gapMs: Math.max(0, Number(process.env.DESKMATE_NOTICE_GAP ?? 12) * 1000)
})

/** A line she says on her own, in her own voice when a brain is there (the plain line otherwise). */
async function sayInVoice(line: string): Promise<void> {
  if (!brain.canThink) {
    await sayPlain(line)
    return
  }
  await report({ kind: 'notice', phase: 'status', title: 'notice', detail: line })
}

function setNoticePrefs(patch: Partial<NoticePrefs>): void {
  const was = noticeSettings()
  settings.set({ notices: { ...(settings.get().notices ?? {}), ...patch } })
  const now = noticeSettings()
  if (was.dnd !== now.dnd) status(now.dnd ? 'do not disturb · I\'ll tell you what comes up later' : 'do not disturb off')
  // Quiet time may have just ended: what she held back comes now.
  notices.tick()
  if (patch.calendar) void refreshCalendarAccess()
  refreshTray()
  setupChanged()
}

/** What the renderer may change, checked field by field. */
function cleanNoticePatch(raw: unknown): Partial<NoticePrefs> {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Partial<NoticePrefs> = {}
  for (const k of ['jobs', 'messages', 'readMessages', 'calendar', 'reminders', 'scheduled', 'dnd'] as const) if (typeof p[k] === 'boolean') out[k] = p[k] as boolean
  if (typeof p.quietHours === 'string') out.quietHours = p.quietHours.trim().slice(0, 40)
  if (typeof p.calendarLead === 'number' && p.calendarLead > 0) out.calendarLead = Math.min(120, Math.round(p.calendarLead))
  for (const k of ['allowApps', 'denyApps'] as const) {
    const v = p[k]
    if (Array.isArray(v)) out[k] = v.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 40)
    else if (typeof v === 'string') out[k] = v.split(',').map((x) => x.trim().slice(0, 60)).filter(Boolean).slice(0, 40)
  }
  return out
}

function noticeState(): NoticeState {
  const saved = settings.get().notices
  return {
    prefs: noticeSettings(),
    quietNow: notices.quiet(),
    quietFromEnv: saved?.quietHours === undefined && Boolean(process.env.DESKMATE_QUIET_HOURS?.trim()),
    calendarAccess,
    accessibility: appHands.available ? appTrusted : null
  }
}

// Messages: the banners Notification Center shows, read every few seconds (inbox.ts).
const bannerWatch = new BannerWatch()
const BANNER_POLL_MS = Math.max(1, Number(process.env.DESKMATE_BANNER_POLL) || 3) * 1000
/** Testing under a Focus (macOS shows no banners then): new entries in the open Notification Center panel count too. */
const DEBUG_PANEL_BANNERS = /^(1|true|yes|on)$/i.test(process.env.DESKMATE_DEBUG_PANEL_BANNERS?.trim() || '')
let bannerPolling = false
async function pollBanners(): Promise<void> {
  const prefs = noticeSettings()
  if (bannerPolling || !prefs.messages || !appHands.available || appTrusted === false) return
  bannerPolling = true
  try {
    let list = await appHands.banners().catch(() => null)
    if (!list) return
    if (DEBUG_PANEL_BANNERS) list = list.map((b) => ({ ...b, inPanel: false }))
    for (const b of bannerWatch.update(list)) {
      if (!appAllowed(b.app, prefs)) {
        console.log(`[inbox] not mentioned: a notification from ${b.app || 'an unnamed app'}`)
        continue
      }
      const line = messageLine(b, prefs.readMessages)
      console.log(`[inbox] ${b.app}: ${line.text.slice(0, 90)}`)
      recentBanners.push({ at: Date.now(), text: line.text })
      if (recentBanners.length > 20) recentBanners.shift()
      notices.post({ kind: 'message', key: `message:${b.app}|${b.title}|${b.subtitle}|${b.body}`, text: line.text, brief: line.brief })
    }
  } finally {
    bannerPolling = false
  }
}

// Calendar: events about to start, read through EventKit (calendar.ts). Each one is mentioned once.
let calendarAccess = 'unknown'
const calendarMentioned = new Set<string>()
async function refreshCalendarAccess(): Promise<string> {
  calendarAccess = appHands.available ? await appHands.calendarStatus().catch(() => 'unknown') : 'unavailable'
  return calendarAccess
}

async function pollCalendar(): Promise<void> {
  const prefs = noticeSettings()
  if (!prefs.calendar || calendarAccess !== 'fullAccess') return
  // DESKMATE_DEBUG_CALENDAR_LEAD: a longer lead than Setup allows, to try the nudge against a real event hours away.
  const lead = Number(process.env.DESKMATE_DEBUG_CALENDAR_LEAD) || prefs.calendarLead
  const events = await appHands.calendarEvents(lead + 2, 2).catch((err) => {
    console.warn(`[calendar] ${(err as Error).message}`)
    return null
  })
  if (!events) return
  for (const due of dueEvents(events, Date.now(), lead, calendarMentioned)) {
    calendarMentioned.add(due.key)
    const line = eventLine(due.event, due.minutes)
    console.log(`[calendar] ${line}`)
    notices.post({ kind: 'calendar', key: `calendar:${due.key}`, text: line, important: true, speak: () => sayInVoice(line) })
  }
}

/** "What's on my calendar today?", "what's next?": read straight from the calendar. */
async function calendarAnswer(which: 'today' | 'tomorrow' | 'next'): Promise<Reply> {
  const r = await calendarLine(which)
  return sayPlain(r.line, r.ok ? 'neutral' : 'sad')
}

/** The calendar for today, tomorrow or the next event, as one line. */
async function calendarLine(which: 'today' | 'tomorrow' | 'next'): Promise<{ ok: boolean; line: string }> {
  const line = (text: string, emotion: Emotion = 'neutral'): { ok: boolean; line: string } => ({ ok: emotion !== 'sad', line: text })
  if (!appHands.available) return line('I need my hands helper to read your calendar (it comes with the Mac app).', 'sad')
  if ((await refreshCalendarAccess()) === 'notDetermined') {
    status('asking macOS for your calendars…')
    await appHands.requestCalendarAccess()
    await refreshCalendarAccess()
    setupChanged()
  }
  if (calendarAccess !== 'fullAccess') {
    return line("I can't see your calendar. Let me in: System Settings → Privacy & Security → Calendars, switch me on, then ask again.", 'sad')
  }
  const now = new Date()
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const sinceMidnight = (now.getTime() - startOfDay.getTime()) / 60_000
  let events: CalendarEvent[]
  try {
    if (which === 'today') {
      events = await appHands.calendarEvents(24 * 60 - sinceMidnight, sinceMidnight)
    } else if (which === 'tomorrow') {
      const from = startOfDay.getTime() + 86_400_000
      events = (await appHands.calendarEvents(48 * 60 - sinceMidnight, 0)).filter((e) => e.start >= from && e.start < from + 86_400_000)
    } else {
      events = (await appHands.calendarEvents(7 * 24 * 60, 0)).filter((e) => !e.allDay && !e.cancelled && e.start > now.getTime())
      const next = events[0]
      if (!next) return line('Nothing on your calendar in the next week.')
      return line(`Next up: ${next.title || 'an event'} ${whenText(next.start, now.getTime())}.`)
    }
  } catch (err) {
    return line(`I couldn't read your calendar: ${(err as Error).message}`, 'sad')
  }
  journal.add('calendar', `read the calendar for ${which}`)
  return line(agendaLine(events, now.getTime(), which))
}

// Reminders and timers (reminders.ts): kept in reminders.json, fired through notices like an alarm (even in quiet time).
const reminderStore = new ReminderStore(join(USER_DATA, 'reminders.json'), (r, lateMs) => {
  const line = dueLine(r, lateMs)
  console.log(`[reminders] due: ${line}`)
  notices.post({ kind: 'reminder', key: `reminder:${r.id}`, text: line, important: true, urgent: true, speak: () => sayInVoice(line) })
  refreshTray()
})
/** "Remind me to stretch" without a time: what to remind them of, while she waits for "in 20 minutes". */
let reminderAsk: { text: string; timer: boolean; at: number } | null = null

function remindersMenu(): Electron.MenuItemConstructorOptions[] {
  const list = reminderStore.list()
  if (!list.length) return []
  const now = Date.now()
  return [
    {
      label: `Reminders (${list.length})`,
      submenu: list.slice(0, 12).map((r) => ({
        label: `Cancel: ${r.timer && / timer$/.test(r.text) ? r.text : r.text || 'reminder'} · ${whenText(r.at, now)}`,
        click: () => {
          reminderStore.remove(r.id)
          journal.add('reminder', `cancelled: ${r.text}`)
          refreshTray()
        }
      }))
    }
  ]
}

const REMIND_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['set', 'list', 'cancel', 'none'] },
    in_minutes: { type: ['number', 'null'] },
    at: { type: ['string', 'null'] },
    what: { type: 'string' },
    timer: { type: 'boolean' },
    all: { type: 'boolean' }
  },
  required: ['action', 'in_minutes', 'at', 'what', 'timer', 'all']
}

/** The odd phrasing the parser does not know ("nudge me after lunch… say 1:30"): her brain reads it into the same shape. */
async function reminderFromBrain(input: string): Promise<ReminderIntent | null> {
  const now = new Date()
  const local = `${now.toDateString()} ${now.toTimeString().slice(0, 5)}`
  const obj = await brain
    .plan(
      `You read a request about reminders or timers. Now it is ${local} (local time). Reply with ONE JSON object: {"action": "set"|"list"|"cancel"|"none", "in_minutes": number|null (a length of time from now), "at": "YYYY-MM-DDTHH:MM"|null (a local clock time), "what": string (what to remind them of, in second person, or the timer's label; for cancel, words that name the reminder), "timer": boolean, "all": boolean (cancel all)}. "none" when it is not about reminders or timers, or no time is given for a new one.`,
      input,
      REMIND_SCHEMA
    )
    .catch(() => null)
  if (!obj) return null
  const what = toSecondPerson(String(obj.what ?? '').trim())
  const timer = Boolean(obj.timer)
  if (obj.action === 'list') return { kind: 'list' }
  if (obj.action === 'cancel') return { kind: 'cancel', query: what, all: Boolean(obj.all), timer }
  if (obj.action !== 'set') return null
  const minutes = Number(obj.in_minutes)
  if (minutes > 0) return { kind: 'set', at: Date.now() + minutes * 60_000, text: what || (timer ? timerName(minutes * 60_000) : ''), timer, ms: minutes * 60_000 }
  const at = typeof obj.at === 'string' ? new Date(obj.at).getTime() : NaN
  if (at > Date.now()) return { kind: 'set', at, text: what, timer }
  return what ? { kind: 'needTime', text: what, timer } : null
}

async function remindTool(input: string, said?: string): Promise<Reply> {
  let intent = parseReminder(input)
  // From her brain: a time in their own words wins over the model's retelling of it.
  const own = said ? timeIn(said) : null
  if (own && intent?.kind === 'set' && own.at !== intent.at) {
    console.log(`[reminders] the model said ${new Date(intent.at).toTimeString().slice(0, 5)}; they said ${new Date(own.at).toTimeString().slice(0, 5)}`)
    intent = { ...intent, at: own.at, ...(own.ms ? { ms: own.ms } : {}) }
  }
  if (!intent && brain.canThink) {
    status('working out when…')
    intent = await reminderFromBrain(input)
  }
  if (!intent) return sayPlain('Say it like "remind me in 20 minutes to stretch", or "set a timer for 5 minutes".')
  const now = Date.now()
  switch (intent.kind) {
    case 'set': {
      reminderAsk = null
      const r = reminderStore.add({ text: intent.text, at: intent.at, timer: intent.timer, ...(intent.ms ? { ms: intent.ms } : {}) })
      console.log(`[reminders] set ${r.timer ? 'timer' : 'reminder'} "${r.text}" for ${new Date(r.at).toString()}`)
      journal.add('reminder', `set: ${r.text} ${whenText(r.at, now)}`)
      refreshTray()
      return sayPlain(setLine(r, now), 'happy')
    }
    case 'needTime':
      reminderAsk = { text: intent.text, timer: intent.timer, at: now }
      return sayPlain(intent.timer ? 'For how long?' : `Sure. When should I remind you${intent.text ? ` to ${intent.text}` : ''}?`)
    case 'list':
      return sayPlain(listLine(reminderStore.list(), now))
    case 'cancel': {
      const hits = reminderStore.match(intent)
      if (!hits.length) {
        if (!reminderStore.list().length) return sayPlain('There are no reminders or timers to cancel.')
        return sayPlain(`I couldn't tell which one. ${listLine(reminderStore.list(), now)}`)
      }
      for (const r of hits) reminderStore.remove(r.id)
      journal.add('reminder', `cancelled: ${hits.map((r) => r.text).join('; ')}`)
      refreshTray()
      const name = (r: Reminder): string => (r.timer ? (/ timer$/.test(r.text) ? `the ${r.text}` : `the ${r.text} timer`) : r.text ? `the reminder to ${r.text}` : 'the reminder')
      return sayPlain(hits.length > 1 ? `Cancelled all ${hits.length}.` : `Cancelled ${name(hits[0])}.`)
    }
  }
}

// ---- the agent core: one Claude tool-use loop over every worker (core.ts), with zero-latency shortcuts in front
// (fastpath.ts) and the MCP servers from <user data>/mcp.json as extra tools. Gemini and Ollama keep the routing above.

/** DESKMATE_AGENT_CORE=0 keeps the older routing even with a Claude brain. */
const AGENT_CORE = !/^(0|false|no|off)$/i.test(process.env.DESKMATE_AGENT_CORE?.trim() || '')
const AGENT_ROUNDS = Math.max(2, Number(process.env.DESKMATE_AGENT_ROUNDS) || 10)
const MCP_CONFIG = join(USER_DATA, 'mcp.json')
const mcp = new McpHub({
  configPath: MCP_CONFIG,
  isEnabled: (name, config) => !config.disabled && !(settings.get().mcpDisabled ?? []).includes(name),
  journal: (text) => journal.add('mcp', text),
  log: (line) => console.log(line),
  version: app.getVersion()
})
/** The message banners she saw lately (as Setup lets her read them), for "anything new?". */
const recentBanners: { at: number; text: string }[] = []
let agentBusy = false

function confirmFor(policy: 'always' | 'voice' | 'never', ctx: ToolCtx): boolean {
  // The guard already asked about this exact call (a scheduled run): no second read-back.
  if (ctx.approved) return false
  return ctx.mustConfirm || policy === 'always' || (policy === 'voice' && ctx.origin === 'voice')
}

const done = (text: string, say = text): ToolOutcome => ({ ok: true, text, say })
const failed = (text: string, say = text): ToolOutcome => ({ ok: false, text, say })

/** Her hands need Accessibility for keys; the AppleScript routines (Messages, Spotify) do not. */
async function handsReady(needsKeys: boolean): Promise<ToolOutcome | null> {
  if (!appHands.available) return failed(handsMessage(new HandsError('', 'unavailable')))
  if (needsKeys && !(await checkAppTrust())) {
    askForAccessibility()
    return failed('I need Accessibility to press keys for you. Turn it on in the window I just opened, then ask me again.')
  }
  return null
}

async function appRoutine(req: AppRequest, ctx: ToolCtx): Promise<ToolOutcome> {
  const blocked = await handsReady(req.app !== 'messages' && req.app !== 'spotify')
  if (blocked) return blocked
  const log = taskLogger(`app-${req.app}`)
  log(`request: ${JSON.stringify(req)} (agent core, ${ctx.origin})`)
  const r = await runApp(req, {
    hands: appHands,
    confirm,
    confirmMessages: confirmFor(CONFIRM_SENDS, ctx),
    confirmPrompts: confirmFor(CONFIRM_JOBS, ctx),
    onStep: status,
    log,
    stopped: () => ctx.stopped(),
    portrait
  })
  journal.add('app', r.summary)
  return { ok: r.ok, text: `${r.summary}${r.where ? ` (in ${r.where})` : ''}`, say: r.say }
}

/** The workers, for the agent core and the shortcuts. Each one returns facts for her brain and a plain line. */
const workerHost: WorkerHost = {
  sendToMe: (a, ctx) => sendToMe(a, ctx),
  sendMessage: (a, ctx) => appRoutine({ app: a.app, action: 'message', to: a.to, text: a.text, photo: a.photo }, ctx),
  openChat: (a, ctx) => appRoutine({ app: a.app, action: 'open', to: a.to, text: '' }, ctx),
  async spotify(a, ctx) {
    if (a.action === 'play_query') {
      if (brain.claudeForAgent && appHands.available) return workerHost.useComputer({ goal: `In Spotify, find and play ${a.query}.` }, ctx)
      return appRoutine({ app: 'spotify', action: 'play_query', to: '', text: a.query }, ctx)
    }
    return appRoutine({ app: 'spotify', action: 'control', to: '', text: a.action === 'now_playing' ? 'now' : a.action }, ctx)
  },
  askClaudeApp: (a, ctx) => appRoutine({ app: 'claude', action: 'prompt', to: '', text: a.prompt }, ctx),
  async claudeCode(a, ctx) {
    if (!hands) return failed("I can't find Claude Code on this computer. Install it and log in once, then ask me again.")
    const project = projects.resolve(a.folder) ?? mentionedProject(projects.list(), a.instruction) ?? projects.current() ?? (a.resume ? lastJobProject() : null)
    if (!project) {
      const known = projects.list().slice(0, 12).map((p) => p.name).join(', ')
      return failed(`Which folder? Known projects: ${known || 'none yet'}. Ask the user which one.`, 'Which folder? Pick one under "Claude works in" in my menu, or say it: "in the vlog".')
    }
    if (!a.resume && !a.instruction.trim()) return failed('Tell me what Claude should do.')
    const busy = agent.running().find((t) => t.cwd === project.path)
    if (busy) return failed(`Claude is still busy in ${project.name} with "${busy.title}".`, `Claude is still busy in ${project.name} with "${busy.title}". Say "stop the task", or wait.`)
    const title = a.resume ? (a.instruction ? `continue, then: ${a.instruction}` : 'continue the last session') : a.instruction
    // A misheard sentence must never start a job; nor may a page or a message that talked her into it.
    if (confirmFor(CONFIRM_JOBS, ctx) && !(await confirm(`Send this to Claude in ${project.name}: ${title}?`))) {
      return failed('The user said no; no job was started.', 'Dropped. Not sending that.')
    }
    let task: Task
    try {
      const resume = a.resume ? agent.latestFor(project.path)?.sessionId ?? 'last' : undefined
      task = agent.run({ prompt: a.instruction, cwd: project.path, resume })
    } catch (err) {
      return failed(`I couldn't start Claude: ${(err as Error).message}`)
    }
    console.log(`[hands] job ${task.id} in ${project.path}: ${task.title}`)
    if (channels.activeChannel) phoneJobs.set(task.id, channels.activeChannel)
    status(`Claude · ${task.title} · starting…`)
    refreshTray()
    return done(`Started a Claude Code job in ${project.name}: "${task.title}". It runs in the background and you will hear when it is done.`, `On it: Claude's working in ${project.name}.`)
  },
  async claudeJobs(a) {
    if (a.action === 'status') {
      const detail = agent.describe()
      return done(detail || 'No Claude jobs have run yet.', detail ? detail.split('\n')[0] : 'No Claude jobs yet.')
    }
    const task = agent.cancel()
    refreshTray()
    return task ? done(`Stopped the job "${task.title}" in ${basename(task.cwd)}.`) : done("Nothing's running right now.")
  },
  async browse(a, ctx) {
    if (!chrome.chromeAvailable()) return failed('I can only drive Chrome on a Mac for now.')
    if (browsing) return failed("I'm already in the middle of something in Chrome.")
    browsing = true
    browseStop = false
    refreshTray()
    const log = taskLogger('browse')
    status(`browsing · ${a.goal.slice(0, 40)}`)
    try {
      const r = await browse(a.goal, { plan: (system, user, schema) => brain.plan(system, user, schema), confirm, onStep: status, log, stopped: () => browseStop || ctx.stopped() })
      console.log(`[browse] ${r.ok ? 'done' : 'stopped'} after ${r.steps} step(s): ${r.answer.slice(0, 120)}`)
      journal.add('browse', `${a.goal} → ${r.answer.slice(0, 200)}`)
      return { ok: r.ok, text: `${r.ok ? 'Found' : 'Stopped before the end'}${r.url ? ` (at ${r.url})` : ''}:\n${untrusted('web', r.answer, r.url)}`, untrusted: 'web' }
    } catch (err) {
      return failed(chromeMessage(err))
    } finally {
      browsing = false
      refreshTray()
    }
  },
  async readPage() {
    try {
      const page = await chrome.pageText(8000)
      status(`reading ${page.title.slice(0, 40) || page.url}…`)
      return { ok: true, text: `"${page.title}" (${page.url}):\n${untrusted('web', page.text, page.url)}`, untrusted: 'web' }
    } catch (err) {
      return failed(chromeMessage(err))
    }
  },
  async browserTab(a) {
    const r = await chromeAct(a.text ? `${a.verb === 'find_on_page' ? 'find' : a.verb}:${a.text}` : a.verb)
    if (r.quiet) status(r.line)
    return { ok: r.ok, text: r.line || 'Done.', say: r.quiet ? '' : r.line }
  },
  async open(a) {
    const r = await openTarget(a.target)
    return { ok: r.ok, text: r.line, say: r.line }
  },
  async findFile(a) {
    const hit = await findAndReveal(a.query)
    if (!hit) return failed(`Nothing called ${a.query} on this Mac.`, `I couldn't find anything called ${a.query} on this Mac.`)
    const more = hit.more > 0 ? ` There ${hit.more === 1 ? 'is one more' : `are ${hit.more} more`} with that name.` : ''
    return done(`Found ${hit.name} at ${hit.path}; it is selected in Finder and you are pointing at it.${more}`, `Here: ${hit.name}, in ${hit.where}.${more}`)
  },
  async useComputer(a, ctx) {
    if (!brain.claudeForAgent) return failed('That needs Claude as my brain.')
    const blocked = await handsReady(true)
    if (blocked) return blocked
    const r = await agentGoal(a.goal, taskLogger('computer'), () => ctx.stopped())
    console.log(`[computer] ${r.ok ? 'done' : 'not done'} after ${r.steps} step(s): ${r.answer.slice(0, 160)}`)
    journal.add('mac', `${a.goal} → ${r.answer.slice(0, 200)}`)
    // What it says comes from reading the screen.
    return { ok: r.ok, text: r.answer, say: r.answer, untrusted: 'screen' }
  },
  async seeScreen() {
    const shot = await captureScreen().catch(() => undefined)
    if (!shot) return failed('No screenshot: Screen Recording is not allowed for me. Tell the user to allow it in System Settings and restart me.')
    return { ok: true, text: 'Screenshot of their screen attached (her own window is greyed out).', image: shot, untrusted: 'screen' }
  },
  async setReminder(a) {
    const now = Date.now()
    const at = a.in_minutes !== null && a.in_minutes > 0 ? now + a.in_minutes * 60_000 : a.at ? new Date(a.at).getTime() : NaN
    if (!Number.isFinite(at)) return failed('Give in_minutes or at.', 'When should I remind you?')
    if (at < now - 30_000) return failed(`${a.at} has already passed; ask the user or pick the next one.`)
    const ms = a.in_minutes !== null ? Math.round(a.in_minutes * 60_000) : undefined
    // "Write your standup notes." reads as "remind you to write your standup notes".
    const words = a.text.trim().replace(/[.!]+$/, '')
    const text = (/^[A-Z][a-z]/.test(words) ? words[0].toLowerCase() + words.slice(1) : words) || (a.timer && ms ? timerName(ms) : '')
    const r = reminderStore.add({ text, at, timer: a.timer, ...(ms ? { ms } : {}), ...(a.repeat !== 'none' ? { repeat: a.repeat } : {}) })
    console.log(`[reminders] set ${r.timer ? 'timer' : 'reminder'} "${r.text}" for ${new Date(r.at).toString()}${r.repeat ? `, ${r.repeat}` : ''}`)
    journal.add('reminder', `set: ${r.text} ${whenText(r.at, now)}${r.repeat ? ` (${r.repeat})` : ''}`)
    refreshTray()
    const line = setLine(r, now)
    return done(line, line)
  },
  async listReminders() {
    const line = listLine(reminderStore.list(), Date.now())
    return done(line, line)
  },
  async cancelReminder(a) {
    const hits = reminderStore.match({ query: a.query, all: a.all, timer: false })
    if (!hits.length) return failed(`No reminder matches. ${listLine(reminderStore.list(), Date.now())}`)
    for (const r of hits) reminderStore.remove(r.id)
    journal.add('reminder', `cancelled: ${hits.map((r) => r.text).join('; ')}`)
    refreshTray()
    const line = hits.length > 1 ? `Cancelled all ${hits.length}.` : `Cancelled the reminder to ${hits[0].text}.`
    return done(line, line)
  },
  async makePlan(a) {
    const r = await planFor(a.goal)
    return { ok: r.ok, text: r.ok ? `${r.line} (The plan is on the card beside you; it waits for their go.)` : r.line, say: r.line }
  },
  async scheduleJob(a) {
    const r = resolveSchedule(a)
    if ('error' in r) return failed(r.error)
    const job = scheduleStore.add({ task: a.task, rule: r.rule, when: a.when, mode: a.as_plan ? 'plan' : 'agent' })
    console.log(`[schedule] new job "${job.label}": ${ruleText(job.rule, job.tz)}, first run ${job.nextAt ? new Date(job.nextAt).toString() : 'never'}`)
    journal.add('schedule', `set up "${job.label}" ${ruleText(job.rule, job.tz)}`)
    refreshTray()
    setupChanged()
    const line = scheduledLine(job, Date.now())
    return done(useAgentCore() ? line : `${line} (Without Claude as my brain I can only remind you when it comes round.)`, line)
  },
  async listJobs() {
    const line = jobsLine(scheduleStore.list(), scheduleStore.waiting(), Date.now())
    return done(line, line)
  },
  async changeJob(a) {
    const r = changeJob(scheduleStore, a)
    if (r.ok) journal.add('schedule', r.text)
    if (r.run) scheduler.runNow(r.run)
    refreshTray()
    setupChanged()
    return { ok: r.ok, text: r.text, say: r.text }
  },
  async calendar(a) {
    const r = await calendarLine(a.which)
    return { ok: r.ok, text: r.line, say: r.line }
  },
  async recallDay(a) {
    const log = journal.describe(a.day === 'yesterday' ? -1 : 0)
    return done(log || '(nothing logged)', log ? log.split('\n').slice(-3).join(' ') : 'Nothing yet.')
  },
  async recentMessages() {
    const fresh = recentBanners.filter((b) => Date.now() - b.at < 6 * 60 * 60_000)
    if (!fresh.length) return done('No message notifications in the last few hours.')
    const lines = fresh.map((b) => `${new Date(b.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${b.text}`).join('\n')
    return { ok: true, text: untrusted('notification', lines), untrusted: 'notification' }
  },
  async move(a) {
    if ((BODY_COMMANDS as string[]).includes(a.action)) {
      const line = await runBodyCommand(a.action as BodyCommand, { boo: a.action === 'peek' })
      return line ? failed(line) : done(`Moving: ${a.action}.`, '')
    }
    sendCommand(a.action)
    return done(`Doing it: ${a.action}.`, '')
  },
  async remember(a) {
    const importance = Math.min(5, Math.max(1, Math.round(a.importance)))
    const [r] = memory.remember([{ text: a.fact, importance, section: a.section }])
    if (r?.ok && importance >= 3) journal.add('memory', `kept: ${a.fact}`)
    return r ? { ok: r.ok, text: r.text, say: '' } : failed('Nothing to keep.')
  },
  async updateMemory(a) {
    const r = memFiles.update(a.old, a.new)
    if (r.ok) journal.add('memory', `changed: ${a.old} → ${a.new}`)
    return { ok: r.ok, text: r.text, say: '' }
  },
  async forget(a) {
    const r = memFiles.remove(a.what)
    if (r.ok) {
      journal.add('memory', `forgot: ${a.what}`)
      return { ok: true, text: r.text, say: '' }
    }
    const faded = memory.forget(a.what)
    return faded ? done(`Forgot "${faded}".`, '') : { ok: false, text: r.text, say: '' }
  },
  async searchPast(a) {
    const category: PastCategory | undefined = a.kind === 'any' ? undefined : a.kind
    const since = a.days_back ? Date.now() - a.days_back * 86_400_000 : undefined
    try {
      let hits = past.search(a.query, { category, since, limit: 12 })
      // Nothing in that window: say so, and look further back once.
      let wider = ''
      if (!hits.length && since) {
        hits = past.search(a.query, { category, limit: 8 })
        if (hits.length) wider = `Nothing in the last ${a.days_back} day(s); from further back:\n`
      }
      if (!hits.length) return done(`Nothing about "${a.query}" in the chat archive, the day logs or the plans.`, "I don't have anything on that.")
      // Old logs hold what pages, screens and messages said, so the lines go in as data.
      return { ok: true, text: `${wider}${untrusted('past', describeHits(hits))}`, untrusted: 'past' }
    } catch (err) {
      console.warn('[past]', (err as Error).message)
      return failed(`Search is not working: ${(err as Error).message}`)
    }
  },
  async readSkill(a) {
    const g = findGuide(guides, a.name)
    if (!g) return failed(`No skill called ${a.name}. Skills: ${guides.map((x) => x.name).join(', ') || 'none'}.`)
    if (!a.file) {
      console.log(`[skills] read ${g.name}`)
      return done(describeGuide(g), '')
    }
    const p = guidePath(g, a.file)
    if (!p) return failed(`${a.file} is not one of the ${g.name} skill's files: ${g.files.join(', ') || 'none'}.`)
    try {
      return done(readFileSync(p, 'utf8').slice(0, 20_000), '')
    } catch (err) {
      return failed(`Could not read ${a.file}: ${(err as Error).message}`)
    }
  },
  async runSkillScript(a, ctx) {
    const g = findGuide(guides, a.name)
    if (!g) return failed(`No skill called ${a.name}.`)
    if (!SKILL_CODE && g.source === 'user') return failed('Skill scripts are off. They run only when Deskmate is started with DESKMATE_SKILL_CODE=1; tell the user.', "Skill scripts are off on this Mac.")
    const p = g.scripts.includes(a.script) ? guidePath(g, a.script) : null
    if (!p) return failed(`${a.script} is not one of the ${g.name} skill's scripts: ${g.scripts.join(', ') || 'none'}.`)
    // The user says yes to a skill's scripts once; a change to any of them asks again.
    const hash = scriptsHash(g)
    const allowed = settings.get().skillScripts ?? {}
    if (allowed[g.name] !== hash) {
      if (!(await confirm(`The ${g.name.replace(/-/g, ' ')} skill wants to run its script ${basename(a.script)} on this Mac. Allow its scripts from now on?`))) {
        return failed('The user said no; the script did not run.', 'Okay, not running it.')
      }
      settings.set({ skillScripts: { ...allowed, [g.name]: hash } })
      journal.add('skill', `allowed the scripts of ${g.name}`)
    }
    const ext = a.script.split('.').pop()?.toLowerCase()
    const [cmd, args, env]: [string, string[], NodeJS.ProcessEnv] =
      ext === 'py'
        ? ['python3', [p, ...a.args], {}]
        : ext === 'sh' || ext === 'bash'
          ? ['/bin/bash', [p, ...a.args], {}]
          : ext === 'js' || ext === 'mjs' || ext === 'cjs'
            ? [process.execPath, [p, ...a.args], { ELECTRON_RUN_AS_NODE: '1' }]
            : [p, a.args, {}]
    status(`skill · ${g.name} · ${basename(a.script)}`)
    const out = await new Promise<{ ok: boolean; text: string }>((resolve) => {
      execFile(cmd, args, { cwd: g.dir, timeout: 120_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: homedir(), LANG: process.env.LANG ?? 'en_US.UTF-8', ...env } }, (err, stdout, stderr) => {
        const text = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 8000)
        resolve({ ok: !err, text: err ? `${err.message}\n${text}` : text || '(no output)' })
      })
    })
    journal.add('skill', `ran ${g.name}/${a.script}: ${out.ok ? 'ok' : 'failed'}`)
    if (ctx.stopped()) return failed('Stopped.')
    return { ok: out.ok, text: untrusted('skill', out.text, `${g.name}/${a.script}`), untrusted: 'skill' }
  },
  async runSkill(skill, slots, ctx) {
    const blocked = await handsReady(true)
    if (blocked) return blocked
    const log = taskLogger(`skill-${skill.name}`)
    console.log(`[skills] ${skill.name} ${JSON.stringify(slots).slice(0, 120)}`)
    const r = await runSkill(skill, slots, skillDeps(log, () => ctx.stopped(), confirmFor(CONFIRM_SENDS, ctx)))
    journal.add('app', r.summary)
    return { ok: r.ok, text: r.ok ? r.say : `${r.say} (${r.summary})`, say: r.say }
  }
}

/** The tool list right now: what this computer can do, the skills, and the connected MCP servers. */
function currentTools(): ToolSpec[] {
  return buildTools(workerHost, {
    skills: appHands.available ? skills : [],
    guides: { any: guides.some((g) => !g.routine), scripts: guides.some((g) => g.scripts.length > 0 && (SKILL_CODE || g.source === 'bundled')) },
    external: mcp.tools(),
    has: { computer: Boolean(brain.claudeForAgent) && appHands.available, chrome: chrome.chromeAvailable(), claudeCode: hands, apps: process.platform === 'darwin' || appHands.available, channel: channels.active }
  })
}

function useAgentCore(): boolean {
  return AGENT_CORE && Boolean(brain.claudeForAgent)
}

/** The instruction skills for her prompt (the routines are tools of their own). */
function skillLines(): string {
  return guideIndex(guides.filter((g) => !g.routine))
}

/** A note on the state she is in, for her brain: a plan on the card, Claude jobs running. */
function turnContext(): string | undefined {
  const notes: string[] = []
  if (plan && (plan.status === 'draft' || plan.status === 'paused' || plan.status === 'running')) notes.push(`[A plan is on the card (${plan.status}): "${plan.title}". "go", "pause" and "stop the plan" work on it.]`)
  const running = agent.running()
  if (running.length) notes.push(`[Claude Code jobs running: ${running.map((t) => `"${t.title}" in ${basename(t.cwd)}`).join('; ')}]`)
  return notes.join('\n') || undefined
}

/**
 * A message through the agent core: a shortcut when the command is unambiguous, else one agent turn. Returns null to
 * hand the message to the older routing (no Claude brain, or Claude unreachable before anything was done).
 */
async function agentDispatch(text: string, opts: { voice?: boolean }): Promise<Reply | null> {
  const from = channels.activeChannel
  const origin: Origin = from ? 'phone' : opts.voice ? 'voice' : 'typed'
  const said = stripName(text)
  const tools = currentTools()
  const fast = fastRoute(said, { skills: appHands.available ? skills : [], channel: Boolean(from) })
  if (fast && tools.some((t) => t.name === fast.tool)) {
    if (agentBusy || acting) return sayPlain("I'm already doing something. Say \"stop\" first.", 'annoyed')
    acting = true
    actStop = false
    refreshTray()
    console.log(`[agent] shortcut (${fast.why}): ${fast.tool} ${JSON.stringify(fast.input).slice(0, 120)}`)
    try {
      const { out, record } = await runOneTool(tools, fast.tool, fast.input, { origin, confirm, onStep: status, log: taskLogger('shortcut'), stopped: () => actStop || quitting })
      memory.addTurn('user', text)
      // As after an agent turn: the history says what was done, so the next turn knows (names only).
      memory.addTurn('user', `[you used: ${fast.tool} (${record.refused ? 'the user said no' : out.ok ? 'done' : 'not done'})]`)
      const line = out.say ?? (out.untrusted ? '' : out.text)
      if (!line) return QUIET
      memory.addTurn('assistant', line)
      return sayPlain(line, out.ok ? 'happy' : 'sad')
    } finally {
      acting = false
      refreshTray()
      status(listening ? listeningStatus() : 'idle')
    }
  }
  const claude = brain.claudeForAgent
  if (!claude) return null
  if (agentBusy || acting) return sayPlain("I'm still on the last thing. Say \"stop\" to cut it short.", 'annoyed')
  // Let her see the screen when the message is about it ("what's this error").
  const aboutScreen =
    /\b(?:screen|error|window|what am i|what i'm|(?:see|look at|looking at|read) (?:this|that|it|here)|what(?:'s| is) (?:this|that)|this (?:page|tab|error|window|thing|code|message|email|bug)|fix (?:this|that|it))\b/i.test(said) &&
    !/\b(?:message|text|tell|remind|timer)\b/i.test(said)
  const screenshot = aboutScreen ? await captureScreen().catch(() => undefined) : undefined
  agentBusy = acting = true
  actStop = false
  refreshTray()
  status('thinking…')
  const log = taskLogger('agent')
  log(`message (${origin}): ${text}`)
  let modelCalls = 0
  try {
    const result = await runAgentTurn(
      {
        text: said,
        origin,
        persona,
        memory: memory.notesBlock(),
        recent: memory.recentBlock(),
        skills: skillLines(),
        history: memory.recentTurns(12).map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', text: t.text })),
        now: new Date(),
        screenshot,
        context: turnContext(),
        channel: from ? CHANNEL_LABELS[from] : undefined
      },
      {
        model: async (req) => {
          modelCalls++
          return callClaude(claude.client, { ...req, model: claude.model, effort: claude.effort, maxTokens: 16000 })
        },
        tools,
        confirm,
        onStep: (line) => status(line),
        log,
        stopped: () => actStop || quitting,
        onSay: (line) => {
          if (line) void sayPlain(line)
        },
        maxRounds: AGENT_ROUNDS
      }
    )
    console.log(`[agent] ${result.rounds} round(s)${result.calls.length ? `: ${result.calls.map((c) => `${c.name}${c.ok ? '' : ' ✗'}`).join(', ')}` : ''}${result.tainted.length ? ` (read ${result.tainted.join(', ')})` : ''}`)
    memory.addTurn('user', text)
    // What she did goes into the history as names only: tool output can hold someone else's text.
    if (result.calls.length) memory.addTurn('user', `[you used: ${result.calls.map((c) => `${c.name} (${c.refused ? 'the user said no' : c.ok ? 'done' : 'not done'})`).join(', ')}]`)
    const reply: Reply = { say: result.say, emotion: result.emotion, speak: true, remember: [] }
    memory.addTurn('assistant', reply.say)
    await deliver(reply, 'chat')
    void learnFrom(said, result, claude)
    return reply
  } catch (err) {
    const e = err instanceof ClaudeError ? err : toClaudeError(err)
    console.warn(`[agent] ${e.code}: ${e.message}`)
    log(`error: ${e.message}`)
    // Nothing done yet and Claude is just unreachable: the older routing (and a local model, when there is one) answers.
    if (modelCalls <= 1 && (e.code === 'rate' || e.code === 'overloaded' || e.code === 'network')) return null
    const say =
      e.code === 'auth'
        ? 'My Anthropic key stopped working. Fix it in Setup, from my menu.'
        : e.code === 'refusal'
          ? "Mm, I'm not touching that one."
          : `I can't reach Claude right now (${e.message.slice(0, 100)}). Try me again in a minute.`
    return sayPlain(say, 'sad')
  } finally {
    agentBusy = acting = false
    refreshTray()
    status(listening ? listeningStatus() : 'idle')
  }
}

// ---- scheduled jobs (schedule.ts, scheduler.ts), the heartbeat (heartbeat.ts) and the morning brief (brief.ts)

/** minutes without the keyboard or mouse before she counts the user as away (DESKMATE_AWAY_MINUTES, default 10) */
const AWAY_MS = Math.max(1, Number(process.env.DESKMATE_AWAY_MINUTES) || 10) * 60_000
/** how long a question from a scheduled run waits on the phone before the step waits for the desk instead */
const PHONE_ASK_MS = 15 * 60_000
let screenLocked = false
let macAsleep = false
let wasPresent = true
/** they came back and she has not caught them up yet (she waits until she is free) */
let backDue = false

/** How long since the keyboard or mouse was touched. */
function idleMs(): number {
  try {
    return powerMonitor.getSystemIdleTime() * 1000
  } catch {
    return 0
  }
}

/** Testing only: a file holding "here" or "away" stands in for the real desk (DESKMATE_DEBUG_PRESENCE=<path>). */
const DEBUG_PRESENCE = process.env.DESKMATE_DEBUG_PRESENCE?.trim() || ''

/** At the desk: the screen unlocked, the Mac awake, and the keyboard or mouse touched in the last few minutes. */
function userPresent(): boolean {
  if (DEBUG_PRESENCE) {
    try {
      return readFileSync(DEBUG_PRESENCE, 'utf8').trim() !== 'away'
    } catch {
      return true
    }
  }
  return !screenLocked && !macAsleep && idleMs() < AWAY_MS
}

function phoneReady(): boolean {
  return channels.reachable()
}

/** She is in the middle of something with the user. */
function busyWithUser(): boolean {
  return agentBusy || acting || planRunning || browsing || Boolean(pending) || herSpeaking || hearing
}

const scheduleStore = new ScheduleStore(join(USER_DATA, 'schedule.json'), (job, info) => scheduler.due(job, info), {
  graceMs: Math.max(1, Number(process.env.DESKMATE_SCHEDULE_CATCHUP_HOURS) || 24) * 3_600_000,
  onMissed: (job, lateMs) => {
    console.log(`[schedule] missed "${job.label}" (${Math.round(lateMs / 3_600_000)} h late)`)
    journal.add('schedule', `missed "${job.label}": the Mac was off or asleep`)
  }
})

const scheduler = new Scheduler({
  store: scheduleStore,
  canRun: () => useAgentCore(),
  runTurn: (job, askFn, lateMs) => runJobTurn(job, askFn, lateMs),
  async makePlan(job) {
    const r = await planFor(job.task)
    return { ok: r.ok, line: r.line }
  },
  async runTool(name, input) {
    const { out } = await runOneTool(currentTools(), name, input, { origin: 'typed', approved: true, confirm, onStep: status, log: taskLogger('schedule'), stopped: () => actStop || quitting })
    refreshTray()
    return { ok: out.ok, line: out.say ?? (out.untrusted ? (out.ok ? 'Done.' : "That didn't work.") : out.text) }
  },
  present: userPresent,
  phone: phoneReady,
  quiet: () => notices.quiet(),
  busy: busyWithUser,
  async say(line, job) {
    notices.post({
      kind: 'schedule',
      key: `schedule:${job?.id ?? 'back'}:${line.toLowerCase()}`,
      text: line,
      brief: job ? `${job.label} ran` : undefined,
      log: false,
      speak: async () => {
        await sayPlain(line)
      }
    })
    refreshTray()
    setupChanged()
  },
  async toPhone(line) {
    await channels.runPreferred(async () => channels.say(line))
  },
  ask: (question, where) => (where === 'phone' && channels.reachable() ? channels.runPreferred(() => ask(question, PHONE_ASK_MS)) : ask(question)),
  log: (kind, text) => journal.add(kind, text),
  console: (line) => console.log(line)
})

/** One scheduled job as its own agent turn: nothing of the conversation in it, her notes and skills as usual. */
async function runJobTurn(job: Job, askFn: Ask, lateMs: number): Promise<RunResult> {
  const claude = brain.claudeForAgent
  if (!claude) throw new Error('no Claude brain')
  agentBusy = acting = true
  actStop = false
  refreshTray()
  status(`scheduled · ${job.label}`)
  const log = taskLogger('schedule')
  log(`job ${job.id} "${job.task}" (${ruleText(job.rule, job.tz)})`)
  try {
    const late = lateMs > 5 * 60_000 ? ` It was due ${Math.round(lateMs / 60_000)} minutes ago (the Mac was asleep or off); say so in a few words.` : ''
    const r = await runAgentTurn(
      { text: job.task, origin: 'schedule', persona, memory: memory.notesBlock(), skills: skillLines(), history: [], now: new Date(), context: `[Scheduled job "${job.label}", ${ruleText(job.rule, job.tz)}.${late}]` },
      {
        model: (req) => callClaude(claude.client, { ...req, model: claude.model, effort: claude.effort, maxTokens: 16000 }),
        tools: currentTools(),
        confirm,
        confirmCall: askFn,
        onStep: (line) => status(line),
        log,
        stopped: () => actStop || quitting,
        maxRounds: AGENT_ROUNDS
      }
    )
    console.log(`[schedule] "${job.label}": ${r.rounds} round(s)${r.calls.length ? `: ${r.calls.map((c) => `${c.name}${c.deferred ? ' (waits)' : c.ok ? '' : ' ✗'}`).join(', ')}` : ''}`)
    return { ok: r.ok, say: r.say, calls: r.calls }
  } finally {
    agentBusy = acting = false
    refreshTray()
    status(listening ? listeningStatus() : 'idle')
  }
}

/** Away → back at the desk: what was kept for them, then the morning brief, then the steps waiting for a yes. */
async function presenceTick(why: 'tick' | 'unlock' | 'resume' | 'start'): Promise<void> {
  const here = userPresent()
  if (here && (!wasPresent || why !== 'tick')) backDue = true
  if (!here) backDue = false
  wasPresent = here
  // In the middle of something: the next tick tries again.
  if (!backDue || busyWithUser() || scheduler.current) return
  backDue = false
  await maybeBrief()
  await scheduler.userBack()
}

function scheduledMenu(): Electron.MenuItemConstructorOptions[] {
  const list = scheduleStore.list()
  const waiting = scheduleStore.waiting()
  const now = Date.now()
  return [
    {
      label: `Scheduled (${list.length})${waiting.length ? ' · waiting for you' : ''}`,
      submenu: [
        ...list.slice(0, 15).map((j) => ({
          label: `${j.label} · ${j.paused ? 'paused' : j.nextAt ? nextText(j.nextAt, now, j.tz) : 'done'}`,
          toolTip: `${ruleText(j.rule, j.tz)}${j.last ? ` · last: ${j.last.status}` : ''}`,
          submenu: [
            { label: 'Run now', click: () => scheduler.runNow(j) },
            { label: j.paused ? 'Resume' : 'Pause', click: () => jobAction(j.id, j.paused ? 'resume' : 'pause') },
            { label: 'Delete', click: () => jobAction(j.id, 'delete') }
          ]
        })),
        ...(waiting.length ? [{ type: 'separator' as const }, ...waiting.slice(0, 6).map((w) => ({ label: `Waiting: ${w.what.slice(0, 60)}`, click: () => void scheduler.userBack() }))] : []),
        ...(list.length || waiting.length ? [{ type: 'separator' as const }] : []),
        { label: list.length ? 'Say "every weekday at 9 …" to add one' : 'Say "every weekday at 9 summarise my Slack"', enabled: false },
        { label: `Heartbeat: ${HEARTBEAT_MINUTES ? `every ${HEARTBEAT_MINUTES} min` : 'off'} · edit the checklist`, click: openHeartbeat },
        { label: 'Morning brief', type: 'checkbox', checked: briefPrefs(settings.get().brief).on, click: () => setBrief({ on: !briefPrefs(settings.get().brief).on }) }
      ]
    }
  ]
}

/** A job from the tray or Setup: pause, resume, delete, run now; or a waiting step: approve, drop. */
function jobAction(id: string, action: JobSetupAction): void {
  const job = scheduleStore.get(id)
  if (action === 'run' && job) scheduler.runNow(job)
  else if ((action === 'pause' || action === 'resume') && job) {
    scheduleStore.setPaused(id, action === 'pause')
    journal.add('schedule', `${action === 'pause' ? 'paused' : 'resumed'} "${job.label}"`)
  } else if (action === 'delete' && job) {
    scheduleStore.remove(id)
    journal.add('schedule', `deleted "${job.label}"`)
  } else if (action === 'approve' || action === 'drop') {
    const w = scheduleStore.takeWaiting(id)
    if (w && action === 'approve') {
      void runOneTool(currentTools(), w.tool, w.input, { origin: 'typed', approved: true, confirm, onStep: status, log: taskLogger('schedule'), stopped: () => actStop || quitting }).then(({ out }) => {
        journal.add('schedule', `${out.ok ? 'done' : 'failed'} after your yes: ${w.what}`)
        void sayPlain(out.say ?? (out.ok ? 'Done.' : "That didn't work."), out.ok ? 'happy' : 'sad')
        setupChanged()
      })
    } else if (w) journal.add('schedule', `not done (your no): ${w.what}`)
  }
  refreshTray()
  setupChanged()
}

// The heartbeat: a cheap look at HEARTBEAT.md every DESKMATE_HEARTBEAT_MINUTES (default 30; 0 off).
const HEARTBEAT_MINUTES = (() => {
  const n = Number(process.env.DESKMATE_HEARTBEAT_MINUTES?.trim() || 30)
  return Number.isFinite(n) && n >= 0 ? n : 30
})()
const HEARTBEAT_PATH = join(MEMORY_DIR, 'HEARTBEAT.md')
const HEARTBEAT_LOG = join(USER_DATA, 'log', 'heartbeat-usage.jsonl')
const told = new Told()
let lastBeat = Date.now()
let beating = false
let beatInfo: ScheduleSetupState['heartbeat']['last'] = null

function heartbeatText(): string {
  try {
    if (!existsSync(HEARTBEAT_PATH)) {
      mkdirSync(MEMORY_DIR, { recursive: true })
      writeFileSync(HEARTBEAT_PATH, HEARTBEAT_TEMPLATE)
    }
    return readFileSync(HEARTBEAT_PATH, 'utf8')
  } catch {
    return ''
  }
}

function openHeartbeat(): void {
  heartbeatText()
  void shell.openPath(HEARTBEAT_PATH)
}

/** How things stand, for the heartbeat: the next few hours, what came in, how the jobs went. */
async function beatSnapshot(): Promise<string> {
  const now = new Date()
  const lines = [`Now: ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} local time. The user is ${userPresent() ? 'at the desk' : 'away from the desk'}.`]
  if (calendarAccess === 'fullAccess' && appHands.available) {
    const events = await appHands.calendarEvents(180, 0).catch(() => [] as CalendarEvent[])
    const soon = events.filter((e) => !e.cancelled && !e.allDay && e.start > now.getTime())
    lines.push(soon.length ? `Calendar, next 3 hours: ${soon.slice(0, 5).map((e) => `${e.title || 'an event'} at ${new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${e.location ? ` (${e.location.split('\n')[0].slice(0, 60)})` : ''}`).join('; ')}` : 'Calendar: nothing in the next 3 hours.')
  } else lines.push('Calendar: not readable.')
  const rem = reminderStore.list().filter((r) => r.at - now.getTime() < 3 * 3_600_000)
  lines.push(rem.length ? `Reminders set for the next 3 hours: ${rem.map((r) => `${r.text || 'a timer'} ${whenText(r.at, now.getTime())}`).join('; ')}` : 'Reminders: none in the next 3 hours.')
  const fresh = recentBanners.filter((b) => now.getTime() - b.at < 3 * 3_600_000)
  lines.push(fresh.length ? `Message notifications in the last 3 hours:\n${untrusted('notification', fresh.map((b) => `${Math.round((now.getTime() - b.at) / 60_000)} min ago: ${b.text}`).join('\n'))}` : 'Message notifications: none lately.')
  const running = agent.running()
  if (running.length) lines.push(`Claude Code jobs running: ${running.map((t) => `"${t.title}"`).join('; ')}`)
  const recentJob = agent.describe().split('\n')[0]
  if (recentJob) lines.push(`Latest Claude Code job: ${recentJob.slice(0, 200)}`)
  const jobs = scheduleStore.list().filter((j) => j.last && now.getTime() - j.last.at < 12 * 3_600_000 && (j.last.status === 'failed' || j.last.status === 'waiting'))
  if (jobs.length) lines.push(`Scheduled jobs that need a look: ${jobs.map((j) => `"${j.label}" ${j.last?.status}`).join('; ')}`)
  const waiting = scheduleStore.waiting()
  if (waiting.length) lines.push(`Steps waiting for the user's yes: ${waiting.map((w) => w.what).join('; ')}`)
  const said = told.recent()
  lines.push(said.length ? `Already told them: ${said.join(' / ')}` : 'Already told them: nothing yet.')
  return lines.join('\n')
}

/** One heartbeat: skipped for free when nothing could need them, else one small call; silent unless something does. */
async function heartbeat(force = false): Promise<void> {
  if (beating) return
  const list = heartbeatItems(heartbeatText())
  const reason = skipReason({
    minutes: force ? Math.max(1, HEARTBEAT_MINUTES) : HEARTBEAT_MINUTES,
    now: new Date(),
    lastAt: force ? 0 : lastBeat,
    idleMs: idleMs(),
    quiet: notices.quiet(),
    hasItems: list.length > 0,
    canThink: Boolean(brain.claudeForAgent),
    busy: busyWithUser() || Boolean(scheduler.current),
    away: screenLocked || macAsleep
  })
  if (reason === 'off' || reason === 'not yet') return
  lastBeat = Date.now()
  if (reason) {
    beatInfo = { at: lastBeat, said: null, tokens: 0, skipped: reason }
    console.log(`[heartbeat] skipped: ${reason}`)
    return
  }
  const claude = brain.claudeForAgent
  if (!claude) return
  beating = true
  const started = Date.now()
  const model = process.env.DESKMATE_HEARTBEAT_MODEL?.trim() || claude.model
  try {
    const req = beatRequest(list.map((i) => `- ${i}`).join('\n'), await beatSnapshot())
    const res = await callClaude(claude.client, { ...req, model, effort: 'low', maxTokens: 600 })
    let said = parseBeat(replyText(res))
    if (said && told.has(said)) said = null
    const rec = usageRecord(started, res.usage, said, model, Date.now() - started)
    try {
      mkdirSync(join(USER_DATA, 'log'), { recursive: true })
      appendFileSync(HEARTBEAT_LOG, `${JSON.stringify(rec)}\n`)
    } catch (err) {
      console.warn('[heartbeat] log:', (err as Error).message)
    }
    const tokens = Number(rec.input) + Number(rec.output) + Number(rec.cacheRead) + Number(rec.cacheWrite)
    console.log(`[heartbeat] ${said ? `says: ${said.slice(0, 90)}` : 'nothing needs you'} · tokens ${rec.input} in, ${rec.cacheRead} cached, ${rec.cacheWrite} cache write, ${rec.output} out (${rec.ms} ms)`)
    beatInfo = { at: started, said, tokens }
    if (said) {
      const line = said
      told.add(line)
      journal.add('heartbeat', line)
      notices.post({ kind: 'schedule', key: `heartbeat:${line.toLowerCase()}`, text: line, brief: line.slice(0, 60), log: false, speak: async () => void (await sayPlain(line)) })
    }
  } catch (err) {
    const e = toClaudeError(err)
    console.warn(`[heartbeat] ${e.code}: ${e.message}`)
    beatInfo = { at: started, said: null, tokens: 0, skipped: `error: ${e.message.slice(0, 80)}` }
  } finally {
    beating = false
    setupChanged()
  }
}

// The morning brief (Setup → Scheduled): the first time they are at the Mac after the set hour, once a day.
let briefing = false

function setBrief(patch: { on?: boolean; after?: string }): void {
  const cur = settings.get().brief ?? {}
  const next = { ...cur }
  if (typeof patch.on === 'boolean') next.on = patch.on
  if (typeof patch.after === 'string' && /^\d{1,2}:\d{2}$/.test(patch.after.trim())) next.after = patch.after.trim().padStart(5, '0')
  settings.set({ brief: next })
  refreshTray()
  setupChanged()
}

async function maybeBrief(force = false): Promise<void> {
  const prefs = briefPrefs(settings.get().brief)
  const now = new Date()
  if (briefing || (!force && !briefDue(prefs, settings.get().brief?.lastDay, now))) return
  briefing = true
  settings.set({ brief: { ...(settings.get().brief ?? {}), lastDay: dayKey(now) } })
  try {
    const since = new Date(now)
    since.setDate(since.getDate() - 1)
    since.setHours(18, 0, 0, 0)
    let events: CalendarEvent[] | null = null
    let calendarProblem: string | undefined
    if (calendarAccess === 'fullAccess' && appHands.available) {
      const sinceMidnight = now.getHours() * 60 + now.getMinutes()
      events = await appHands.calendarEvents(24 * 60 - sinceMidnight, sinceMidnight).catch(() => {
        calendarProblem = "I couldn't read your calendar this morning."
        return [] as CalendarEvent[]
      })
    } else if (appHands.available) calendarProblem = "I can't see your calendar yet: allow it in Setup, under What she tells you about."
    const entries = [...memFiles.entries('user'), ...memFiles.entries('memory')]
    const lines = briefLines(
      {
        events,
        reminders: reminderStore.list().map((r) => ({ text: r.text, at: r.at })),
        results: scheduler.takeResults(since.getTime()).map((r) => ({ label: r.label, line: r.line })),
        waiting: scheduleStore.waiting().length,
        messages: recentBanners.filter((b) => b.at >= since.getTime()).map((b) => b.text.split(':')[0].replace(/ (?:messaged|wrote to) you/i, '').slice(0, 60)),
        note: noteForToday(entries.map((e) => e.text), now, entries.filter((e) => /project/i.test(e.section)).map((e) => e.text)),
        calendarProblem
      },
      now
    )
    console.log(`[brief] ${lines.length} line(s)`)
    journal.add('brief', lines.join(' | ').slice(0, 380))
    if (!plan || plan.status === 'done' || plan.status === 'stopped') {
      planCard.show({
        id: `brief:${dayKey(now)}`,
        goal: 'morning brief',
        title: now.getHours() < 12 ? 'Good morning' : 'Your day',
        steps: lines.map((text) => ({ text, worker: 'say' as PlanWorker, input: '', status: 'pending' as const })),
        status: 'draft',
        current: 0,
        createdAt: Date.now(),
        kind: 'brief'
      })
    }
    const plain = briefSpoken(lines, now)
    notices.post({
      kind: 'schedule',
      key: `brief:${dayKey(now)}`,
      text: plain,
      brief: 'your morning brief',
      log: false,
      speak: async () => {
        if (brain.canThink) await report({ kind: 'notice', phase: 'status', title: 'morning brief', detail: `Your morning brief for the user. Say it in two or three short, warm sentences (only what matters most today): ${lines.join(' ')}` })
        else await sayPlain(plain)
      }
    })
  } finally {
    briefing = false
    setupChanged()
  }
}

function scheduleState(): ScheduleSetupState {
  const now = Date.now()
  const b = briefPrefs(settings.get().brief)
  return {
    jobs: scheduleStore.list().map((j) => ({ id: j.id, label: j.label, task: j.task, when: j.when, rule: ruleText(j.rule, j.tz), next: j.paused || j.nextAt === null ? null : nextText(j.nextAt, now, j.tz), paused: j.paused, mode: j.mode, last: j.last ?? null })),
    waiting: scheduleStore.waiting().map((w) => ({ id: w.id, label: w.label, what: w.what, at: w.at })),
    heartbeat: { minutes: HEARTBEAT_MINUTES, path: HEARTBEAT_PATH, items: heartbeatItems(heartbeatText()).length, last: beatInfo },
    brief: { on: b.on, after: b.after, lastDay: settings.get().brief?.lastDay ?? null },
    agentCore: useAgentCore()
  }
}

// ---- she gets better with use: skills she writes herself (learn.ts), and what Setup shows of her memory

/** DESKMATE_LEARN_SKILLS=0: she never writes skills on her own */
const LEARN_SKILLS = !/^(0|false|no|off)$/i.test(process.env.DESKMATE_LEARN_SKILLS?.trim() || '')

/** After a long task that worked, or one done by following a skill, she writes down how (one more Claude call). */
async function learnFrom(request: string, result: Awaited<ReturnType<typeof runAgentTurn>>, claude: NonNullable<Brain['claudeForAgent']>): Promise<void> {
  if (!LEARN_SKILLS) return
  const plan = learnPlan(result, guides)
  if (!plan) return
  try {
    const draft = await draftFromTurn(
      (req) => callClaude(claude.client, { system: req.system, messages: req.messages, model: claude.model, effort: claude.effort, maxTokens: 6000 }),
      plan,
      request,
      result.calls,
      { skills: guideIndex(guides), guides }
    )
    if (!draft) {
      console.log(`[learn] ${plan.kind === 'update' ? `${plan.skill}: no change` : 'nothing worth a skill'}`)
      return
    }
    const taken = [...guides.map((g) => g.name), ...skills.map((x) => x.name)]
    const d = drafts.write(draft, plan.kind === 'update' ? { kind: 'update', updates: plan.skill, request } : { kind: 'new', request }, taken)
    console.log(`[learn] draft ${d.name} (${d.kind}) in ${d.dir}`)
    journal.add('skill', d.kind === 'update' ? `proposed a better ${d.updates}${d.why ? `: ${d.why}` : ''}` : `wrote a draft skill, ${d.name}, from "${request.slice(0, 120)}"`)
    offerDraft(d)
  } catch (err) {
    console.warn('[learn]', (err as Error).message)
  }
}

function draftCard(d: Draft): Plan {
  return {
    id: `skill:${d.name}`,
    goal: d.request,
    title: d.kind === 'update' ? `Better: ${(d.updates ?? d.name).replace(/-/g, ' ')}` : `New skill: ${d.name.replace(/-/g, ' ')}`,
    steps: (d.steps.length ? d.steps : [d.description]).map((text) => ({ text, worker: 'say' as PlanWorker, input: '', status: 'pending' as const })),
    status: 'draft',
    current: 0,
    createdAt: d.created,
    note: (d.why ?? d.description).slice(0, 160),
    kind: 'skill'
  }
}

/** The draft on the card and in one line; a yes said next keeps it (the card, the tray and Setup work too). */
function offerDraft(d: Draft): void {
  if (!plan || plan.status === 'done' || plan.status === 'stopped') planCard.show(draftCard(d))
  refreshTray()
  setupChanged()
  if (!pending && !agentBusy && !acting && !planRunning) pending = { kind: 'skill', at: Date.now(), name: d.name }
  void sayPlain(draftLine(d))
}

/** Keep a draft (it becomes a skill she uses) or throw it away; returns her line. */
async function settleDraft(name: string, keep: boolean): Promise<string> {
  const d = drafts.get(name)
  if (planCard.shown?.id === `skill:${name}`) planCard.hide()
  if (!d) return 'That draft is gone already.'
  let line: string
  if (keep) {
    const r = drafts.approve(name, guides)
    journal.add('skill', r.ok ? (d.kind === 'update' ? `updated ${d.updates} (your yes)` : `kept ${d.name} as a skill (your yes)`) : `could not keep ${d.name}: ${r.text}`)
    await reloadSkills()
    line = r.ok ? (d.kind === 'update' ? "Updated. I'll do it that way from now on." : "Kept it. Next time I'll know how.") : r.text
  } else {
    drafts.reject(name)
    journal.add('skill', `threw away the draft ${d.name}`)
    line = 'Okay, binned it.'
  }
  refreshTray()
  setupChanged()
  return line
}

function draftsMenu(): Electron.MenuItemConstructorOptions[] {
  const list = drafts.list()
  if (!list.length) return []
  return [
    { type: 'separator' },
    {
      label: `Drafts waiting for your yes (${list.length})`,
      submenu: list.map((d) => ({
        label: d.kind === 'update' ? `Better ${d.updates?.replace(/-/g, ' ')}` : d.name.replace(/-/g, ' '),
        toolTip: d.why ?? d.description,
        submenu: [
          { label: d.kind === 'update' ? 'Update the skill' : 'Keep it', click: () => void settleDraft(d.name, true).then((l) => sayPlain(l, 'happy')) },
          { label: 'Show it', click: () => void shell.openPath(join(d.dir, 'SKILL.md')) },
          { label: 'On the card', click: () => planCard.show(draftCard(d)) },
          { label: 'Throw it away', click: () => void settleDraft(d.name, false).then((l) => sayPlain(l)) }
        ]
      }))
    }
  ]
}

function openMemoryFolder(): void {
  memFiles.ensure()
  void shell.openPath(MEMORY_DIR)
}

function learnState(): NonNullable<SetupState['learn']> {
  let searchable: number | null = null
  try {
    past.sync()
    searchable = past.count()
  } catch (err) {
    console.warn('[past]', (err as Error).message)
  }
  const sizes = memFiles.sizes()
  return {
    memoryDir: MEMORY_DIR,
    files: [
      { name: 'USER.md', ...sizes.user },
      { name: 'MEMORY.md', ...sizes.memory }
    ],
    searchable,
    skills: [
      ...skills.map((x) => ({ name: x.title, description: `${x.description} (${x.app.name})`, kind: 'routine' as const, source: x.source })),
      ...guides.filter((g) => !g.routine).map((g) => ({ name: g.name, description: g.description, kind: 'guide' as const, source: g.source }))
    ],
    drafts: drafts.list().map((d) => ({ name: d.name, kind: d.kind, ...(d.updates ? { updates: d.updates } : {}), description: d.description, ...(d.why ? { why: d.why } : {}), steps: d.steps })),
    skillCode: SKILL_CODE
  }
}

/** Setup → Tool servers: what mcp.json lists and how each one is doing. */
function mcpState(): NonNullable<SetupState['mcp']> {
  return { configPath: MCP_CONFIG, exists: existsSync(MCP_CONFIG), servers: mcp.status(), errors: mcp.configErrors(), agentCore: useAgentCore() }
}

async function setMcpEnabled(name: string, on: boolean): Promise<void> {
  const off = new Set(settings.get().mcpDisabled ?? [])
  if (on) off.delete(name)
  else off.add(name)
  settings.set({ mcpDisabled: [...off] })
  await mcp.setEnabled(name, on)
  console.log(`[mcp] ${name} ${on ? 'on' : 'off'}`)
}

/** A starter mcp.json when there is none, then the file in their editor. */
async function openMcpConfig(): Promise<void> {
  if (!existsSync(MCP_CONFIG)) {
    const starter = { mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', join(homedir(), 'Documents')], disabled: true } } }
    writeFileSync(MCP_CONFIG, `${JSON.stringify(starter, null, 2)}\n`)
  }
  await shell.openPath(MCP_CONFIG)
}

// ---- ears: hands-free listening

let attendUntil = 0 // wake mode: until when she answers without hearing her name
let attendTimer: NodeJS.Timeout | null = null
let herSpeaking = false
let followUp = false // her current line is the "yes?" to her name; when it ends, the window for the question opens

function listeningStatus(): string {
  const how = !WAKE_GATE ? 'just talk' : Date.now() < attendUntil ? 'yes? go on' : `say "${character.name}"`
  return `listening · ${how} · ${shortcutLabel()} ${WAKE_MODE === 'word' ? 'mutes' : 'stops'}`
}

/** Opens (or extends) the window in which she answers without her name, and shows it in the status row. */
function attend(): void {
  attendUntil = Date.now() + ATTEND_MS
  if (listening) status(listeningStatus())
  if (attendTimer) clearTimeout(attendTimer)
  attendTimer = setTimeout(() => {
    attendTimer = null
    if (listening && !hearing && !herSpeaking && Date.now() >= attendUntil) status(listeningStatus())
  }, ATTEND_MS + 50)
}

// "Mika?" gets a canned one-word answer; its audio is made once per voice so it comes back at once.
const ackAudio = new Map<string, Audio | null>()
function ackKey(say: string): string {
  return `${JSON.stringify(character.voice)}|${say}`
}

async function acknowledge(): Promise<void> {
  const reply = brain.acknowledge()
  const key = ackKey(reply.say)
  let audio = ackAudio.get(key)
  if (audio === undefined) {
    audio = await synthesize(reply.say, character.voice)
    ackAudio.set(key, audio)
  }
  followUp = true
  attend()
  await deliver(reply, 'chat', audio)
}

/** Synthesizes the acknowledgement lines ahead of time, so the first "Mika?" is not met with a pause. */
async function warmAcknowledgements(): Promise<void> {
  for (const [say] of ACKNOWLEDGEMENTS) {
    const key = ackKey(say)
    if (!ackAudio.has(key)) ackAudio.set(key, await synthesize(say, character.voice).catch(() => null))
  }
}

async function setListening(on: boolean): Promise<boolean> {
  if (on) {
    if (!ears) {
      status('My ears need the local voice server: DESKMATE_STT=local in .env (docs/VOICES.md).')
      return false
    }
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      if (!granted) {
        status('Microphone access refused. System Settings → Privacy & Security → Microphone → allow Deskmate (or Electron).')
        return false
      }
    }
  }
  listening = on
  win?.webContents.send('listen:state', on)
  status(on ? listeningStatus() : 'not listening')
  refreshTray()
  return listening
}

let hearing = false
/**
 * One utterance from the microphone (or the debug hook): transcribe, then treat it exactly like typed chat. With the
 * wake word on, only a sentence that starts or ends with her name counts, unless she is already paying attention:
 * they talked over her, she is waiting for their yes, or they just called her name. (Not after every answer: in a
 * room with a video or a call going, an open window after each line had her answering the room.)
 */
async function onUtterance(bytes: Uint8Array, ms: number, bargedIn = false): Promise<void> {
  if (hearing) {
    console.log('[ears] still answering the last one; dropped an utterance')
    return
  }
  hearing = true
  try {
    status('…')
    const t0 = Date.now()
    const durationMs = ms || wavDurationMs(bytes)
    const attending = !WAKE_GATE || bargedIn || Boolean(pending) || Date.now() < attendUntil
    // The cheap always-on ear: a long utterance that is not for her is transcribed only far enough to look for her name.
    const headOnly = WAKE_GATE && !attending && durationMs > WAKE_HEAD_S * 1000
    let transcript = await transcribe(headOnly ? wavHead(bytes, WAKE_HEAD_S) : bytes)
    let text = cleanTranscript(transcript)
    let hit = text && WAKE_GATE ? wake.find(text) : null
    if (hit && headOnly) {
      // Her name opened a long sentence: now the whole thing.
      transcript = await transcribe(bytes)
      text = cleanTranscript(transcript)
      hit = text ? wake.find(text) : null
    }
    const notForHer = Boolean(text) && WAKE_GATE && !hit && !attending
    const notes = [bargedIn ? 'over her' : '', headOnly ? 'first seconds' : '', text ? (notForHer ? 'not for me' : '') : 'ignored'].filter(Boolean).join(', ')
    console.log(`[ears] ${durationMs} ms of audio -> ${JSON.stringify(transcript.text)} in ${Date.now() - t0} ms${notes ? ` (${notes})` : ''}`)
    if (!text) {
      status(listening ? listeningStatus() : 'idle')
      return
    }
    if (notForHer) {
      status(`heard "${text}" (not for me)`)
      return
    }
    const said = hit ? hit.rest : text
    if (hit && wake.alone(said)) {
      // "Mika?" and nothing else: a quick "yes?", then she keeps listening for the question.
      status(`you: ${text}`)
      await acknowledge()
      return
    }
    status(`you: ${said}`)
    activity()
    if (WAKE_GATE) {
      attendUntil = 0 // spent: the next sentence needs her name again
      if (attendTimer) clearTimeout(attendTimer)
    }
    await handleChat(said || text, { voice: true })
  } catch (err) {
    console.error('[ears]', err)
    status(`my ears failed: ${(err as Error).message}`)
  } finally {
    hearing = false
  }
}

ipcMain.handle('listen:set', (_event, on: boolean) => setListening(Boolean(on)))
ipcMain.handle('mic:heard', (_event, wav: Uint8Array | ArrayBuffer, ms: number, bargedIn?: boolean) => {
  if (!listening) return
  const bytes = wav instanceof Uint8Array ? new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength) : new Uint8Array(wav)
  return onUtterance(bytes, Number(ms) || 0, Boolean(bargedIn))
})
// She started or stopped talking. The follow-up window counts from the end of her line, not from its start.
ipcMain.on('speech:state', (_event, on: boolean) => {
  herSpeaking = Boolean(on)
  if (!herSpeaking && followUp) {
    followUp = false
    if (WAKE_GATE) attend()
  }
})

ipcMain.handle('watch:look', () => observe(true))

// Touch reactions (tap / drag) are debounced so a flurry of clicks does not queue a flurry of API calls.
let lastTouchAt = 0
let touching = false
async function react(touch: Touch): Promise<void> {
  activity()
  const now = Date.now()
  if (touching || now - lastTouchAt < 2500) return
  touching = true
  lastTouchAt = now
  try {
    const reply = await brain.respond({ kind: 'touch', touch })
    await deliver(reply, 'touch')
  } catch (err) {
    console.error('[touch]', err)
  } finally {
    touching = false
  }
}
ipcMain.handle('touch:react', (_event, touch: Touch) => react(touch))

ipcMain.handle('settings:set-key', async (_event, key: string) => {
  const result = await brain.setKey(String(key))
  if (result.ok) status(`${character.name} is thinking with ${brain.modelName} now`)
  return result
})

ipcMain.on('window:move-by', (_event, dx: number, dy: number) => {
  const [x, y] = win.getPosition()
  win.setPosition(Math.round(x + Number(dx)), Math.round(y + Number(dy)))
  body.userMoved()
})
ipcMain.on('avatar:anchors', (_event, anchors) => body.setAnchors(anchors))
ipcMain.handle('watch:toggle', () => setWatching(!watching))

ipcMain.on('window:ignore-mouse', (_event, ignore: boolean) => {
  // Click-through everywhere except over the character and the panel; `forward` keeps mousemove flowing so we can re-enable.
  win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
})

ipcMain.on('bar:hide', () => bar.hide())
ipcMain.on('plan:action', (_event, action: PlanAction) => {
  // The card may be showing a skill she wrote instead of a plan.
  const shown = planCard.shown
  // The morning brief's card only closes.
  if (shown?.kind === 'brief') {
    planCard.hide()
    return
  }
  if (shown?.kind === 'skill' && shown.id.startsWith('skill:')) {
    const name = shown.id.slice('skill:'.length)
    if (action === 'go' || action === 'stop') void settleDraft(name, action === 'go').then((line) => sayPlain(line, action === 'go' ? 'happy' : 'neutral'))
    else planCard.hide()
    return
  }
  const known: PlanAction[] = ['go', 'pause', 'resume', 'stop', 'retry', 'dismiss']
  if (known.includes(action)) void planDo({ kind: action } as PlanCommand)
})
ipcMain.on('plan:height', (_event, px: number) => planCard.setHeight(Number(px)))

// ---- chat apps (channels/): Telegram, Discord, iMessage, Slack and Signal bring the owner's messages into her chat
// path, and take her lines, pictures and files back. The hub keeps the rules (who may talk to her) the same for all.

/** Setup's token wins over DESKMATE_TELEGRAM_TOKEN in .env, like her brain. */
function telegramToken(): string {
  return settings.get().telegramToken?.trim() || process.env.DESKMATE_TELEGRAM_TOKEN?.trim() || ''
}

// Only for testing against fake APIs and a fixture Messages database; the real ones are the default.
const TELEGRAM_API_URL = process.env.DESKMATE_TELEGRAM_API_URL?.trim() || undefined
const DISCORD_API_URL = process.env.DESKMATE_DISCORD_API_URL?.trim() || undefined
const SLACK_API_URL = process.env.DESKMATE_SLACK_API_URL?.trim() || undefined
const CHAT_DB_PATH = process.env.DESKMATE_CHAT_DB?.trim() || CHAT_DB

function setupChanged(): void {
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('setup:changed')
}

type ChannelPrefs = NonNullable<SettingsData['channels']>

function channelPrefs(): ChannelPrefs {
  return settings.get().channels ?? {}
}

function setChannelPrefs<K extends keyof ChannelPrefs>(id: K, patch: ChannelPrefs[K]): void {
  const all = channelPrefs()
  const was = all[id]
  settings.set({ channels: { ...all, [id]: typeof patch === 'object' && patch !== null ? { ...(typeof was === 'object' ? was : {}), ...patch } : patch } })
}

function storedOwner(id: ChannelId): Owner | null {
  if (id === 'telegram') {
    const p = settings.get().remotePaired
    return p ? { chat: String(p.chatId), id: String(p.userId), name: p.name } : null
  }
  if (id === 'discord' || id === 'slack') return channelPrefs()[id]?.owner ?? null
  return null
}

function saveOwner(id: ChannelId, owner: Owner | null): void {
  if (id === 'telegram') settings.set({ remotePaired: owner ? { chatId: Number(owner.chat), userId: Number(owner.id), name: owner.name } : undefined })
  else if (id === 'discord' || id === 'slack') setChannelPrefs(id, { owner: owner ?? undefined })
}

/** Set up enough to start: a token, a number, a handle. */
function channelConfigured(id: ChannelId): boolean {
  const p = channelPrefs()
  switch (id) {
    case 'telegram':
      return Boolean(telegramToken())
    case 'discord':
      return Boolean(p.discord?.token)
    case 'slack':
      return Boolean(p.slack?.botToken && p.slack?.appToken)
    case 'imessage':
      return process.platform === 'darwin' && Boolean(p.imessage?.handles?.length)
    case 'signal':
      return Boolean(p.signal?.account)
    case 'whatsapp':
      return false
  }
}

/** Switched on (Telegram is on by default once it has a token; the others are off until switched on). */
function channelWanted(id: ChannelId): boolean {
  if (id === 'telegram') return settings.get().remoteEnabled !== false
  if (id === 'whatsapp') return false
  return channelPrefs()[id]?.on === true
}

function makeChannel(id: ChannelId): Channel | null {
  const p = channelPrefs()
  switch (id) {
    case 'telegram':
      return new TelegramChannel(new TelegramApi(telegramToken(), { base: TELEGRAM_API_URL }))
    case 'discord':
      return new DiscordChannel(new DiscordApi(p.discord?.token ?? '', { base: DISCORD_API_URL }))
    case 'slack':
      return new SlackChannel(new SlackApi(p.slack?.botToken ?? '', p.slack?.appToken ?? '', { base: SLACK_API_URL }))
    case 'imessage':
      return new IMessageChannel({ db: new ChatDb(CHAT_DB_PATH), handles: () => channels.allowlist('imessage'), send: sendIMessage, access: () => chatDbAccess(CHAT_DB_PATH) })
    case 'signal':
      return new SignalChannel({ account: p.signal?.account ?? '', handles: () => channels.allowlist('signal'), cli: p.signal?.cli })
    case 'whatsapp':
      return null
  }
}

/** iMessage's way out: the Messages AppleScript, into the chat the message came from. A file goes from Pictures,
 * where Messages may read it, and is removed a while after. */
async function sendIMessage(chat: string, text: string, file?: OutFile): Promise<void> {
  // Testing only: what she would send is written to a file instead (DESKMATE_DEBUG_IMESSAGE_SEND=<path>), so a test
  // with a fixture chat.db never texts a real number.
  const debugSend = process.env.DESKMATE_DEBUG_IMESSAGE_SEND?.trim()
  if (debugSend) {
    appendFileSync(debugSend, `${JSON.stringify({ chat, text, file: file ? { name: file.name, bytes: file.bytes.byteLength, mime: file.mime } : null })}\n`)
    return
  }
  let path = ''
  if (file) {
    const dir = join(app.getPath('pictures'), 'Deskmate', 'sent')
    mkdirSync(dir, { recursive: true })
    path = join(dir, `${Date.now()}-${basename(file.name) || 'file'}`)
    writeFileSync(path, file.bytes)
    setTimeout(() => rmSync(path, { force: true }), 10 * 60_000).unref()
  }
  await sendToMessagesChat(chat, text, path)
}

function startChannel(id: ChannelId): void {
  channels.remove(id)
  if (!channelConfigured(id) || !channelWanted(id)) return
  const ch = makeChannel(id)
  if (!ch) return
  channels.add(ch)
  channels.start(id)
}

function startChannels(): void {
  for (const id of CHANNEL_IDS) startChannel(id)
}

function setChannel(id: ChannelId, on: boolean): void {
  if (id === 'telegram') settings.set({ remoteEnabled: on })
  else if (id !== 'whatsapp') setChannelPrefs(id, { on })
  if (on) startChannel(id)
  else {
    channels.stop(id)
    if (channels.pairRequest(id)) pairAnswer?.(false)
  }
  status(on ? channelStatusLine(id) : `${CHANNEL_LABELS[id]} off`)
}

/** "Discord on · DM @deskmate the code in Setup to pair" */
function channelStatusLine(id: ChannelId): string {
  const label = CHANNEL_LABELS[id]
  const st = channels.state(id)
  if (!st?.running) return st?.error ? `${label}: ${st.error}` : `${label} off`
  if (st.owner) return `${label} on · ${st.owner}`
  if (id === 'telegram') return `${label} on · send /start to ${st.account ?? 'your bot'} to pair your phone`
  if (id === 'discord' || id === 'slack') return `${label} on · pair it in Setup (a code to send ${st.account ?? 'the bot'})`
  return `${label} on · message yourself to reach her`
}

function channelsMenu(): Electron.MenuItemConstructorOptions {
  const items: Electron.MenuItemConstructorOptions[] = CHANNEL_IDS.map((id) => {
    const label = CHANNEL_LABELS[id]
    if (id === 'whatsapp') return { label: 'WhatsApp: not available', enabled: false, toolTip: WHATSAPP_REASON }
    if (id === 'imessage' && process.platform !== 'darwin') return { label: 'iMessage: Mac only', enabled: false }
    if (!channelConfigured(id)) return { label: `${label}: set up…`, click: () => openSetup('remote') }
    const st = channels.state(id)
    const on = Boolean(st?.running)
    const who = on ? (st?.owner ? ` · ${st.owner}` : channels.hasOwner(id) ? '' : ' · not paired') : ''
    return { label: `${label}: ${on ? 'on' : 'off'}${who}`, type: 'checkbox', checked: on, toolTip: st?.error ?? channelStatusLine(id), click: () => setChannel(id, !on) }
  })
  items.push(
    { type: 'separator' },
    {
      label: 'Answer voice notes with a voice note',
      type: 'checkbox',
      checked: Boolean(channelPrefs().voiceReplies),
      click: () => {
        setChannelPrefs('voiceReplies', !channelPrefs().voiceReplies)
        refreshTray()
        setupChanged()
      }
    },
    { label: 'Set up chat apps…', click: () => openSetup('remote') }
  )
  const n = CHANNEL_IDS.filter((id) => channels.state(id)?.running).length
  return { label: n ? `Chat apps (${n} on)` : 'Chat apps', submenu: items }
}

/** A /start while nobody is paired: she reads it back on the Mac, and Setup shows Allow / Refuse. Either answers. */
function askToPair(req: PairRequest): Promise<boolean> {
  pairAnswer?.(false)
  return new Promise((resolve) => {
    let mine: Pending | null = null
    const finish = (yes: boolean): void => {
      if (pairAnswer !== finish) return
      pairAnswer = null
      // Answered in Setup: her read-back is no longer waiting.
      if (mine && pending === mine) {
        pending = null
        mine.kind === 'confirm' && mine.resolve(yes)
      }
      setupChanged()
      refreshTray()
      resolve(yes)
    }
    pairAnswer = finish
    const label = CHANNEL_LABELS[req.channel]
    console.log(`[channels] ${req.channel}: ${req.name} asks to pair; code ${req.code}`)
    const spoken = req.code.split('').join(' ')
    void confirm(`Someone on ${label}, ${req.name}, wants to control me from their phone. The code is ${spoken}. Is that you?`).then(finish)
    mine = pending
    status(`📱 pairing request · ${label} · ${req.name} · code ${req.code} · say yes, or Allow in Setup`)
    setupChanged()
  })
}

/** One message from a channel's owner. It runs as that channel's work, so every line and step of hers goes back. */
async function channelMessage(text: string, from: { channel: ChannelId; name: string; voice: boolean }): Promise<void> {
  console.log(`[channels] ${from.channel}: ${from.voice ? 'voice note' : 'message'} from ${from.name}: ${text.slice(0, 80)}`)
  // On the Mac only: the phone knows what it sent.
  const line = `📱 ${CHANNEL_LABELS[from.channel]}: ${text.slice(0, 70)}`
  win?.webContents.send('status', line)
  bar.status(line)
  await handleChat(text)
}

/** The screen as a PNG for the phone (her window greyed out, like every capture). */
async function screenshotPng(): Promise<Uint8Array | null> {
  const shot = await captureScreen().catch(() => undefined)
  if (!shot) return null
  return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')).toPNG()
}

/** send_to_me: a screenshot, or a file after a read-back, to the chat the message came from. */
async function sendToMe(a: { what: 'screenshot' | 'file'; file: string | null }, ctx: ToolCtx): Promise<ToolOutcome> {
  const where = channels.activeChannel
  if (!where) return { ok: false, text: 'That only works for a message from their phone; they are at the computer, so show them here instead.' }
  const label = CHANNEL_LABELS[where]
  if (a.what === 'screenshot') {
    const png = await screenshotPng()
    if (!png) return { ok: false, text: 'No screenshot: Screen Recording is not allowed for me.', say: "I can't see the screen: Screen Recording is off for me." }
    await channels.photo(png, 'Your screen just now')
    journal.add('channel', `sent a screenshot to ${label}`)
    return { ok: true, text: `Sent a screenshot of the screen to them on ${label} (her own window greyed out).`, say: "Here's your screen." }
  }
  const r = await resolveFile(a.file ?? '', { find: async (q) => (await findFiles(q))[0] ?? null })
  if (!r.ok) return { ok: false, text: `Not sent: ${r.why}.`, say: `I didn't send it: ${r.why}.` }
  const f = r.file
  // Always read back, whatever the read-back setting: a file is leaving the Mac.
  if (!ctx.approved && !(await ctx.confirm(`Send ${f.name} (${megabytes(f.bytes)}, in ${f.where}) to you on ${label}?`))) return { ok: false, text: 'The user said no; not sent.', say: 'Okay, not sent.' }
  try {
    await channels.file({ name: f.name, bytes: new Uint8Array(readFileSync(f.path)), mime: mimeFor(f.name) }, f.name)
  } catch (err) {
    return { ok: false, text: `${label} would not take it: ${(err as Error).message}`, say: `${label} wouldn't take it: ${(err as Error).message.slice(0, 120)}` }
  }
  journal.add('channel', `sent ${f.path} to ${label}`)
  return { ok: true, text: `Sent ${f.name} (${f.path}) to them on ${label}.`, say: `Sent ${f.name}.` }
}

/** A phone number with its country code, or an email (an Apple ID). */
function cleanHandles(raw: string): { handles: string[]; bad: string[] } {
  const parts = raw.split(/[\n,;]+/).map((h) => h.trim()).filter(Boolean)
  const ok = (h: string): boolean => /^\+\d[\d\s().-]{5,18}$/.test(h) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h)
  return { handles: [...new Set(parts.filter(ok))], bad: parts.filter((h) => !ok(h)) }
}

/** What the Mac has to allow or have before a channel can start; null when nothing. */
function channelBlocker(id: ChannelId): string | null {
  if (id === 'imessage') {
    const a = chatDbAccess(CHAT_DB_PATH)
    return a.ok ? null : (a.reason ?? 'Deskmate cannot read the Messages database.')
  }
  if (id === 'signal' && !findSignalCli(channelPrefs().signal?.cli)) return 'signal-cli is not installed: brew install signal-cli, then link it to your account (see docs/CHANNELS.md).'
  return null
}

async function channelsState(): Promise<ChannelsSetupState> {
  const p = channelPrefs()
  const list: ChannelSetup[] = CHANNEL_IDS.map((id) => {
    const st = channels.state(id)
    const pairing = id === 'telegram' ? 'ask' : id === 'imessage' || id === 'signal' ? 'allowlist' : 'code'
    const base: ChannelSetup = {
      id,
      label: CHANNEL_LABELS[id],
      available: true,
      configured: channelConfigured(id),
      on: Boolean(st?.running),
      pairing,
      account: st?.account ?? null,
      owner: st?.owner ?? (pairing === 'allowlist' ? null : (storedOwner(id)?.name ?? null)),
      request: st?.request && pairAnswer ? st.request : null,
      code: st?.code ?? null,
      error: st?.error ?? null
    }
    if (id === 'whatsapp') return { ...base, available: false, why: WHATSAPP_REASON }
    if (id === 'imessage' && process.platform !== 'darwin') return { ...base, available: false, why: 'iMessage is only on macOS.' }
    if (id === 'telegram') base.fromEnv = !settings.get().telegramToken?.trim() && Boolean(process.env.DESKMATE_TELEGRAM_TOKEN?.trim())
    if (id === 'imessage') base.handles = p.imessage?.handles ?? []
    if (id === 'signal') {
      base.handles = p.signal?.handles ?? []
      base.number = p.signal?.account ?? ''
    }
    if (id === 'imessage' || id === 'signal') base.blocker = channelBlocker(id)
    return base
  })
  const stt = localSttSelected() ? await sttHealthy().catch(() => false) : false
  return { list, voiceReplies: Boolean(p.voiceReplies), stt }
}

/** One Setup action on a channel; tokens are checked with the service before they are kept. */
async function channelAction(id: ChannelId, action: ChannelAction, data: Record<string, string>): Promise<{ ok: boolean; error?: string; account?: string; code?: string }> {
  const label = CHANNEL_LABELS[id]
  switch (action) {
    case 'on':
    case 'off':
      setChannel(id, action === 'on')
      return { ok: true }
    case 'allow':
    case 'refuse':
      pairAnswer?.(action === 'allow')
      return { ok: true }
    case 'pair': {
      if (!channels.state(id)?.running) return { ok: false, error: `Switch ${label} on first.` }
      const code = channels.openPairing(id)
      return code ? { ok: true, code } : { ok: false, error: `${label} does not pair with a code.` }
    }
    case 'pair-cancel':
      channels.closePairing(id)
      return { ok: true }
    case 'forget':
      channels.unpair(id)
      saveOwner(id, null)
      status(`${label} unpaired`)
      return { ok: true }
    case 'voice-replies':
      setChannelPrefs('voiceReplies', data.on === 'true')
      return { ok: true }
    case 'save':
      break
    default:
      return { ok: false, error: 'Unknown action.' }
  }
  // save: what each app needs, checked first.
  if (id === 'telegram') {
    const token = (data.token ?? '').trim()
    const r = await checkTelegramToken(token, { base: TELEGRAM_API_URL })
    if (!r.ok) return { ok: false, error: r.error }
    // Another bot is another chat: the old pairing does not carry over.
    if (token !== telegramToken()) {
      channels.unpair(id)
      settings.set({ remotePaired: undefined })
    }
    settings.set({ telegramToken: token, remoteEnabled: true })
    startChannel(id)
    status(channelStatusLine(id))
    return { ok: true, account: r.bot ? `@${r.bot}` : undefined }
  }
  if (id === 'discord') {
    const token = (data.token ?? '').trim()
    const r = await checkDiscordToken(token, { base: DISCORD_API_URL })
    if (!r.ok) return { ok: false, error: r.error }
    if (token !== channelPrefs().discord?.token) {
      channels.unpair(id)
      setChannelPrefs('discord', { owner: undefined })
    }
    setChannelPrefs('discord', { token, on: true })
    startChannel(id)
    return { ok: true, account: r.bot ? `@${r.bot}` : undefined }
  }
  if (id === 'slack') {
    const botToken = (data.bot ?? '').trim()
    const appToken = (data.app ?? '').trim()
    const r = await checkSlackTokens(botToken, appToken, { base: SLACK_API_URL })
    if (!r.ok) return { ok: false, error: r.error }
    if (botToken !== channelPrefs().slack?.botToken) {
      channels.unpair(id)
      setChannelPrefs('slack', { owner: undefined })
    }
    setChannelPrefs('slack', { botToken, appToken, on: true })
    startChannel(id)
    return { ok: true, account: r.bot }
  }
  if (id === 'imessage' || id === 'signal') {
    const { handles, bad } = cleanHandles(data.handles ?? '')
    if (bad.length) return { ok: false, error: `${bad.slice(0, 3).join(', ')}: not a phone number with its country code (+1…) or an email.` }
    if (id === 'imessage') {
      if (!handles.length) return { ok: false, error: 'Add at least one handle: your own phone number (+1…) or Apple ID email.' }
      setChannelPrefs('imessage', { handles, on: true })
    } else {
      const account = (data.number ?? '').replace(/[\s().-]/g, '')
      if (!/^\+\d{6,15}$/.test(account)) return { ok: false, error: 'Your Signal number, with the country code (+15551234567).' }
      setChannelPrefs('signal', { account, handles, on: true })
    }
    channels.setAllowlist(id, handles)
    startChannel(id)
    const blocker = channelBlocker(id)
    return blocker ? { ok: false, error: blocker } : { ok: true }
  }
  return { ok: false, error: `${label} is not available.` }
}

// ---- first-run window: her brain, her voice, and what macOS lets her do

let setupWin: BrowserWindow | null = null
let setupStartMode: string = brain.mode

function openSetup(section?: 'characters' | 'remote'): void {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show()
    setupWin.focus()
    if (section) void setupWin.webContents.executeJavaScript(`document.getElementById('${section}')?.scrollIntoView()`)
    return
  }
  setupStartMode = brain.mode
  setupWin = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 460,
    minHeight: 520,
    title: 'Set up Deskmate',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#14101f',
    show: false,
    webPreferences: { preload: PRELOAD, sandbox: false }
  })
  // Its links (Ollama, the Gemini key page) open in the browser, not in a new window.
  setupWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  setupWin.once('ready-to-show', () => {
    setupWin?.show()
    if (process.platform === 'darwin') app.focus({ steal: true })
  })
  setupWin.on('closed', () => {
    setupWin = null
    finishSetup()
  })
  loadPage(setupWin, 'setup')
  if (section) setupWin.webContents.once('did-finish-load', () => void setupWin?.webContents.executeJavaScript(`document.getElementById('${section}')?.scrollIntoView()`))
}

/** Closing the window counts as done: it does not come back on its own. Her window reloads if her brain changed. */
function finishSetup(): void {
  if (!settings.get().setupDone) settings.set({ setupDone: true })
  if (brain.mode !== setupStartMode) {
    setupStartMode = brain.mode
    win?.webContents.reload()
  }
  refreshTray()
}

async function setupState(): Promise<SetupState> {
  const ollama = await brain.detectOllama()
  const mac = process.platform === 'darwin'
  const media = (kind: 'microphone' | 'screen'): string => (mac || process.platform === 'win32' ? systemPreferences.getMediaAccessStatus(kind) : 'granted')
  const keys = appHands.available ? await checkAppTrust() : null
  const localVoice = localTtsSelected()
  return {
    platform: process.platform,
    brain: {
      mode: brain.mode,
      modelName: brain.modelName,
      ollama: { running: ollama.running, models: ollama.models, current: brain.ollamaModel },
      geminiKey: brain.hasGeminiKey,
      claude: await (async () => {
        const list = await brain.claudeModelList()
        return { key: brain.hasClaudeKey, model: brain.claudeModel, effort: brain.claudeEffort, models: list.models, error: list.error }
      })()
    },
    voice: {
      provider: localVoice ? 'local' : process.env.ELEVENLABS_API_KEY?.trim() ? 'elevenlabs' : 'system',
      localServer: localVoice ? await sttHealthy().catch(() => false) : false
    },
    permissions: { microphone: media('microphone'), screen: media('screen'), keys },
    channels: await channelsState(),
    notices: noticeState(),
    mcp: mcpState(),
    learn: learnState(),
    schedule: scheduleState()
  }
}

const PRIVACY_PANES: Record<PermissionKind, string> = {
  microphone: 'Privacy_Microphone',
  screen: 'Privacy_ScreenCapture',
  keys: 'Privacy_Accessibility',
  calendars: 'Privacy_Calendars'
}

async function allow(kind: PermissionKind): Promise<void> {
  if (process.platform !== 'darwin') return
  if (kind === 'microphone') {
    // Asked once by macOS itself; after a "no" only System Settings can change it.
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined' && (await systemPreferences.askForMediaAccess('microphone'))) return
  } else if (kind === 'calendars') {
    // Asked once by macOS itself, like the microphone; after a "no" only System Settings can change it.
    if ((await refreshCalendarAccess()) === 'notDetermined' && (await appHands.requestCalendarAccess()).granted) {
      await refreshCalendarAccess()
      return
    }
  } else if (kind === 'screen') {
    // The first capture attempt is what puts the app on the Screen Recording list.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined)
    if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return
  } else {
    systemPreferences.isTrustedAccessibilityClient(true)
  }
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[kind]}`)
}

ipcMain.handle('setup:get', () => setupState())
ipcMain.handle('setup:ollama', async (_event, model: string) => {
  const result = await brain.useOllama(String(model))
  if (result.ok) status(`${character.name} is thinking with ${brain.modelName} now`)
  return result
})
ipcMain.handle('setup:gemini', async (_event, key: string) => {
  const result = await brain.useGemini(String(key))
  if (result.ok) status(`${character.name} is thinking with ${brain.modelName} now`)
  return result
})
ipcMain.handle('setup:claude', async (_event, key: string | null, model: string, effort?: string) => {
  const result = await brain.useClaude(key ? String(key) : null, String(model ?? ''), effort as 'low' | 'medium' | 'high' | undefined)
  if (result.ok) {
    status(`${character.name} is thinking with ${brain.modelName} now`)
    refreshTray()
  }
  return result
})
ipcMain.handle('setup:allow', (_event, kind: PermissionKind) => allow(kind))
ipcMain.handle('setup:channel', async (_event, rawId: string, action: ChannelAction, data?: Record<string, string>) => {
  const id = CHANNEL_IDS.find((c) => c === rawId)
  if (!id) return { ok: false, error: 'No such chat app.' }
  try {
    return await channelAction(id, action, data ?? {})
  } finally {
    refreshTray()
    setupChanged()
  }
})
ipcMain.handle('setup:notices', (_event, raw: unknown) => {
  setNoticePrefs(cleanNoticePatch(raw))
  return noticeState()
})
ipcMain.handle('setup:calendar', async () => {
  const result = await appHands.requestCalendarAccess()
  await refreshCalendarAccess()
  console.log(`[calendar] access ${result.granted ? 'granted' : `not granted (${result.status}${result.error ? `: ${result.error}` : ''})`}`)
  if (result.granted) void pollCalendar()
  setupChanged()
  return result
})
ipcMain.handle('setup:mcp-toggle', async (_event, name: string, on: boolean) => {
  await setMcpEnabled(String(name), Boolean(on))
  return mcpState()
})
ipcMain.handle('setup:mcp-reload', async () => {
  await mcp.start()
  return mcpState()
})
ipcMain.handle('setup:mcp-open', () => openMcpConfig())
ipcMain.handle('setup:memory-open', () => openMemoryFolder())
ipcMain.handle('setup:job', (_event, id: string, action: JobSetupAction) => {
  if (['pause', 'resume', 'delete', 'run', 'approve', 'drop'].includes(String(action))) jobAction(String(id), action)
  return scheduleState()
})
ipcMain.handle('setup:brief', (_event, patch: { on?: unknown; after?: unknown }) => {
  setBrief({ ...(typeof patch?.on === 'boolean' ? { on: patch.on } : {}), ...(typeof patch?.after === 'string' ? { after: patch.after.slice(0, 5) } : {}) })
  return scheduleState()
})
ipcMain.handle('setup:heartbeat-open', () => openHeartbeat())
ipcMain.handle('setup:skills-open', () => {
  mkdirSync(USER_SKILLS, { recursive: true })
  void shell.openPath(USER_SKILLS)
})
ipcMain.handle('setup:draft', async (_event, name: string, action: string) => {
  const d = drafts.get(String(name))
  if (d && action === 'show') void shell.openPath(join(d.dir, 'SKILL.md'))
  else if (d && (action === 'keep' || action === 'discard')) void sayPlain(await settleDraft(d.name, action === 'keep'), action === 'keep' ? 'happy' : 'neutral')
  return learnState()
})
ipcMain.handle('setup:finish', () => {
  setupWin?.close()
})
ipcMain.on('setup:open', () => openSetup())

let stopLocalTts: () => void = () => undefined

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide() // menu-bar app: no Dock icon
  protocol.handle('deskmate', serveCharacterFile)
  const local = await brain.detectOllama()
  if (local.running) {
    console.log(`[brain] Ollama running; models: ${local.models.join(', ') || '(none)'}; using ${brain.ollamaModel}: ${local.hasModel ? 'yes' : 'NOT INSTALLED (ollama pull ' + brain.ollamaModel + ')'}`)
  }
  stopLocalTts = await autostartLocalTts(RESOURCES, USER_DATA)
  void agent.check().then((claude) => {
    hands = claude.ok
    console.log(claude.ok ? `[hands] Claude Code ${claude.version} at ${agent.findBinary()}; jobs run with --permission-mode ${agent.permissionMode}` : `[hands] ${claude.error}`)
    refreshTray()
  })
  await reloadSkills()
  if (appHands.available) {
    void checkAppTrust().then((ok) =>
      console.log(`[apps] app control ready (Discord, Slack, Claude); Accessibility ${ok ? 'granted' : 'NOT granted: she will ask the first time'}`)
    )
  } else if (process.platform === 'darwin') {
    console.log('[apps] native/bin/deskmate-hands missing: app control is off (npm run build compiles it)')
  }
  if (process.platform === 'win32') console.log('[apps] Windows hands (experimental): PowerShell + UI Automation')
  if (chrome.chromeAvailable()) {
    void chrome.running().then((up) => console.log(`[browser] ${chrome.BROWSER_APP} ${up ? 'is open; she can drive it' : 'is not open right now'}`))
  }
  if (ears) {
    void sttHealthy().then((ok) => console.log(`[ears] local speech-to-text ${ok ? 'answering' : 'not answering yet (the server may still be loading)'} at ${sttUrl()}`))
    try {
      if (!globalShortcut.register(LISTEN_SHORTCUT, () => void setListening(!listening))) console.warn(`[ears] could not register ${LISTEN_SHORTCUT}`)
      else console.log(`[ears] ${LISTEN_SHORTCUT} toggles hands-free listening`)
    } catch (err) {
      console.warn('[ears] shortcut:', (err as Error).message)
    }
    console.log(`[ears] wake word ${WAKE_GATE ? `"${character.name}"${WAKE_MODE === 'word' ? ', listening from the start' : ''}` : 'off'}; barge-in ${BARGE_IN ? 'on' : 'off (the mic closes while she talks)'}`)
  }
  try {
    if (globalShortcut.register(COMMAND_SHORTCUT, () => bar.toggle())) {
      commandShortcut = COMMAND_SHORTCUT
      console.log(`[bar] ${COMMAND_SHORTCUT} opens the command bar`)
    } else console.warn(`[bar] could not register ${COMMAND_SHORTCUT} (another app has it); set DESKMATE_COMMAND_SHORTCUT`)
  } catch (err) {
    console.warn('[bar] shortcut:', (err as Error).message)
  }
  createWindow()
  body.rememberHome()
  if (/^(1|true|yes|on)$/i.test(process.env.DESKMATE_WANDER?.trim() || '')) body.wander(true, () => !acting && !browsing && !herSpeaking)
  if (!/^(0|false|no|off)$/i.test(process.env.DESKMATE_IDLE_TOUCHES?.trim() || '')) body.idleTouches(true)
  if (!/^(0|false|no|off)$/i.test(process.env.DESKMATE_CURSOR_PLAY?.trim() || '')) body.cursorPlay(true)
  setInterval(() => {
    void boredTick()
    void restlessTick()
  }, 20_000).unref()
  if (SLEEP_AFTER_MIN > 0) {
    setInterval(() => {
      if (body.mode === 'idle' || body.mode === 'sit' || body.mode === 'lie') {
        if (Date.now() - lastActivity > SLEEP_AFTER_MIN * 60_000 && !acting && !browsing && !herSpeaking && !hearing && !agent.running().length) body.sleep()
      }
    }, 30_000).unref()
  }
  createTray()
  startChannels()
  // What she comes to tell you about on her own: reminders (kept across restarts), messages, the calendar.
  reminderStore.start()
  // Scheduled jobs: whatever came due while she was off runs now, once. Sleep, wake and the lock screen tell her
  // when the user is away; coming back brings what was kept for them and the morning brief.
  scheduleStore.start()
  powerMonitor.on('suspend', () => {
    macAsleep = true
  })
  powerMonitor.on('resume', () => {
    macAsleep = false
    scheduleStore.check()
    reminderStore.start()
    void presenceTick('resume')
  })
  powerMonitor.on('lock-screen', () => {
    screenLocked = true
  })
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false
    void presenceTick('unlock')
  })
  // The heartbeat waits for the presence check: she catches them up (and asks what waits) before any check-in.
  setInterval(() => void presenceTick('tick').then(() => heartbeat()), 30_000).unref()
  setTimeout(() => void presenceTick('start'), 20_000).unref()
  heartbeatText()
  {
    const jobs = scheduleStore.list()
    console.log(`[schedule] ${jobs.length} job(s)${jobs.length ? `: ${jobs.map((j) => `"${j.label}" ${ruleText(j.rule, j.tz)}${j.paused ? ' (paused)' : ''}`).join('; ')}` : ''}; heartbeat ${HEARTBEAT_MINUTES ? `every ${HEARTBEAT_MINUTES} min (${heartbeatItems(heartbeatText()).length} item(s) in HEARTBEAT.md)` : 'off'}; morning brief ${briefPrefs(settings.get().brief).on ? `after ${briefPrefs(settings.get().brief).after}` : 'off'}`)
  }
  // Tool servers connect in the background; Setup shows how each one is doing.
  void mcp.start().then(() => {
    const ready = mcp.status().filter((m) => m.state === 'ready')
    if (ready.length) console.log(`[mcp] ${ready.map((m) => `${m.name} (${m.tools.length})`).join(', ')}`)
    setupChanged()
  })
  setInterval(() => void pollBanners(), BANNER_POLL_MS).unref()
  setInterval(() => {
    notices.tick()
    void pollCalendar()
  }, 30_000).unref()
  void refreshCalendarAccess().then((access) => {
    const p = noticeSettings()
    const quiet = parseQuietHours(p.quietHours)
    console.log(
      `[notice] jobs ${p.jobs ? 'on' : 'off'}; messages ${p.messages ? `on${p.readMessages ? ' (with the text)' : ''}${appHands.available ? '' : ' (no helper)'}` : 'off'}; calendar ${p.calendar ? access : 'off'}; reminders ${p.reminders ? 'on' : 'off'} (${reminderStore.list().length} waiting); quiet hours ${quiet ? p.quietHours : 'none'}${p.dnd ? '; do not disturb' : ''}`
    )
    setTimeout(() => void pollCalendar(), 5000).unref()
  })
  // First run: no brain yet, so the setup window does the asking (it does not come back once closed).
  if (!settings.get().setupDone && brain.mode === 'demo') openSetup()
  if (ears && WAKE_MODE === 'word') void setListening(true)
  if (ears && WAKE_GATE) setTimeout(() => void warmAcknowledgements(), 12_000).unref()
  if (updateCheckEnabled()) {
    // after the window has loaded, so the status line has somewhere to go
    setTimeout(() => void checkForUpdate(), 15_000).unref()
    setInterval(() => void checkForUpdate(), UPDATE_EVERY_MS).unref()
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win.show()
  })
})

app.on('before-quit', () => {
  quitting = true
  browseStop = true
  actStop = true
  appHands.stop()
  reminderStore.stop()
  scheduleStore.stop()
  void mcp.close()
  channels.stopAll()
  bar.destroy()
  body.destroy()
  planCard.destroy()
  for (const t of agent.running()) agent.cancel(t.id)
  stopLocalTts()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // Keep running in the tray; Quit lives in the tray menu.
})
