import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, sep } from 'node:path'
import type { Settings } from './settings'
import type { ProjectInfo } from '../shared/types'

export interface Project extends ProjectInfo {
  lastUsed?: number
  source: 'env' | 'file' | 'claude' | 'folder' | 'current'
}

const STOP = new Set(['the', 'my', 'our', 'a', 'an', 'this', 'that', 'project', 'folder', 'repo', 'repository', 'directory', 'dir', 'app', 'one'])
const CACHE_MS = 20_000

/**
 * Where Claude jobs run. Projects come from DESKMATE_PROJECTS (name=path;name=path), <user data>/projects.json
 * ({"vlog": "~/Movies/vlog"}), the folder picked in the tray, and the folders Claude Code has already been used
 * in (the names of the folders under ~/.claude/projects, nothing inside them), so "resume the vlog" finds the
 * right place without setup.
 */
export class Projects {
  private cache: { at: number; list: Project[] } | null = null

  constructor(
    private readonly settings: Settings,
    private readonly file: string
  ) {}

  list(): Project[] {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.list
    const byPath = new Map<string, Project>()
    const add = (p: Project): void => {
      const key = p.path.replace(/[\\/]+$/, '')
      const prev = byPath.get(key)
      if (!prev) byPath.set(key, { ...p, path: key })
      else {
        byPath.set(key, {
          ...prev,
          // a name the user gave (env or file) beats the folder's own name
          name: prev.source === 'claude' || prev.source === 'folder' ? p.name : prev.name,
          lastUsed: Math.max(prev.lastUsed ?? 0, p.lastUsed ?? 0) || undefined
        })
      }
    }
    for (const p of this.fromEnv()) add(p)
    for (const p of this.fromFile()) add(p)
    for (const p of this.fromClaude()) add(p)
    const current = this.current()
    if (current) add({ ...current, source: 'folder' })
    const list = [...byPath.values()].filter((p) => existsSync(p.path)).sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
    this.cache = { at: Date.now(), list }
    return list
  }

  /** The folder jobs run in when they do not name one: what the user picked, else DESKMATE_WORKDIR. */
  current(): Project | null {
    const picked = this.settings.get().activeProject
    if (picked && existsSync(picked)) return { name: basename(picked), path: picked, source: 'current', lastUsed: Date.now() }
    const env = expand(process.env.DESKMATE_WORKDIR?.trim() || '')
    if (env && existsSync(env)) return { name: basename(env), path: env, source: 'env' }
    return null
  }

  setCurrent(path: string): void {
    this.settings.set({ activeProject: path })
    this.cache = null
  }

  /** Resolves "the vlog", "deskmate", "~/Desktop/site" or an absolute path to a folder; null when nothing fits. */
  resolve(hint?: string | null): Project | null {
    if (!hint) return null
    const raw = hint.trim().replace(/^["'`]|["'`.,!?]+$/g, '')
    if (!raw) return null
    const asPath = expand(raw)
    if (isAbsolute(asPath) && existsSync(asPath)) return { name: basename(asPath), path: asPath, source: 'folder' }

    const key = norm(raw)
    const words = raw
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w))
    if (!key && !words.length) return null
    let best: { p: Project; score: number } | null = null
    for (const p of this.list()) {
      const name = norm(p.name)
      let score = 0
      if (key && name === key) score = 5
      else if (key && (name.includes(key) || (key.length >= 3 && name.length >= 3 && key.includes(name)))) score = 4
      else {
        const segs = p.path.split(/[\\/]/).map(norm).filter(Boolean)
        const hits = words.filter((w) => name.includes(norm(w)) || segs.some((s) => s.includes(norm(w)))).length
        if (hits) score = 1 + hits
      }
      if (score && (!best || score > best.score || (score === best.score && (p.lastUsed ?? 0) > (best.p.lastUsed ?? 0)))) best = { p, score }
    }
    if (best) return best.p
    for (const base of [homedir(), join(homedir(), 'Desktop'), join(homedir(), 'Documents'), join(homedir(), 'Projects'), join(homedir(), 'code')]) {
      const dir = join(base, raw)
      if (existsSync(dir)) return { name: basename(dir), path: dir, source: 'folder' }
    }
    return null
  }

  private fromEnv(): Project[] {
    const spec = process.env.DESKMATE_PROJECTS?.trim()
    if (!spec) return []
    return spec
      .split(/[;\n]/)
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=')
        const path = expand(eq >= 0 ? pair.slice(eq + 1).trim() : pair)
        const name = eq >= 0 ? pair.slice(0, eq).trim() : basename(path)
        return { name, path, source: 'env' as const }
      })
  }

  private fromFile(): Project[] {
    if (!existsSync(this.file)) return []
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>
      return Object.entries(data).map(([name, path]) => ({ name, path: expand(String(path)), source: 'file' as const }))
    } catch (err) {
      console.warn(`[projects] ${this.file} ignored: ${(err as Error).message}`)
      return []
    }
  }

  /**
   * Claude Code keeps one folder per project under ~/.claude/projects, named after the path with every
   * separator turned into a dash. Only those folder names are used (the transcripts inside are never opened);
   * the real path is rebuilt by walking the filesystem, which also recovers names with spaces or dashes.
   */
  private fromClaude(): Project[] {
    if (process.platform === 'win32') return []
    const root = join(homedir(), '.claude', 'projects')
    if (!existsSync(root)) return []
    const out: Project[] = []
    try {
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory() || !dir.name.startsWith('-')) continue
        const path = decodeProjectDir(dir.name)
        if (!path || path === homedir() || !existsSync(path)) continue
        out.push({ name: basename(path), path, lastUsed: statSync(join(root, dir.name)).mtimeMs, source: 'claude' })
      }
    } catch (err) {
      console.warn(`[projects] could not list ${root}: ${(err as Error).message}`)
    }
    return out
  }
}

/** The project whose name appears inside a sentence ("trim the intro of the China vlog"), longest name wins. */
export function mentionedProject(projects: Project[], text: string): Project | null {
  const hay = norm(text)
  let best: Project | null = null
  for (const p of projects) {
    const name = norm(p.name)
    if (name.length >= 4 && hay.includes(name) && (!best || name.length > norm(best.name).length)) best = p
  }
  return best
}

/**
 * "-Users-me-Desktop-China-Vlog" → "/Users/me/Desktop/China Vlog". Claude Code writes every character that is
 * not a letter or digit as a dash, so at each level the directory listing is matched against the longest run of
 * encoded segments that fits; names with spaces, dashes and dots all come back.
 */
function decodeProjectDir(name: string): string | null {
  const parts = name.slice(1).split('-')
  let current: string = sep
  let i = 0
  while (i < parts.length) {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return null
    }
    let matched: string | null = null
    for (let j = parts.length; j > i && !matched; j--) {
      const want = parts.slice(i, j).join('-')
      const hit = entries.find((e) => encodeSegment(e) === want)
      if (!hit) continue
      const candidate = join(current, hit)
      try {
        if (statSync(candidate).isDirectory()) {
          matched = candidate
          i = j
        }
      } catch {
        // not that one
      }
    }
    if (!matched) return null
    current = matched
  }
  return current
}

function encodeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '-')
}

function expand(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}
