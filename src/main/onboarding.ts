// The first-run tour's permission step: what macOS reports for each permission, turned into one row each with a chip
// and the button that helps (ask now, or open the right System Settings pane). Pure, so it can be tested; index.ts
// gathers the raw answers (systemPreferences, the hands helper, the Messages database) and the setup page draws rows.

import type { OnboardPermId, OnboardPermRow, OnboardPermState } from '../shared/types'

/** Raw answers, as each API gives them. */
export interface PermProbe {
  /** Accessibility for the app (null: no helper, so unknown) */
  accessibility: boolean | null
  /** systemPreferences.getMediaAccessStatus: granted | denied | not-determined | restricted | unknown */
  screen: string
  microphone: string
  /** the hands helper's AEDeterminePermissionToAutomateTarget: granted | denied | notDetermined | notRunning |
   * notInstalled | timeout (it would not say; asking usually does) | error … */
  messages: string
  spotify: string
  /** EventKit: fullAccess | writeOnly | denied | restricted | notDetermined | unknown */
  calendars: string
  /** can she open ~/Library/Messages/chat.db (null: not checked) */
  fullDisk: boolean | null
}

/** System Settings → Privacy & Security panes (x-apple.systempreferences:com.apple.preference.security?<pane>). */
export const PRIVACY_PANES: Record<OnboardPermId, string> = {
  accessibility: 'Privacy_Accessibility',
  screen: 'Privacy_ScreenCapture',
  microphone: 'Privacy_Microphone',
  'automation-messages': 'Privacy_Automation',
  'automation-spotify': 'Privacy_Automation',
  calendars: 'Privacy_Calendars',
  'full-disk': 'Privacy_AllFiles'
}

export function settingsUrl(id: OnboardPermId): string {
  return `x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[id]}`
}

const ROWS: { id: OnboardPermId; label: string; why: string; needed: boolean }[] = [
  { id: 'accessibility', label: 'Accessibility', why: 'so she can press keys and click in your apps (Discord, Slack, Notes…)', needed: true },
  { id: 'screen', label: 'Screen Recording', why: "so she can see what you're doing and read what's on screen", needed: true },
  { id: 'microphone', label: 'Microphone', why: 'so she can hear you when you talk to her', needed: true },
  { id: 'automation-messages', label: 'Automation: Messages', why: 'so she can text people (always after your yes)', needed: false },
  { id: 'automation-spotify', label: 'Automation: Spotify', why: 'so she can play, pause and skip music', needed: false },
  { id: 'calendars', label: 'Calendar', why: 'so she can nudge you before a meeting (read only)', needed: false },
  { id: 'full-disk', label: 'Full Disk Access', why: 'only to reach her from iMessage on your phone: she reads the Messages database', needed: false }
]

/** One permission's raw answer as a state. */
export function permState(id: OnboardPermId, p: PermProbe): OnboardPermState {
  switch (id) {
    case 'accessibility':
      return p.accessibility === null ? 'unknown' : p.accessibility ? 'granted' : 'not-asked'
    case 'screen':
    case 'microphone':
      return media(id === 'screen' ? p.screen : p.microphone)
    case 'automation-messages':
    case 'automation-spotify':
      return automation(id === 'automation-messages' ? p.messages : p.spotify)
    case 'calendars':
      return /^(fullAccess|authorized)$/.test(p.calendars) ? 'granted' : p.calendars === 'notDetermined' ? 'not-asked' : /^(denied|restricted|writeOnly)$/.test(p.calendars) ? 'denied' : 'unknown'
    case 'full-disk':
      return p.fullDisk === null ? 'unknown' : p.fullDisk ? 'granted' : 'denied'
  }
}

function media(status: string): OnboardPermState {
  if (status === 'granted') return 'granted'
  if (status === 'not-determined') return 'not-asked'
  if (status === 'denied' || status === 'restricted') return 'denied'
  return 'unknown'
}

function automation(status: string): OnboardPermState {
  if (status === 'granted') return 'granted'
  if (status === 'notDetermined') return 'not-asked'
  if (status === 'denied') return 'denied'
  if (status === 'notRunning') return 'not-running'
  if (status === 'notInstalled') return 'not-installed'
  return 'unknown'
}

/**
 * The rows for the tour, in order. `action` is the button: "ask" where macOS can still show its own question
 * (or Accessibility's prompt, which also lists the app), "launch" for an Automation target that has to be open before
 * macOS will ask, "settings" once it was refused (only System Settings can change a no), none when granted.
 */
export function permissionRows(p: PermProbe): OnboardPermRow[] {
  return ROWS.map((r) => {
    const state = permState(r.id, p)
    // Screen Recording has no question of its own: a first capture puts the app on the list, then the pane opens,
    // so "Allow" stays useful after a no too. An Automation check that timed out is worth asking outright.
    const action: OnboardPermRow['action'] =
      state === 'granted' || state === 'not-installed'
        ? null
        : state === 'not-running'
          ? 'launch'
          : (state === 'not-asked' && r.id !== 'full-disk') || (r.id === 'screen' && state === 'denied') || (r.id.startsWith('automation') && state === 'unknown')
            ? 'ask'
            : 'settings'
    return { ...r, state, action, pane: settingsUrl(r.id) }
  })
}

/** "2 of 3 needed": the three she needs to be useful; the rest are for the things that use them. */
export function permSummary(rows: OnboardPermRow[]): { granted: number; needed: number; done: boolean } {
  const needed = rows.filter((r) => r.needed)
  const granted = needed.filter((r) => r.state === 'granted').length
  return { granted, needed: needed.length, done: granted === needed.length }
}

/** A line from tts-local/setup.sh: "setup.sh: [2/4] creating …" is step 2 of 4. */
export function setupProgress(line: string): { step: number; of: number } | null {
  const m = /setup\.sh: \[(\d+)\/(\d+)\]/.exec(line)
  return m ? { step: Number(m[1]), of: Number(m[2]) } : null
}

/** What setup.sh's failure means for someone who has never opened a terminal. */
export function setupError(lines: string[]): string {
  const text = lines.join('\n')
  if (/need Python 3\.10/.test(text)) return 'Kokoro needs Python 3.10–3.12. Install it with Homebrew (brew install python@3.12) or uv, then press Install again.'
  if (/No space left/i.test(text)) return 'The disk is full: Kokoro and Whisper need about 2 GB.'
  if (/Could not find a version|No matching distribution|Temporary failure|Connection|timed out/i.test(text)) return 'The download failed: check the internet connection and press Install again.'
  const last = lines.filter((l) => l.trim()).at(-1)
  return `The install stopped${last ? `: ${last.slice(0, 200)}` : '.'}`
}

/** The three things to say in "try me": safe on any brain, quick, and each shows a different side of her. */
export function tryExamples(platform: string): string[] {
  return ['What can you do for me?', 'Remind me in 1 minute to stretch', platform === 'darwin' ? "What's on my screen right now?" : 'Tell me a fun fact about space']
}
