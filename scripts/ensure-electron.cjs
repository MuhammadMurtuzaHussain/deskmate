// Electron's binary is fetched by its postinstall script, which some npm setups skip.
// Run before dev/build/start so a fresh clone works without a manual step.
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const electronDir = join(__dirname, '..', 'node_modules', 'electron')
const pathFile = join(electronDir, 'path.txt')
const present = existsSync(pathFile) && existsSync(join(electronDir, 'dist', readFileSync(pathFile, 'utf8').trim()))

if (!present) {
  console.log('[deskmate] Electron binary missing, downloading it now…')
  execFileSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' })
}
