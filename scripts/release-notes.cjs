// Release notes from CHANGELOG.md: the "## <version>" section (its heading may go on: "## 1.0.0: …"), without the
// heading, plus the install lines. `node scripts/release-notes.cjs 1.0.0-rc.1 > notes.md`; the release workflow puts
// it on the draft release. Fails when the version has no section, so a tag without notes is noticed.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

/** The body of the "## <version>" section, or null. */
function sectionFor(changelog, version) {
  const v = version.replace(/^v/, '')
  const lines = changelog.split(/\r?\n/)
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${esc}\\]?(?:[\\s:]|$)`).test(l))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

function notes(changelog, version) {
  const body = sectionFor(changelog, version)
  if (body === null) return null
  const v = version.replace(/^v/, '')
  const install = [
    '### Install',
    '',
    `- **macOS** (Apple silicon and Intel): \`Deskmate-${v}-mac-universal.dmg\`, open it and drag Deskmate to Applications.`,
    '  If the build is not notarized yet: the first time, right-click Deskmate → Open (or System Settings → Privacy & Security → Open Anyway).',
    `- **Windows 10/11**: \`Deskmate-${v}-win-x64-setup.exe\` (updates itself) or the portable exe.`,
    `- **Linux**: \`Deskmate-${v}-linux-x86_64.AppImage\` (updates itself) or the .deb.`,
    '',
    'First launch opens a short tour: her brain, a character, her voice, the macOS permissions, and a quick try.'
  ].join('\n')
  return `${body}\n\n${install}\n`
}

if (require.main === module) {
  const version = process.argv[2] || require('../package.json').version
  const out = notes(readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), version)
  if (out === null) {
    console.error(`[release-notes] CHANGELOG.md has no "## ${version}" section`)
    process.exit(1)
  }
  process.stdout.write(out)
}

module.exports = { sectionFor, notes }
