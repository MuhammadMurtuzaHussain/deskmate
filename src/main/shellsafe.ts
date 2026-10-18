import { homedir } from 'node:os'

/**
 * The deny-list for commands she runs herself (run_command, and a skill script's arguments), outside Claude Code: no
 * superuser, no deleting home or the system, no touching keys and passwords, no piping a download into a shell, no
 * wiping disks, no shutting the Mac down. A refused command never runs, whatever the permission level says. The list
 * is a seat belt, not a sandbox: anything that passes still asks the user first by default, runs in a scratch folder
 * (or the project folder the user named) and gets an environment without her keys. Claude Code jobs are not run
 * through here; they use Claude Code's own permission modes (docs/SAFETY.md).
 */

export interface ShellVerdict {
  ok: boolean
  /** why it was refused, in words she can say */
  why?: string
}

const HOME = homedir()

/** Paths that a recursive delete, chmod or chown must never reach. */
const SYSTEM = ['/', '/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private', '/var', '/Applications', '/Users', '/Volumes', '/opt', '/cores']

/** Where keys and passwords live. */
const CREDENTIALS = /(?:^|[\s"'=/])(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+)?\/?(?:\.ssh\b|\.aws\/credentials|\.aws\b|\.gnupg\b|\.netrc\b|\.npmrc\b|\.pypirc\b|\.docker\/config\.json|\.kube\/config|\.config\/gh\/hosts\.yml|Library\/Keychains\b|\.password-store\b)|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\b(?:security)\s+(?:find-(?:generic|internet)-password|dump-keychain|export)\b|\bkeychain\b.*\b(?:dump|export|password)\b/i

const RULES: { re: RegExp; why: string }[] = [
  { re: /(?:^|[;&|(`]\s*|\$\(\s*)(?:sudo|doas|su)\b/, why: 'it asks for superuser rights (sudo)' },
  { re: /\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|k|da|fi)?sh\b|\b(?:curl|wget)\b[^|;&]*\|\s*(?:python3?|perl|ruby|node)\b/, why: 'it pipes a download straight into a shell' },
  { re: /(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/, why: 'it runs a download as a script' },
  { re: /\b(?:mkfs(?:\.\w+)?|newfs\w*|fdisk|gpt\s+destroy)\b|\bdiskutil\s+(?:erase\w*|zero\w*|partition\w*|reformat|secureErase|apfs\s+delete\w*)\b/i, why: 'it erases or repartitions a disk' },
  { re: /\bdd\b[^;&|]*\bof=\/dev\//, why: 'it writes straight onto a disk device' },
  { re: />\s*\/dev\/(?:disk|rdisk|sd)\w*/, why: 'it writes straight onto a disk device' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'it is a fork bomb' },
  { re: /\b(?:shutdown|reboot|halt)\b|\bpmset\s+(?:sleepnow|-a\s+disablesleep)/, why: 'it shuts down or restarts the Mac' },
  { re: /\b(?:csrutil|spctl\s+--master-disable|nvram)\b/, why: 'it changes system security settings' },
  { re: /\blaunchctl\s+(?:unload|bootout|disable)\b|\bkillall\s+(?:-9\s+)?(?:Finder|Dock|WindowServer|loginwindow)\b/, why: 'it stops parts of macOS' },
  { re: /\bcrontab\s+-r\b/, why: 'it deletes every scheduled cron job' },
  { re: /\bhistory\s+-c\b|>\s*~?\/?\.(?:bash|zsh)_history\b/, why: 'it wipes the shell history' },
  { re: /\bchmod\s+(?:-R\s+)?[0-7]*777\s+(?:\/|~)(?:\s|$)/, why: 'it opens up the permissions of the whole disk or home folder' },
  { re: /\bgit\s+push\b[^;&|]*\s(?:--force|-f)\b/, why: 'it force-pushes over shared history' }
]

/** The separate commands in a line ("a && b; c | d"), roughly: enough to look at each rm on its own. */
function pieces(cmd: string): string[] {
  return cmd.split(/&&|\|\||;|\||\n|`|\$\(/).map((x) => x.trim()).filter(Boolean)
}

function expand(arg: string): string {
  return arg
    .replace(/^["']|["']$/g, '')
    .replace(/^~(?=\/|$)/, HOME)
    .replace(/^\$\{?HOME\}?(?=\/|$)/, HOME)
    .replace(/\/+$/, '') || '/'
}

/** A recursive delete or ownership change that reaches home, the system, or everything in a folder by wildcard. */
function dangerousTargets(piece: string): string | null {
  const words = piece.split(/\s+/)
  const cmd = words[0]?.replace(/^.*\//, '')
  if (cmd !== 'rm' && cmd !== 'chown' && cmd !== 'chmod' && cmd !== 'chflags') return null
  const flags = words.slice(1).filter((w) => w.startsWith('-')).join(' ')
  const recursive = /(?:^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags)
  if (!recursive) return null
  for (const raw of words.slice(1).filter((w) => !w.startsWith('-'))) {
    const t = expand(raw)
    if (t === HOME || t === '/' || SYSTEM.includes(t)) return `it would ${cmd === 'rm' ? 'delete' : 'change'} ${t === HOME ? 'your whole home folder' : t}`
    if (/^\/(?:System|Library|usr|bin|sbin|etc|private|Applications)(?:\/|$)/.test(t)) return `it would ${cmd === 'rm' ? 'delete' : 'change'} system files in ${t}`
    if (t === `${HOME}/*` || t === '/*' || t === '*' || t === '.*' || /^\/\*?$/.test(t)) return 'it would delete everything in a folder by wildcard'
    if (/^(?:\/Users\/[^/]+|~)\/?(?:Desktop|Documents|Downloads|Library|Pictures|Movies|Music)?$/.test(raw.replace(/["']/g, ''))) return `it would delete ${raw}`
    if (t.startsWith(`${HOME}/`) && /^(?:Desktop|Documents|Downloads|Library|Pictures|Movies|Music)$/.test(t.slice(HOME.length + 1))) return `it would delete your whole ${t.slice(HOME.length + 1)} folder`
  }
  return null
}

/** Whether a command may run at all. */
export function checkCommand(cmd: string): ShellVerdict {
  const line = cmd.trim()
  if (!line) return { ok: false, why: 'there is no command' }
  if (line.length > 4000) return { ok: false, why: 'it is too long to check' }
  for (const r of RULES) if (r.re.test(line)) return { ok: false, why: r.why }
  if (CREDENTIALS.test(line)) return { ok: false, why: 'it touches keys or passwords (SSH keys, the Keychain, cloud credentials)' }
  for (const piece of pieces(line)) {
    const bad = dangerousTargets(piece)
    if (bad) return { ok: false, why: bad }
  }
  return { ok: true }
}

/** Arguments to a skill script, checked the same way (each one, and all of them as a line). */
export function checkArgs(args: string[]): ShellVerdict {
  return checkCommand(args.join(' ') || 'true')
}

/** The environment a command gets: the PATH and locale, never her keys or tokens. */
export function safeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'SHELL', 'TERM']) if (base[k]) out[k] = base[k]
  out.LANG ??= 'en_US.UTF-8'
  return out
}
