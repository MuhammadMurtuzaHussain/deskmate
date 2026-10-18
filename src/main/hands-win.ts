import { execFile } from 'node:child_process'
import type { CalendarEvent } from './calendar'
// The .ts extension lets `npm test` load this file straight from Node; the bundler takes it either way.
import { HandsError, type DesktopHands, type FocusedElement, type MenuItem, type Rect, type Snapshot, type TopWindow } from './hands.ts'
import type { Banner } from './inbox'

/**
 * Her hands on Windows (experimental): the same calls as the macOS helper, done with PowerShell, UI Automation and
 * SendKeys. Each call is one short `powershell.exe` run; its arguments travel as base64 JSON that the script decodes,
 * so nothing anyone typed is ever spliced into the script. An app is named by its process name ("WhatsApp"), and the
 * macOS bundle ids the built-in routines use are mapped to those. Calls that press keys check that the app is still the
 * foreground window first, like the Mac helper does. OCR, notification banners, the calendar and sitting on windows
 * are not here yet. Untested on real Windows so far: the command generation is unit-tested, the rest needs a PC.
 */

/** Bundle ids used by the routines and skills → the process names their Windows apps run as. */
export const WINDOWS_APPS: Record<string, string> = {
  'com.hnc.Discord': 'Discord',
  'com.tinyspeck.slackmacgap': 'slack',
  'com.anthropic.claudefordesktop': 'claude',
  'com.spotify.client': 'Spotify',
  'net.whatsapp.WhatsApp': 'WhatsApp',
  'desktop.WhatsApp': 'WhatsApp',
  'ru.keepcoder.Telegram': 'Telegram',
  'org.telegram.desktop': 'Telegram',
  'com.google.Chrome': 'chrome',
  'com.microsoft.VSCode': 'Code',
  'com.apple.TextEdit': 'notepad',
  'com.apple.finder': 'explorer'
}

/** A bundle id or an exe name as the process name to look for: "com.hnc.Discord" → "Discord", "notepad.exe" → "notepad". */
export function winApp(app: string): string {
  return WINDOWS_APPS[app] ?? app.replace(/\.exe$/i, '')
}

const KEY_NAMES: Record<string, string> = {
  return: '{ENTER}',
  enter: '{ENTER}',
  escape: '{ESC}',
  esc: '{ESC}',
  tab: '{TAB}',
  space: ' ',
  delete: '{DEL}',
  backspace: '{BACKSPACE}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}'
}
const MODIFIERS: Record<string, string> = { cmd: '^', command: '^', ctrl: '^', control: '^', shift: '+', alt: '%', option: '%' }
const SENDKEYS_SPECIAL = /[+^%~(){}[\]]/g

/**
 * A chord in the Mac helper's words as SendKeys: "cmd+k" → "^k" (⌘ is Ctrl on Windows), "cmd+shift+n" → "^+n",
 * "return" → "{ENTER}", "alt+f4" → "%{F4}".
 */
export function sendKeysCombo(combo: string): string {
  const parts = combo.toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean)
  const key = parts.pop()
  if (!key) throw new HandsError(`empty key combo "${combo}"`, 'bad_combo')
  let mods = ''
  for (const m of parts) {
    const s = MODIFIERS[m]
    if (!s) throw new HandsError(`unknown modifier "${m}" in "${combo}"`, 'bad_combo')
    if (!mods.includes(s)) mods += s
  }
  let k: string
  if (KEY_NAMES[key]) k = KEY_NAMES[key]
  else if (/^f(?:[1-9]|1[0-6])$/.test(key)) k = `{${key.toUpperCase()}}`
  else if (key.length === 1) k = key.replace(SENDKEYS_SPECIAL, '{$&}')
  else throw new HandsError(`unknown key "${key}" in "${combo}"`, 'bad_combo')
  return mods + k
}

/** Text typed as itself through SendKeys: its special characters braced, a new line as Shift+Enter (no accidental send). */
export function sendKeysText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(SENDKEYS_SPECIAL, '{$&}').replace(/\n/g, '+{ENTER}')
}

export type WinCommand =
  | 'installed'
  | 'launch'
  | 'frontmost'
  | 'windowTitle'
  | 'focused'
  | 'focusInput'
  | 'key'
  | 'type'
  | 'paste'
  | 'menu'
  | 'resolve'
  | 'snapshot'
  | 'act'
  | 'locate'
  | 'frame'

// ---- the PowerShell

const PRELUDE = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Out-Ok($o) { $o['ok'] = $true; [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)) }
function Fail($e) { [Console]::Out.WriteLine((@{ ok = $false; error = [string]$e } | ConvertTo-Json -Compress)); exit 0 }
trap { Fail ("error: " + $_.Exception.Message) }`

const WIN32 = String.raw`Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class DmWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
}
'@
function Front {
  $h = [DmWin]::GetForegroundWindow(); $p = [uint32]0; [void][DmWin]::GetWindowThreadProcessId($h, [ref]$p)
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  $sb = New-Object Text.StringBuilder 512; [void][DmWin]::GetWindowText($h, $sb, 512)
  @{ hwnd = $h; pid = [int]$p; name = [string]$proc.ProcessName; title = $sb.ToString() }
}
function Expect { if ($A.expect) { $f = Front; if ($f.name -ne $A.expect) { Fail ("focus_changed: " + $f.name) } } }
function MainProc($n) { Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }`

const UIA = String.raw`Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
function Root { if ($A.app) { $p = MainProc $A.app; if (-not $p) { Fail "no_window: $($A.app)" }; $AE::FromHandle($p.MainWindowHandle) } else { $AE::FromHandle([DmWin]::GetForegroundWindow()) } }
function Role($el) {
  $t = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  switch ($t) { 'Edit' { 'AXTextField' } 'Document' { 'AXTextArea' } 'ComboBox' { 'AXComboBox' } 'Button' { 'AXButton' } default { $t } }
}
function ValueOf($el) {
  try { return $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
  try { return $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(4000) } catch {}
  return $null
}
function Describe($el) {
  $o = @{ role = (Role $el); title = $el.Current.Name; description = $el.Current.HelpText }
  $v = ValueOf $el; if ($null -ne $v) { $o.value = $v }
  $o
}
$Wanted = 'Button','Edit','Document','Hyperlink','ListItem','MenuItem','TabItem','CheckBox','RadioButton','ComboBox','TreeItem','DataItem'
function Actionable($root, $max) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $out = @()
  foreach ($el in $all) {
    if ($out.Count -ge $max) { break }
    try { if ($el.Current.IsOffscreen) { continue } } catch { continue }
    $t = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($Wanted -contains $t) { $out += $el }
  }
  ,$out
}
function RectOf($el) { $r = $el.Current.BoundingRectangle; @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }`

const FORMS = 'Add-Type -AssemblyName System.Windows.Forms'

/** Just the body of each command; which helper blocks it needs comes from NEEDS. */
const BODIES: Record<WinCommand, string> = {
  installed: String.raw`$n = $A.app
$ok = [bool](Get-Process -Name $n -ErrorAction SilentlyContinue) -or [bool](Get-Command "$n.exe" -ErrorAction SilentlyContinue) -or [bool](Get-StartApps | Where-Object { $_.Name -like "*$n*" } | Select-Object -First 1)
Out-Ok @{ installed = $ok }`,
  launch: String.raw`$n = $A.app; $t0 = Get-Date
$p = MainProc $n; $was = [bool]$p
if (-not $p) {
  $s = Get-StartApps | Where-Object { $_.Name -like "*$n*" } | Select-Object -First 1
  if ($s) { Start-Process ("shell:AppsFolder\" + $s.AppID) } else { Start-Process $n }
  while (-not $p -and ((Get-Date) - $t0).TotalMilliseconds -lt $A.timeoutMs) { Start-Sleep -Milliseconds 250; $p = MainProc $n }
  if (-not $p) { Fail "launch_timeout: $n" }
}
if ([DmWin]::IsIconic($p.MainWindowHandle)) { [void][DmWin]::ShowWindow($p.MainWindowHandle, 9) }
(New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null
[void][DmWin]::SetForegroundWindow($p.MainWindowHandle)
Out-Ok @{ pid = $p.Id; wasRunning = $was; ms = [int]((Get-Date) - $t0).TotalMilliseconds }`,
  frontmost: String.raw`$f = Front
Out-Ok @{ bundleId = $f.name; name = $f.name; title = $f.title }`,
  windowTitle: String.raw`$p = MainProc $A.app
Out-Ok @{ title = $(if ($p -and $p.MainWindowTitle) { $p.MainWindowTitle } else { $null }) }`,
  focused: String.raw`$el = $AE::FocusedElement
$mine = @(Get-Process -Name $A.app -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if (-not $el -or $mine -notcontains $el.Current.ProcessId) { Out-Ok @{ element = $null } } else { Out-Ok @{ element = (Describe $el) } }`,
  focusInput: String.raw`Expect
$root = Root
$boxes = @(Actionable $root 400 | Where-Object { @('Edit', 'Document') -contains ($_.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') })
$hint = [string]$A.hint
$pick = $null
if ($hint) { $pick = $boxes | Where-Object { ($_.Current.Name + ' ' + $_.Current.HelpText) -like "*$hint*" } | Select-Object -Last 1 }
if (-not $pick) { $pick = $boxes | Select-Object -Last 1 }
if (-not $pick) { Fail "no_input: $hint" }
$pick.SetFocus()
Out-Ok @{ element = (Describe $pick) }`,
  key: String.raw`Expect
[System.Windows.Forms.SendKeys]::SendWait([string]$A.keys)
Out-Ok @{}`,
  type: String.raw`Expect
[System.Windows.Forms.SendKeys]::SendWait([string]$A.keys)
Out-Ok @{}`,
  paste: String.raw`Expect
$old = $null; try { $old = Get-Clipboard -Raw } catch {}
Set-Clipboard -Value ([string]$A.text)
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 300
if ($old) { Set-Clipboard -Value $old }
Out-Ok @{}`,
  menu: String.raw`if ($A.press) { Expect }
$root = Root
$items = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem))))
if (-not $A.press) { Out-Ok @{ items = @($items | ForEach-Object { @{ path = @($_.Current.Name); enabled = $_.Current.IsEnabled } }) }; return }
$pressed = @()
foreach ($name in $A.press) {
  $it = $items | Where-Object { $_.Current.Name -replace '&', '' -eq $name } | Select-Object -First 1
  if (-not $it) { Fail "no_menu_item: $name" }
  $pressed += $it.Current.Name
  try { $it.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); Start-Sleep -Milliseconds 250 } catch { $it.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  $items = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem))))
}
Out-Ok @{ pressed = $pressed }`,
  resolve: String.raw`$n = [string]$A.name
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*$n*" -or $_.MainWindowTitle -like "*$n*") } | Select-Object -First 1
if ($p) { Out-Ok @{ bundleId = $p.ProcessName; name = $p.ProcessName }; return }
$s = Get-StartApps | Where-Object { $_.Name -like "*$n*" } | Select-Object -First 1
if (-not $s) { Fail "not_installed: $n" }
Out-Ok @{ bundleId = ($s.Name -replace '\s', ''); name = $s.Name }`,
  snapshot: String.raw`$root = Root
$pr = Get-Process -Id $root.Current.ProcessId
$els = Actionable $root $A.maxElements
$lines = @(); $i = 1
foreach ($el in $els) { $lines += ('[' + $i + '] ' + ((Role $el) -replace '^AX', '') + ' "' + $el.Current.Name + '"'); $i++ }
$texts = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text))) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
$text = ($texts -join [Environment]::NewLine); if ($text.Length -gt $A.maxText) { $text = $text.Substring(0, $A.maxText) }
Out-Ok @{ app = $pr.ProcessName; bundleId = $pr.ProcessName; title = $root.Current.Name; elements = $lines; text = $text }`,
  act: String.raw`Expect
$els = Actionable (Root) 150
$el = $els[$A.index - 1]
if (-not $el) { Fail "no_element: $($A.index)" }
$via = $A.action
if ($A.action -eq 'focus') { $el.SetFocus() }
elseif ($A.action -eq 'press') {
  $done = $false
  foreach ($pat in @([System.Windows.Automation.InvokePattern], [System.Windows.Automation.TogglePattern], [System.Windows.Automation.SelectionItemPattern], [System.Windows.Automation.ExpandCollapsePattern])) {
    if ($done) { break }
    try {
      $pp = $el.GetCurrentPattern($pat::Pattern)
      switch ($pat.Name) { 'InvokePattern' { $pp.Invoke() } 'TogglePattern' { $pp.Toggle() } 'SelectionItemPattern' { $pp.Select() } 'ExpandCollapsePattern' { $pp.Expand() } }
      $via = $pat.Name; $done = $true
    } catch {}
  }
  if (-not $done) { $A.action = 'click' }
}
if ($A.action -eq 'click') {
  $r = $el.Current.BoundingRectangle
  [void][DmWin]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
  [DmWin]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); [DmWin]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
  $via = 'click'
}
Out-Ok @{ element = (Describe $el); via = $via }`,
  locate: String.raw`$root = Root
$want = [string]$A.text
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$hit = $null
foreach ($el in $all) { if ($el.Current.Name -like "*$want*" -or (ValueOf $el) -like "*$want*") { $hit = $el; break } }
Out-Ok @{ frame = $(if ($hit) { RectOf $hit } else { $null }) }`,
  frame: String.raw`$els = Actionable (Root) 150
$el = $els[$A.index - 1]
if (-not $el) { Fail "no_element: $($A.index)" }
Out-Ok @{ frame = (RectOf $el) }`
}

const NEEDS: Record<WinCommand, ('win32' | 'uia' | 'forms')[]> = {
  installed: [],
  launch: ['win32'],
  frontmost: ['win32'],
  windowTitle: ['win32'],
  focused: ['win32', 'uia'],
  focusInput: ['win32', 'uia'],
  key: ['win32', 'forms'],
  type: ['win32', 'forms'],
  paste: ['win32', 'forms'],
  menu: ['win32', 'uia'],
  resolve: [],
  snapshot: ['win32', 'uia'],
  act: ['win32', 'uia'],
  locate: ['win32', 'uia'],
  frame: ['win32', 'uia']
}

/** The arguments as the script receives them: base64 of UTF-8 JSON, decoded inside, never pasted into the source. */
export function encodeArgs(args: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
}

/** The whole script for one call. */
export function psScript(cmd: WinCommand, args: Record<string, unknown>): string {
  const blocks = NEEDS[cmd].map((n) => (n === 'win32' ? WIN32 : n === 'uia' ? UIA : FORMS))
  return [PRELUDE, `$A = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodeArgs(args)}')) | ConvertFrom-Json`, ...blocks, BODIES[cmd]].join('\n')
}

/** powershell.exe's arguments for a script: Windows PowerShell 5.1 (on every Windows 10 and 11), single-threaded
 * apartment for the clipboard and SendKeys, and the script as -EncodedCommand (base64 of UTF-16LE). */
export function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** One JSON line from a script, as the Mac helper would answer: a result, or a HandsError with its code. */
export function parseReply(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).at(-1)
  if (!line) throw new HandsError('no answer from PowerShell', 'helper_gone')
  let r: Record<string, unknown>
  try {
    r = JSON.parse(line) as Record<string, unknown>
  } catch {
    throw new HandsError(`bad answer from PowerShell: ${line.slice(0, 120)}`, 'helper_gone')
  }
  if (r.ok) return r
  const error = String(r.error ?? 'unknown')
  throw new HandsError(error, error.split(':')[0])
}

export type PsRunner = (args: string[], timeoutMs: number) => Promise<string>

const runPowerShell: PsRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(new HandsError(`PowerShell: ${err.message}`, err.killed ? 'timeout' : 'helper_gone'))
      else resolve(String(stdout))
    })
  })

const unsupported = (what: string): HandsError => new HandsError(`${what} isn't on Windows yet`, 'unsupported')

export class WinHands implements DesktopHands {
  calendarDisclaim = false
  /** calls run one at a time, like the Mac helper's queue, so keys from two calls never interleave */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly run: PsRunner
  private readonly platform: string

  constructor(opts: { run?: PsRunner; platform?: string } = {}) {
    this.run = opts.run ?? runPowerShell
    this.platform = opts.platform ?? process.platform
  }

  get available(): boolean {
    return this.platform === 'win32'
  }

  call(cmd: WinCommand, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    if (!this.available) return Promise.reject(new HandsError('the Windows hands only run on Windows', 'unavailable'))
    const next = this.queue.then(async () => parseReply(await this.run(psArgs(psScript(cmd, args)), timeoutMs)))
    this.queue = next.catch(() => undefined)
    return next
  }

  async permissions(): Promise<{ keys: boolean; accessibility: boolean; screen: boolean }> {
    // Windows asks nothing for SendKeys or UI Automation; an elevated app in front still ignores them.
    return { keys: this.available, accessibility: this.available, screen: this.available }
  }

  async installed(app: string): Promise<boolean> {
    return Boolean((await this.call('installed', { app: winApp(app) })).installed)
  }

  async launch(app: string, timeoutMs = 25_000): Promise<{ pid: number; wasRunning: boolean; ms: number }> {
    const r = await this.call('launch', { app: winApp(app), timeoutMs }, timeoutMs + 10_000)
    return { pid: Number(r.pid), wasRunning: Boolean(r.wasRunning), ms: Number(r.ms) }
  }

  async frontmost(): Promise<{ bundleId: string; name: string; title?: string }> {
    const r = await this.call('frontmost')
    return { bundleId: String(r.bundleId ?? ''), name: String(r.name ?? ''), title: r.title ? String(r.title) : undefined }
  }

  async windowTitle(app: string): Promise<string | null> {
    const r = await this.call('windowTitle', { app: winApp(app) })
    return r.title ? String(r.title) : null
  }

  async focused(app: string): Promise<FocusedElement | null> {
    return ((await this.call('focused', { app: winApp(app) })).element as FocusedElement | null) ?? null
  }

  async focusInput(app: string, hint: string, expect?: string): Promise<FocusedElement> {
    return (await this.call('focusInput', { app: winApp(app), hint, expect: expect && winApp(expect) })).element as FocusedElement
  }

  async key(combo: string, expect?: string): Promise<void> {
    await this.call('key', { keys: sendKeysCombo(combo), expect: expect && winApp(expect) })
  }

  async type(text: string, expect?: string): Promise<void> {
    await this.call('type', { keys: sendKeysText(text), expect: expect && winApp(expect) }, 20_000 + text.length * 30)
  }

  async paste(text: string, expect?: string): Promise<void> {
    await this.call('paste', { text, expect: expect && winApp(expect) })
  }

  async menuItems(app: string): Promise<MenuItem[]> {
    return ((await this.call('menu', { app: winApp(app) })).items as MenuItem[]) ?? []
  }

  async pressMenu(app: string, path: string[], expect?: string): Promise<string[]> {
    return ((await this.call('menu', { app: winApp(app), press: path, expect: expect && winApp(expect) })).pressed as string[]) ?? []
  }

  async resolve(name: string): Promise<{ bundleId: string; name: string }> {
    const r = await this.call('resolve', { name })
    return { bundleId: String(r.bundleId), name: String(r.name) }
  }

  async snapshot(app?: string, limits: { maxElements?: number; maxText?: number } = {}): Promise<Snapshot> {
    const r = await this.call('snapshot', { app: app ? winApp(app) : null, maxElements: limits.maxElements ?? 150, maxText: limits.maxText ?? 4000 }, 30_000)
    return { app: String(r.app ?? ''), bundleId: String(r.bundleId ?? ''), title: r.title ? String(r.title) : null, elements: (r.elements as string[]) ?? [], text: String(r.text ?? '') }
  }

  async act(index: number, action: 'press' | 'focus' | 'click', expect?: string): Promise<{ element: FocusedElement; via?: string }> {
    const r = await this.call('act', { index, action, expect: expect && winApp(expect), app: expect ? winApp(expect) : null }, 30_000)
    return { element: r.element as FocusedElement, via: r.via ? String(r.via) : undefined }
  }

  async ocr(): Promise<{ app: string; bundleId: string; items: string[] }> {
    throw unsupported('Reading the screen with OCR')
  }

  async clickText(): Promise<void> {
    throw unsupported('Clicking OCR text')
  }

  async topWindow(): Promise<TopWindow | null> {
    return null
  }

  async windowById(): Promise<Rect | null> {
    return null
  }

  async elementFrame(index: number): Promise<Rect> {
    return (await this.call('frame', { index }, 30_000)).frame as Rect
  }

  async textFrame(): Promise<Rect> {
    throw unsupported('OCR text positions')
  }

  async locate(app: string, text: string): Promise<Rect | null> {
    return ((await this.call('locate', { app: winApp(app), text }, 30_000)).frame as Rect | null) ?? null
  }

  async banners(): Promise<Banner[]> {
    return []
  }

  async calendarStatus(): Promise<string> {
    return 'unavailable'
  }

  async calendarEvents(): Promise<CalendarEvent[]> {
    return []
  }

  async requestCalendarAccess(): Promise<{ granted: boolean; status: string; error?: string }> {
    return { granted: false, status: 'unavailable', error: 'the calendar is macOS-only for now' }
  }

  stop(): void {
    // nothing long-lived to stop: each call is its own PowerShell run
  }
}
