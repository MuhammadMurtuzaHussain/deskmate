import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function loadFile(path: string): void {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

/**
 * Loads `.env.local` then `.env` from each given directory, in order (the user-data folder first for the
 * packaged app, then the project root in development). Earlier files win; real environment variables always win.
 */
export function loadDotEnv(...dirs: string[]): void {
  for (const dir of dirs) {
    loadFile(join(dir, '.env.local'))
    loadFile(join(dir, '.env'))
  }
}
