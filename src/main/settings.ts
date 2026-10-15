import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SettingsData {
  geminiApiKey?: string
  activeCharacter?: string
  /** folder Claude jobs run in unless the user names another */
  activeProject?: string
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
