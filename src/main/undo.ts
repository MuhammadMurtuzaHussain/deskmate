import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Taking things back, only where that is honest. A file she put in the Trash goes back where it was; a file she moved
 * or renamed goes back to its old name; an app or a tab she opened can be closed; the clipboard she changed gets its
 * old text back; a reminder or a job she set or cancelled can be removed or put back. A sent message, a Claude Code
 * job's edits or a purchase cannot be undone, and the activity log says so instead of pretending. The file parts are
 * here (pure node:fs, so the tests run them in a temp folder); the rest runs in index.ts.
 */

export type Undo =
  | { kind: 'trash'; from: string; trashed: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'quit-app'; app: string }
  | { kind: 'close-tab'; url: string }
  | { kind: 'clipboard'; previous: string }
  /** put back reminders she cancelled (the stored reminder objects) */
  | { kind: 'reminder-restore'; reminders: unknown[] }
  /** remove reminders she set */
  | { kind: 'reminder-remove'; ids: string[] }
  /** remove a scheduled job she set up */
  | { kind: 'job-remove'; id: string }
  | { kind: 'none'; why: string }

/** What undoing it would do, in a few words ("put Resume.pdf back in Documents"), or why it can't. */
export function undoLabel(u: Undo | undefined): string {
  if (!u) return ''
  switch (u.kind) {
    case 'trash':
      return `put ${basename(u.from)} back in ${basename(dirname(u.from))}`
    case 'move':
      return `move ${basename(u.to)} back to ${basename(u.from) === basename(u.to) ? basename(dirname(u.from)) : basename(u.from)}`
    case 'quit-app':
      return `quit ${u.app}`
    case 'close-tab':
      return 'close the tab she opened'
    case 'clipboard':
      return 'put the old clipboard back'
    case 'reminder-restore':
      return u.reminders.length > 1 ? `put ${u.reminders.length} reminders back` : 'put the reminder back'
    case 'reminder-remove':
      return u.ids.length > 1 ? `remove the ${u.ids.length} reminders` : 'remove the reminder'
    case 'job-remove':
      return 'delete the scheduled job'
    case 'none':
      return `can't undo: ${u.why}`
  }
}

export function canUndo(u: Undo | undefined): boolean {
  return Boolean(u) && u?.kind !== 'none'
}

/** Why she may not move or trash this path, or null. Her own reach stops at the user's files: not the system, not
 * hidden folders with keys in them, not home or a whole top-level folder. */
export function protectedPath(path: string, home = homedir(), extra: string[] = []): string | null {
  if (!path || !isAbsolute(path)) return 'that is not a full path'
  const p = resolve(path)
  const h = resolve(home)
  if (p === '/' || p === h) return 'that is a whole disk or your home folder'
  if (!p.startsWith(`${h}${sep}`)) {
    for (const root of ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private', '/var', '/opt', '/Applications', '/Volumes', '/cores', '/dev']) {
      if (p === root || p.startsWith(`${root}${sep}`)) return `${root} belongs to the system`
    }
    return 'it is outside your home folder'
  }
  const rel = p.slice(h.length + 1).split(sep)
  if (rel.length === 1 && ['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public', 'Applications'].includes(rel[0])) return `that is your whole ${rel[0]} folder`
  if (rel[0] === 'Library') return 'your Library folder holds app data and keys'
  if (rel.some((part) => part.startsWith('.'))) return 'hidden folders hold settings and keys'
  for (const x of extra) {
    const e = resolve(x)
    if (p === e || p.startsWith(`${e}${sep}`)) return 'that is my own data'
  }
  return null
}

/** A name in `dir` that is free: "Resume.pdf", else "Resume 2.pdf", "Resume 3.pdf"… */
export function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return join(dir, name)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 2; i < 1000; i++) {
    const candidate = join(dir, `${stem} ${i}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(dir, `${stem} ${Date.now()}${ext}`)
}

export type FileResult = { ok: true; text: string; undo: Undo } | { ok: false; text: string; crossDevice?: boolean }

/** Moves a file or folder into the Trash folder, remembering where it was. A file on another disk is not moved
 * (crossDevice: the caller can hand it to Finder's Trash instead, without an undo). */
export function trashFile(path: string, trashDir = join(homedir(), '.Trash'), opts: { home?: string; extra?: string[] } = {}): FileResult {
  const why = protectedPath(path, opts.home, opts.extra)
  if (why) return { ok: false, text: `Not trashed: ${why}.` }
  if (!existsSync(path)) return { ok: false, text: `Not trashed: ${path} does not exist.` }
  mkdirSync(trashDir, { recursive: true })
  const target = freeName(trashDir, basename(path))
  try {
    renameSync(path, target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') return { ok: false, text: `${basename(path)} is on another disk.`, crossDevice: true }
    return { ok: false, text: `Not trashed: ${(err as Error).message}` }
  }
  return { ok: true, text: `Moved ${basename(path)} to the Trash (from ${dirname(path)}). It can be put back with "undo that".`, undo: { kind: 'trash', from: path, trashed: target } }
}

/** Moves or renames a file or folder. Never overwrites: a name that is taken is refused. `to` may be a folder. */
export function moveFile(from: string, to: string, opts: { home?: string; extra?: string[] } = {}): FileResult {
  const bad = protectedPath(from, opts.home, opts.extra)
  if (bad) return { ok: false, text: `Not moved: ${bad}.` }
  if (!existsSync(from)) return { ok: false, text: `Not moved: ${from} does not exist.` }
  let target = to
  if (existsSync(to) && statSync(to).isDirectory()) target = join(to, basename(from))
  const badTo = protectedPath(target, opts.home, opts.extra)
  if (badTo) return { ok: false, text: `Not moved there: ${badTo}.` }
  if (existsSync(target)) return { ok: false, text: `Not moved: ${target} already exists, and I never overwrite.` }
  if (!existsSync(dirname(target))) return { ok: false, text: `Not moved: the folder ${dirname(target)} does not exist.` }
  try {
    renameSync(from, target)
  } catch (err) {
    return { ok: false, text: `Not moved: ${(err as NodeJS.ErrnoException).code === 'EXDEV' ? 'that is another disk; use Finder for that' : (err as Error).message}` }
  }
  return { ok: true, text: `Moved ${from} to ${target}.`, undo: { kind: 'move', from, to: target } }
}

/** Takes back a trash or a move. Refuses when something else now sits where the file would go back to. */
export function undoFile(u: Undo): { ok: boolean; text: string } {
  if (u.kind === 'trash') {
    if (!existsSync(u.trashed)) return { ok: false, text: `${basename(u.from)} is no longer in the Trash (it was emptied or moved).` }
    if (existsSync(u.from)) return { ok: false, text: `Something called ${basename(u.from)} is back in ${dirname(u.from)} already; I left the Trash as it is.` }
    mkdirSync(dirname(u.from), { recursive: true })
    renameSync(u.trashed, u.from)
    return { ok: true, text: `Put ${basename(u.from)} back in ${dirname(u.from)}.` }
  }
  if (u.kind === 'move') {
    if (!existsSync(u.to)) return { ok: false, text: `${basename(u.to)} is not at ${dirname(u.to)} any more.` }
    if (existsSync(u.from)) return { ok: false, text: `Something called ${basename(u.from)} is at the old place now; I did not overwrite it.` }
    if (!existsSync(dirname(u.from))) return { ok: false, text: `The old folder ${dirname(u.from)} is gone.` }
    renameSync(u.to, u.from)
    return { ok: true, text: `Moved ${basename(u.to)} back to ${u.from}.` }
  }
  return { ok: false, text: 'Not a file change.' }
}
