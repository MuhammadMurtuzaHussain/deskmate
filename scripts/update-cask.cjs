// Fills in the Homebrew cask for a release: `node scripts/update-cask.cjs 1.0.0 release/Deskmate-1.0.0-mac-universal.dmg`
// prints packaging/homebrew/Casks/deskmate.rb with that version and the DMG's sha256 (copy it into the tap repository;
// docs/HOMEBREW.md). With --write it updates the template in place.
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const CASK = join(__dirname, '..', 'packaging', 'homebrew', 'Casks', 'deskmate.rb')

/** The cask text with `version` and `sha256` replaced. */
function fillCask(text, version, sha256) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`)
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`)
  return text.replace(/^(\s*version ")[^"]*(")/m, `$1${version}$2`).replace(/^(\s*sha256 ")[^"]*(")/m, `$1${sha256}$2`)
}

if (require.main === module) {
  const [version, dmg] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (!version || !dmg) {
    console.error('usage: node scripts/update-cask.cjs <version> <path to Deskmate-<version>-mac-universal.dmg> [--write]')
    process.exit(2)
  }
  const sha = createHash('sha256').update(readFileSync(dmg)).digest('hex')
  const out = fillCask(readFileSync(CASK, 'utf8'), version.replace(/^v/, ''), sha)
  if (process.argv.includes('--write')) writeFileSync(CASK, out)
  else process.stdout.write(out)
}

module.exports = { fillCask }
