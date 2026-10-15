import { contextBridge, ipcRenderer } from 'electron'
import type { AvatarCommand, DeskmateApi, ReplyPayload } from '../shared/types'

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
  onReply: (cb) => {
    ipcRenderer.on('reply', (_event, payload: ReplyPayload) => cb(payload))
  },
  onStatus: (cb) => {
    ipcRenderer.on('status', (_event, text: string) => cb(text))
  },
  onCommand: (cb) => {
    ipcRenderer.on('avatar:command', (_event, command: AvatarCommand) => cb(command))
  }
}

contextBridge.exposeInMainWorld('deskmate', api)
