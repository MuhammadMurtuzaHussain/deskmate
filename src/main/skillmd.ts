import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * Skills in the open Agent Skills format (agentskills.io; the shape OpenClaw's ClawHub and Hermes Agent use too): a
 * folder with a SKILL.md, YAML frontmatter with a `name` and a `description`, then Markdown instructions, and
 * optionally scripts/, references/ and assets/ beside it. Only the name and the description go into her prompt; she
 * loads the instructions with read_skill when a request matches, and a skill's scripts run only with
 * DESKMATE_SKILL_CODE=1 and the user's yes for that skill (asked again when its scripts change).
 *
 * A folder may also hold a skill.json, Deskmate's own executable app routine (skills.ts); then the routine is the
 * tool the agent calls and the SKILL.md is its card for other agents and its notes for her.
 */

export interface Guide {
  /** lower-case letters, digits and single dashes, as the folder is named */
  name: string
  description: string
  /** the instructions (the Markdown after the frontmatter) */
  body: string
  /** the rest of the frontmatter (license, compatibility, metadata, allowed-tools…) */
  meta: Record<string, unknown>
  dir: string
  source: 'bundled' | 'user'
  /** files in the folder besides SKILL.md, as paths inside it ("references/api.md") */
  files: string[]
  /** of those, the ones under scripts/ */
  scripts: string[]
  /** the folder has a skill.json routine too */
  routine: boolean
}

export interface GuideLoad {
  guides: Guide[]
  problems: { dir: string; errors: string[] }[]
}

// ---- a small YAML reader, enough for frontmatter: maps, lists, quoted and plain scalars, block scalars (| and >),
// flow collections ([a, b], {"k": "v"}) and comments.

interface Line {
  indent: number
  text: string
  n: number
}

function stripComment(s: string): string {
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote && !(quote === '"' && s[i - 1] === '\\')) quote = null
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(s[i - 1])) quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd()
  }
  return s
}

function plainScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return s === '' ? '' : null
  if (/^(?:true|True|TRUE)$/.test(s)) return true
  if (/^(?:false|False|FALSE)$/.test(s)) return false
  if (/^[-+]?\d+$/.test(s)) return Number(s)
  if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) return Number(s)
  return s
}

function quoted(s: string, i: number): { value: string; end: number } {
  const q = s[i]
  let out = ''
  let j = i + 1
  for (; j < s.length; j++) {
    const c = s[j]
    if (q === "'" && c === "'") {
      if (s[j + 1] === "'") {
        out += "'"
        j++
        continue
      }
      return { value: out, end: j + 1 }
    }
    if (q === '"' && c === '\\') {
      const e = s[++j]
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' }
      if (e === 'u') {
        out += String.fromCharCode(parseInt(s.slice(j + 1, j + 5), 16))
        j += 4
      } else out += map[e] ?? e
      continue
    }
    if (q === '"' && c === '"') return { value: out, end: j + 1 }
    out += c
  }
  throw new Error('a quoted string is not closed')
}

/** A flow collection or scalar starting at s[i]: [a, "b", {c: d}]. */
function flow(s: string, i = 0): { value: unknown; end: number } {
  const ws = (): void => {
    while (i < s.length && /\s/.test(s[i])) i++
  }
  ws()
  const c = s[i]
  if (c === '[') {
    const arr: unknown[] = []
    i++
    for (;;) {
      ws()
      if (s[i] === ']') return { value: arr, end: i + 1 }
      const item = flow(s, i)
      arr.push(item.value)
      i = item.end
      ws()
      if (s[i] === ',') i++
      else if (s[i] === ']') return { value: arr, end: i + 1 }
      else throw new Error('expected "," or "]"')
    }
  }
  if (c === '{') {
    const obj: Record<string, unknown> = {}
    i++
    for (;;) {
      ws()
      if (s[i] === '}') return { value: obj, end: i + 1 }
      const key = flow(s, i)
      i = key.end
      ws()
      if (s[i] !== ':') throw new Error('expected ":" in {…}')
      i++
      const val = flow(s, i)
      obj[String(key.value)] = val.value
      i = val.end
      ws()
      if (s[i] === ',') i++
      else if (s[i] === '}') return { value: obj, end: i + 1 }
      else throw new Error('expected "," or "}"')
    }
  }
  if (c === '"' || c === "'") return quoted(s, i)
  let j = i
  while (j < s.length && !/[,\]}]/.test(s[j]) && !(s[j] === ':' && /[\s,\]}]/.test(s[j + 1] ?? ' '))) j++
  return { value: plainScalar(s.slice(i, j)), end: j }
}

/** "key: rest" → [key, rest], or null when the line is not a map entry. */
function splitKey(text: string): [string, string] | null {
  if (text[0] === '"' || text[0] === "'") {
    const q = quoted(text, 0)
    const rest = text.slice(q.end)
    const m = /^\s*:(?:\s+|$)(.*)$/.exec(rest)
    return m ? [q.value, m[1]] : null
  }
  const m = /^([^\s:#][^:#]*?)\s*:(?:\s+(.*))?$/.exec(text)
  return m ? [m[1], m[2] ?? ''] : null
}

function scalarOrFlow(rest: string, lines: Line[], i: number, indent: number): { value: unknown; next: number } {
  const t = rest.trim()
  if (t[0] === '[' || t[0] === '{') {
    // A flow collection may run over several lines.
    let src = t
    let next = i
    for (;;) {
      try {
        const r = flow(src)
        return { value: r.value, next }
      } catch (err) {
        if (next >= lines.length) throw err
        src += ` ${lines[next].text}`
        next++
      }
    }
  }
  if (t[0] === '"' || t[0] === "'") {
    let src = t
    let next = i
    for (;;) {
      try {
        return { value: quoted(src, 0).value, next }
      } catch (err) {
        if (next >= lines.length) throw err
        src += ` ${lines[next].text}`
        next++
      }
    }
  }
  // A plain scalar may go on over more-indented lines, folded into one.
  let value = stripComment(t)
  let next = i
  while (next < lines.length && lines[next].indent > indent && !splitKey(lines[next].text) && !lines[next].text.startsWith('- ')) {
    value += ` ${stripComment(lines[next].text)}`
    next++
  }
  return { value: plainScalar(value), next }
}

function blockScalar(header: string, lines: Line[], i: number, indent: number, raw: string[]): { value: string; next: number } {
  const folded = header[0] === '>'
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
  const body: string[] = []
  let next = i
  let base = -1
  // Block scalars keep blank lines, so they read the raw source lines.
  for (let r = lines[i - 1].n + 1; r < raw.length; r++) {
    const l = raw[r]
    if (l.trim() === '') {
      body.push('')
      continue
    }
    const ind = l.length - l.trimStart().length
    if (ind <= indent) break
    if (base < 0) base = ind
    body.push(l.slice(Math.min(base, ind)))
    while (next < lines.length && lines[next].n <= r) next++
  }
  while (chomp !== 'keep' && body.length && body[body.length - 1] === '') body.pop()
  let text = folded ? body.reduce((acc, l, k) => (k === 0 ? l : l === '' ? `${acc}\n` : acc.endsWith('\n') || acc === '' ? acc + l : `${acc} ${l}`), '') : body.join('\n')
  if (chomp === 'clip' && body.length) text += '\n'
  return { value: text, next }
}

function block(lines: Line[], i: number, indent: number, raw: string[]): { value: unknown; next: number } {
  if (i >= lines.length) return { value: null, next: i }
  const first = lines[i]
  if (first.text === '-' || first.text.startsWith('- ')) {
    const arr: unknown[] = []
    let next = i
    while (next < lines.length && lines[next].indent === first.indent && (lines[next].text === '-' || lines[next].text.startsWith('- '))) {
      const line = lines[next]
      const rest = line.text === '-' ? '' : line.text.slice(2).trimStart()
      next++
      if (!rest) {
        if (next < lines.length && lines[next].indent > line.indent) {
          const r = block(lines, next, lines[next].indent, raw)
          arr.push(r.value)
          next = r.next
        } else arr.push(null)
        continue
      }
      if (splitKey(rest) && !/^[[{]/.test(rest.trim())) {
        // "- key: value" starts a map whose keys line up with "key".
        const col = line.indent + (line.text.length - rest.length)
        const sub: Line[] = [{ indent: col, text: rest, n: line.n }]
        while (next < lines.length && lines[next].indent >= col) sub.push(lines[next++])
        arr.push(block(sub, 0, col, raw).value)
        continue
      }
      const r = rest[0] === '|' || rest[0] === '>' ? blockScalar(rest, lines, next, line.indent, raw) : scalarOrFlow(rest, lines, next, line.indent)
      arr.push(r.value)
      next = r.next
    }
    return { value: arr, next }
  }
  const obj: Record<string, unknown> = {}
  let next = i
  while (next < lines.length && lines[next].indent === indent) {
    const line = lines[next]
    const kv = splitKey(line.text)
    if (!kv) throw new Error(`line ${line.n + 1}: expected "key: value"`)
    const [key, rest] = kv
    next++
    const r0 = stripComment(rest).trim()
    if (!r0) {
      const child = next < lines.length && (lines[next].indent > indent || (lines[next].indent === indent && (lines[next].text === '-' || lines[next].text.startsWith('- '))))
      if (child) {
        const r = block(lines, next, lines[next].indent, raw)
        obj[key] = r.value
        next = r.next
      } else obj[key] = null
      continue
    }
    if (/^[|>][-+0-9]*$/.test(r0)) {
      const r = blockScalar(r0, lines, next, indent, raw)
      obj[key] = r.value
      next = r.next
      continue
    }
    const r = scalarOrFlow(rest, lines, next, indent)
    obj[key] = r.value
    next = r.next
  }
  if (next < lines.length && lines[next].indent > indent) throw new Error(`line ${lines[next].n + 1}: unexpected indent`)
  return { value: obj, next }
}

/** YAML (the subset frontmatter uses) to a value. Throws with the line on a shape it can't read. */
export function parseYaml(src: string): unknown {
  const raw = src.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n')
  const lines: Line[] = []
  raw.forEach((l, n) => {
    const t = l.trim()
    if (!t || t.startsWith('#')) return
    lines.push({ indent: l.length - l.trimStart().length, text: l.trim(), n })
  })
  if (!lines.length) return {}
  const r = block(lines, 0, lines[0].indent, raw)
  if (r.next < lines.length) throw new Error(`line ${lines[r.next].n + 1}: could not read this`)
  return r.value
}

/** SKILL.md text → its frontmatter and body. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string; error?: string } {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t)
  if (!m) return { data: {}, body: t.trim(), error: 'no frontmatter (a SKILL.md starts with --- , name: and description:, then ---)' }
  try {
    const data = parseYaml(m[1])
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { data: {}, body: t.slice(m[0].length).trim(), error: 'the frontmatter is not a map of keys' }
    return { data: data as Record<string, unknown>, body: t.slice(m[0].length).trim() }
  } catch (err) {
    return { data: {}, body: t.slice(m[0].length).trim(), error: `the frontmatter is not valid YAML: ${(err as Error).message}` }
  }
}

export const NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/

/** A skill name from a title ("Export the vlog!" → "export-the-vlog"). */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'skill'
  )
}

/** A SKILL.md made into a guide, or why it can't be one. A name that doesn't match the folder loads with a note. */
export function parseGuide(text: string, dir: string, source: Guide['source']): { guide?: Guide; errors: string[]; notes: string[] } {
  const errors: string[] = []
  const notes: string[] = []
  const { data, body, error } = splitFrontmatter(text)
  if (error) return { errors: [error], notes }
  const folder = dir.split(/[\\/]/).filter(Boolean).pop() ?? ''
  let name = typeof data.name === 'string' ? data.name.trim() : ''
  if (!name) {
    if (NAME_RE.test(folder)) {
      notes.push(`no "name": using the folder's, ${folder}`)
      name = folder
    } else errors.push('"name" is missing')
  } else if (!NAME_RE.test(name)) errors.push(`"name" must be 1–64 lower-case letters, digits and single dashes (got "${name}")`)
  else if (folder && name !== folder) notes.push(`"name" is ${name} but the folder is ${folder}`)
  const description = typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : ''
  if (!description) errors.push('"description" is missing (it says what the skill does and when to use it)')
  else if (description.length > 1024) notes.push('"description" is over 1024 characters; only the start is shown')
  if (!body) notes.push('no instructions after the frontmatter')
  if (errors.length) return { errors, notes }
  const { name: _n, description: _d, ...meta } = data
  const files = listFiles(dir)
  return {
    guide: {
      name,
      description: description.slice(0, 1024),
      body,
      meta,
      dir,
      source,
      files,
      scripts: files.filter((f) => f.startsWith('scripts/')),
      routine: existsSync(join(dir, 'skill.json'))
    },
    errors,
    notes
  }
}

/** Files under a skill folder (not SKILL.md, not hidden ones), at most 200, as paths with forward slashes. */
function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 4 || out.length >= 200) return
    let entries: string[]
    try {
      entries = readdirSync(d).sort()
    } catch {
      return
    }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules' || e === '__pycache__') continue
      const p = join(d, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, depth + 1)
      else {
        const rel = relative(dir, p).split(sep).join('/')
        if (rel !== 'SKILL.md') out.push(rel)
      }
    }
  }
  walk(dir, 0)
  return out
}

/**
 * Every SKILL.md one folder down in the given roots. A later root's skill with the same name replaces an earlier one
 * (yours over the bundled ones). The drafts folder is never a root: drafts are not active until approved.
 */
export function loadGuides(roots: { dir: string; source: Guide['source'] }[]): GuideLoad {
  const byName = new Map<string, Guide>()
  const problems: GuideLoad['problems'] = []
  for (const root of roots) {
    if (!existsSync(root.dir)) continue
    for (const entry of readdirSync(root.dir).sort()) {
      if (entry.startsWith('.') || entry === 'drafts') continue
      const dir = join(root.dir, entry)
      const file = join(dir, 'SKILL.md')
      try {
        if (!statSync(dir).isDirectory() || !existsSync(file)) continue
      } catch {
        continue
      }
      const { guide, errors, notes } = parseGuide(readFileSync(file, 'utf8'), dir, root.source)
      if (!guide) {
        problems.push({ dir, errors })
        continue
      }
      if (notes.length) problems.push({ dir, errors: notes.map((n) => `(loaded) ${n}`) })
      byName.set(guide.name, guide)
    }
  }
  return { guides: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems }
}

/** The skills for her prompt: one "- name: description" line each, within a budget. */
export function guideIndex(guides: Guide[], budget = 6000): string {
  const lines: string[] = []
  let size = 0
  for (const g of guides) {
    const line = `- ${g.name}: ${g.description}${g.scripts.length ? ' (has scripts)' : ''}`
    if (size + line.length > budget) {
      lines.push(`- …and ${guides.length - lines.length} more`)
      break
    }
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

/** A guide by the name the model gave ("Export Vlog", "export_vlog" and "export-vlog" are one). */
export function findGuide(guides: Guide[], name: string): Guide | undefined {
  const want = slug(name.replace(/_/g, '-').replace(/^skill-/, ''))
  return guides.find((g) => g.name === want) ?? guides.find((g) => g.name === slug(name))
}

/** A file inside the skill's folder, or null when the path leaves it or is not one of its files. */
export function guidePath(guide: Guide, rel: string): string | null {
  const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!guide.files.includes(clean)) return null
  const full = resolve(guide.dir, clean)
  return full.startsWith(resolve(guide.dir) + sep) ? full : null
}

/** What read_skill hands back: the instructions and what else is in the folder. */
export function describeGuide(guide: Guide): string {
  const others = guide.files.filter((f) => f !== 'skill.json')
  return [
    `Skill ${guide.name}: ${guide.description}`,
    '',
    guide.body || '(no instructions)',
    ...(others.length ? ['', `Files in this skill (read one with read_skill and its path${guide.scripts.length ? '; run a script with run_skill_script' : ''}): ${others.join(', ')}`] : [])
  ].join('\n')
}

/** A fingerprint of a skill's scripts: the user's yes holds until one of them changes. */
export function scriptsHash(guide: Guide): string {
  const h = createHash('sha256')
  for (const s of guide.scripts) {
    h.update(s)
    h.update('\0')
    try {
      h.update(readFileSync(join(guide.dir, s)))
    } catch {
      // gone
    }
    h.update('\0')
  }
  return h.digest('hex').slice(0, 32)
}
