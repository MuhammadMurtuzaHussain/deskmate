// The experimental Windows hands: key chords as SendKeys, app names, the PowerShell each call runs, and replies.
// Nothing runs PowerShell here except on Windows, where the scripts are only parsed. Run with `npm test`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { HandsError } from '../src/main/hands.ts'
import { encodeArgs, parseReply, psArgs, psScript, sendKeysCombo, sendKeysText, winApp, WinHands, type WinCommand } from '../src/main/hands-win.ts'

const COMMANDS: WinCommand[] = ['installed', 'launch', 'frontmost', 'windowTitle', 'focused', 'focusInput', 'key', 'type', 'paste', 'menu', 'resolve', 'snapshot', 'act', 'locate', 'frame']

test('key chords: ⌘ is Ctrl, names become SendKeys names', () => {
  assert.equal(sendKeysCombo('cmd+k'), '^k')
  assert.equal(sendKeysCombo('cmd+shift+n'), '^+n')
  assert.equal(sendKeysCombo('ctrl+cmd+k'), '^k')
  assert.equal(sendKeysCombo('return'), '{ENTER}')
  assert.equal(sendKeysCombo('cmd+return'), '^{ENTER}')
  assert.equal(sendKeysCombo('Escape'), '{ESC}')
  assert.equal(sendKeysCombo('down'), '{DOWN}')
  assert.equal(sendKeysCombo('alt+f4'), '%{F4}')
  assert.equal(sendKeysCombo('shift+tab'), '+{TAB}')
  assert.equal(sendKeysCombo('cmd+='), '^=')
  assert.equal(sendKeysCombo('cmd+('), '^{(}')
  assert.throws(() => sendKeysCombo('hyper+k'), /unknown modifier/)
  assert.throws(() => sendKeysCombo('cmd+launchpad'), /unknown key/)
})

test('typed text: SendKeys specials are braced, a new line is Shift+Enter so nothing sends early', () => {
  assert.equal(sendKeysText('hi (5+5=10) ~100% {ok} [x] ^_^'), 'hi {(}5{+}5=10{)} {~}100{%} {{}ok{}} {[}x{]} {^}_{^}')
  assert.equal(sendKeysText('line one\nline two\r\nthree'), 'line one+{ENTER}line two+{ENTER}three')
})

test('app names: the routines\' bundle ids map to Windows process names', () => {
  assert.equal(winApp('com.hnc.Discord'), 'Discord')
  assert.equal(winApp('net.whatsapp.WhatsApp'), 'WhatsApp')
  assert.equal(winApp('ru.keepcoder.Telegram'), 'Telegram')
  assert.equal(winApp('notepad.exe'), 'notepad')
  assert.equal(winApp('WhatsApp'), 'WhatsApp')
})

test('what anyone typed never lands in the script itself, only as base64 JSON', () => {
  const nasty = `'; Remove-Item -Recurse C:\\ ; "$(calc)" \`n`
  for (const cmd of COMMANDS) {
    const script = psScript(cmd, { text: nasty, app: nasty, hint: nasty, name: nasty, keys: nasty })
    assert.equal(script.includes('Remove-Item'), false, cmd)
    assert.ok(script.includes(encodeArgs({ text: nasty, app: nasty, hint: nasty, name: nasty, keys: nasty })), cmd)
  }
  const decoded = JSON.parse(Buffer.from(encodeArgs({ text: 'héllo ✓' }), 'base64').toString('utf8'))
  assert.deepEqual(decoded, { text: 'héllo ✓' })
})

test('each script loads only what it needs, checks the app in front before keys, and fits on a command line', () => {
  const key = psScript('key', { keys: '^k', expect: 'Discord' })
  assert.match(key, /^Expect$/m)
  assert.match(key, /System\.Windows\.Forms/)
  assert.doesNotMatch(key, /UIAutomationClient/)
  assert.doesNotMatch(psScript('installed', { app: 'x' }), /DmWin|UIAutomationClient|Windows\.Forms/)
  for (const cmd of ['key', 'type', 'paste', 'focusInput', 'act'] as WinCommand[]) assert.match(psScript(cmd, {}), /^Expect$/m, cmd)
  for (const cmd of COMMANDS) {
    const args = psArgs(psScript(cmd, { text: 'x'.repeat(2000) }))
    assert.deepEqual(args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand'])
    assert.ok(args.join(' ').length < 32_000, `${cmd} is ${args.join(' ').length} characters`)
    assert.equal(Buffer.from(args[6], 'base64').toString('utf16le'), psScript(cmd, { text: 'x'.repeat(2000) }))
  }
})

test('replies: a result, or a HandsError with the Mac helper\'s codes', () => {
  assert.deepEqual(parseReply('WARNING: something\r\n{"title":"#general - Discord","ok":true}\r\n'), { title: '#general - Discord', ok: true })
  assert.throws(
    () => parseReply('{"ok":false,"error":"focus_changed: explorer"}'),
    (err: unknown) => err instanceof HandsError && err.code === 'focus_changed'
  )
  assert.throws(() => parseReply(''), (err: unknown) => err instanceof HandsError && err.code === 'helper_gone')
})

test('WinHands: calls go through PowerShell in order, with the right arguments; missing pieces say so', async () => {
  const seen: { cmd: Record<string, unknown>; script: string }[] = []
  const replies: string[] = ['{"pid":42,"wasRunning":false,"ms":900,"ok":true}', '{"ok":true}', '{"ok":true}', '{"ok":false,"error":"focus_changed: explorer"}']
  const hands = new WinHands({
    platform: 'win32',
    run: async (args) => {
      const script = Buffer.from(args[6], 'base64').toString('utf16le')
      const b64 = /FromBase64String\('([^']+)'\)/.exec(script)?.[1] ?? ''
      seen.push({ cmd: JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), script })
      return replies.shift() ?? '{"ok":true}'
    }
  })
  assert.equal(hands.available, true)
  assert.deepEqual(await hands.launch('com.hnc.Discord'), { pid: 42, wasRunning: false, ms: 900 })
  await hands.key('cmd+k', 'com.hnc.Discord')
  await hands.paste('on my way', 'com.hnc.Discord')
  await assert.rejects(hands.type('sam', 'com.hnc.Discord'), (err: unknown) => err instanceof HandsError && err.code === 'focus_changed')
  assert.deepEqual(
    seen.map((s) => s.cmd),
    [
      { app: 'Discord', timeoutMs: 25_000 },
      { keys: '^k', expect: 'Discord' },
      { text: 'on my way', expect: 'Discord' },
      { keys: 'sam', expect: 'Discord' }
    ]
  )
  await assert.rejects(hands.ocr(), (err: unknown) => err instanceof HandsError && err.code === 'unsupported')
  assert.equal(await hands.topWindow(), null)
  assert.deepEqual(await hands.banners(), [])
  assert.equal((await hands.requestCalendarAccess()).granted, false)

  const mac = new WinHands({ platform: 'darwin', run: async () => '{"ok":true}' })
  assert.equal(mac.available, false)
  await assert.rejects(mac.key('return'), (err: unknown) => err instanceof HandsError && err.code === 'unavailable')
})

test('on Windows, every script parses as PowerShell', { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }, () => {
  for (const cmd of COMMANDS) {
    const script = psScript(cmd, { app: 'notepad', text: 'x', keys: 'x', hint: '', index: 1, action: 'focus', maxElements: 10, maxText: 100, name: 'x', timeoutMs: 1000 })
    const check = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf8').toString('base64')}')), [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(check, 'utf16le').toString('base64')], { stdio: 'pipe' })
  }
})
