# Launch plan

Working notes for the open-source launch: "an agent with a face". Nothing here is published yet; the decisions are
yours. The code keeps the name **Deskmate** until you pick one.

## 1. Name and tagline

What the name has to do: say "agent" and "character" at once, be searchable, not collide with a companion app people
already know, and survive as a GitHub repo, a domain and a menu-bar app name. Availability below is **not checked**:
before deciding, search GitHub, npm, the App Store, Steam, the domain, and the USPTO / EUIPO trademark databases.

| | name | tagline | for | against |
|---|---|---|---|---|
| 1 | **Deskmate** (keep) | "An agent with a face." | No rename; already in the code, the bundle id, the releases and the docs. Says "on your desk" and "friend". | Very close to **Desktop Mate**, a commercial desktop companion on Steam, which is the exact category people will compare with; a generic word, hard to own in search. |
| 2 | **Familiar** | "Your computer's familiar: an agent with a face." | A witch's familiar is a companion spirit that runs errands: exactly the product. Distinctive in AI tooling, memorable, a story to tell. | Also an ordinary adjective, so searches need "Familiar app" / "familiar agent"; check for existing apps. |
| 3 | **Tomo** | "A friend on your desktop who gets things done." | Japanese for "friend", short, fits the anime-style characters, easy to say to her ("Tomo, …" works as a wake word). | Several apps already use it; leans into the anime framing, which may narrow the audience. |
| 4 | **Facet** | "The agent with a face." | Puns on "face", reads as a serious tool, good for the developer audience that compares it with OpenClaw and Hermes. | Abstract; says little about the companion side; common word in software (search facets). |
| 5 | **Sidekick** (or **Deskkick**) | "The sidekick that actually does the work." | Instantly understood, friendly, describes the relationship. | Heavily used by other products; the most likely of these to have trademark trouble. |

My pick: keep **Deskmate** for the launch if a quick check finds no trademark problem with "Desktop Mate" in your
markets (the rename costs a lot and the repo already has history), and lead every post with the tagline "an agent
with a face" so it carries the positioning. If the check is not clean, **Familiar** is the strongest alternative.

Taglines that work with any name:

- "An agent with a face."
- "The AI agent that lives on your desktop."
- "She works your apps. She asks before she sends."
- "Talk to your computer. Someone talks back, and gets it done."

A rename touches: `package.json` (`name`, `productName`, `build.appId`, artifact names), the tray and window titles
in `src/main/index.ts`, `SELF_IDS`, the user-data folder name (move existing data or users lose settings and
memory), docs, the landing page, and the repository name (GitHub redirects the old URL).

## 2. Launch checklist

**Code and release**

- [ ] Merge phases 6–10 into `main` in order; CI green on macOS, Windows and Ubuntu.
- [ ] Decide the launch version (the code says 0.6.0; a launch is a good moment for 0.7.0 or 1.0.0) and move the
      CHANGELOG's "Unreleased" section under it.
- [ ] Sign and notarize the macOS builds (section 4). Unsigned builds still work, but "right-click → Open" loses
      people at the first step.
- [ ] Fresh-install test on a clean Mac user account: setup window, each permission prompt, a reminder, a Discord
      message to yourself, a plan, a Claude Code job, a skill.
- [ ] Try the bundled WhatsApp and Telegram skills on your own Mac, each with a chat to yourself (WhatsApp "Message
      yourself", Telegram Saved Messages), and fix any step the current app versions need. They were written from
      the apps' menus and tested against fake hands only.
- [ ] Windows: install the build on a real PC and try the experimental hands (a Discord message to yourself, the
      Notes-like flow in Notepad), or ask for testers in the launch post.
- [ ] Scan the history for secrets before the repo gets attention: `gitleaks detect` (or GitHub secret scanning).
- [ ] The two removed screenshots of a private model (`docs/screenshot-jian-*.png`) are still in git history. If its
      licence doesn't allow sharing, rewrite history with `git filter-repo --path-glob 'docs/screenshot-jian-*'
      --invert-paths` before making the repo widely known (this changes every commit id).

**Repository**

- [ ] Description: "An agent with a face: an open-source AI agent that lives on your desktop as a Live2D or 3D
      character." Website: the landing page. Topics: `ai-agent`, `desktop-agent`, `ai-companion`, `live2d`, `vrm`,
      `electron`, `ollama`, `claude`, `macos`, `local-llm`.
- [ ] Social preview image (Settings → General): a 1280×640 crop of `docs/hero.png`.
- [ ] Turn on Discussions (the issue template links to it) and private vulnerability reporting (Security → Settings).
- [ ] Labels: `bug`, `enhancement`, `skill`, `good first issue`, `help wanted`, `windows`.
- [ ] Seed 5–8 `good first issue`s, mostly skills: Signal, Mail, Microsoft Teams, Things, Obsidian, Spotify playlists,
      Windows Notepad. Skills are the easiest way in for new contributors.
- [ ] Pin an issue "Windows testers wanted".

**Landing page**

- [ ] Serve `docs/site/` with GitHub Pages (Settings → Pages → deploy from a branch, `main` / `docs`, then the page is
      at `/site/`; or a small Pages workflow that publishes `docs/site` as the root). It needs the images beside it:
      it uses `../hero.png` etc., so publish `docs/` or copy the images in.
- [ ] Optional custom domain; the page has no analytics and no external requests.

**Posts** (one day, morning US Eastern, Tuesday to Thursday; be around all day to answer)

- [ ] Show HN: "Show HN: Deskmate – an open-source AI agent with a face that lives on your desktop". First comment:
      why a face, the safety model, what's local, what's rough (Windows experimental, unsigned if so).
- [ ] r/LocalLLaMA (lead with fully local: Ollama + Kokoro + Whisper), r/macapps, r/ClaudeAI (Claude Code jobs and
      the agent), r/vtubers or r/VRoid (characters).
- [ ] X / Bluesky / Mastodon thread with the demo video; tag the Live2D, VRoid, Ollama and Kokoro communities.
- [ ] DEV / a blog post: "Building an agent with a face" (the reverse-engineering story is good material).
- [ ] Product Hunt a week later, with the video and the first round of fixes.

**After**

- [ ] Triage issues daily for the first two weeks; label skill requests and point them to docs/SKILLS.md.
- [ ] A 0.x.1 within a week with the first fixes; thank reporters in the CHANGELOG.

## 3. Demo video shot list

60–90 seconds, 1080p or 4K, screen recording plus voice-over or captions (many people watch muted). Record on a
clean desktop with notifications off, a test user account, test chats with yourself, and only the bundled CC0 /
free-sample characters. Never show real people's names or messages.

| # | length | shot | on screen | caption / voice-over |
|---|---|---|---|---|
| 1 | 4 s | Cold open | An empty desktop. Victoria walks over from her corner ("come here"). | "This is Deskmate." |
| 2 | 6 s | Talk | You say "hey Victoria, what's on my calendar today?"; she answers with a bubble, lip-synced. | "An AI agent with a face." |
| 3 | 12 s | App routine | "Tell Sam on Discord I'm running late." Discord opens, the chat is found, the read-back bubble "Send … to Sam?", you say yes, it sends. (Sam is your own second account.) | "She works your apps, and asks before anything goes out." |
| 4 | 15 s | Plan | ⌥Space, "get ready for my 3pm demo: run the tests, find the slides, tell the team on WhatsApp". The plan card appears; "go"; steps tick off; she pauses at the WhatsApp read-back. | "Bigger jobs become a plan you can see and change." |
| 5 | 10 s | Claude Code | "Ask Claude to fix the failing test in deskmate." While it runs she gets bored, sits on the terminal and dozes; the job ends; she wakes: "Okay, back to work. All tests pass." | "She hands code to Claude Code and tells you when it's done." |
| 6 | 8 s | Body | "Where's my resume?" She walks over to Finder and points at the file. A quick sit-on-window, and a swat at the cursor. | "She lives on your desktop." |
| 7 | 8 s | Phone | On a phone: Telegram, "what's on my screen?", her answer, a Yes / No button for a send. | "Text her from anywhere." |
| 8 | 10 s | Skills | The editor with `skill.json`; tray → Reload skills; "make a note saying buy milk"; Notes gets the note. | "Teach her a new app with a small JSON file." |
| 9 | 5 s | Characters | The picker; switch Victoria → Mika (Live2D). | "Live2D, VRM, MMD, or your own." |
| 10 | 6 s | Outro | Her waving beside the repo URL and "MIT · runs fully local". | "Open source. Free. Local first." |

B-roll worth having: the local stack running offline (Wi-Fi off), the safety refusal ("You switched apps, so I
stopped"), the setup window.

## 4. Signing and notarization (macOS)

These need your own Apple developer account and can't be done from the repository. Without them the app runs, but
Gatekeeper warns and every user has to right-click → Open.

**One-time setup**

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) (individual, yearly fee).
2. Create a **Developer ID Application** certificate: Xcode → Settings → Accounts → your team → Manage Certificates →
   + → Developer ID Application. (Or create a CSR in Keychain Access and upload it at developer.apple.com →
   Certificates.)
3. Export it with its private key from Keychain Access as a `.p12` with a strong password.
4. For notarization, create an **App Store Connect API key** (App Store Connect → Users and Access → Integrations →
   App Store Connect API, role Developer). Download the `.p8` and note the Key ID and Issuer ID. (An Apple ID with an
   app-specific password from appleid.apple.com also works.)
5. Note your Team ID (developer.apple.com → Membership).

**Config changes** (one pull request when you have the certificate)

`build/entitlements.mac.plist`: what the hardened runtime must allow:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.automation.apple-events</key><true/>
  <key>com.apple.security.personal-information.calendars</key><true/>
</dict>
</plist>
```

Without `automation.apple-events` the hardened runtime silently blocks the Messages, Spotify and Chrome scripting;
without `audio-input` the microphone; without `personal-information.calendars` the calendar.

In `package.json` → `build.mac`:

```json
"hardenedRuntime": true,
"gatekeeperAssess": false,
"entitlements": "build/entitlements.mac.plist",
"entitlementsInherit": "build/entitlements.mac.plist",
"binaries": ["Contents/Resources/bin/deskmate-hands"],
"notarize": true
```

`binaries` makes sure the Swift hands helper is signed with the same identity and runtime; an unsigned helper inside
a signed app fails notarization.

**Signing in the release workflow**

Add repository secrets: `CSC_LINK` (the `.p12`, base64: `base64 -i cert.p12 | pbcopy`), `CSC_KEY_PASSWORD`,
`APPLE_API_KEY` (the `.p8` contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`. In
`.github/workflows/release.yml`, remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"` and pass those secrets as env to the
"Package and publish" step. electron-builder signs, submits to Apple's notary service, waits, and staples the ticket.
(For the API key, write the secret to a file in a step before and point `APPLE_API_KEY` at that path.)

**Check a build**

```bash
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Deskmate.app
codesign -d --entitlements - release/mac-arm64/Deskmate.app
spctl -a -vvv -t install release/mac-arm64/Deskmate.app
xcrun stapler validate release/Deskmate-0.7.0-mac-arm64.dmg
```

`spctl` should say "accepted, source=Notarized Developer ID".

**Tell users upgrading from an unsigned build:** macOS ties Accessibility, Screen Recording and Automation to the
signature, so the first signed version asks for them again. Say so in the release notes, and remove the old
"right-click → Open" and `xattr` lines from the README.

**Windows** (optional): an OV or EV code-signing certificate (or Azure Trusted Signing) removes most SmartScreen
warnings; electron-builder takes it through `CSC_LINK` / `CSC_KEY_PASSWORD` on the Windows runner, or
`win.azureSignOptions`. Unsigned builds still install via "More info → Run anyway".

## 5. Screenshots

`docs/hero.png`, `plan-card.png`, `command-bar.png`, `setup.png` and `characters.png` were taken from a separate, muted
test copy of the app (its own user-data folder, no audio): the plan card is a real plan made by a local model
(qwen2.5:7b through Ollama), left as a draft; Victoria's bubble and the command bar's answer are her real line
about that plan, shown again in the bubble for the shot; Mika's greeting was written for the shot.
The windows were captured on their own with transparent backgrounds and composed onto a plain backdrop and a mock
editor window, so no real desktop shows. Characters: Victoria (VRoid sample, CC0) and Mika (Live2D sample Haru, Live2D
Free Material License).
