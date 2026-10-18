import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Her long-term memory as two plain Markdown files the user can read and edit, in <user data>/memory:
 * USER.md (who they are, what they like, the people they talk to, their projects) and MEMORY.md (durable facts and
 * lessons she has learned doing things for them). One entry is one "- " line under a "## " heading. Both go into the
 * agent's system prompt every turn, in the cached part, so each has a size cap: when a file is full she has to merge
 * or drop entries before adding one, like a person tidying a notebook. Lines the user wrote by hand are kept as they
 * are; she only adds, replaces or removes whole entries.
 */

export type MemoryFile = 'user' | 'memory'
export type MemorySection = 'who' | 'preferences' | 'people' | 'projects' | 'facts' | 'lessons'

export const SECTIONS: { id: MemorySection; file: MemoryFile; title: string; hint: string }[] = [
  { id: 'who', file: 'user', title: 'Who they are', hint: 'name, where they live, what they do' },
  { id: 'preferences', file: 'user', title: 'What they like', hint: 'preferences, habits, how they want things done' },
  { id: 'people', file: 'user', title: 'People', hint: 'who they message and how they know them' },
  { id: 'projects', file: 'user', title: 'Projects', hint: 'what they are working on, and where' },
  { id: 'facts', file: 'memory', title: 'Facts', hint: 'things that stay true' },
  { id: 'lessons', file: 'memory', title: 'Lessons', hint: 'what worked, what did not, app quirks' }
]

const FILES: Record<MemoryFile, { name: string; title: string; cap: number; intro: string }> = {
  user: {
    name: 'USER.md',
    title: 'About you',
    cap: 2400,
    intro: 'What she knows about you. She reads this every time you talk and keeps it up to date; edit it freely. One thing per line, starting with "- ".'
  },
  memory: {
    name: 'MEMORY.md',
    title: 'What she has learned',
    cap: 3200,
    intro: 'Durable facts and lessons from doing things for you. She reads this every time you talk; edit it freely. One thing per line, starting with "- ".'
  }
}

export const MEMORY_CAPS: Record<MemoryFile, number> = { user: FILES.user.cap, memory: FILES.memory.cap }

export interface MemoryEntry {
  file: MemoryFile
  /** the heading it sits under, as written */
  section: string
  text: string
  /** its line in the file */
  line: number
}

export interface EditResult {
  ok: boolean
  /** for her brain: what happened, or why not and what to do instead */
  text: string
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const words = (s: string): Set<string> => new Set(norm(s).split(' ').filter((w) => w.length > 2 || /\d/.test(w)))

/** How much of `a`'s words are in `b` (0..1). */
function overlap(a: string, b: string): number {
  const wa = words(a)
  if (!wa.size) return 0
  const wb = words(b)
  let n = 0
  for (const w of wa) if (wb.has(w)) n++
  return n / wa.size
}

/** One entry's text as it may be stored: one line, no leading bullet, not too long. */
export function cleanEntry(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[-*•]\s+/, '')
    .trim()
    .slice(0, 300)
}

/** A section from words a model or a person might use ("Preferences", "people", "lesson"). */
export function sectionFor(raw: string): MemorySection | null {
  const s = norm(raw)
  for (const sec of SECTIONS) if (s === sec.id || s === norm(sec.title) || `${s}s` === sec.id) return sec.id
  return null
}

/** Where a fact without a section belongs: a guess from its words, for facts from the older brains and the move from
 * the JSON memory. */
export function guessSection(text: string): MemorySection {
  const t = text.toLowerCase()
  if (/\b(?:works? on|working on|project|repo|codebase|building|app called|their (?:app|startup|company|channel))\b/.test(t)) return 'projects'
  if (/\b(?:mum|mom|dad|father|mother|sister|brother|wife|husband|partner|girlfriend|boyfriend|friend|boss|cowork|colleague|son|daughter|cousin|aunt|uncle|grandma|grandpa)\b/.test(t)) return 'people'
  if (/\b(?:likes?|loves?|prefers?|hates?|dislikes?|favou?rite|enjoys?|into|wants? (?:me|you) to|always|never|rather)\b/.test(t)) return 'preferences'
  if (/\b(?:works? best|worked|did not work|didn't work|fails?|quirk|trick|use the|shortcut|instead of)\b/.test(t)) return 'lessons'
  if (/\b(?:user|they|their|them|he|she|his|her|name|lives?|born|birthday|age|job|works? (?:as|at|for)|studies|student)\b/.test(t)) return 'who'
  return 'facts'
}

function template(file: MemoryFile): string {
  const f = FILES[file]
  const sections = SECTIONS.filter((s) => s.file === file)
    .map((s) => `## ${s.title}\n`)
    .join('\n')
  return `# ${f.title}\n\n<!-- ${f.intro} -->\n\n${sections}`
}

export class MemoryFiles {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  path(file: MemoryFile): string {
    return join(this.dir, FILES[file].name)
  }

  /** Creates the folder and both files when they are missing. */
  ensure(): void {
    mkdirSync(this.dir, { recursive: true })
    for (const file of ['user', 'memory'] as MemoryFile[]) if (!existsSync(this.path(file))) writeFileSync(this.path(file), template(file))
  }

  read(file: MemoryFile): string {
    try {
      return readFileSync(this.path(file), 'utf8')
    } catch {
      return ''
    }
  }

  private write(file: MemoryFile, text: string): void {
    mkdirSync(this.dir, { recursive: true })
    // Whole-file replace, so an editor that has it open never sees half a file.
    const tmp = `${this.path(file)}.tmp`
    writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`)
    renameSync(tmp, this.path(file))
  }

  /** Every "- " entry in a file, with the heading it is under. Lines that wrap (indented, no bullet) join the entry. */
  entries(file: MemoryFile): MemoryEntry[] {
    const out: MemoryEntry[] = []
    let section = ''
    let inComment = false
    this.read(file)
      .split('\n')
      .forEach((line, n) => {
        if (inComment) {
          if (line.includes('-->')) inComment = false
          return
        }
        if (/^\s*<!--/.test(line)) {
          if (!line.includes('-->')) inComment = true
          return
        }
        const h = /^#{2,6}\s+(.+?)\s*$/.exec(line)
        if (h) {
          section = h[1]
          return
        }
        const b = /^\s{0,3}[-*]\s+(.+?)\s*$/.exec(line)
        if (b) out.push({ file, section, text: b[1], line: n })
        else if (/^\s{2,}\S/.test(line) && out.length && out[out.length - 1].line === n - 1) {
          out[out.length - 1].text += ` ${line.trim()}`
          out[out.length - 1].line = n
        }
      })
    return out
  }

  /** The characters the entries take (the cap counts these, not the headings or the note at the top). */
  used(file: MemoryFile): number {
    return this.entries(file).reduce((n, e) => n + e.text.length + 1, 0)
  }

  /** Adds an entry under its section; a near-copy of one already there is left as it is. */
  add(text: string, section: MemorySection): EditResult {
    const entry = cleanEntry(text)
    if (!entry) return { ok: false, text: 'Nothing to keep.' }
    const sec = SECTIONS.find((s) => s.id === section) ?? SECTIONS.find((s) => s.id === 'facts')!
    const file = sec.file
    const same = [...this.entries('user'), ...this.entries('memory')].find((e) => norm(e.text) === norm(entry) || norm(e.text).includes(norm(entry)))
    if (same) return { ok: true, text: `Already in ${FILES[same.file].name}: "${same.text}".` }
    const cap = FILES[file].cap
    const used = this.used(file)
    if (used + entry.length + 1 > cap) {
      return {
        ok: false,
        text: `${FILES[file].name} is full (${used} of ${cap} characters). Make room first: merge entries that say similar things with update_memory, or drop ones that no longer matter with forget, then keep this.`
      }
    }
    this.ensure()
    const lines = this.read(file).split('\n')
    const heading = lines.findIndex((l) => {
      const h = /^#{2,6}\s+(.+?)\s*$/.exec(l)
      return h ? sectionFor(h[1]) === sec.id : false
    })
    if (heading < 0) {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
      lines.push('', `## ${sec.title}`, `- ${entry}`)
    } else {
      // After the last entry of that section (or right under the heading).
      let at = heading + 1
      for (let i = heading + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) if (/^\s{0,3}[-*]\s+|^\s{2,}\S/.test(lines[i])) at = i + 1
      lines.splice(at, 0, `- ${entry}`)
    }
    this.write(file, lines.join('\n'))
    return { ok: true, text: `Kept in ${FILES[file].name} under ${sec.title}.` }
  }

  /** The entry `query` names: a piece of its text, or most of its words. Several equal matches is a question back. */
  find(query: string): { entry?: MemoryEntry; error?: string } {
    const q = norm(query)
    if (!q) return { error: 'Say which entry: a few words from it.' }
    const all = [...this.entries('user'), ...this.entries('memory')]
    const exact = all.filter((e) => norm(e.text).includes(q))
    if (exact.length === 1) return { entry: exact[0] }
    if (exact.length > 1) {
      const whole = exact.filter((e) => norm(e.text) === q)
      if (whole.length === 1) return { entry: whole[0] }
      return { error: `Several entries match "${query}": ${exact.slice(0, 5).map((e) => `"${e.text}"`).join('; ')}. Use more of the words.` }
    }
    const scored = all.map((e) => ({ e, s: overlap(query, e.text) })).filter((x) => x.s >= 0.6)
    scored.sort((a, b) => b.s - a.s)
    if (!scored.length) return { error: `No entry matches "${query}".` }
    if (scored.length > 1 && scored[1].s === scored[0].s) return { error: `Several entries match "${query}": ${scored.slice(0, 5).map((x) => `"${x.e.text}"`).join('; ')}. Use more of the words.` }
    return { entry: scored[0].e }
  }

  /** Replaces the entry `old` names with `text` (same place, same file). */
  update(old: string, text: string): EditResult {
    const { entry, error } = this.find(old)
    if (!entry) return { ok: false, text: error ?? 'Not found.' }
    const next = cleanEntry(text)
    if (!next) return this.remove(old)
    const cap = FILES[entry.file].cap
    const used = this.used(entry.file) - entry.text.length + next.length
    if (used > cap) return { ok: false, text: `That would make ${FILES[entry.file].name} too long (${used} of ${cap} characters). Say it shorter, or forget something first.` }
    this.replaceLines(entry, `- ${next}`)
    return { ok: true, text: `Changed "${entry.text}" to "${next}" in ${FILES[entry.file].name}.` }
  }

  /** Drops the entry `old` names. */
  remove(old: string): EditResult {
    const { entry, error } = this.find(old)
    if (!entry) return { ok: false, text: error ?? 'Not found.' }
    this.replaceLines(entry, null)
    return { ok: true, text: `Forgot "${entry.text}" (from ${FILES[entry.file].name}).` }
  }

  private replaceLines(entry: MemoryEntry, line: string | null): void {
    const lines = this.read(entry.file).split('\n')
    // A wrapped entry ends at entry.line; it starts at the bullet above.
    let start = entry.line
    while (start > 0 && !/^\s{0,3}[-*]\s+/.test(lines[start])) start--
    lines.splice(start, entry.line - start + 1, ...(line === null ? [] : [line]))
    this.write(entry.file, lines.join('\n'))
  }

  /** Both files for the system prompt: headings and entries only, each within its cap (a file edited past it by hand is
   * cut, and says so). */
  prompt(): string {
    const parts: string[] = []
    for (const file of ['user', 'memory'] as MemoryFile[]) {
      const list = this.entries(file)
      if (!list.length) continue
      const bySection = new Map<string, string[]>()
      let size = 0
      let cut = false
      for (const e of list) {
        if (size + e.text.length > FILES[file].cap * 1.25) {
          cut = true
          break
        }
        size += e.text.length + 1
        const key = e.section || 'Notes'
        bySection.set(key, [...(bySection.get(key) ?? []), e.text])
      }
      const body = [...bySection.entries()].map(([sec, items]) => `### ${sec}\n${items.map((t) => `- ${t}`).join('\n')}`).join('\n')
      parts.push(`## ${FILES[file].name} (${file === 'user' ? 'about the user' : 'what you have learned'})\n${body}${cut ? '\n(cut: the file is over its size)' : ''}`)
    }
    return parts.join('\n\n')
  }

  /** A clean slate: both files back to empty, the old ones kept as USER.md.bak / MEMORY.md.bak. */
  reset(): void {
    for (const file of ['user', 'memory'] as MemoryFile[]) {
      if (existsSync(this.path(file))) renameSync(this.path(file), `${this.path(file)}.bak`)
    }
    this.ensure()
  }

  /** For Setup: how full each file is. */
  sizes(): Record<MemoryFile, { used: number; cap: number; entries: number }> {
    const one = (file: MemoryFile): { used: number; cap: number; entries: number } => ({ used: this.used(file), cap: FILES[file].cap, entries: this.entries(file).length })
    return { user: one('user'), memory: one('memory') }
  }
}
