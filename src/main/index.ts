import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, systemPreferences, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { mentionedProject, Projects, type Project } from './projects'
import { Settings } from './settings'
import { cleanTranscript, localSttSelected, sttHealthy, sttUrl, transcribe, wavDurationMs, wavHead } from './stt'
import { autostartLocalTts, synthesize } from './tts'
import { Hands, HandsError } from './hands'
import { newerRelease, updateCheckEnabled, type Release } from './updates'
import { createWakeMatcher } from './wake'
import { ProjectWatcher } from './watcher'
import type { AppConfig, Audio, AvatarCommand, CharacterConfig, Emotion, Reply, ReplyPayload, ToolCall, Touch } from '../shared/types'

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
/** Accessibility granted to the app that runs her (null until checked); without it macOS drops her key presses. */
let appTrusted: boolean | null = null

/** Something she is waiting on an answer for: a job she read back, or a risky browser action. */
type Pending =
  | { kind: 'job'; call: ToolCall; project: Project; at: number }
  | { kind: 'confirm'; at: number; resolve: (yes: boolean) => void }
let pending: Pending | null = null

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
  return LISTEN_SHORTCUT.replace('CommandOrControl', process.platform === 'darwin' ? '⌘' : 'Ctrl')
    .replace('Shift', process.platform === 'darwin' ? '⇧' : 'Shift')
    .replace(/\+/g, process.platform === 'darwin' ? '' : '+')
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
    title: character.name,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  // Sit above everything, on every Space, like the overlay in the reel.
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Closing hides her; the tray keeps the app alive. Quit from the tray menu.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
      refreshTray()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

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

function status(text: string): void {
  win?.webContents.send('status', text)
}

/** One downscaled JPEG of the primary display. The overlay hides itself for the instant of the capture. */
async function captureScreen(): Promise<Stimulus['screenshot']> {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    console.warn(`[screen] access status: ${systemPreferences.getMediaAccessStatus('screen')} (needs Screen Recording permission)`)
    status('I cannot see your screen yet. System Settings → Privacy & Security → Screen Recording → allow Deskmate (or Electron in dev), then restart me.')
  }
  const display = screen.getPrimaryDisplay()
  const width = 1280
  const height = Math.round((display.size.height / display.size.width) * width)
  win.setOpacity(0)
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
    const jpeg = source.thumbnail.toJPEG(60)
    if (process.env.DESKMATE_DEBUG_SAVE_CAPTURE) writeFileSync(process.env.DESKMATE_DEBUG_SAVE_CAPTURE, jpeg)
    return { data: jpeg.toString('base64'), mediaType: 'image/jpeg' }
  } finally {
    win.setOpacity(1)
  }
}

async function deliver(reply: Reply, source: ReplyPayload['source'], ready?: Audio | null): Promise<void> {
  if (!reply.speak || !reply.say) return
  console.log(`[say:${source}] ${reply.say.slice(0, 90)}`)
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
    watchTimer = setInterval(() => void observe(), watchIntervalSec * 1000)
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
    wakeWord: WAKE_GATE ? character.name : null
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
  if (!req) return sayPlain('So far I can message people on Discord and Slack, and ask the Claude app things. Who, where, and what should it say?')
  if (!(await checkAppTrust())) {
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
    const result = await runApp(req, {
      hands: appHands,
      confirm,
      confirmMessages: confirmFor(CONFIRM_SENDS),
      confirmPrompts: confirmFor(CONFIRM_JOBS),
      onStep: status,
      log,
      stopped: () => actStop || quitting
    })
    console.log(`[apps] ${result.ok ? 'done' : 'not done'}: ${result.summary}`)
    memory.addTurn('user', `[${APPS[req.app].name}: ${result.summary}]`)
    return sayPlain(result.say, result.ok ? 'happy' : 'sad')
  } finally {
    acting = false
    refreshTray()
    status(listening ? listeningStatus() : 'idle')
  }
}

/** Runs one tool call, from the router (explicit) or from her brain (she already said she is on it). */
async function runTool(call: ToolCall, opts: { voice?: boolean; acknowledged?: boolean }): Promise<Reply> {
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
  if (text.toLowerCase() === '/forget') {
    memory.clear()
    const reply: Reply = { say: 'Clean slate. Who are you again, sweetheart?', emotion: 'smug', speak: true, remember: [] }
    await deliver(reply, 'chat')
    return reply
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
  if (/^(?:stop|stop it|cancel|that's enough|enough)[.!]?$/i.test(stripName(text)) && (acting || browsing || agent.running().length)) return cancelJob()

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
  await deliver(reply, 'chat')
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
  if (task.status === 'done') void report({ phase: 'done', title: task.title, folder, detail: (task.result || task.lastText || '').slice(0, 1500) })
  else if (task.status === 'failed') void report({ phase: 'failed', title: task.title, folder, detail: task.error })
})

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
})
ipcMain.handle('watch:toggle', () => setWatching(!watching))

ipcMain.on('window:ignore-mouse', (_event, ignore: boolean) => {
  // Click-through everywhere except over the character and the panel; `forward` keeps mousemove flowing so we can re-enable.
  win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
})

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
  createWindow()
  createTray()
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
  for (const t of agent.running()) agent.cancel(t.id)
  stopLocalTts()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // Keep running in the tray; Quit lives in the tray menu.
})
