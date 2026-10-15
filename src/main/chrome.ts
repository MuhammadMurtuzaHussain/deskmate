import { execFile } from 'node:child_process'

/**
 * Her browser hands: drives the user's own, logged-in Chrome through AppleScript (macOS). Tabs, navigation and
 * URLs work out of the box; reading the page, clicking and typing go through `execute javascript`, which Chrome
 * only allows after a one-time switch (View → Developer → Allow JavaScript from Apple Events). Nothing here
 * launches a second browser or a separate profile: it is the Chrome the user is looking at.
 */

export type ChromeFailure = 'unsupported' | 'not_running' | 'no_window' | 'js_off' | 'not_authorized' | 'failed'

export class ChromeError extends Error {
  constructor(
    readonly code: ChromeFailure,
    message: string
  ) {
    super(message)
  }
}

export interface TabInfo {
  window: number
  index: number
  active: boolean
  url: string
  title: string
}

export interface PageElement {
  ref: number
  kind: string
  text: string
  href?: string
  inView: boolean
}

export interface Observation {
  url: string
  title: string
  text: string
  scrollY: number
  scrollMax: number
  elements: PageElement[]
}

/** "Google Chrome" by default; Brave, Edge and other Chromium browsers speak the same AppleScript dictionary. */
export const BROWSER_APP = process.env.DESKMATE_BROWSER_APP?.trim() || 'Google Chrome'
const SEARCH_URL = process.env.DESKMATE_SEARCH_URL?.trim() || 'https://www.google.com/search?q=%s'

export function searchUrl(query: string): string {
  return SEARCH_URL.replace('%s', encodeURIComponent(query))
}

export function chromeAvailable(): boolean {
  return process.platform === 'darwin'
}

/** Runs AppleScript lines; dynamic values travel as `argv` so nothing needs escaping inside the script. */
function osa(lines: string[], args: string[] = []): Promise<string> {
  if (!chromeAvailable()) return Promise.reject(new ChromeError('unsupported', 'I can only drive Chrome on a Mac for now.'))
  return new Promise((resolve, reject) => {
    execFile('osascript', [...lines.flatMap((l) => ['-e', l]), ...args], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).replace(/\n$/, ''))
      const text = `${stderr || ''} ${err.message}`
      if (/JavaScript through AppleScript is turned off/i.test(text)) {
        return reject(new ChromeError('js_off', `${BROWSER_APP} needs one setting first: View → Developer → Allow JavaScript from Apple Events. Then ask me again.`))
      }
      if (/Not authorized to send Apple events|-1743|not allowed assistive access|-1719/i.test(text)) {
        return reject(new ChromeError('not_authorized', `macOS is not letting me control ${BROWSER_APP}. System Settings → Privacy & Security → Automation → allow Deskmate for ${BROWSER_APP}.`))
      }
      if (/NO_WINDOW/.test(text)) return reject(new ChromeError('no_window', `${BROWSER_APP} has no window open.`))
      if (/isn't running|is not running|-600|Application isn't running/i.test(text)) return reject(new ChromeError('not_running', `${BROWSER_APP} is not open.`))
      reject(new ChromeError('failed', text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'AppleScript failed'))
    })
  })
}

const IN_CHROME = `tell application "${BROWSER_APP}"`
const ACTIVE_TAB = ['if (count of windows) = 0 then error "NO_WINDOW"', 'tell active tab of front window']

export async function running(): Promise<boolean> {
  if (!chromeAvailable()) return false
  try {
    return (await osa([`application "${BROWSER_APP}" is running`])) === 'true'
  } catch {
    return false
  }
}

export async function tabs(): Promise<TabInfo[]> {
  // Inside a Chrome tell block `tab` is Chrome's tab class, so the separator is built outside it.
  const out = await osa([
    'set sep to ASCII character 9',
    IN_CHROME,
    'set out to ""',
    'set wi to 0',
    'repeat with w in windows',
    'set wi to wi + 1',
    'set ti to 0',
    'set ai to (active tab index of w) as integer',
    'repeat with t in tabs of w',
    'set ti to ti + 1',
    'if ti is ai then',
    'set act to "1"',
    'else',
    'set act to "0"',
    'end if',
    'set out to out & wi & sep & ti & sep & act & sep & (URL of t) & sep & (title of t) & linefeed',
    'end repeat',
    'end repeat',
    'return out',
    'end tell'
  ])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [w, i, active, url, ...title] = line.split('\t')
      return { window: Number(w), index: Number(i), active: active === '1', url, title: title.join('\t') }
    })
}

export async function activeTab(): Promise<{ url: string; title: string } | null> {
  try {
    const out = await osa([IN_CHROME, ...ACTIVE_TAB, 'return (URL) & linefeed & (title)', 'end tell', 'end tell'])
    const [url, ...title] = out.split('\n')
    return { url, title: title.join('\n') }
  } catch (err) {
    if (err instanceof ChromeError && (err.code === 'no_window' || err.code === 'not_running')) return null
    throw err
  }
}

/** Opens a URL in a new tab of the front window (a new window when there is none), without stealing focus. */
export async function open(url: string, where: 'tab' | 'current' = 'tab'): Promise<void> {
  const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
  if (where === 'current') {
    await osa(['on run argv', IN_CHROME, ...ACTIVE_TAB, 'set URL to (item 1 of argv)', 'end tell', 'end tell', 'end run'], [target])
    return
  }
  await osa(
    [
      'on run argv',
      IN_CHROME,
      'if (count of windows) = 0 then make new window',
      'tell front window to make new tab at end of tabs with properties {URL:(item 1 of argv)}',
      'end tell',
      'end run'
    ],
    [target]
  )
}

/** Moves the active tab by `delta` (1 = next, -1 = previous) and returns the new tab's title. */
export async function switchTab(delta: number): Promise<string> {
  const d = Math.trunc(delta) || 1
  return osa([
    IN_CHROME,
    'if (count of windows) = 0 then error "NO_WINDOW"',
    'tell front window',
    'set n to count of tabs',
    'set i to active tab index',
    `set i to ((i - 1 + (${d})) mod n + n) mod n + 1`,
    'set active tab index to i',
    'return title of active tab',
    'end tell',
    'end tell'
  ])
}

export async function closeTab(): Promise<void> {
  await osa([IN_CHROME, 'if (count of windows) = 0 then error "NO_WINDOW"', 'tell front window to close active tab', 'end tell'])
}

export async function navigate(action: 'back' | 'forward' | 'reload'): Promise<void> {
  const verb = action === 'back' ? 'go back' : action === 'forward' ? 'go forward' : 'reload'
  await osa([IN_CHROME, ...ACTIVE_TAB, verb, 'end tell', 'end tell'])
}

/** Runs JavaScript in the active tab. Objects come back JSON-parsed when the script returns a JSON string. */
export async function js<T = unknown>(code: string): Promise<T> {
  const out = await osa(['on run argv', IN_CHROME, ...ACTIVE_TAB, 'return execute javascript (item 1 of argv)', 'end tell', 'end tell', 'end run'], [code])
  try {
    return JSON.parse(out) as T
  } catch {
    return out as unknown as T
  }
}

const TEXT_CLEAN = `(s) => String(s || '').replace(/[ \\t\\u00a0]+/g, ' ').replace(/\\s*\\n\\s*/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()`

export async function pageText(limit = 6000): Promise<{ url: string; title: string; text: string; length: number }> {
  return js(`(() => { const clean = ${TEXT_CLEAN}; const t = clean(document.body && document.body.innerText); return JSON.stringify({ url: location.href, title: document.title, text: t.slice(0, ${limit}), length: t.length }) })()`)
}

/** What the browse loop sees: where it is, what the page says, and numbered things it can click or type into. */
export async function observe(): Promise<Observation> {
  return js(`(() => {
    const clean = ${TEXT_CLEAN};
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > -300 && r.top < innerHeight + 1500 };
    const label = (el) => clean(el.getAttribute('aria-label') || (el.tagName === 'INPUT' ? (el.value && el.type !== 'password' ? el.value : el.placeholder) : '') || el.innerText || el.placeholder || el.title || el.alt || el.name || '').slice(0, 80);
    document.querySelectorAll('[data-dm-ref]').forEach((e) => e.removeAttribute('data-dm-ref'));
    const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=textbox],[role=searchbox],[role=combobox],[contenteditable=true],summary';
    const els = [...document.querySelectorAll(sel)].filter(visible);
    const items = [];
    els.slice(0, 150).forEach((el, i) => {
      const ref = i + 1; el.setAttribute('data-dm-ref', String(ref));
      const tag = el.tagName.toLowerCase();
      const kind = tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : (tag === 'textarea' || el.isContentEditable || /textbox|searchbox|combobox/.test(el.getAttribute('role') || '')) ? 'textbox' : tag === 'select' ? 'select' : 'button';
      const r = el.getBoundingClientRect();
      const item = { ref, kind, text: label(el), inView: r.top >= 0 && r.bottom <= innerHeight };
      if (tag === 'a') item.href = String(el.href).slice(0, 140);
      items.push(item);
    });
    const text = clean(document.body && document.body.innerText);
    return JSON.stringify({ url: location.href, title: document.title, scrollY: Math.round(scrollY), scrollMax: Math.max(0, document.documentElement.scrollHeight - innerHeight), text: text.slice(0, 2000), elements: items.filter((i) => i.text || i.kind !== 'link').slice(0, 60) });
  })()`)
}

export async function click(ref: number): Promise<string> {
  return js(`(() => { const el = document.querySelector('[data-dm-ref="${Math.trunc(ref)}"]'); if (!el) return 'missing'; el.scrollIntoView({ block: 'center' }); if (el.focus) el.focus(); el.click(); return 'clicked ' + String(el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 60) })()`)
}

/** Clicks the first visible link or button whose label contains `text` (exact match preferred). */
export async function clickText(text: string): Promise<string> {
  return js(`(() => { const want = ${JSON.stringify(text.toLowerCase())}; const clean = ${TEXT_CLEAN};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight * 3 };
    const els = [...document.querySelectorAll('a[href],button,input[type=submit],input[type=button],[role=button],[role=link],[role=tab],[role=menuitem],summary,label')].filter(visible);
    const lab = (el) => clean(el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').toLowerCase();
    const el = els.find((e) => lab(e) === want) || els.find((e) => lab(e).startsWith(want)) || els.find((e) => lab(e).includes(want));
    if (!el) return 'missing'; el.scrollIntoView({ block: 'center' }); el.click(); return 'clicked ' + lab(el).slice(0, 60) })()`)
}

/** Types into a field the way a person would (frameworks see input events); `submit` presses Enter after. */
export async function type(ref: number, text: string, submit: boolean): Promise<string> {
  const result = await js<string>(`(() => { const el = document.querySelector('[data-dm-ref="${Math.trunc(ref)}"]'); if (!el) return 'missing'; const text = ${JSON.stringify(text)};
    el.scrollIntoView({ block: 'center' }); el.focus();
    if (el.isContentEditable) { el.textContent = text; el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })) }
    else { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d && d.set) d.set.call(el, text); else el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
    if (${submit ? 'true' : 'false'}) { for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })) }
    return 'typed into ' + (el.getAttribute('aria-label') || el.placeholder || el.name || el.tagName.toLowerCase()) })()`)
  if (submit && result !== 'missing') {
    // Enter handled by the page itself in most cases; a plain form needs the submit nudged.
    await new Promise((r) => setTimeout(r, 600))
    await js(`(() => { const el = document.activeElement; if (el && el.form && typeof el.form.requestSubmit === 'function' && el.getAttribute('data-dm-ref') === '${Math.trunc(ref)}') el.form.requestSubmit(); return 'ok' })()`).catch(() => undefined)
  }
  return result
}

export async function scroll(direction: 'down' | 'up'): Promise<void> {
  await js(`(() => { window.scrollBy({ top: ${direction === 'down' ? '' : '-'}Math.round(innerHeight * 0.85), behavior: 'instant' }); return 'ok' })()`)
}

export async function find(text: string): Promise<boolean> {
  const out = await js<unknown>(`window.find(${JSON.stringify(text)}, false, false, true, false, true, false)`)
  return out === true || out === 'true'
}
