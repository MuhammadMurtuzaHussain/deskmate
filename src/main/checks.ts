import type { FocusedElement } from './hands'

/**
 * The checks her hands make before and while they act in an app, shared by the app routines (apps.ts), the Claude
 * agent (computer.ts) and skills (skills.ts). Pure, so the tests can use them without Electron or the helper.
 */

/** Off limits whatever the goal: secrets, system settings, and shells (Claude Code jobs exist for real terminal work). */
export const DENY_APPS = new Set([
  'com.apple.keychainaccess',
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.bitwarden.desktop',
  'com.apple.systempreferences',
  'com.apple.SecurityAgent',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.mitchellh.ghostty'
])

/** Where Return sends something to other people. */
export const MESSAGING_APPS = new Set([
  'com.hnc.Discord',
  'com.tinyspeck.slackmacgap',
  'com.apple.MobileSMS',
  'net.whatsapp.WhatsApp',
  'desktop.WhatsApp',
  'ru.keepcoder.Telegram',
  'org.telegram.desktop',
  'com.apple.mail',
  'com.microsoft.Outlook',
  'com.microsoft.teams2',
  'org.whispersystems.signal-desktop'
])

/** A button or menu item that does something to other people or can't be taken back. */
export const RISKY_LABEL = /\b(send|post|publish|tweet|reply|submit|delete|remove|trash|erase|buy|pay|purchase|checkout|check out|order|transfer|donate|subscribe|unsubscribe|confirm|sign out|log out|accept|agree|share|invite|call|leave)\b/i

/** Text she never types for anyone: card numbers and secrets. */
export const NEVER_TYPE = /\b(?:\d[ -]?){13,19}\b|password|passcode|cvv|cvc|social security|iban/i

/** A key press that sends what is in a message box: Return or Enter, alone or with a modifier. */
export const SEND_KEY = /^(?:(?:cmd|ctrl|shift|alt)\+)*(?:return|enter)$/

/** Shortcuts that move things to the Trash, empty it, or delete for good (Finder, Mail, Photos and most editors). */
export const DESTRUCTIVE_KEY = /^(?:(?:cmd|ctrl|shift|alt)\+)*(?:cmd|ctrl)\+(?:(?:shift|alt)\+)*(?:backspace|delete|forwarddelete)$/

/** Text boxes, as the macOS helper names them (the Windows hands report the same names). */
export const EDITABLE_ROLES = new Set(['AXTextArea', 'AXTextField', 'AXComboBox'])

export function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/** True when every word of what they named shows up in the window title ("general chat" ↔ "#general-chat | …"). */
export function titleMatches(target: string, title: string | null): boolean {
  if (!title) return false
  const have = new Set(words(title))
  const want = words(target)
  return want.length > 0 && want.every((w) => have.has(w) || [...have].some((h) => h.startsWith(w) && w.length >= 3))
}

/** "(3) #general | My Server - Discord" → "#general"; "general (Channel) - Acme - Slack" → "general". */
export function chatLabel(title: string, appName: string): string {
  const parts = title
    .replace(/^\(\d+\)\s*/, '')
    .replace(/^•\s*/, '')
    .split(/\s+[|–—-]\s+/)
    .map((p) => p.trim())
    .filter((p) => p && p.toLowerCase() !== appName.toLowerCase())
  return (parts[0] ?? title).replace(/\s*\((?:channel|dm|group dm)\)$/i, '').trim()
}

function squash(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** True unless the box reports a value that does not hold `text` (a box that reports nothing gets the benefit). */
export function boxHolds(box: FocusedElement | null, text: string): boolean {
  if (box?.value === undefined) return true
  return squash(box.value).includes(squash(text).slice(0, 40))
}
