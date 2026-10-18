/**
 * New message notifications, as macOS shows them: the helper reads the banners off Notification Center's
 * accessibility tree every few seconds (no Full Disk Access, no notification database), and this decides which ones
 * are new and worth a word. By default she says who and on which app ("Sam messaged you on Discord"); reading the
 * message itself is a setting. Chat apps are on by default; others can be allowed, and any app can be denied.
 * While a Focus is on, macOS shows no banners, so she hears about nothing either.
 */

export interface Banner {
  /** Notification Center's id for the banner (a UUID); a stack keeps its id while its newest message changes */
  id: string
  app: string
  title: string
  subtitle: string
  body: string
  stacked?: boolean
  /** read from the open Notification Center panel, not a banner sliding in */
  inPanel?: boolean
}

/** Apps whose notifications are messages from people. Matched on the name macOS shows, lower case. */
export const CHAT_APPS = [
  'messages',
  'discord',
  'slack',
  'whatsapp',
  'telegram',
  'signal',
  'microsoft teams',
  'teams',
  'messenger',
  'instagram',
  'skype',
  'google chat',
  'beeper',
  'element',
  'wechat',
  'line',
  'viber',
  'mail',
  'outlook',
  'spark',
  'superhuman'
]
const MAIL_APPS = ['mail', 'outlook', 'spark', 'superhuman']
/** Her own banners, and the ones Electron shows for her in development. */
const SELF_APPS = ['deskmate', 'electron']

const norm = (s: string): string => s.trim().toLowerCase()

/** Whether she mentions notifications from this app: never if denied, yes for chat apps and the ones allowed. */
export function appAllowed(app: string, prefs: { allowApps: string[]; denyApps: string[] }): boolean {
  const a = norm(app)
  if (!a || SELF_APPS.includes(a)) return false
  if (prefs.denyApps.some((d) => norm(d) === a)) return false
  return CHAT_APPS.includes(a) || prefs.allowApps.some((d) => norm(d) === a)
}

function contentKey(b: Banner): string {
  return [b.app, b.title, b.subtitle, b.body].map((s) => norm(s).replace(/\s+/g, ' ')).join('|')
}

/**
 * Remembers what has been on screen, so each notification is announced once: when it slides in, not again when it
 * moves into Notification Center or when the panel is opened. The first look after she starts only takes note of what
 * is there already. A message with the same words as one in the last few minutes counts as the same one (the id
 * changes when a banner moves into the list).
 */
export class BannerWatch {
  private readonly seenIds = new Map<string, number>()
  private readonly seenContent = new Map<string, number>()
  private primed = false
  private readonly opts: { contentMs?: number; idMs?: number }

  constructor(opts: { contentMs?: number; idMs?: number } = {}) {
    this.opts = opts
  }

  /** The banners in this look that are new. Ones only in the open panel are noted, not returned. */
  update(list: Banner[], now = Date.now()): Banner[] {
    const contentMs = this.opts.contentMs ?? 10 * 60_000
    const idMs = this.opts.idMs ?? 6 * 3_600_000
    for (const [k, at] of this.seenContent) if (now - at > contentMs) this.seenContent.delete(k)
    for (const [k, at] of this.seenIds) if (now - at > idMs) this.seenIds.delete(k)
    const fresh: Banner[] = []
    for (const b of list) {
      const content = contentKey(b)
      const idKey = `${b.id}|${content}`
      const known = this.seenContent.has(content) || (b.id !== '' && this.seenIds.has(idKey))
      this.seenContent.set(content, now)
      if (b.id) this.seenIds.set(idKey, now)
      if (!this.primed || known || b.inPanel) continue
      fresh.push(b)
    }
    this.primed = true
    return fresh
  }
}

/** "Sam (#general, Design Team)" → "Sam"; Slack's "Sam in #general" → "Sam". */
export function sender(title: string): string {
  return title
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+in\s+#\S+.*$/i, '')
    .trim()
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t
}

/**
 * What she says about one banner, and a few words for when several are said together.
 * readBody=false (the default in Setup): app and sender only.
 */
export function messageLine(b: Banner, readBody: boolean): { text: string; brief: string } {
  const app = b.app.trim() || 'an app'
  const a = norm(app)
  const who = sender(b.title)
  const chat = CHAT_APPS.includes(a)
  let text: string
  let brief: string
  if (chat && who) {
    const mail = MAIL_APPS.includes(a)
    text = mail ? `${who} emailed you.` : `${who} messaged you on ${app}.`
    brief = mail ? `an email from ${who}` : `${who} on ${app}`
  } else if (chat) {
    text = `New message on ${app}.`
    brief = `one on ${app}`
  } else {
    // An app they allowed that is not a chat app: its headline is the news.
    text = who ? `${app}: ${who}.` : `Something from ${app}.`
    brief = who ? `${app}: ${who}` : app
  }
  if (readBody) {
    const said = clip([b.subtitle, b.body].filter(Boolean).join(': '), 180)
    if (said) text = `${text.replace(/[.]$/, '')}: "${said}"`
  }
  return { text, brief }
}
