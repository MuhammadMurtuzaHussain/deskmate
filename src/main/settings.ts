import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
  /** phone remote: the Telegram bot token from @BotFather (DESKMATE_TELEGRAM_TOKEN in .env is used when this is empty) */
  telegramToken?: string
  /** phone remote on (default when a token exists) or off, from the tray menu or Setup */
  remoteEnabled?: boolean
  /** the one Telegram account allowed to control her, confirmed on the Mac */
  remotePaired?: { chatId: number; userId: number; name: string }
  /** the first-run window was finished or closed once */
  setupDone?: boolean
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
