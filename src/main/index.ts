import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, screen, shell, systemPreferences, Tray } from 'electron'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Brain, type Stimulus } from './brain'
import { loadDotEnv } from './env'
import { Memory } from './memory'
import { Settings } from './settings'
import { autostartLocalTts, synthesize } from './tts'
import { ProjectWatcher } from './watcher'
import type { AppConfig, AvatarCommand, CharacterConfig, Reply, ReplyPayload, Touch } from '../shared/types'

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
  const character = { ...(JSON.parse(readFileSync(join(dir, 'character.json'), 'utf8')) as CharacterConfig), id }
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

function switchCharacter(id: string): void {
  if (!characters.some((c) => c.id === id)) return
  activeId = id
  trayDancing = false
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

function buildTrayMenu(): Menu {
  const loginItem = app.getLoginItemSettings().openAtLogin
  const threeD = character.renderer === 'vrm' || character.renderer === 'mmd'
  return Menu.buildFromTemplate([
    { label: `${character.name} · ${brain.modelName}`, enabled: false },
    { type: 'separator' },
    { label: win?.isVisible() ? 'Hide her' : 'Show her', click: toggleWindow },
    { label: 'Look at my screen now', click: () => void observe(true) },
    { label: watching ? 'Stop watching' : 'Watch my screen', type: 'checkbox', checked: watching, click: () => void setWatching(!watching) },
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
        const reply = await brain.respond({ kind: 'chat', text: debugSay })
        console.log('[debug] reply', JSON.stringify(reply))
        await deliver(reply, 'chat')
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
      }, debugSay || debugTouch || debugCommand || process.env.DESKMATE_DEBUG_LOOK ? 16000 : 8000)
    })
  }
}

function status(text: string): void {
  win?.webContents.send('status', text)
}

/** One downscaled JPEG of the primary display. The overlay hides itself for the instant of the capture. */
async function captureScreen(): Promise<Stimulus['screenshot']> {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    status('I cannot see your screen yet. System Settings → Privacy & Security → Screen Recording → allow deskmate (or Electron in dev).')
  }
  const display = screen.getPrimaryDisplay()
  const width = 1280
  const height = Math.round((display.size.height / display.size.width) * width)
  win.setOpacity(0)
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) return undefined
    return { data: source.thumbnail.toJPEG(60).toString('base64'), mediaType: 'image/jpeg' }
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

ipcMain.handle('config:get', (): AppConfig => ({ character, characters, mode: brain.mode, modelName: brain.modelName, watchDir, watching, watchIntervalSec }))

ipcMain.handle('character:set', (_event, id: string) => {
  switchCharacter(String(id))
  // The renderer reloads itself to load the new model; config:get then returns the new character.
  win.webContents.reload()
})

ipcMain.handle('chat:send', async (_event, rawText: string): Promise<Reply> => {
  const text = String(rawText).slice(0, 2000)
  if (text.trim().toLowerCase() === '/forget') {
    memory.clear()
    const reply: Reply = { say: 'Clean slate. Who are you again, sweetheart?', emotion: 'smug', speak: true, remember: [] }
    await deliver(reply, 'chat')
    return reply
  }
  // Let her see the screen when she answers, so "what's this error" works. Always on the local brain (free);
  // on Gemini only when the message sounds like it is about the screen, to save quota.
  const aboutScreen = /\b(this|that|these|here|screen|error|tab|page|what am i|what i'm|see|look|fix|why)\b/i.test(text)
  const screenshot = brain.mode === 'ollama' || aboutScreen ? await captureScreen().catch(() => undefined) : undefined
  const reply = await brain.respond({ kind: 'chat', text, screenshot })
  await deliver(reply, 'chat')
  return reply
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
  createWindow()
  createTray()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win.show()
  })
})

app.on('before-quit', () => {
  quitting = true
  stopLocalTts()
})

app.on('window-all-closed', () => {
  // Keep running in the tray; Quit lives in the tray menu.
})
