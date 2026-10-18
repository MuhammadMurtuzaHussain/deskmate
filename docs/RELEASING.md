# Releasing Deskmate

How a release is built, signed, published and announced. Everything here runs without any Apple account: unsigned
builds work today, and signing switches on by itself once the secrets below exist.

## The short version

1. Bump `version` in `package.json` (`1.0.0-rc.2`, `1.0.0`) and add a `## <version>` section at the top of
   `CHANGELOG.md`. `npm test` checks that the section exists.
2. Commit, then tag and push the tag:

   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) builds macOS (one universal DMG + zip), Windows
   (installer + portable) and Linux (AppImage + deb), uploads them to a **draft** release, and writes the notes from
   your CHANGELOG section. A version with a `-` (rc, beta) is marked as a prerelease.
4. Open the draft on GitHub, download the DMG, try it on a Mac (the checklist below), then press **Publish**.
5. Update the Homebrew tap ([HOMEBREW.md](HOMEBREW.md)).

Nothing is published without step 4. To build without releasing, run the workflow by hand (Actions → Release → Run
workflow): the files are kept as workflow artifacts for a week.

## Building locally

```bash
npm run dist:mac      # release/Deskmate-<version>-mac-universal.dmg and .zip, then the packaging smoke test
npm run dist:win      # on Windows
npm run dist:linux    # on Linux
npm run pack          # just the .app for this Mac's chip, in release/mac-arm64 (quick)
npm run smoke:package # check what is in release/ again
```

The smoke test (`scripts/smoke-package.cjs`) fails the build when something the app needs at runtime is missing:
the app-control helper (and that it is universal), the five shipped characters (and nothing private), the skills, the
Kokoro scripts (without a venv), the tray icons, `app-update.yml` for the updater, the pages in `app.asar`, the
macOS usage texts, and a signature that verifies.

The terminal prints how the Mac build will be signed:

```
[deskmate] macOS signing: no Developer ID certificate (CSC_LINK / CSC_NAME): ad-hoc signed
```

## Unsigned (ad-hoc) builds: what users see

Today's builds are ad-hoc signed: the signature verifies, but it does not say who made the app, and Apple has not
checked it. On a Mac that downloaded it:

- macOS refuses the first open ("Apple could not verify Deskmate is free of malware"). The user opens System Settings →
  Privacy & Security, scrolls down, and presses **Open Anyway** (once). On macOS 14 and earlier, right-click → Open
  also works. From a terminal: `xattr -dr com.apple.quarantine /Applications/Deskmate.app`.
- Permissions (Accessibility, Screen Recording…) are tied to the signature. An ad-hoc build gets a new identity every
  release, so after an update macOS may list Deskmate twice and the permissions have to be switched on again. The
  first-run tour (tray → Welcome tour…) shows which.
- The app cannot update itself: macOS's updater (Squirrel.Mac) only installs updates signed with a Developer ID. The
  app notices and falls back to "Update available" in the tray, which opens the release page.

Windows builds are unsigned too: SmartScreen shows "Windows protected your PC" → More info → Run anyway. The installer
still updates itself; the portable exe does not.

## Signing and notarizing the Mac build

### What to buy and create (once)

1. **Apple Developer Program** membership: US$99 a year, at <https://developer.apple.com/programs/enroll/>. An
   individual membership is fine; it needs an Apple ID with two-factor authentication. Approval can take a day or two.
   Your **Team ID** (10 characters) is on <https://developer.apple.com/account> → Membership details.
2. A **Developer ID Application** certificate (this is the one for apps distributed outside the App Store; not
   "Apple Development", not "Mac App Distribution"):
   - On your Mac, open Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority,
     enter your email, choose "Saved to disk".
   - At <https://developer.apple.com/account/resources/certificates/add> choose **Developer ID Application**, upload
     that request, download the certificate and double-click it to add it to your login keychain.
   - (Or in Xcode → Settings → Accounts → your team → Manage Certificates → + → Developer ID Application.)
3. Export it for CI: in Keychain Access → My Certificates, right-click "Developer ID Application: Your Name (TEAMID)"
   → Export → `.p12`, with a strong password. Then turn it into one line of text:

   ```bash
   base64 -i DeveloperID.p12 | pbcopy
   ```

4. Credentials for **notarization** (Apple scans the app and staples a ticket so Gatekeeper opens it without a
   warning). Pick one:
   - **App-specific password** (simplest): <https://account.apple.com> → Sign-In and Security → App-Specific Passwords
     → +. You need your Apple ID email, that password, and your Team ID.
   - **App Store Connect API key** (no personal password in CI): <https://appstoreconnect.apple.com/access/integrations/api>
     → Team Keys → +, role **Developer**. Download the `.p8` (only once), note the **Key ID** and the **Issuer ID**.

### GitHub secrets to add

Repository → Settings → Secrets and variables → Actions → New repository secret:

| Secret | What goes in it |
|---|---|
| `MAC_CSC_LINK` | the base64 text of the `.p12` from step 3 |
| `MAC_CSC_KEY_PASSWORD` | the password you gave the `.p12` |
| `APPLE_ID` | your Apple ID email (app-specific password route) |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | your 10-character Team ID |
| `APPLE_API_KEY_P8` | instead of the three above: the whole text of the `.p8` file |
| `APPLE_API_KEY_ID` | its Key ID |
| `APPLE_API_ISSUER` | the Issuer ID |

With `MAC_CSC_LINK` alone the build is signed with your Developer ID and the hardened runtime but not notarized;
add one set of Apple credentials to notarize too. Leave them all out and the build stays ad-hoc, as now. Never put any
of these in the repository, an issue, or a log.

### What signing turns on

`electron-builder.config.cjs` and `scripts/signing.cjs` decide from the environment:

- **Developer ID** (`CSC_LINK` or `CSC_NAME` set, or `DESKMATE_SIGN=1` to let electron-builder find the certificate
  in your keychain): signed with the hardened runtime and `build/entitlements.mac.plist`; every helper inside (the
  Electron helpers and `Resources/bin/deskmate-hands`) gets `build/entitlements.mac.inherit.plist`. Entitlements:
  JIT and unsigned executable memory (V8, WebAssembly), library validation off (electron-builder's default),
  microphone (hands-free talk), Apple Events (Chrome, Spotify, Messages, Notes through AppleScript), Calendars (the
  helper reads events), and the camera explicitly off.
- **Notarized** when the Developer ID is there and one full set of Apple credentials is too (`APPLE_ID` +
  `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_API_KEY` (a path to the `.p8`) + `APPLE_API_KEY_ID` +
  `APPLE_API_ISSUER`, or `APPLE_KEYCHAIN_PROFILE`). electron-builder submits with `notarytool` and staples the ticket.
- **Ad-hoc** otherwise (`identity: "-"`, no hardened runtime, which would refuse the ad-hoc signed Electron framework).

Locally, the same variables work:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"   # a certificate already in your keychain
export APPLE_ID=you@example.com APPLE_TEAM_ID=TEAMID
export APPLE_APP_SPECIFIC_PASSWORD=…                              # from account.apple.com, never committed
npm run dist:mac
```

Check the result:

```bash
codesign --verify --deep --strict --verbose=2 release/mac-universal/Deskmate.app
codesign -dv --entitlements - release/mac-universal/Deskmate.app/Contents/Resources/bin/deskmate-hands
spctl --assess --type execute --verbose release/mac-universal/Deskmate.app   # "accepted, source=Notarized Developer ID"
xcrun stapler validate release/Deskmate-*-mac-universal.dmg
```

### Windows signing (optional)

Add `WIN_CSC_LINK` (a base64 `.pfx` from a code-signing certificate vendor) and `WIN_CSC_KEY_PASSWORD`. Without them
the Windows build is unsigned and SmartScreen warns, as now.

## Updates

The app reads `app-update.yml` (made from the `publish` block of the build config) and asks GitHub Releases.

| Copy | What happens |
|---|---|
| Developer ID signed Mac build | downloads the new release in the background, installs it on quit; tray → **Restart to update** |
| Ad-hoc / unsigned Mac build | tray → **Update available** opens the release page (macOS will not install unsigned updates) |
| Windows installer, AppImage | update themselves, like a signed Mac build |
| Portable exe, .deb, a checkout | tray item to the release page |

A release candidate also sees newer release candidates; a release only sees releases. Drafts are never seen, so
nobody gets a build before you press Publish. `DESKMATE_UPDATE_CHECK=0` turns all of it off;
`DESKMATE_UPDATE_AUTO=0` keeps the check but never downloads.

The first signed release cannot reach people on an unsigned build automatically: they download it once by hand
(the tray item takes them there), and from then on it updates itself.

## Before pressing Publish

On a Mac that has never run Deskmate (or a new macOS user account):

- [ ] The DMG opens, Deskmate drags to Applications and starts (after Open Anyway, if not notarized).
- [ ] The tour opens. A brain works (an Ollama model is enough), a character can be picked, "Install the voice" runs
      to the end (or explains what is missing), and the permission rows change as you switch them on in System
      Settings.
- [ ] "Try me" answers. "Remind me in 1 minute to stretch" rings.
- [ ] App control works after Accessibility is on ("make a note saying test" in Notes).
- [ ] Tray → Welcome tour… opens it again. Quit works.
- [ ] The notes on the draft read well; the files are all there (DMG, zip, `latest-mac.yml`, the exe files,
      `latest.yml`, AppImage, deb, `latest-linux.yml`).

Then Publish, update the tap, and post the announcement.
