import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

// "Send me the PDF I just downloaded": which file that is, and whether it may leave the Mac at all. A file only ever
// goes to the owner's own chat (hub.ts), after a read-back with its name and size; files that hold keys or passwords
// are never sent, whoever asks.

/** The biggest file she sends (the chat apps cap bots lower still: Discord 10 MB, Telegram 50 MB). */
export const MAX_SEND_BYTES = 25 * 1024 * 1024

const KINDS: [RegExp, string[]][] = [
  [/\bpdfs?\b/i, ['pdf']],
  [/\b(?:word|docx?|documents?)\b/i, ['doc', 'docx', 'pages', 'rtf', 'txt', 'md', 'odt']],
  [/\b(?:spreadsheets?|excel|sheets?|csv|xlsx?)\b/i, ['xls', 'xlsx', 'csv', 'numbers']],
  [/\b(?:slides|presentations?|decks?|pptx?|keynote)\b/i, ['ppt', 'pptx', 'key']],
  [/\b(?:photos?|pictures?|pics?|images?|screenshots?|png|jpe?g|heic)\b/i, ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp']],
  [/\b(?:videos?|movies?|clips?|recordings?|mp4|mov)\b/i, ['mp4', 'mov', 'm4v', 'webm']],
  [/\b(?:zips?|archives?)\b/i, ['zip', 'tar', 'gz', '7z', 'dmg']],
  [/\b(?:audio|songs?|mp3|voice memos?)\b/i, ['mp3', 'm4a', 'wav', 'aac']]
]

/** Half-finished downloads and macOS litter. */
const PARTIAL = /\.(?:crdownload|download|part|partial|tmp)$|^\.|^Icon\r?$/i

/** Never sent: keys, password stores, the app's own secrets. */
export function blockedPath(path: string): string | null {
  const home = homedir()
  const p = resolve(path)
  const under = (dir: string): boolean => p === join(home, dir) || p.startsWith(`${join(home, dir)}/`)
  if (['.ssh', '.aws', '.gnupg', '.config/gcloud', '.kube', '.docker', 'Library/Keychains', 'Library/Messages', 'Library/Cookies', 'Library/Application Support/Deskmate', 'Library/Application Support/deskmate'].some(under))
    return 'it holds keys, passwords or private messages'
  const name = basename(p).toLowerCase()
  if (/^\.env(?:\..*)?$/.test(name) || /\.(?:pem|key|p12|pfx|kdbx|keychain|keychain-db|ovpn)$/.test(name) || /^id_(?:rsa|ed25519|ecdsa|dsa)/.test(name) || /(?:^|[._-])(?:secrets?|credentials?|passwords?)(?:[._-]|$)/.test(name))
    return 'it looks like it holds keys or passwords'
  return null
}

/** The extensions a description asks for ("the PDF" → pdf), or null for any. */
export function kindOf(desc: string): string[] | null {
  for (const [re, exts] of KINDS) if (re.test(desc)) return exts
  return null
}

/** The newest finished file in a folder, of the kinds given. */
export function newestIn(dir: string, exts: string[] | null): string | null {
  let best: { path: string; at: number } | null = null
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const n of names) {
    if (PARTIAL.test(n)) continue
    const ext = n.toLowerCase().split('.').pop() ?? ''
    if (exts && !exts.includes(ext)) continue
    const path = join(dir, n)
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      // A download keeps its server date as mtime; birthtime is when it landed here.
      const at = Math.max(st.birthtimeMs || 0, st.ctimeMs)
      if (!best || at > best.at) best = { path, at }
    } catch {
      // gone meanwhile
    }
  }
  return best?.path ?? null
}

/** The words of a description that name the file itself ("the tax PDF I just downloaded" → "tax pdf"). */
export function fileQuery(desc: string): string {
  return desc
    .replace(/\b(?:that |which )?i (?:just |recently )?(?:downloaded|saved|got|made|exported)\b.*$/i, '')
    .replace(/\b(?:from|in) (?:my |the )?downloads?(?: folder)?\b/i, '')
    .replace(/^(?:the|my|that|this|a|an)\s+/i, '')
    .replace(/\b(?:latest|newest|last|recent|new)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface Resolved {
  path: string
  name: string
  bytes: number
  /** "Downloads", "Documents/Taxes": where it is, for the read-back */
  where: string
}

/** Which file the user means, or why none can be sent. `find` searches the Mac (Spotlight) for a name. */
export async function resolveFile(desc: string, deps: { find(query: string): Promise<string | null>; downloads?: string }): Promise<{ ok: true; file: Resolved } | { ok: false; why: string }> {
  const raw = desc.trim()
  const home = homedir()
  let path: string | null = null
  const expanded = raw.replace(/^~(?=\/|$)/, home)
  if (isAbsolute(expanded) && existsSync(expanded)) path = expanded
  else if (/\bdownload(?:s|ed)?\b/i.test(raw) && (/\b(?:just|latest|newest|last|recent(?:ly)?)\b/i.test(raw) || !fileQuery(raw) || kindOf(fileQuery(raw)) !== null)) {
    path = newestIn(deps.downloads ?? join(home, 'Downloads'), kindOf(raw))
    if (!path) return { ok: false, why: `there is no ${kindOf(raw) ? `${kindOf(raw)![0].toUpperCase()} ` : ''}file in Downloads` }
  } else {
    const q = fileQuery(raw)
    if (!q) return { ok: false, why: 'I need a name for the file' }
    path = await deps.find(q)
    if (!path) return { ok: false, why: `nothing called ${q} on this Mac` }
  }
  const blocked = blockedPath(path)
  if (blocked) return { ok: false, why: `I don't send ${basename(path)}: ${blocked}` }
  let st
  try {
    st = statSync(path)
  } catch {
    return { ok: false, why: `${basename(path)} is gone` }
  }
  if (st.isDirectory()) return { ok: false, why: `${basename(path)} is a folder; I only send files` }
  if (st.size > MAX_SEND_BYTES) return { ok: false, why: `${basename(path)} is ${megabytes(st.size)}, too big to send from here` }
  const where = path.startsWith(`${home}/`) ? path.slice(home.length + 1).split('/').slice(0, -1).join('/') || 'your home folder' : path.split('/').slice(0, -1).join('/')
  return { ok: true, file: { path, name: basename(path), bytes: st.size, where } }
}

export function megabytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
