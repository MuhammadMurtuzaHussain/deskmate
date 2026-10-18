import { contextBridge, ipcRenderer } from 'electron'
import type { AvatarCommand, DeskmateApi, PermissionKind, RemoteAction, ReplyPayload } from '../shared/types'

const api: DeskmateApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  send: (text) => ipcRenderer.invoke('chat:send', text),
  lookNow: () => ipcRenderer.invoke('watch:look'),
  toggleWatch: () => ipcRenderer.invoke('watch:toggle'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('window:ignore-mouse', ignore),
  moveBy: (dx, dy) => ipcRenderer.send('window:move-by', dx, dy),
  react: (touch) => ipcRenderer.invoke('touch:react', touch),
  setKey: (key) => ipcRenderer.invoke('settings:set-key', key),
  setCharacter: (id) => ipcRenderer.invoke('character:set', id),
  setListening: (on) => ipcRenderer.invoke('listen:set', on),
  // A typed array crosses the bridge intact; a bare ArrayBuffer does not always.
  heard: (wav, ms, bargedIn) => ipcRenderer.invoke('mic:heard', new Uint8Array(wav), ms, Boolean(bargedIn)),
  speaking: (on) => ipcRenderer.send('speech:state', on),
  onReply: (cb) => {
    ipcRenderer.on('reply', (_event, payload: ReplyPayload) => cb(payload))
  },
  onStatus: (cb) => {
    ipcRenderer.on('status', (_event, text: string) => cb(text))
  },
  onCommand: (cb) => {
    ipcRenderer.on('avatar:command', (_event, command: AvatarCommand) => cb(command))
  },
  onListen: (cb) => {
    ipcRenderer.on('listen:state', (_event, on: boolean) => cb(on))
  },
  hideBar: () => ipcRenderer.send('bar:hide'),
  onLine: (cb) => {
    ipcRenderer.on('bar:line', (_event, say: string) => cb(say))
  },
  getSetup: () => ipcRenderer.invoke('setup:get'),
  useOllama: (model) => ipcRenderer.invoke('setup:ollama', model),
  useGemini: (key) => ipcRenderer.invoke('setup:gemini', key),
  useClaude: (key, model, effort) => ipcRenderer.invoke('setup:claude', key, model, effort),
  allow: (kind: PermissionKind) => ipcRenderer.invoke('setup:allow', kind),
  finishSetup: () => ipcRenderer.invoke('setup:finish'),
  openSetup: () => ipcRenderer.send('setup:open'),
  useTelegram: (token) => ipcRenderer.invoke('setup:telegram', token),
  remote: (action: RemoteAction) => ipcRenderer.invoke('setup:remote', action),
  onSetupChanged: (cb) => {
    ipcRenderer.on('setup:changed', () => cb())
  }
}

contextBridge.exposeInMainWorld('deskmate', api)
