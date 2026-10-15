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

Then just talk. She listens for a pause, transcribes the sentence on your machine, and answers out loud. While she is speaking the mic is closed, so she never answers herself. The status row shows what she heard (`you: …`), so a mis-hearing is easy to spot.

- `DESKMATE_WAKE_NAME=1` makes her ignore anything that does not contain her name, for a noisy room or a call.
- `DESKMATE_STT_MODEL` picks the Whisper size: `base.en` is lighter, `small.en` (default) hears well, `small` or `medium` for other languages.
- Nothing you say leaves the computer. Whisper runs on the CPU through faster-whisper; a sentence takes about a second on an Apple Silicon Mac.

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

## Privacy

Speech recognition and her brain (with Ollama) stay on your machine. A job sends your instruction, and whatever Claude Code reads in that folder, to Anthropic, exactly as running `claude` there yourself would.
