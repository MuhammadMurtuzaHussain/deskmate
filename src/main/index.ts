import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, systemPreferences, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Agent, type Task } from './agent'
import { Brain, type Stimulus, type TaskReport } from './brain'
import { routeCommand } from './commands'
import { loadDotEnv } from './env'
import { Memory } from './memory'
import { mentionedProject, Projects, type Project } from './projects'
import { Settings } from './settings'
import { cleanTranscript, localSttSelected, sttHealthy, sttUrl, transcribe } from './stt'
import { autostartLocalTts, synthesize } from './tts'
import { ProjectWatcher } from './watcher'
import type { AppConfig, AvatarCommand, CharacterConfig, Emotion, Reply, ReplyPayload, ToolCall, Touch } from '../shared/types'

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

// Her hands and ears: Claude Code jobs, the folders they run in, and hands-free listening.
const agent = new Agent(join(USER_DATA, 'tasks'))
const projects = new Projects(settings, join(USER_DATA, 'projects.json'))
let hands = Boolean(agent.findBinary())
const ears = localSttSelected()
let listening = false
const LISTEN_SHORTCUT = process.env.DESKMATE_LISTEN_SHORTCUT?.trim() || 'CommandOrControl+Shift+Space'
const WAKE_NAME = /^(1|true|yes|on)$/i.test(process.env.DESKMATE_WAKE_NAME?.trim() || '')
/** always | voice (default) | never: whether she repeats a job back and waits for a yes before Claude starts */
const CONFIRM_JOBS = (process.env.DESKMATE_CONFIRM_JOBS?.trim().toLowerCase() || 'voice') as 'always' | 'voice' | 'never'
/** a job she has read back and is waiting on a yes/no for */
let pending: { call: ToolCall; project: Project; at: number } | null = null

function switchCharacter(id: string): void {
  if (!characters.some((c) => c.id === id)) return
  activeId = id
  trayDancing = false
  pending = null
  ;({ character, persona } = readCharacter(id))
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
  return Menu.buildFromTemplate([
    { label: `${character.name} · ${brain.modelName}`, enabled: false },
    { type: 'separator' },
    { label: win?.isVisible() ? 'Hide her' : 'Show her', click: toggleWindow },
    { label: 'Look at my screen now', click: () => void observe(true) },
    { label: watching ? 'Stop watching' : 'Watch my screen', type: 'checkbox', checked: watching, click: () => void setWatching(!watching) },
    {
      label: `${listening ? 'Stop listening' : 'Listen hands-free'}  ${shortcutLabel()}`,
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
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
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
    // Feeds a WAV file through the same path as the microphone: transcription, routing, reply.
    debugSayFired = true
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const bytes = new Uint8Array(readFileSync(debugWav))
          void onUtterance(bytes, 0)
        } catch (err) {
          console.error('[debug] could not read DESKMATE_DEBUG_WAV', err)
        }
      }, 10000)
    })
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

async function deliver(reply: Reply, source: ReplyPayload['source']): Promise<void> {
  if (!reply.speak || !reply.say) return
  console.log(`[say:${source}] ${reply.say.slice(0, 90)}`)
  const audio = await synthesize(reply.say, character.voice)
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
    })()
  })
)

ipcMain.handle('character:set', (_event, id: string) => {
  switchCharacter(String(id))
  // The renderer reloads itself to load the new model; config:get then returns the new character.
  win.webContents.reload()
})

ipcMain.handle('chat:send', (_event, rawText: string): Promise<Reply> => handleChat(String(rawText)))

// ---- what she can do with her hands

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
  if (/^(?:yes|yeah|yep|yup|sure|ok|okay|go|go ahead|do it|send it|send|please|yes please|confirm|affirmative|run it|ship it)\b/.test(t)) return 'yes'
  if (/^(?:no|nope|nah|don't|do not|cancel|stop|never mind|nevermind|forget it|wait|hold on|not now)\b/.test(t)) return 'no'
  return null
}

/** "Hey Mika, …" → "…": her name is how they get her attention, not part of the message. */
function stripName(text: string): string {
  const name = character.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`^(?:hey|hi|ok|okay|yo|hello|so)?[\\s,]*${name}[\\s,:!.?-]+`, 'i'), '').replace(new RegExp(`[\\s,]+${name}[.!?]*$`, 'i'), '').trim() || text
}

function jobTitle(call: ToolCall): string {
  if (call.name === 'claude_resume') return call.input ? `continue, then: ${call.input}` : 'continue the last session'
  return call.input
}

async function cancelJob(id?: string): Promise<Reply> {
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
  if (acknowledged) return { say: '', emotion: 'neutral', speak: false, remember: [] }
  return report({ phase: 'started', title: task.title, folder: project.name })
}

/** Opens a website, a known project folder, a path, or an application by name. */
async function openThing(raw: string): Promise<Reply> {
  const input = raw
    .trim()
    .replace(/^(?:the |my )/i, '')
    .replace(/\s+(?:folder|project|directory|repo|app|website|site)$/i, '')
  if (/^(?:https?:\/\/|www\.)/i.test(input) || /^[\w-]+\.(?:com|org|net|io|dev|app|ai|co)(?:\/|$)/i.test(input)) {
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
  const ok = await openApp(input)
  return ok ? sayPlain(`Opening ${input}.`) : sayPlain(`I couldn't find anything called ${input} to open.`, 'sad')
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

/** Runs one tool call, from the router (explicit) or from her brain (she already said she is on it). */
async function runTool(call: ToolCall, opts: { voice?: boolean; acknowledged?: boolean }): Promise<Reply> {
  switch (call.name) {
    case 'tasks':
      return report({ phase: 'status', title: 'status', detail: agent.describe() })
    case 'cancel':
      return cancelJob()
    case 'open':
      return openThing(call.input)
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
      const confirm = CONFIRM_JOBS === 'always' || (CONFIRM_JOBS === 'voice' && Boolean(opts.voice))
      if (confirm) {
        // A misheard sentence must never start a job: she reads it back and waits for a yes.
        pending = { call, project, at: Date.now() }
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
    return { say: '', emotion: 'neutral', speak: false, remember: [] }
  }
  // A job waiting for a yes or no.
  if (pending) {
    if (Date.now() - pending.at > 90_000) pending = null
    else {
      const answer = yesNo(stripName(text))
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

function listeningStatus(): string {
  return `listening · ${WAKE_NAME ? `start with "${character.name}"` : 'just talk'} · ${shortcutLabel()} stops`
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
/** One utterance from the microphone (or the debug hook): transcribe, then treat it exactly like typed chat. */
async function onUtterance(bytes: Uint8Array, ms: number): Promise<void> {
  if (hearing) {
    console.log('[ears] still answering the last one; dropped an utterance')
    return
  }
  hearing = true
  try {
    status('…')
    const t0 = Date.now()
    const transcript = await transcribe(bytes)
    const text = cleanTranscript(transcript)
    console.log(`[ears] ${ms || Math.round((transcript.duration ?? 0) * 1000)} ms of audio -> ${JSON.stringify(transcript.text)} in ${Date.now() - t0} ms${text ? '' : ' (ignored)'}`)
    if (!text) {
      status(listening ? listeningStatus() : 'idle')
      return
    }
    if (WAKE_NAME && !new RegExp(character.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) {
      status(`heard "${text}" (not for me)`)
      return
    }
    status(`you: ${text}`)
    await handleChat(text, { voice: true })
  } catch (err) {
    console.error('[ears]', err)
    status(`my ears failed: ${(err as Error).message}`)
  } finally {
    hearing = false
  }
}

ipcMain.handle('listen:set', (_event, on: boolean) => setListening(Boolean(on)))
ipcMain.handle('mic:heard', (_event, wav: Uint8Array | ArrayBuffer, ms: number) => {
  if (!listening) return
  const bytes = wav instanceof Uint8Array ? new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength) : new Uint8Array(wav)
  return onUtterance(bytes, Number(ms) || 0)
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
  if (ears) {
    void sttHealthy().then((ok) => console.log(`[ears] local speech-to-text ${ok ? 'answering' : 'not answering yet (the server may still be loading)'} at ${sttUrl()}`))
    try {
      if (!globalShortcut.register(LISTEN_SHORTCUT, () => void setListening(!listening))) console.warn(`[ears] could not register ${LISTEN_SHORTCUT}`)
      else console.log(`[ears] ${LISTEN_SHORTCUT} toggles hands-free listening`)
    } catch (err) {
      console.warn('[ears] shortcut:', (err as Error).message)
    }
  }
  createWindow()
  createTray()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win.show()
  })
})

app.on('before-quit', () => {
  quitting = true
  for (const t of agent.running()) agent.cancel(t.id)
  stopLocalTts()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // Keep running in the tray; Quit lives in the tray menu.
})
