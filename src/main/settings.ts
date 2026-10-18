import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NoticePrefs } from '../shared/types'
import { joinSecrets, registerSecret, splitSecrets, type SecretBox } from './secrets.ts'
import type { PermissionPrefs } from './permissions'

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
   * live in the encrypted secrets file (secrets.ts), never in settings.json, and are never logged. */
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
  /** per-tool permission levels and per-origin overrides (permissions.ts) */
  permissions?: PermissionPrefs
  /** the spending meter: a monthly budget in US dollars (0 or missing: none), and the month she was told to go past it */
  spend?: { budget?: number; overMonth?: string; warnedMonth?: string }
  /** the kill switch's shortcut (an Electron accelerator; default Control+Alt+Escape) */
  stopShortcut?: string
  /** let her run terminal commands with run_command (each one asks, the deny-list applies) */
  shell?: boolean
}

/** The account paired on a chat app (channels/hub.ts Owner). */
export interface ChannelOwner {
  chat: string
  id: string
  name: string
}

/**
 * Small JSON settings file in the app's user-data folder. The secrets in it (API keys, chat-app tokens) are kept apart
 * in an encrypted file next to it when a SecretBox is available (Electron safeStorage: the macOS Keychain), and moved
 * there from an older settings.json once. Without a box (a Linux without a keyring) they stay in settings.json, which
 * is mode 0600.
 */
export class Settings {
  private data: SettingsData = {}
  private box: SecretBox | null = null
  /** where the secrets are: 'keychain' (encrypted file) or 'file' (plain, in settings.json) */
  store: 'keychain' | 'file' = 'file'
  /** how many secrets moved out of settings.json on this start */
  migrated = 0
  private readonly vaultPath: string

  private readonly path: string

  constructor(path: string, opts: { box?: SecretBox | null; vaultPath?: string } = {}) {
    this.path = path
    this.vaultPath = opts.vaultPath ?? `${path.replace(/\.json$/, '')}.secrets`
    try {
      if (existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf8')) as SettingsData
    } catch {
      this.data = {}
    }
    if (opts.box) this.useBox(opts.box)
    else this.registerAll()
  }

  /** Starts keeping the secrets encrypted with this box: reads the vault, and moves any secret still in settings.json
   * into it (once). Returns false when the box cannot encrypt here. */
  useBox(box: SecretBox): boolean {
    if (!box.available()) return false
    const plain = splitSecrets(this.data as Record<string, unknown>)
    let vault: Record<string, string> = {}
    try {
      if (existsSync(this.vaultPath)) vault = JSON.parse(box.decrypt(readFileSync(this.vaultPath))) as Record<string, string>
    } catch (err) {
      // Locked out of the key (access denied, a copied profile): the file stays as it is for a later start, and the
      // secrets entered meanwhile stay in settings.json.
      console.warn(`[settings] could not read the secrets file, keeping secrets in settings.json for now: ${(err as Error).message}`)
      this.registerAll()
      return false
    }
    this.box = box
    this.store = 'keychain'
    // A secret still in settings.json was entered by an older version (or by hand): it moves into the vault.
    const moving = Object.keys(plain.secrets).filter((k) => plain.secrets[k] !== vault[k])
    this.migrated = Object.keys(plain.secrets).length
    this.data = joinSecrets(plain.rest, { ...vault, ...plain.secrets }) as SettingsData
    if (this.migrated) {
      this.writeVault({ ...vault, ...plain.secrets })
      this.writeJson(plain.rest)
      if (moving.length) console.log(`[settings] moved ${moving.length} secret(s) from settings.json to the ${box.name}`)
    }
    this.registerAll()
    return true
  }

  private registerAll(): void {
    const { secrets } = splitSecrets(this.data as Record<string, unknown>)
    registerSecret(...Object.values(secrets))
  }

  get(): SettingsData {
    return { ...this.data }
  }

  set(patch: SettingsData): void {
    this.data = { ...this.data, ...patch }
    mkdirSync(dirname(this.path), { recursive: true })
    if (this.box) {
      const { rest, secrets } = splitSecrets(this.data as Record<string, unknown>)
      this.writeVault(secrets)
      this.writeJson(rest)
    } else {
      this.writeJson(this.data as Record<string, unknown>)
    }
    this.registerAll()
  }

  private writeJson(obj: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    // Written beside and renamed, so a crash never leaves half a settings file.
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  private writeVault(secrets: Record<string, string>): void {
    if (!this.box) return
    const tmp = `${this.vaultPath}.tmp`
    writeFileSync(tmp, this.box.encrypt(JSON.stringify(secrets)), { mode: 0o600 })
    renameSync(tmp, this.vaultPath)
  }
}
