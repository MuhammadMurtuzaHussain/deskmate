// electron-builder configuration (npm run dist:mac / dist:win / dist:linux, and the release workflow).
// Signing is decided from the environment by scripts/signing.cjs; with nothing set the Mac build is ad-hoc signed and
// still runs. docs/RELEASING.md has the whole story.
const { signingPlan, dropEmpty } = require('./scripts/signing.cjs')

/** The characters that ship with the app. Anything else under character/ is someone's own and stays out. */
const SHIPPED_CHARACTERS = ['mika', 'shino', 'victoria', 'vita', 'vivi']

dropEmpty()
const plan = signingPlan()
if (process.platform === 'darwin' && !process.env.DESKMATE_QUIET_SIGNING) console.log(`[deskmate] macOS signing: ${plan.why}`)

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.murtuza.deskmate',
  productName: 'Deskmate',
  copyright: 'Copyright © 2026 Muhammad Murtuza Hussain',
  directories: { buildResources: 'build', output: 'release' },
  asar: true,
  files: [
    'out/**',
    'package.json',
    '!out/renderer/models/jian/**',
    '!out/renderer/models/nicole/**',
    '!out/renderer/models/ani/**',
    '!out/renderer/models/*/dances/**',
    '!out/renderer/models/victoria/test.vrma'
  ],
  extraResources: [
    { from: 'character', to: 'character', filter: SHIPPED_CHARACTERS.flatMap((id) => [`${id}/character.json`, `${id}/persona.md`]) },
    { from: 'skills', to: 'skills' },
    { from: 'build', to: 'build', filter: ['tray*.png', 'tray.ico', 'icon.png'] },
    // The scripts only: the Kokoro venv is made under the user-data folder (Setup → Her voice → Install).
    { from: 'tts-local', to: 'tts-local', filter: ['setup.sh', 'run.sh', 'server.py', 'requirements.txt'] }
  ],
  mac: {
    category: 'public.app-category.productivity',
    // The helper is universal already (scripts/build-hands.cjs --universal), so both halves carry the same file.
    extraResources: [{ from: 'native/bin', to: 'bin', filter: ['deskmate-hands'] }],
    // One download for both chips; the zip is what the auto-updater fetches.
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] }
    ],
    artifactName: 'Deskmate-${version}-mac-${arch}.${ext}',
    icon: 'build/icon.png',
    minimumSystemVersion: '13.0',
    // Developer ID: hardened runtime with the entitlements below (also given to the helpers, deskmate-hands among
    // them). Ad-hoc: no hardened runtime, which would refuse to load the ad-hoc signed Electron framework.
    identity: plan.developerId ? undefined : '-',
    hardenedRuntime: plan.developerId,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    notarize: plan.notarize,
    gatekeeperAssess: false,
    extendInfo: {
      LSUIElement: true,
      NSScreenCaptureDescription: 'Deskmate looks at your screen so your companion can react to what you are doing.',
      NSMicrophoneUsageDescription: 'Deskmate listens while hands-free mode is on, so you can talk to your companion.',
      NSAppleEventsUsageDescription: 'Deskmate controls the apps you ask her to use: Chrome to browse, Spotify to play music, Messages to send texts (always after your yes).',
      NSCalendarsFullAccessUsageDescription: 'Deskmate reads your upcoming events so your companion can remind you before they start. Nothing is changed.',
      NSCalendarsUsageDescription: 'Deskmate reads your upcoming events so your companion can remind you before they start. Nothing is changed.'
    }
  },
  dmg: { artifactName: 'Deskmate-${version}-mac-${arch}.${ext}' },
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] }
    ],
    icon: 'build/icon.png'
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: 'Deskmate',
    artifactName: 'Deskmate-${version}-win-${arch}-setup.${ext}'
  },
  portable: { artifactName: 'Deskmate-${version}-win-${arch}-portable.${ext}' },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Utility',
    icon: 'build/icon.png',
    artifactName: 'Deskmate-${version}-linux-${arch}.${ext}',
    desktop: { entry: { Name: 'Deskmate', Comment: 'AI desk companion' } }
  },
  // Releases are drafted by CI and published by hand; the app reads app-update.yml (made from this) to find updates.
  publish: { provider: 'github', owner: 'MuhammadMurtuzaHussain', repo: 'deskmate', releaseType: 'draft' }
}
