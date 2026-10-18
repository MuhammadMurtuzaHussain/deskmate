// How a macOS build is signed, decided from the environment only (no secrets in the repo):
//   - Developer ID: CSC_LINK (a base64 .p12 or a path/URL to one) or CSC_NAME (a certificate already in the keychain),
//     or DESKMATE_SIGN=1 to let electron-builder find one itself. Hardened runtime on, entitlements from build/.
//     Notarized when Apple credentials are there too: APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or an
//     App Store Connect API key (APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER), or APPLE_KEYCHAIN_PROFILE.
//   - Otherwise ad-hoc ("-"): runs on any Mac after the first right-click → Open, and cannot auto-update (updater.ts).
// See docs/RELEASING.md.

const set = (env, name) => typeof env[name] === 'string' && env[name].trim() !== ''

/** @returns {{ developerId: boolean, notarize: boolean, why: string }} */
function signingPlan(env = process.env) {
  const developerId = set(env, 'CSC_LINK') || set(env, 'CSC_NAME') || /^(1|true|yes|on)$/i.test(env.DESKMATE_SIGN?.trim() || '')
  if (!developerId) return { developerId: false, notarize: false, why: 'no Developer ID certificate (CSC_LINK / CSC_NAME): ad-hoc signed' }
  const appleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every((n) => set(env, n))
  const apiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every((n) => set(env, n))
  const profile = set(env, 'APPLE_KEYCHAIN_PROFILE')
  const notarize = appleId || apiKey || profile
  return {
    developerId: true,
    notarize,
    why: notarize ? `Developer ID, notarized (${appleId ? 'Apple ID' : apiKey ? 'API key' : 'keychain profile'})` : 'Developer ID, not notarized (no APPLE_* credentials)'
  }
}

/** Empty values (a GitHub secret that is not set comes through as "") would make electron-builder stop with an error
 * when only some of a group are set, so they are dropped before it reads them. */
function dropEmpty(env = process.env) {
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE']) {
    if (name in env && !set(env, name)) delete env[name]
  }
}

module.exports = { signingPlan, dropEmpty }
