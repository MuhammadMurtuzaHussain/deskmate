# Contributing to Deskmate

Thanks for helping. Bug reports, skills, characters' docs, fixes and features are all welcome. Small pull requests
with a clear "why" get merged fastest; for something big, open an issue first so we can agree on the shape.

## Dev setup

You need Node 22 or newer and npm. On macOS, the Xcode command line tools (`xcode-select --install`) for the Swift
hands helper; Windows and Linux build without it.

```bash
git clone https://github.com/MuhammadMurtuzaHussain/deskmate.git
cd deskmate
npm install
cp .env.example .env     # optional
npm run dev              # her window, with the renderer hot-reloading
```

| command | |
|---|---|
| `npm test` | unit tests (Node's test runner straight on the `.ts` files; no Electron needed) |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm run eval` | the agent eval: 32 requests against fake hands, replaying recorded answers (`-- --live` calls the API and re-records; needs `ANTHROPIC_API_KEY`) |
| `npm run build` | the hands helper (macOS) and the app into `out/` |
| `npm start` | runs the built app |
| `npm run dist` | installers for your OS into `release/` |

CI runs typecheck and tests on macOS, Windows and Ubuntu for every pull request.

## Testing with your own instance

If you also use Deskmate day to day, run a second, separate copy for testing so it doesn't touch your real one:

```bash
npm run build
npx electron . --mute-audio --user-data-dir=/tmp/deskmate-test --remote-debugging-port=9461
```

- `--user-data-dir` gives it its own settings, memory, plans, skills and logs. Put a `settings.json` there with
  `{"setupDone": true}` to skip the setup window, and `.env` lines to set the brain.
- `--mute-audio` keeps it silent. `DESKMATE_TTS_AUTOSTART=0` stops it starting a second voice server.
- Set `DESKMATE_COMMAND_SHORTCUT` and `DESKMATE_LISTEN_SHORTCUT` to something unused so the two copies don't fight
  over ⌥Space.
- `DESKMATE_IDLE_TOUCHES=0 DESKMATE_CURSOR_PLAY=0 DESKMATE_IDLE_MOVES=0` keep her still while you take screenshots.
- `--remote-debugging-port` lets you drive her renderer over the Chrome DevTools Protocol, e.g.
  `window.deskmate.send('remind me in 1 minute to stretch')`.
- Stop it by killing that process only; never `killall Electron`, which takes the real one with it.
- Prefer a built copy (`npm run build`) over a second `npm run dev` from the same `node_modules`: two Vite dev
  servers re-optimizing the same dependency cache can break each other.

Anything that sends a message: test with a chat to yourself (WhatsApp's "Message yourself", Telegram's Saved
Messages, a Discord server of your own), never with other people.

Changed a tool description, the agent rules or the shortcuts? Run `npm run eval` (and `-- --live` if you have a key)
and say in the pull request how the score moved.

## Writing a skill

The quickest way to add something she can do. A skill is a folder with a `skill.json`:

1. Copy `skills/notes-new-note/` into your skills folder (tray → **Skills** → **Open my skills folder**) and rename it.
2. Set `name`, `app.bundleId` (`osascript -e 'id of app "Name"'`), the slots and the trigger phrases.
3. Write the steps from the app's own menus and shortcuts (the menu bar's items are the most stable thing to drive).
4. Tray → **Skills** → **Reload skills**, and check the log line.
5. Try it on something harmless; each run logs every step to `<user data>/tasks/skill-<name>-….log`.

The format, the trigger language and the send rules: [docs/SKILLS.md](docs/SKILLS.md).

To contribute a skill to the repository, put it under `skills/<name>/` and add a test to `test/skills.test.ts` that
runs it against the fake hands there: check the keys it presses, the app they go to, and that nothing is sent on a
"no". Say in the pull request which app version you tried it with. Handlers (code) are fine for bundled skills but
keep them small; most things fit in steps.

## Code layout

| | |
|---|---|
| `src/main/index.ts` | the app: windows, tray, routing what you say to tools, plans, notices |
| `src/main/brain.ts` | the brains (Ollama, Gemini, Claude) and her reply format |
| `src/main/core.ts` | the agent core: one Claude tool-use loop over every worker, with the injection guard |
| `src/main/tools.ts` | every worker as a tool (schemas, risk classes) and the `WorkerHost` interface |
| `src/main/fastpath.ts` | the regex shortcuts that skip the model, mapped onto the same tools |
| `src/main/untrusted.ts` | wrapping text from screens, pages, messages and MCP as data; the per-turn taint |
| `src/main/mcp.ts` | the MCP client (`mcp.json`, stdio and streamable HTTP) |
| `src/main/hands.ts` | the macOS hands helper client, and the `DesktopHands` interface |
| `src/main/hands-win.ts` | the experimental Windows hands (PowerShell + UI Automation) |
| `src/main/checks.ts` | the safety lists and checks shared by everything that acts |
| `src/main/apps.ts` | built-in routines: Discord, Slack, Messages, Spotify, the Claude app |
| `src/main/skills.ts` | skills: loading, triggers, the step runner and its rules |
| `src/main/computer.ts` | the Claude agent that works any app |
| `src/main/browse.ts`, `chrome.ts` | the Chrome agent |
| `src/main/plan.ts` | plans and the planner prompt |
| `src/main/agent.ts` | Claude Code jobs |
| `src/main/remote.ts` | the Telegram phone remote |
| `src/main/body.ts` | her body on the desktop |
| `src/renderer/` | her window (Live2D / VRM / MMD), the command bar, the plan card, setup |
| `native/` | the Swift hands helper |
| `skills/` | bundled skills |
| `test/` | unit tests; `test/evals/` the agent eval (tasks, fake hands, recordings) |

Pure logic goes in modules the tests can import without Electron (see `checks.ts`, `skills.ts`, `reminders.ts`).
Node runs the tests on the `.ts` files directly, so those modules import other modules with the `.ts` extension and
avoid TypeScript-only syntax such as constructor parameter properties.

## Style

- TypeScript, strict. Match the code around you: short functions, comments that say why.
- Her lines are plain and short: no markdown, exact names and numbers, and she says plainly when she stopped and why.
- Anything that acts on the computer goes through the checks in `checks.ts` and asks before sending, posting,
  deleting or paying. A pull request that weakens a rule in [SECURITY.md](SECURITY.md) needs a very good reason.
- No new dependencies without a word in the issue first; the app should stay small and work offline.
- Update the docs and the CHANGELOG's "Unreleased" section with user-facing changes.

## Characters and assets

Don't add models, voices or clips you don't have the rights to share. The bundled characters are CC0 or under the
Live2D Free Material License; screenshots in `docs/` use only those.

## Code of conduct

Everyone in the project's spaces follows the [Code of Conduct](CODE_OF_CONDUCT.md).
