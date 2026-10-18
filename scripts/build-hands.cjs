// Compiles native/hands/main.swift into native/bin/deskmate-hands (macOS only), the helper behind her hands in
// native apps. Skipped when the binary is newer than the source. `--universal` builds arm64 + x86_64 for releases.
// Without the Xcode command line tools it warns and carries on: everything else works, app control does not.
const { existsSync, mkdirSync, statSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

if (process.platform !== 'darwin') process.exit(0)

const root = join(__dirname, '..')
const src = join(root, 'native', 'hands', 'main.swift')
// The usage text macOS shows when she asks for Calendars, linked into the binary.
const plist = join(root, 'native', 'hands', 'Info.plist')
const outDir = join(root, 'native', 'bin')
const out = join(outDir, 'deskmate-hands')
const universal = process.argv.includes('--universal')

const fresh = existsSync(out) && statSync(out).mtimeMs > Math.max(statSync(src).mtimeMs, statSync(plist).mtimeMs)
if (fresh && !universal) process.exit(0)

mkdirSync(outDir, { recursive: true })
const compile = (target, dest) =>
  execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', target, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist, '-o', dest, src], {
    stdio: 'inherit'
  })

try {
  if (universal) {
    const arm = `${out}-arm64`
    const x86 = `${out}-x86_64`
    compile('arm64-apple-macos13.0', arm)
    compile('x86_64-apple-macos13.0', x86)
    execFileSync('lipo', ['-create', '-output', out, arm, x86], { stdio: 'inherit' })
    rmSync(arm)
    rmSync(x86)
  } else {
    compile(`${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`, out)
  }
  console.log(`[deskmate] built ${universal ? 'universal ' : ''}native/bin/deskmate-hands`)
} catch (err) {
  console.warn(`[deskmate] could not build the hands helper (install the Xcode command line tools: xcode-select --install): ${err.message}`)
}
