import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NoticePrefs } from '../shared/types'

export interface SettingsData {
  geminiApiKey?: string
  activeCharacter?: string
  /** folder Claude jobs run in unless the user names another */
  activeProject?: string
  /** chosen in the first-run window; DESKMATE_BRAIN / OLLAMA_MODEL in .env win over these */
  brain?: 'ollama' | 'gemini' | 'anthropic'
  ollamaModel?: string
  /** Claude through the Anthropic API (ANTHROPIC_API_KEY / ANTHROPIC_MODEL in .env win) */
  anthropicApiKey?: string
  anthropicModel?: string
  anthropicEffort?: 'low' | 'medium' | 'high'
  /** Telegram channel: the bot token from @BotFather (DESKMATE_TELEGRAM_TOKEN in .env is used when this is empty) */
  telegramToken?: string
  /** Telegram on (default when a token exists) or off, from the tray menu or Setup */
  remoteEnabled?: boolean
  /** the one Telegram account allowed to control her, confirmed on the Mac */
  remotePaired?: { chatId: number; userId: number; name: string }
  /** the other chat apps she can be reached through (channels/); each is off until set up and switched on. Tokens
   * live only here (this file is mode 0600) and are never logged. */
  channels?: {
    discord?: { token?: string; on?: boolean; owner?: ChannelOwner }
    slack?: { botToken?: string; appToken?: string; on?: boolean; owner?: ChannelOwner }
    /** handles that count as the user: their own number and Apple ID, a second number */
    imessage?: { on?: boolean; handles?: string[] }
    /** account: the user's Signal number, linked to signal-cli; handles: other numbers of theirs */
    signal?: { on?: boolean; account?: string; handles?: string[]; cli?: string }
    /** answer a voice note with a voice clip (Kokoro) as well as text */
    voiceReplies?: boolean
  }
  /** the first-run window was finished or closed once */
  setupDone?: boolean
  /** newest release the "update available" status line was already shown for, so it is said once per version */
  updateNotified?: string
  /** what she tells you about on her own (Setup → "What she tells you about"); missing fields take the defaults */
  notices?: Partial<NoticePrefs>
  /** MCP servers from mcp.json switched off in Setup (by name) */
  mcpDisabled?: string[]
  /** skills whose scripts the user allowed to run, with a fingerprint of the scripts they said yes to (skillmd.ts) */
  skillScripts?: Record<string, string>
  /** the morning brief (Setup → Scheduled): on, not before this hour ("07:00"), and the day it last ran */
  brief?: { on?: boolean; after?: string; lastDay?: string }
}

/** The account paired on a chat app (channels/hub.ts Owner). */
export interface ChannelOwner {
  chat: string
  id: string
  name: string
}

/** Small JSON settings file in the app's user-data folder; holds what published users enter in the app (their own key). */
export class Settings {
  private data: SettingsData = {}

  constructor(private readonly path: string) {
    try {
      if (existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf8')) as SettingsData
    } catch {
      this.data = {}
    }
  }

  get(): SettingsData {
    return { ...this.data }
  }

  set(patch: SettingsData): void {
    this.data = { ...this.data, ...patch }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }
}
