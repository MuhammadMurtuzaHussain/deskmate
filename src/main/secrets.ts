/**
 * Secrets: the API keys and chat-app tokens, and keeping them out of everything she writes down. Keys live in an
 * encrypted file (Electron safeStorage, which on macOS keeps its key in the login Keychain) instead of settings.json;
 * the settings migrate once. Anything key-shaped is redacted from logs, the journal, her notes, the activity log and
 * what she sends to a chat app, and her memory refuses a fact that holds one. Pure apart from the box passed in, so
 * the tests use a fake box and never touch the real Keychain.
 */

/** What a key or token looks like, by provider; each match is replaced by its label. */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { label: 'openai-key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{32,}/g },
  { label: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { label: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { label: 'slack-app-token', re: /\bxapp-[A-Za-z0-9-]{10,}/g },
  { label: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { label: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'telegram-token', re: /\b\d{8,11}:AA[A-Za-z0-9_-]{30,}/g },
  { label: 'discord-token', re: /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/g },
  { label: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  // "password: hunter2", "api_key=…", "token = …" with a value after it
  { label: 'secret', re: /\b((?:api[_-]?key|secret|password|passwd|token|bearer)\s*[:=]\s*)["']?[^\s"']{8,}["']?/gi }
]

/** Exact secret values the app knows (its own keys and tokens), redacted wherever they show up. */
const known = new Set<string>()

/** Adds the app's own secrets (a key just entered, the tokens loaded at start), so they are redacted even when they
 * do not look like any provider's shape. Short values are ignored: they would redact ordinary words. */
export function registerSecret(...values: (string | undefined | null)[]): void {
  for (const v of values) {
    const t = v?.trim()
    if (t && t.length >= 12) known.add(t)
  }
}

/** The text with every key-shaped run and every known secret replaced by "[redacted …]". */
export function redact(text: string): string {
  if (!text) return text
  let out = text
  for (const s of known) if (out.includes(s)) out = out.split(s).join('[redacted]')
  for (const { label, re } of PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, (m, lead?: string) => (label === 'secret' && typeof lead === 'string' ? `${lead}[redacted]` : `[redacted ${label}]`))
  }
  return out
}

/** True when the text holds something key-shaped (for refusing it in her memory). */
export function looksSecret(text: string): boolean {
  return redact(text) !== text
}

/** Redacts every string inside a JSON-ish value (an activity entry's arguments). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /key|token|secret|password/i.test(k) && typeof v === 'string' && v ? '[redacted]' : redactDeep(v)])) as T
  return value
}

/** Encrypts and decrypts with a key the OS keeps (Electron safeStorage in the app; a fake in the tests). */
export interface SecretBox {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
  /** shown in Setup: "macOS Keychain" */
  name: string
}

/** The settings fields that hold secrets, as paths into the settings object. */
export const SECRET_FIELDS: string[][] = [
  ['anthropicApiKey'],
  ['geminiApiKey'],
  ['telegramToken'],
  ['channels', 'discord', 'token'],
  ['channels', 'slack', 'botToken'],
  ['channels', 'slack', 'appToken']
]

export function getPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

export function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj
  for (const k of path.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (value === undefined || value === '') delete cur[last]
  else cur[last] = value
}

/** Splits the secrets out of a settings object: the object without them, and the secrets by dotted path. */
export function splitSecrets(data: Record<string, unknown>): { rest: Record<string, unknown>; secrets: Record<string, string> } {
  const rest = JSON.parse(JSON.stringify(data)) as Record<string, unknown>
  const secrets: Record<string, string> = {}
  for (const path of SECRET_FIELDS) {
    const v = getPath(rest, path)
    if (typeof v === 'string' && v.trim()) secrets[path.join('.')] = v
    if (v !== undefined) setPath(rest, path, undefined)
  }
  return { rest, secrets }
}

/** Puts the secrets back into a settings object (a copy). */
export function joinSecrets(rest: Record<string, unknown>, secrets: Record<string, string>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
  for (const [dotted, v] of Object.entries(secrets)) setPath(out, dotted.split('.'), v)
  return out
}
