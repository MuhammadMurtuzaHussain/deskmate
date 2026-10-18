# Talk to her, and let her put Claude to work

Deskmate 0.4 has ears and hands. Ears: a local Whisper model turns what you say into text, so you can talk to her and she talks back. Hands: when you ask her to get something done, she gives the job to **Claude Code**, the coding agent you already have on your computer, in the project folder you mean, and tells you in her own voice when it is finished.

Her brain is still Gemini or your local Ollama model. Claude is the tool she picks up when you ask for real work.

## Ears: speech to speech

1. Set up the local voice server once (it does both speaking and listening):
   ```bash
   brew install espeak-ng      # macOS; apt install espeak-ng on Linux
   tts-local/setup.sh          # Kokoro (~330 MB) and Whisper small.en (~480 MB)
   ```
2. In `.env`: `DESKMATE_TTS=local` (listening is on by default when the local voice is on; `DESKMATE_STT=off` turns it off).
3. Press **⌘⇧Space** (Ctrl+Shift+Space on Windows/Linux), or click **mic** in her panel, or pick **Listen hands-free** in the tray menu. macOS asks for the microphone the first time.

Then just talk. She listens for a pause, transcribes the sentence on your machine, and answers out loud. Talk over her and she stops mid-sentence and listens to you instead (barge-in): echo cancellation keeps her own voice out of the mic, and only a voice that stays well above what is left of it for about half a second counts. The status row shows what she heard (`you: …`), so a mis-hearing is easy to spot.

- `DESKMATE_STT_MODEL` picks the Whisper size: `base.en` is lighter, `small.en` (default) hears well, `small` or `medium` for other languages.
- `DESKMATE_BARGE_IN=0` closes the mic while she talks, as earlier versions did, if your speakers are loud enough for her to trigger herself. The dev log prints one `[mic] while she talked` line per line of hers with her measured echo and the bar it had to clear, so you can see how much room there is.
- Nothing you say leaves the computer. Whisper runs on the CPU through faster-whisper; a sentence takes about a second on an Apple Silicon Mac.

### Wake word

`DESKMATE_WAKE_MODE=word` makes her a hands-free assistant. Her ears are on from launch, and she answers only when a sentence starts or ends with her name: "Mika, what's on this page", "what do you think, Mika?". Say just "Mika?" and she comes back with a quick "yes?" (a canned line, no model call) and listens for your question for about eight seconds; anything you say while interrupting her is for her too. After an answer the next sentence needs her name again, so a video or a call in the room does not get answered. Whisper's spelling of her name is matched loosely (Mica, Meeka and Mikah all wake Mika; a one-syllable name that is also a word, like Ani, will wake on "any" too). To keep always-on listening cheap, a long sentence that does not start with her name is only transcribed for its first few seconds. The shortcut, the **mic** button and the tray item mute and unmute her ears.

`DESKMATE_WAKE_NAME=1` is the older switch: the same name gate, with listening still started by hand.

## Claude brain and the agent on your Mac

Pick **Claude** in the setup window (menu-bar icon → Setup…), paste an Anthropic API key, and choose a model from the list your key can use. Claude Opus 5.5 is the default and the most dependable at multi-step work; Claude Sonnet 5.5 and Claude Haiku 5.5 answer faster and cost less. Or in `.env`: `DESKMATE_BRAIN=anthropic`, `ANTHROPIC_API_KEY=…`, `ANTHROPIC_MODEL=claude-opus-5-5`, `ANTHROPIC_EFFORT=low` (low, the default, is quickest and cheapest; medium and high think harder). Once you pick a brain in the setup window, that choice wins over `.env`. Usage is billed to your Anthropic account (an API key is separate from a Claude.ai subscription).

With Claude as her brain:

- **Chat** uses the same reply format as the other brains (structured output), sees your screen when you ask about it, and keeps her persona cached between turns so replies stay quick and cheap. Requests Anthropic's safety filters decline are retried on the model Anthropic recommends (server-side fallback, on the models that support it). If Claude is rate limited or unreachable and Ollama is running, the local model answers instead.
- **The agent.** For anything that takes several steps across apps, she hands the goal to Claude with her hands as tools: open an app by name, read its front window as numbered elements plus its text, click an element, type into a field, press keys and shortcuts, pick a menu item, read the window's text with OCR and click on text (for canvas apps, games and web views that accessibility cannot describe), take a screenshot, paste a picture of her, open or read a web page, the Discord/Slack/Messages/Claude-app routines, and a yes/no question to you. Claude works in a loop (look, act, look again to check) for up to `DESKMATE_AGENT_STEPS` (25) rounds, and she says what happened. Say it, type it, or `/computer <goal>` (also `/agent`).

The rules live in the tools, so the model cannot talk its way past them:

- Keys, clicks and typing only go to the app the agent last looked at; if you switch apps, the next step is refused and it has to look again.
- Password managers, Keychain, System Settings and terminals are off limits, and so is Deskmate itself.
- Clicking anything labelled send, post, delete, buy, pay, confirm, share (and similar), choosing such a menu item, and pressing Return in a messaging app (Discord, Slack, Messages, WhatsApp, Telegram, Mail, Teams, Signal) all wait for your yes.
- It never types passwords or card numbers, and never into a password field.
- Spoken goals are read back before the run starts (`DESKMATE_CONFIRM_JOBS`). "Stop" ends a run at the next step.
- Every run is logged in `<user data>/tasks/computer-*.log`.

## Hands: jobs for Claude Code

You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude` once in a terminal, then `/login`). Deskmate finds it on PATH or in the usual install folders; `DESKMATE_CLAUDE_BIN` points at it otherwise. The tray menu shows **Claude works in: …** when she has found it.

### What you can say

| you say | she does |
|---|---|
| "ask Claude to fix the failing tests in deskmate" | starts a Claude Code job in the deskmate folder |
| "tell Claude to trim the intro of the China vlog to ten seconds" | finds the folder from the name you used |
| "resume the vlog edit" / "ask Claude to continue in deskmate" | continues the most recent Claude session in that folder, or the job she started there |
| "continue the vlog edit, then export it as mp4" | resumes with a new instruction |
| "how's Claude doing" / "is Claude done" | reads the status of her jobs |
| "stop the task" | kills the running job |
| "open github.com" / "open the vlog folder" / "open Spotify" | opens a site, a project folder or an app |

Typed commands work too: `/claude <job>`, `/resume [folder]`, `/tasks`, `/cancel`, `/open <thing>`. Everything that is not a command goes to her brain, which may still decide a tool is called for ("can you get someone to fix this build?" → she asks Claude).

### Which folder

- The folder you name ("in the vlog", "in deskmate", "for my website") wins. Deskmate knows every folder you have used Claude Code in (it reads the folder names under `~/.claude/projects`, nothing inside them), plus `DESKMATE_PROJECTS` (`name=path;name=path`) and `<user data>/projects.json` (`{"vlog": "~/Movies/vlog"}`).
- Otherwise the folder picked under **Claude works in** in the tray menu, or `DESKMATE_WORKDIR`.
- If she cannot tell, she asks.

### Before a job starts

A sentence she misheard must never start a job. For spoken requests she reads the job back ("Send this to Claude in China Vlog: trim the intro to ten seconds?") and waits for a yes. Typed requests run at once. `DESKMATE_CONFIRM_JOBS=always|voice|never` changes that.

### What Claude may do

Jobs run with `claude -p … --permission-mode acceptEdits`: Claude can read and edit files inside the project folder and run the commands its allow list already permits; anything else is refused because there is nobody at the keyboard to approve it. If you want a job to run shell commands freely, set `DESKMATE_CLAUDE_PERMISSION_MODE=bypassPermissions`, knowing what that means. `DESKMATE_CLAUDE_MAX_TURNS` caps how long a job may go; `DESKMATE_CLAUDE_MODEL` picks a cheaper model; `DESKMATE_CLAUDE_ARGS` passes anything else to the CLI.

### While it runs and after

The status row follows the job (`Claude · trim the intro · Edit cut.py`). When it ends she tells you what Claude said, in her words but with the facts intact, and the full transcript of the run is one click away under **Claude jobs** in the tray menu (also in `<user data>/tasks/`). One job per folder at a time; "how's Claude doing" and "stop the task" work any time. Jobs use your Claude Code login, so they count against your Claude plan like any other Claude Code session.

### Resuming

"Resume", "continue", "pick it up" in a folder reuses the Claude session she started there, or the most recent Claude Code conversation in that folder if she has none (`claude --continue`), so a job you began yourself in a terminal can be carried on by voice.

## Browser: she drives your Chrome

On macOS she works inside the Chrome you already have open, logged in as you, through AppleScript. No second browser, no separate profile. Two one-time things:

1. The first time, macOS asks whether Deskmate may control Google Chrome. Say yes (System Settings → Privacy & Security → Automation if you change your mind).
2. In Chrome: **View → Developer → Allow JavaScript from Apple Events.** Tabs, URLs and navigation work without it; reading the page, clicking and typing need it. She tells you if it is off.

`DESKMATE_BROWSER_APP=Brave Browser` (or Microsoft Edge) switches browsers; they speak the same dictionary. Windows and Linux are not covered yet; there, "ask Claude to …" with `DESKMATE_CLAUDE_ARGS=--chrome` hands browsing to Claude Code's own Chrome integration.

### Quick verbs (no thinking, instant)

| you say | she does |
|---|---|
| "what's on this page" / "summarize this tab" / "is there a price on this page" | reads the page text and answers from it |
| "find 'refund policy' on this page" | Chrome's find, scrolled to the match |
| "search for Dublin weather" / "google three-vrm docs" | opens the search in a new tab |
| "next tab" / "previous tab" / "close this tab" / "go back" / "reload" / "scroll down" | exactly that |
| "click sign in" / "press the blue button" | clicks the first visible link or button with that label |
| "open github.com" / "open youtube" | opens the site (or a matching app) |

### Browsing goals (she thinks)

"Look up the cheapest flight to Lisbon next Friday", "find out when the Dublin Marathon is", "in Chrome, open my GitHub notifications and tell me what's new", `/browse <goal>`. Her brain runs a short look-decide-act loop in the active tab: each step it sees the page text and the numbered links, buttons and fields, picks one action (search, open, click, type, scroll, back) and repeats, up to `DESKMATE_BROWSE_STEPS` (12). At the end she tells you what she found, with the facts kept exact, and the status row shows each step while it runs. Say "stop" to cut it short.

Rules she keeps regardless of what the page says: never type passwords, card numbers or personal data; anything that buys, pays, sends, posts, deletes or signs is read back to you first and waits for a yes, as are clicks and typing on checkout or payment pages. A local 8B model handles simple goals (search, open the right result, read off an answer); Gemini is noticeably better at longer ones. For heavy browsing jobs, "ask Claude to …" with `--chrome` in `DESKMATE_CLAUDE_ARGS` uses Claude Code's Chrome extension instead.

The log of every browsing run is in `<user data>/tasks/`.

## Apps: Discord, Slack and the Claude app (macOS)

She can work the desktop apps you already use, logged in as you, even when they are closed: she opens them, finds the chat, and types for you.

| you say | she does |
|---|---|
| "tell sam on Discord that I'm running late" | opens Discord, jumps to sam, reads it back, sends on your yes |
| "message #general in Slack: standup moved to 11" | the same in Slack |
| "go to #gaming on Discord" / "open my DMs with ana in Slack" | just takes you there |
| "open Claude and ask it to draft a cover letter" / "ask the Claude app what a monad is" | new chat in the Claude desktop app, prompt typed and sent |

Typed shortcuts: `/discord sam: running late`, `/slack #general`, `/app <anything>`. Other phrasings go to her brain, which hands them over ("let ana know on slack the deploy is done").

"Ask Claude to …" is still a Claude Code job in a project folder; "the Claude app", "open Claude and ask …" is the chat app.

### Messages (iMessage) and Spotify

| you say | she does |
|---|---|
| "text Note Pad that I'm on my way" / "message mum on imessage saying see you at 8" | finds the chat by the person's name (or the group's), reads it back, sends on your yes |
| "…, and send a photo of yourself" | adds a picture of her (also works on Discord and Slack: it goes in as an attachment) |
| "pause the music" / "skip this song" / "previous track" / "what's playing" | Spotify, at once |
| "play bohemian rhapsody on spotify" | with Claude as her brain the agent finds and plays it; otherwise she opens Spotify's search for it |
| "take a selfie" / `/selfie` | copies a picture of her to the clipboard (and saves it in Pictures › Deskmate) to paste anywhere |

Messages and Spotify are driven through their own scripting, not by typing into their windows, so nothing shows up as "typing…" for the other person. The first time, macOS asks whether Deskmate (Electron when run from source) may control Messages / Spotify: say yes (System Settings → Privacy & Security → Automation if you change your mind). If two chats match equally ("sam" with two Sams), she asks which one instead of guessing.

### One-time setup

**Accessibility** for whatever runs her: Deskmate when installed, or Electron / your terminal app when you run `npm run dev`. The first time you ask, she opens System Settings → Privacy & Security → Accessibility; switch it on and ask again. The tray menu shows **Let her use your apps (Accessibility)…** until it is on. The helper that presses the keys is a small Swift program, `native/bin/deskmate-hands`, built by `npm run dev` / `npm run build` (needs the Xcode command line tools: `xcode-select --install`).

### How she does it, and what keeps it safe

Each app has a fixed routine; no model is in the loop while keys are pressed:

1. Opens or brings the app forward (`open -b`, so it also works when the app is closed or hidden in the tray) and waits for its window.
2. ⌘K (Discord's Quick Switcher, Slack's Jump to), types the name, and checks the search box shows it before pressing Enter.
3. **Reads the window title back.** If it does not show the chat you named ("#general", "sam"), she backs out and tells you what she saw instead. Nothing is typed into the wrong chat.
4. **Reads the message back and waits for your yes** (`DESKMATE_CONFIRM_SENDS`, default always). After the yes she checks the app is still on that chat.
5. Pastes the text into the message box (clipboard restored afterwards), checks it landed in the box, presses Enter, and checks the box emptied.

Keys only ever go to the app she is working in: if you switch apps while she works, she stops before the next key. ⌘Q, ⌘Tab and ⌘Space are never sent. Say "stop" to cut a run short. Every run is logged in `<user data>/tasks/app-*.log`.

For the Claude app she switches to its chat side (Go › Claude) before New Chat, so a prompt never lands in a Code session. Prompts follow `DESKMATE_CONFIRM_JOBS` (read back when spoken).

Not yet: reading replies back to you, WhatsApp / Telegram / other apps, Windows and Linux.

## Privacy

Speech recognition and her brain (with Ollama) stay on your machine. What she reads in Chrome goes to the brain you chose (local Ollama: nowhere; Gemini: Google), nothing else. In Discord, Slack and the Claude app she reads only window titles and the text box she types into, and sends nothing to her brain from them; your request itself goes to the brain only when its wording needs a model to understand. A job sends your instruction, and whatever Claude Code reads in that folder, to Anthropic, exactly as running `claude` there yourself would.
