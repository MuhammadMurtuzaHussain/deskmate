import { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, systemPreferences, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Agent, type Task } from './agent'
import { APP_PLAN_SCHEMA, APP_PLAN_SYSTEM, APPS, fromPlan, handsMessage, parseAppRequest, runApp, type AppRequest } from './apps'
import { ACKNOWLEDGEMENTS, Brain, type Stimulus, type TaskReport } from './brain'
import { browse } from './browse'
import * as chrome from './chrome'
import { routeCommand } from './commands'
import { loadDotEnv } from './env'
import { Memory } from './memory'
import { checkToken, outsidePhone, PhoneRemote, TelegramApi, type PairRequest } from './remote'
import { mentionedProject, Projects, type Project } from './projects'
import { Settings } from './settings'
import { cleanTranscript, localSttSelected, sttHealthy, sttUrl, transcribe, wavDurationMs, wavHead } from './stt'
import { autostartLocalTts, localTtsSelected, synthesize } from './tts'
import { CommandBar } from './bar'
import { Body } from './body'
import { agendaLine, dueEvents, eventLine, type CalendarEvent } from './calendar'
import { appAllowed, BannerWatch, messageLine } from './inbox'
import { Journal } from './journal'
import { NoticeCenter, noticePrefs, parseQuietHours, type Notice } from './notice'
import { dueLine, listLine, parseReminder, parseWhen, ReminderStore, setLine, timeIn, timerName, toSecondPerson, whenText, type Reminder, type ReminderIntent } from './reminders'
import { planCommand, planSummary, plannerSystem, PLAN_SCHEMA, PlanStore, reviseSystem, toPlan, type PlanCommand } from './plan'
import { PlanCard } from './planwin'
import { runComputerTask } from './computer'
import { Hands, HandsError } from './hands'
import { newerRelease, updateCheckEnabled, type Release } from './updates'
import { createWakeMatcher } from './wake'
import { ProjectWatcher } from './watcher'
import { BODY_COMMANDS, type NoticePrefs, type NoticeState, type Plan, type PlanAction, type PlanWorker, type AppConfig, type Audio, type AvatarCommand, type BodyCommand, type CharacterConfig, type Emotion, type PermissionKind, type Reply, type ReplyPayload, type SetupState, type ToolCall, type Touch } from '../shared/types'

// In development everything is in the project; packaged, characters/tts-local/icons ship as extraResources.
const ROOT = app.getAppPath()
const RESOURCES = app.isPackaged ? process.resourcesPath : ROOT
const USER_DATA = app.getPath('userData')
const REPO_URL = 'https://github.com/MuhammadMurtuzaHussain/deskmate'
loadDotEnv(USER_DATA, ROOT)

// Characters live in character/<id>/{character.json, persona.md}. Each has her own persona, voice and memory file.
// Two roots: the ones shipped with the app, and the user's own under <user data>/character (editable, survives updates).
const CHARACTER_DIRS = [join(USER_DATA, 'character'), join(RESOURCES, 'character')]
function characterDir(id: string): string | null {
  return CHARACTER_DIRS.find((d) => existsSync(join(d, id, 'character.json'))) ?? null
}
function listCharacters(): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const root of CHARACTER_DIRS) {
    if (!existsSync(root)) continue
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || seen.has(d.name) || !existsSync(join(root, d.name, 'character.json'))) continue
      try {
        const cfg = JSON.parse(readFileSync(join(root, d.name, 'character.json'), 'utf8')) as CharacterConfig
        seen.set(d.name, cfg.name)
      } catch (err) {
        console.warn(`[character] skipping ${d.name}: ${(err as Error).message}`)
      }
    }
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id))
}
function readCharacter(id: string): { character: CharacterConfig; persona: string } {
  const dir = join(characterDir(id) as string, id)
  let character = { ...(JSON.parse(readFileSync(join(dir, 'character.json'), 'utf8')) as CharacterConfig), id }
  // local.json (gitignored) overlays private tweaks: your own dance clips, voice, outfits, model path.
  const localPath = join(dir, 'local.json')
  if (existsSync(localPath)) {
    try {
      character = { ...character, ...(JSON.parse(readFileSync(localPath, 'utf8')) as Partial<CharacterConfig>), id }
    } catch (err) {
      console.warn(`[character] ${id}/local.json ignored: ${(err as Error).message}`)
    }
  }
  const persona = readFileSync(join(dir, 'persona.md'), 'utf8')
  return { character, persona }
}

const settings = new Settings(join(app.getPath('userData'), 'settings.json'))
const characters = listCharacters()
if (characters.length === 0) throw new Error('no characters found under character/<id>/character.json')
const requested = process.env.DESKMATE_CHARACTER?.trim() || settings.get().activeCharacter || 'mika'
let activeId = characters.some((c) => c.id === requested) ? requested : characters[0].id
let { character, persona } = readCharacter(activeId)
let memory = new Memory(join(app.getPath('userData'), `memory-${activeId}.json`))
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

// Her hands in desktop apps (macOS): the native helper that launches apps, presses keys and reads window titles.
const appHands = new Hands(Hands.locate(RESOURCES, ROOT))
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
  busy: () => acting || browsing || herSpeaking || hearing
})
// What she did, by day ("what did you do today?"), and the plan she is showing or working through.
const journal = new Journal(join(USER_DATA, 'log'))
const plans = new PlanStore(join(USER_DATA, 'plans'))
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
}

/** Something she is waiting on an answer for: a job she read back, or a risky browser action. */
type Pending =
  | { kind: 'job'; call: ToolCall; project: Project; at: number }
  | { kind: 'confirm'; at: number; resolve: (yes: boolean) => void }
let pending: Pending | null = null

// Her phone remote (a Telegram bot), when it is set up and on; see the "phone remote" section below.
let remote: PhoneRemote | null = null
/** the bot's @name once getMe answered; the error when the token stopped working */
let remoteBot: string | null = null
let remoteError: string | null = null
/** answers the open pairing question (her read-back on the Mac, or Allow / Refuse in Setup) */
let pairAnswer: ((yes: boolean) => void) | null = null
/** Claude Code jobs started from the phone: their end is reported there too */
const phoneJobs = new Set<string>()

function switchCharacter(id: string): void {
  if (!characters.some((c) => c.id === id)) return
  activeId = id
  trayDancing = false
  if (pending?.kind === 'confirm') pending.resolve(false)
  pending = null
  ;({ character, persona } = readCharacter(id))
  wake = createWakeMatcher(character.name)
  memory = new Memory(join(app.getPath('userData'), `memory-${id}.json`))
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
        { label: 'Back to her spot', click: () => void runBodyCommand('go_home') },
        { label: body.mode === 'sleep' ? 'Wake her' : 'Let her nap', click: () => void runBodyCommand(body.mode === 'sleep' ? 'wake' : 'sleep') },
        { label: 'Walk around on her own', type: 'checkbox', checked: body.wandering, click: () => void runBodyCommand(body.wandering ? 'stay' : 'wander') }
      ]
    },
    ...remindersMenu(),
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
    remoteMenuItem(),
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
    { label: 'Setup…', click: openSetup },
    { label: 'Open settings folder', click: () => void shell.openPath(USER_DATA) },
    { label: 'Open characters folder', click: () => void shell.openPath(CHARACTER_DIRS[1]) },
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
  if (!IDLE_STATUS.test(text)) remote?.status(text)
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
  // Trim to what is not transparent. The bitmap is in device pixels (BGRA); crop() takes points.
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
    image = image.crop({
      x: Math.max(0, Math.floor((x0 - pad) / scale)),
      y: Math.max(0, Math.floor((y0 - pad) / scale)),
      width: Math.min(size.width, Math.ceil((x1 - x0 + 2 * pad) / scale)),
      height: Math.min(size.height, Math.ceil((y1 - y0 + 2 * pad) / scale))
    })
  }
  const dir = join(app.getPath('pictures'), 'Deskmate')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${character.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`)
  const png = image.toPNG()
  writeFileSync(file, png)
  // Electron 44's clipboard takes W3C-style items.
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]).catch((err) => console.warn('[portrait] clipboard:', (err as Error).message))
  return file
}

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
  // Work that came from the phone gets her lines there; while she waits on a yes, with Yes / No buttons.
  if (source !== 'observe' && source !== 'touch') remote?.say(reply.say, { ask: Boolean(pending) })
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
    watchTimer = outsidePhone(() => setInterval(() => void observe(), watchIntervalSec * 1000))
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
  (): AppConfig => ({
    character,
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
  if (pending?.kind === 'confirm') pending.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const done = (yes: boolean): void => {
      if (settled) return
      settled = true
      if (pending?.kind === 'confirm' && pending.resolve === done) pending = null
      resolve(yes)
    }
    pending = { kind: 'confirm', at: Date.now(), resolve: done }
    setTimeout(() => done(false), 60_000).unref()
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
  if (remote?.active) phoneJobs.add(task.id)
  status(`Claude · ${task.title} · starting…`)
  refreshTray()
  if (acknowledged) return QUIET
  return report({ phase: 'started', title: task.title, folder: project.name })
}

/** Opens a website, a known project folder, a path, or an application by name. */
async function openThing(raw: string): Promise<Reply> {
  const input = raw
    .trim()
    .replace(/^(?:the |my )/i, '')
    .replace(/\s+(?:folder|project|directory|repo|app|website|site)$/i, '')
  if (/^(?:https?:\/\/|www\.)/i.test(input) || /^[\w-]+\.(?:com|org|net|io|dev|app|ai|co|uk|ie|de|fr)(?:\/|$)/i.test(input)) {
    await shell.openExternal(/^https?:/i.test(input) ? input : `https://${input}`)
    return sayPlain(`Opening ${input}.`)
  }
  const project = projects.resolve(input)
  if (project) {
    await shell.openPath(project.path)
    return sayPlain(`Opening ${project.name}.`)
  }
  const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input
  if (existsSync(expanded)) {
    await shell.openPath(expanded)
    return sayPlain(`Opening ${basename(expanded)}.`)
  }
  if (await openApp(input)) return sayPlain(`Opening ${input}.`)
  if (/^[\w-]+$/.test(input)) {
    // Not an app, one word: most likely a site ("open youtube").
    await shell.openExternal(`https://${input.toLowerCase()}.com`)
    return sayPlain(`Opening ${input.toLowerCase()}.com.`)
  }
  return sayPlain(`I couldn't find anything called ${input} to open.`, 'sad')
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
  const colon = input.indexOf(':')
  const verb = colon >= 0 ? input.slice(0, colon) : input
  const arg = colon >= 0 ? input.slice(colon + 1).trim() : ''
  try {
    switch (verb) {
      case 'next_tab':
        status(`tab: ${await chrome.switchTab(1)}`)
        return QUIET
      case 'prev_tab':
        status(`tab: ${await chrome.switchTab(-1)}`)
        return QUIET
      case 'close_tab':
        await chrome.closeTab()
        status('closed the tab')
        return QUIET
      case 'back':
      case 'forward':
      case 'reload':
        await chrome.navigate(verb)
        return QUIET
      case 'scroll_down':
      case 'scroll_up':
        await chrome.scroll(verb === 'scroll_down' ? 'down' : 'up')
        return QUIET
      case 'search':
        await chrome.open(chrome.searchUrl(arg))
        return sayPlain(`Searching for ${arg}.`)
      case 'click': {
        const result = await chrome.clickText(arg)
        if (result === 'missing') return sayPlain(`I can't see anything called "${arg}" to click on this page.`, 'annoyed')
        status(result)
        return QUIET
      }
      case 'find': {
        if (await chrome.find(arg)) {
          status(`found "${arg}"`)
          return QUIET
        }
        return sayPlain(`"${arg}" isn't on this page.`)
      }
      default:
        return sayPlain(`I don't know how to ${verb} in Chrome.`)
    }
  } catch (err) {
    return sayPlain(chromeMessage(err), 'sad')
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

/** Something to do inside a desktop app: a Discord or Slack message, a chat to open, a prompt for the Claude app. */
async function runAppTool(input: string, opts: { voice?: boolean; acknowledged?: boolean }): Promise<Reply> {
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
      maxSteps: Math.max(5, Number(process.env.DESKMATE_AGENT_STEPS) || 25)
    })
    return result
  }
}

/** Body moves: from her brain's "action", or from a phrase. Returns a line to say, or null to stay quiet. */
async function runBodyCommand(command: BodyCommand): Promise<string | null> {
  switch (command) {
    case 'come_here':
      await body.comeToCursor()
      return null
    case 'go_home':
      await body.goHome()
      return null
    case 'sit': {
      if (!appHands.available) return 'I need my hands helper to find a window to sit on.'
      const app = await body.sitOnTopWindow()
      if (app === 'too_high') return "That window's right up at the top of the screen, there's no room for me on it. Move it down a bit?"
      return app ? null : "There's no window here I can sit on."
    }
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
  [/^(?:stand up|get up|get down)[.!]?$/i, 'stand'],
  [/^(?:go to sleep|take a nap|nap time|sleep)[.!]?$/i, 'sleep'],
  [/^(?:wake up)[.!]?$/i, 'wake'],
  [/^(?:walk around|wander(?: around)?|go explore|explore|roam(?: around)?)[.!]?$/i, 'wander'],
  [/^(?:stay(?: put| there| here)?|stop (?:walking|wandering)(?: around)?)[.!]?$/i, 'stay']
]
const RE_FIND = /^(?:where(?:'s| is| are| did i (?:put|save|leave))|find|show me(?: where)?|locate|look for|can you find)\s+(?:my|the|that|this|a|an)\s+(.+?)(?:\s+(?:is|are|went|file|folder|document))?(?: on (?:my|this) (?:mac|computer|laptop))?[?.!]*$/i

const FILEISH = /\b(?:file|files|folder|pdf|docx?|document|photo|picture|pic|image|screenshot|resume|cv|invoice|receipt|spreadsheet|slides|presentation|zip|video|recording|download(?:s|ed)?|\.\w{2,4})\b/i
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
async function findAndReveal(what: string): Promise<{ name: string; where: string; more: number } | null> {
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
  return { name, where, more: found.length - 1 }
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
  w.push('app', 'find', 'open', 'say', 'ask')
  return w
}

function showPlan(): void {
  if (!plan) return
  plans.save(plan)
  planCard.show(plan)
  refreshTray()
}

async function makePlan(goal: string): Promise<Reply> {
  const what = goal.trim()
  if (!what) return sayPlain('A plan for what?')
  if (!brain.canThink) return sayPlain('I need a brain to plan with. Pick one in Setup, from my menu.', 'sad')
  if (planRunning) return sayPlain('I\'m in the middle of a plan. Say "stop the plan" first.', 'annoyed')
  status('planning…')
  const workers = planWorkers()
  let obj: Record<string, unknown>
  try {
    obj = await brain.plan(plannerSystem(workers), `Goal: ${what}`, PLAN_SCHEMA)
  } catch (err) {
    return sayPlain(`I couldn't plan that: ${(err as Error).message.slice(0, 120)}`, 'sad')
  }
  const next = toPlan(what, obj, workers)
  if (!next) return sayPlain("I couldn't break that into steps. Say it another way?", 'sad')
  plan = next
  console.log(`[plan] ${next.title}: ${next.steps.map((s) => `${s.worker}: ${s.text}`).join(' | ')}`)
  journal.add('plan', `planned "${next.title}" (${next.steps.length} steps)`)
  showPlan()
  if (PLAN_AUTO) {
    void runPlan()
    return sayPlain(`On it: ${next.title}.`)
  }
  return sayPlain(planSummary(next))
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
      reviseSystem(workers),
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
    case 'app': {
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
    const reply: Reply = { say: 'Clean slate. Who are you again, sweetheart?', emotion: 'smug', speak: true, remember: [] }
    await deliver(reply, 'chat')
    return reply
  }
  if (/^(?:\/(?:selfie|portrait)|(?:take|send|give me|show me) (?:a |an )?(?:selfie|photo of you(?:rself)?|picture of you(?:rself)?|pic of you(?:rself)?))[.!]?$/i.test(stripName(text))) {
    try {
      if (remote?.active) {
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
        await remote.photo(readFileSync(file))
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
    const line = await runBodyCommand(move[1])
    return line ? sayPlain(line) : QUIET
  }
  const lookFor = RE_FIND.exec(said)
  if (lookFor && !/\b(?:page|tab|website|site|screen|error|bug|flight|price|cheapest|best|weather)\b/i.test(lookFor[1])) {
    // "where's my …" is about a place on this Mac; "find the …" only when it names a file-like thing.
    if (/^where/i.test(said) || FILEISH.test(lookFor[1]) || FILEISH.test(said)) return findAndShow(lookFor[1])
  }

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
  if (reply.tool?.name === 'app' && !/\b(?:discord|slack|claude|messages?|imessages?|imsg|texts?|texting|spotify|music|song|track)\b/i.test(text)) {
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
  if (reply.action && (BODY_COMMANDS as string[]).includes(reply.action)) void runBodyCommand(reply.action as BodyCommand)
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
  if (phoneJobs.delete(task.id) && remote) {
    void remote.run(tell)
    return
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
    speak: tell
  })
})

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
    // With the phone remote on, what she tells you on her own goes to the phone too.
    if (remote?.paired) await remote.run(speak)
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
  for (const k of ['jobs', 'messages', 'readMessages', 'calendar', 'reminders', 'dnd'] as const) if (typeof p[k] === 'boolean') out[k] = p[k] as boolean
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
  if (!appHands.available) return sayPlain('I need my hands helper to read your calendar (it comes with the Mac app).', 'sad')
  if ((await refreshCalendarAccess()) === 'notDetermined') {
    status('asking macOS for your calendars…')
    await appHands.requestCalendarAccess()
    await refreshCalendarAccess()
    setupChanged()
  }
  if (calendarAccess !== 'fullAccess') {
    return sayPlain("I can't see your calendar. Let me in: System Settings → Privacy & Security → Calendars, switch me on, then ask again.", 'sad')
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
      if (!next) return sayPlain('Nothing on your calendar in the next week.')
      return sayPlain(`Next up: ${next.title || 'an event'} ${whenText(next.start, now.getTime())}.`)
    }
  } catch (err) {
    return sayPlain(`I couldn't read your calendar: ${(err as Error).message}`, 'sad')
  }
  journal.add('calendar', `read the calendar for ${which}`)
  return sayPlain(agendaLine(events, now.getTime(), which))
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
  const known: PlanAction[] = ['go', 'pause', 'resume', 'stop', 'retry', 'dismiss']
  if (known.includes(action)) void planDo({ kind: action } as PlanCommand)
})
ipcMain.on('plan:height', (_event, px: number) => planCard.setHeight(Number(px)))

// ---- phone remote: a Telegram bot brings the paired phone's messages into her chat path

/** Setup's token wins over DESKMATE_TELEGRAM_TOKEN in .env, like her brain. */
function telegramToken(): string {
  return settings.get().telegramToken?.trim() || process.env.DESKMATE_TELEGRAM_TOKEN?.trim() || ''
}

/** Only for testing against a fake Bot API; the real one is the default. */
const TELEGRAM_API_URL = process.env.DESKMATE_TELEGRAM_API_URL?.trim() || undefined

function setupChanged(): void {
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('setup:changed')
}

function remoteMenuItem(): Electron.MenuItemConstructorOptions {
  if (!telegramToken()) return { label: 'Phone remote: set up…', toolTip: 'Send her messages from your phone, through a Telegram bot', click: openSetup }
  const paired = settings.get().remotePaired
  return {
    label: `Phone remote: ${remote ? 'on' : 'off'}`,
    type: 'checkbox',
    checked: Boolean(remote),
    toolTip: remoteError ?? (paired ? `Paired with ${paired.name}` : `Send /start to ${remoteBot ? `@${remoteBot}` : 'your bot'} in Telegram to pair your phone`),
    click: () => setRemote(!remote)
  }
}

function remoteStatusLine(): string {
  const paired = settings.get().remotePaired
  if (paired) return `phone remote on · ${paired.name}`
  return `phone remote on · send /start to ${remoteBot ? `@${remoteBot}` : 'your bot'} in Telegram`
}

function setRemote(on: boolean): void {
  settings.set({ remoteEnabled: on })
  if (on) startRemote()
  else stopRemote()
  status(on ? remoteStatusLine() : 'phone remote off')
}

function stopRemote(): void {
  remote?.stop()
  remote = null
  pairAnswer?.(false)
  refreshTray()
  setupChanged()
}

function startRemote(): void {
  remote?.stop()
  remote = null
  pairAnswer?.(false)
  remoteError = null
  const token = telegramToken()
  if (token && settings.get().remoteEnabled !== false) {
    const api = new TelegramApi(token, { base: TELEGRAM_API_URL })
    const r = new PhoneRemote({
      api,
      paired: settings.get().remotePaired ?? null,
      askToPair,
      onPaired: (paired) => {
        settings.set({ remotePaired: paired ?? undefined })
        console.log(paired ? `[remote] paired with ${paired.name}` : '[remote] unpaired')
        status(paired ? `phone paired · ${paired.name}` : 'phone unpaired')
        refreshTray()
        setupChanged()
      },
      onMessage: phoneMessage,
      onFatal: (message) => {
        if (remote === r) remote = null
        remoteError = message
        status(message)
        refreshTray()
        setupChanged()
      },
      log: (line) => console.log(`[remote] ${line}`)
    })
    remote = r
    r.start()
    void api.getMe().then(
      (me) => {
        remoteBot = me.username ?? null
        const paired = settings.get().remotePaired
        console.log(`[remote] polling @${remoteBot ?? '?'}; ${paired ? `paired with ${paired.name}` : 'not paired yet: the first /start asks here'}`)
        refreshTray()
        setupChanged()
      },
      (err) => console.warn(`[remote] getMe: ${(err as Error).message}`)
    )
  }
  refreshTray()
  setupChanged()
}

/** A /start while no phone is paired: she reads it back on the Mac, and Setup shows Allow / Refuse. Either answers. */
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
    console.log(`[remote] ${req.name} (chat ${req.chatId}) asks to pair; code ${req.code}`)
    const spoken = req.code.split('').join(' ')
    void confirm(`Someone on Telegram, ${req.name}, wants to control me from their phone. The code is ${spoken}. Is that you?`).then(finish)
    mine = pending
    status(`📱 pairing request · ${req.name} · code ${req.code} · say yes, or Allow in Setup`)
    setupChanged()
  })
}

/** One message from the paired phone. It runs as phone work, so every line and step of hers goes back to the phone. */
async function phoneMessage(text: string): Promise<void> {
  console.log(`[remote] from the phone: ${text.slice(0, 80)}`)
  // On the Mac only: the phone knows what it sent.
  const line = `📱 ${text.slice(0, 70)}`
  win?.webContents.send('status', line)
  bar.status(line)
  await handleChat(text)
}

// ---- first-run window: her brain, her voice, and what macOS lets her do

let setupWin: BrowserWindow | null = null
let setupStartMode: string = brain.mode

function openSetup(): void {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show()
    setupWin.focus()
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
    remote: {
      token: Boolean(telegramToken()),
      fromEnv: !settings.get().telegramToken?.trim() && Boolean(process.env.DESKMATE_TELEGRAM_TOKEN?.trim()),
      bot: remoteBot,
      on: Boolean(remote),
      paired: settings.get().remotePaired?.name ?? null,
      request: remote?.pairing && pairAnswer ? { name: remote.pairing.name, code: remote.pairing.code } : null,
      error: remoteError
    },
    notices: noticeState()
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
ipcMain.handle('setup:telegram', async (_event, raw: string) => {
  const token = String(raw ?? '').trim()
  const result = await checkToken(token, { base: TELEGRAM_API_URL })
  if (result.ok) {
    // Another bot is another chat: the old pairing does not carry over.
    const changed = token !== telegramToken()
    settings.set({ telegramToken: token, remoteEnabled: true, ...(changed ? { remotePaired: undefined } : {}) })
    remoteBot = result.bot ?? null
    startRemote()
    status(remoteStatusLine())
  }
  return result
})
ipcMain.handle('setup:remote', (_event, action: string) => {
  if (action === 'allow' || action === 'refuse') pairAnswer?.(action === 'allow')
  else if (action === 'forget') {
    if (remote?.paired) remote.unpair()
    else settings.set({ remotePaired: undefined })
    status('phone unpaired')
  } else if (action === 'on' || action === 'off') setRemote(action === 'on')
  refreshTray()
  setupChanged()
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
ipcMain.handle('setup:finish', () => {
  setupWin?.close()
})
ipcMain.on('setup:open', () => openSetup())

let stopLocalTts: () => void = () => undefined

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide() // menu-bar app: no Dock icon
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
  if (appHands.available) {
    void checkAppTrust().then((ok) =>
      console.log(`[apps] app control ready (Discord, Slack, Claude); Accessibility ${ok ? 'granted' : 'NOT granted: she will ask the first time'}`)
    )
  } else if (process.platform === 'darwin') {
    console.log('[apps] native/bin/deskmate-hands missing: app control is off (npm run build compiles it)')
  }
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
  if (SLEEP_AFTER_MIN > 0) {
    setInterval(() => {
      if (body.mode === 'idle' || body.mode === 'sit') {
        if (Date.now() - lastActivity > SLEEP_AFTER_MIN * 60_000 && !acting && !browsing && !herSpeaking && !hearing && !agent.running().length) body.sleep()
      }
    }, 30_000).unref()
  }
  createTray()
  startRemote()
  // What she comes to tell you about on her own: reminders (kept across restarts), messages, the calendar.
  reminderStore.start()
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
  remote?.stop()
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
