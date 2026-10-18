import { contextBridge, ipcRenderer } from 'electron'
import type { ActivityView, Plan, PlanAction, Anchors, AvatarCommand, BodyState, DeskmateApi, Gesture, NoticePrefs, PermissionKind, ChannelAction, ChannelKey, ReplyPayload } from '../shared/types'

const api: DeskmateApi = {
  getConfig: (id) => ipcRenderer.invoke('config:get', id),
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
  onBody: (cb) => {
    ipcRenderer.on('avatar:body', (_event, state: BodyState) => cb(state))
  },
  onGesture: (cb) => {
    ipcRenderer.on('avatar:gesture', (_event, gesture: Gesture) => cb(gesture))
  },
  reportAnchors: (anchors: Anchors) => ipcRenderer.send('avatar:anchors', anchors),
  channel: (id: ChannelKey, action: ChannelAction, data?: Record<string, string>) => ipcRenderer.invoke('setup:channel', id, action, data),
  setNotices: (patch: Partial<NoticePrefs>) => ipcRenderer.invoke('setup:notices', patch),
  calendarAccess: () => ipcRenderer.invoke('setup:calendar'),
  mcpToggle: (name, on) => ipcRenderer.invoke('setup:mcp-toggle', name, on),
  mcpReload: () => ipcRenderer.invoke('setup:mcp-reload'),
  mcpOpenConfig: () => ipcRenderer.invoke('setup:mcp-open'),
  openMemory: () => ipcRenderer.invoke('setup:memory-open'),
  openSkills: () => ipcRenderer.invoke('setup:skills-open'),
  draftAction: (name, action) => ipcRenderer.invoke('setup:draft', name, action),
  jobAction: (id, action) => ipcRenderer.invoke('setup:job', id, action),
  setBrief: (patch) => ipcRenderer.invoke('setup:brief', patch),
  openHeartbeat: () => ipcRenderer.invoke('setup:heartbeat-open'),
  onSetupChanged: (cb) => {
    ipcRenderer.on('setup:changed', () => cb())
  },
  listCharacters: () => ipcRenderer.invoke('characters:list'),
  characterThumb: (id) => ipcRenderer.invoke('characters:thumb', id),
  characterDetails: (id) => ipcRenderer.invoke('characters:details', id),
  saveCharacter: (id, patch) => ipcRenderer.invoke('characters:save', id, patch),
  addCharacter: (path) => ipcRenderer.invoke('characters:add', path),
  removeCharacter: (id) => ipcRenderer.invoke('characters:remove', id),
  voices: () => ipcRenderer.invoke('characters:voices'),
  onCharactersChanged: (cb) => {
    ipcRenderer.on('characters:changed', () => cb())
  },
  onPlan: (cb) => {
    ipcRenderer.on('plan:update', (_event, plan: Plan | null) => cb(plan))
  },
  planAction: (action: PlanAction) => ipcRenderer.send('plan:action', action),
  planHeight: (px: number) => ipcRenderer.send('plan:height', px),
  setPermission: (tool, level, origin) => ipcRenderer.invoke('setup:permission', tool, level, origin),
  setOriginFloor: (origin, floor) => ipcRenderer.invoke('setup:floor', origin, floor),
  setSafety: (patch) => ipcRenderer.invoke('setup:safety', patch),
  stopEverything: () => ipcRenderer.invoke('safety:stop'),
  setBudget: (n) => ipcRenderer.invoke('setup:budget', n),
  openActivity: () => ipcRenderer.send('activity:open'),
  onActivity: (cb) => {
    ipcRenderer.on('activity:update', (_event, view: ActivityView) => cb(view))
  },
  activityUndo: (id) => ipcRenderer.invoke('activity:undo', id)
}

contextBridge.exposeInMainWorld('deskmate', api)
