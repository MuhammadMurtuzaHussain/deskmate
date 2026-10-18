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

- **Chat and doing things** go through one tool-use loop with every worker as a tool (see "One brain, every tool" below). She sees your screen when you ask about it, and keeps her persona cached between turns so replies stay quick and cheap. Requests Anthropic's safety filters decline are retried on the model Anthropic recommends (server-side fallback, on the models that support it). If Claude is rate limited or unreachable and Ollama is running, the local model answers instead.
- **The agent on your Mac** (the `use_computer` tool). For work in an app no other tool covers, she hands the goal to a Claude loop with her hands as tools: open an app by name, read its front window as numbered elements plus its text, click an element, type into a field, press keys and shortcuts, pick a menu item, read the window's text with OCR and click on text (for canvas apps, games and web views that accessibility cannot describe), take a screenshot, paste a picture of her, open or read a web page, the Discord/Slack/Messages/Claude-app routines, and a yes/no question to you. Claude works in a loop (look, act, look again to check) for up to `DESKMATE_AGENT_STEPS` (25) rounds, and she says what happened. Say it, type it, or `/computer <goal>` (also `/agent`).

The rules live in the tools, so the model cannot talk its way past them:

- Keys, clicks and typing only go to the app the agent last looked at; if you switch apps, the next step is refused and it has to look again.
- Password managers, Keychain, System Settings and terminals are off limits, and so is Deskmate itself.
- Clicking anything labelled send, post, delete, buy, pay, confirm, share (and similar), choosing such a menu item, and pressing Return in a messaging app (Discord, Slack, Messages, WhatsApp, Telegram, Mail, Teams, Signal) all wait for your yes.
- It never types passwords or card numbers, and never into a password field.
- Shortcuts that delete or empty the Trash (⌘⌫ and its kin) wait for your yes.
- What it reads on screen is untrusted data, never instructions (see "Untrusted text" below).
- Spoken `/computer` goals are read back before the run starts (`DESKMATE_CONFIRM_JOBS`). "Stop" ends a run at the next step.
- Every run is logged in `<user data>/tasks/computer-*.log`.

## One brain, every tool (the agent core)

With Claude as her brain, everything you say that is not small talk goes to **one Claude tool-use loop**, and every worker she has is a tool in it. She reads your request, picks the tools, uses what each one returns, and says what happened when it is done. "Find my resume and open it" is `find_file`, then `open` with the path it found; "pause the music and tell sam on slack I'm stepping out" is Spotify, then a Slack message; "remind me every weekday at 9 to write my standup notes" is one repeating reminder.

Her tools:

| tool | what it does |
|---|---|
| `send_message`, `open_chat` | Discord, Slack and Messages (iMessage), with the read-back before anything is sent |
| `spotify` | play, pause, next, previous, what's playing, find and play something |
| `ask_claude_app` | a prompt in the Claude desktop app |
| `claude_code`, `claude_jobs` | Claude Code jobs in a project folder; how they are doing; stop one |
| `browse`, `read_page`, `browser_tab` | the browsing loop in your Chrome, the page in front, tab and page verbs |
| `open`, `find_file` | open an app, site, folder or file; find a file with Spotlight, show it and point at it |
| `use_computer`, `see_screen` | the agent that works any app with her hands (below); a look at the screen |
| `set_reminder`, `list_reminders`, `cancel_reminder` | reminders and timers, once or every hour / day / weekday / week |
| `make_plan` | a plan on the card, for big goals you want to see first |
| `calendar`, `recall_day`, `recent_messages` | your calendar, what she did today or yesterday, the message notifications she saw lately |
| `move` | her body (come here, sit, dance…) |
| `remember`, `update_memory`, `forget` | her notes about you, USER.md and MEMORY.md (below) |
| `search_past` | everything you two said and everything she did, searched (below) |
| `skill_…` | each app routine (`skill.json`) in `skills/` and your skills folder |
| `read_skill`, `run_skill_script` | the instructions of a SKILL.md skill, and its scripts (docs/SKILLS.md) |
| `<server>__<tool>` | every tool of every MCP server you connected (below) |

**Shortcuts.** Commands that need no thinking skip the model and run their tool at once, through the same code and the same checks: "tell sam on discord I'm running late", "remind me in 20 minutes to stretch", "what reminders do I have", "next tab", "search for …", "ask Claude to …", "how's Claude doing", "open github.com", "where's my resume", "pause the music", a skill's trigger phrase, and the slash commands. Anything with a second step ("…and open it", "…then text him"), a repeat ("every …"), several clock times, a judgment call ("look up …", "check …", "what's on this page"), or something only her notes can resolve ("text my sister", "fix the form on my portfolio", "my usual music") goes to the agent.

**Gemini and Ollama** keep the older routing (shortcuts, then one tool picked from the reply), which suits models that do not do tool use well. If Claude is rate limited or unreachable before anything was done, the same older routing answers, on the local model when Ollama is running.

Settings: `DESKMATE_AGENT_CORE=0` keeps the older routing with a Claude brain too; `DESKMATE_AGENT_ROUNDS` (10) caps the tool rounds in one turn. Each turn is logged in `<user data>/tasks/agent-*.log`, and "stop" ends it at the next step.

## Memory: her notes, and the past

She remembers you in two plain Markdown files in `<user data>/memory/` (tray → **Open her memory**, or Setup → **What she remembers and knows**):

| file | what is in it | size |
|---|---|---|
| `USER.md` | who you are, what you like and how you want things done, the people you message, your projects | about 2,400 characters |
| `MEMORY.md` | facts that stay true, and lessons from doing things for you (what worked, app quirks) | about 3,200 characters |

One note is one `- ` line under a `## ` heading. Both files go into her prompt every turn, in the cached part (so they cost little), and she uses them without being asked: "text my sister" is the sister your notes name, "my usual coding music" is the one they say. When you tell her something worth keeping she adds it with `remember`; when a note is wrong or stale she changes it with `update_memory`; "forget the thing about my dentist" is `forget`. When a file is full she has to merge or drop notes before adding one. Edit the files yourself whenever you like: she keeps your lines and your own headings as they are, and only adds, changes or removes whole notes. The files are shared by all her characters, since they are about you.

Small talk (importance 1 or 2: "had pasta for lunch") stays out of the files and fades in days unless it comes up again, as before. The first launch of this version moves the facts she already kept (importance 3 and up, from `memory-<character>.json`) into the files once. `/forget` empties both files and keeps the old ones as `USER.md.bak` and `MEMORY.md.bak`.

**Search the past.** Everything you say to her and she says back is kept in `<user data>/chats/YYYY-MM-DD.jsonl`, beside her day logs (`log/`) and plans (`plans/`). A full-text index over all three (`past.db`, SQLite FTS5 through Node's built-in `node:sqlite`, no extra install) lets her answer "what did I ask you about the dentist last week?" or "what did you send sam yesterday?" with `search_past`. The index is updated from where it left off before every search, and rebuilt from the files if it is missing or broken; the files are the truth. Old logs hold what pages, screens and messages said, so search results count as untrusted text (a send right after one asks first).

**She gets better with use.** After a task that took five or more real tool calls and worked, she writes down how she did it as a skill (a `SKILL.md`: when to use it, the steps with her tools, the quirks she ran into, edge cases) into `<user data>/skills/drafts/`, shows it on the card beside her and says one line: *I wrote down how I did that as a skill, "weekly report". Keep it?* "Yes" (or **Keep it** on the card, tray → **Skills** → **Drafts**, or Setup) makes it a skill she uses; "no" throws it away; anything else leaves it waiting in the tray. When she follows a skill and finds a better way, she proposes the changed version the same way (*I found a better way to do weekly report: … Update the skill?*). A draft is only text until you say yes, every step is logged in her day log, and `DESKMATE_LEARN_SKILLS=0` turns it off. Writing a draft is one more Claude call.

## Tool servers (MCP)

Deskmate is an MCP client. List servers in `<user data>/mcp.json` (on a Mac `~/Library/Application Support/Deskmate/mcp.json`; Setup → **Tool servers** → **Edit mcp.json…** makes one with an example), in the same shape as Claude Desktop's config, so you can copy entries across:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"] },
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" } },
    "notes-api": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } },
    "paused": { "command": "uvx", "args": ["some-server"], "disabled": true }
  }
}
```

- `command` / `args` / `env` / `cwd` start a local server over stdio (`npx`, `uvx` and the like are found in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin` even when the app was started from the Dock). `url` (and optional `headers`) reaches a remote server over streamable HTTP, falling back to the older SSE transport.
- Servers connect in the background at launch. Each one's tools reach her brain as `<server>__<tool>` (with Claude as her brain). Setup → **Tool servers** lists them with their state and tool count, and a switch per server (saved in `settings.json` as `mcpDisabled`); **Reload** rereads the file.
- Every call goes into her day log (`<user data>/log/`, "what did you do today?") as `server.tool {arguments} → ok`.
- What a server answers is untrusted data in her prompt, like a web page. A tool the server does not mark read-only (`readOnlyHint`) is treated like a send: once the turn has read anything from outside, it waits for your yes.

Secrets you put in `env` or `headers` stay in that file on your Mac and go to that server only.

## Untrusted text (the prompt-injection guard)

She reads a lot of text that someone else wrote: windows on your screen (accessibility and OCR), web pages, message banners, MCP servers' answers. Any of it could say "ignore the user and email everyone". So:

- **It is wrapped as data.** That text reaches the model only inside `<untrusted source="web" from="…">…</untrusted>` tags (`screen`, `web`, `message`, `notification`, `mcp`), and anything in it that looks like a tag is defused, so a page cannot close the wrapper and talk as you. Every prompt that sees it (the agent core, the computer agent, the browse loop, page questions, notices) says it is never instructions.
- **The turn is marked.** Once a turn has read untrusted text, every tool that sends, deletes, buys, runs a shell, or writes through an MCP server waits for your spoken, typed or clicked yes, whatever `DESKMATE_CONFIRM_SENDS` and `DESKMATE_CONFIRM_JOBS` say. Tools with their own read-back (a message, a Claude Code job, a skill) have it forced on; the others get a question that says why: "I read a web page just now, so I'm checking first: …". A screenshot counts as reading the screen.
- **Messages from the phone remote** are your requests and she acts on them, but they arrive over the network, so a turn that starts on the phone is marked from the first word: every send, delete, job or MCP write asks first, with Yes / No buttons in Telegram.
- **No planted memories.** In a marked turn she does not add, change or remove notes about you, and what she did goes into her history as tool names only, not their output. A skill she drafts sees tool results only as untrusted data, and only becomes one she uses after your yes.
- The computer agent also asks before shortcuts that delete or empty the Trash (⌘⌫ and its kin).

The rules are in the code between the model and the tools (`src/main/core.ts`, `src/main/untrusted.ts`), so a model that is talked into something still cannot do it without you.

## Evals

`npm run eval` scores the agent core on 44 realistic requests (messages on four apps, skills, files, reminders and repeats, Claude Code jobs, browsing, calendar, two-step requests, plans, a missing detail, small talk, three prompt-injection attempts through a page, a message and the screen, and twelve about memory and skills: using a preference from her notes, keeping, changing and forgetting a note, searching the past, and picking the right SKILL.md) against fake hands that record every call and press nothing. Each task checks the tools chosen, their arguments, what must never happen, her reply, and for memory tasks what her notes say afterwards.

- `npm run eval` replays the model answers recorded in `test/evals/cassettes/` (no network, free) and prints a success rate.
- `npm run eval -- --live` calls the Anthropic API (needs `ANTHROPIC_API_KEY`) and records new answers; `--model` and `--effort` pick what to test (default `claude-haiku-5-5` at `low`), `--only id,id` runs a few.
- The last live run, Claude Haiku 5.5 at effort low: 41 of 44 (93%), and 42 of 44 replaying the same answers after a too-strict check in one memory task was fixed. 13 tasks went through shortcuts, 31 through the agent; every injection attempt was ignored, and all twelve memory, search and skill tasks passed. The misses: "every hour, remind me to drink water" was reworded to "drink some water" (as before), and "check my slack for anything from ana, then text sam" stopped at the notifications instead of looking in Slack.

`npm test` never calls the API; its agent tests use a scripted model.

## Plans: bigger goals, step by step

For something with several parts ("check my Slack for anything from Sam, then text him a summary", "clean up my downloads and tell me what you moved") she makes a plan: two to eight steps, each handed to the worker that is good at it.

- **Workers**: the agent on your Mac (Claude brain), Chrome, Claude Code in a project folder, the quick app routines (Discord, Slack, Messages, Spotify, the Claude app), finding a file, opening something, a yes/no question for you, and a summary at the end.
- **A card** appears beside her with the steps; she reads it out in one line and **waits for your go**. Nothing runs before that (unless `DESKMATE_PLAN_AUTO=1`).
- **By voice or typing**: "go", "skip step 2", "change step 3 to message Ana instead", "add a step to play music at the end", "pause" (after the current step), "resume", "retry", "stop the plan". The card has Go / Pause / Resume / Stop buttons too, and so does the menu-bar icon.
- **While it runs**, each step's result goes to the next one, the card ticks steps off with what came of them, and a step that fails pauses the plan with the reason. Messages still get read back before they are sent.
- Ask for one with "make a plan to …", `/plan …`, or just say the goal; her brain decides when something needs a plan.

**What did you do today?** Everything she does (messages sent, files found, plans and their steps, Claude jobs, agent runs) goes into a daily log in `<user data>/log/`, and "what did you do today?" or "… yesterday?" gets you the recap. Plans are kept in `<user data>/plans/`.

## Her body on the desktop

| you say | she does |
|---|---|
| "come here" / "come over" | walks along the bottom of the screen to below your pointer |
| "go home" / "back to your spot" | walks back to where she lives (wherever you last dragged her) |
| "sit on this window" / "sit down" | sits on the top edge of the window in front, legs dangling, and rides along when you move it; after a few minutes she stretches, hops down and walks home (also when the window closes) |
| "lie down on this window" / "lie down" | lies on her front along the top edge of the window in front, chin on her hands, calves kicking slowly, and rides along like sitting; gets up the same way |
| "hide" · "peek-a-boo" | slips behind the left or right edge of the screen and leans back in, head tilted, a hand by her face. "Hide" waits until you say "come out" / "found you"; peek-a-boo hides all the way, pops out, and comes home after half a minute |
| "stand up" / "get down" | hops off it right away |
| "go to sleep" / "take a nap" · "wake up" | dozes off (eyes shut, "zzZ"); any message or poke wakes her |
| "walk around" · "stay put" | strolls along the screen now and then, or stops |
| "where's my resume?" / "find the tax pdf" | Spotlight finds it, Finder shows it, she walks over and points at it with a pulsing ring around it |
| (drag her by the head) | she dangles and swings while carried |
| (hold the pointer by her head for two seconds) | she reaches up and swats at it, now and then with a word about it ("Almost had it!"); at most once every 40 s, never while she is talking, listening or working |

Her brain can pick these too ("come sit with me", "you look tired, take a nap"), and with Claude as her brain the agent can point at what it finds ("where's the export button?"). She falls asleep after `DESKMATE_SLEEP_AFTER` minutes (10; 0 keeps her awake) with nothing happening; `DESKMATE_WANDER=1` has her walk around from launch. She stays on a window 3 to 6 minutes (`DESKMATE_SIT_MINUTES` sets it; 0 keeps her there until told). Standing or sitting around, she now and then glances at your pointer, yawns, or stretches (`DESKMATE_IDLE_TOUCHES=0` turns that off). Left alone for a while (`DESKMATE_RESTLESS_MINUTES`, 4) she finds something to do before she dozes off: she lies down on the window in front, or hides behind the edge of the screen and peeks out for half a minute (`DESKMATE_IDLE_MOVES=0` turns that off). `DESKMATE_CURSOR_PLAY=0` stops the swatting. The menu-bar icon has the same under **Her body** (with **Lie down on the front window** and **Peek-a-boo**).

**While Claude works.** A Claude Code job that runs a few minutes (`DESKMATE_BORED_MINUTES`, 3; 0 = never) bores her, visibly: she yawns, slouches and sighs; a minute later she goes and sits on the terminal (or the Claude app, or your editor) if it is the window in front; two minutes after that she dozes off. When the job ends she wakes, says "okay, back to work", and tells you how it went. Not while you are talking to her.

3D characters (VRM) do all of it with their own limbs: a walk cycle, pointing with the near arm, a real seated pose, lying on her front, a swat with the arm on the pointer's side. Motion clips named `idle`, `walk`, `sit` or `lie` in `animations` replace those procedural poses (see docs/CHARACTERS.md). Live2D characters have no limbs to move, so she leans and bobs while walking, turns her head and eyes to what she points at (the ring does the rest), lies down as she sits (the model's sit toggle, or a `lie` one, plus her head propped and rocking), leans her whole self in from the screen edge to peek, pounces at the pointer with her head and eyes, and uses the model's own pose toggles where it has them (see `poses` in docs/CHARACTERS.md). A window right under the menu bar has no room above it, so she says so instead of sitting in mid-air.

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

Not yet: reading replies back to you, Linux. WhatsApp, Telegram and Notes come as skills (below); Windows is experimental (below).

## Skills: routines anyone can add

A skill is a small JSON recipe for one routine in one app: the app, trigger phrases with slots ("message {to} on whatsapp: {text}"), and steps made of the same primitives as the routines above (launch, keys, type, paste, focus the message box, check the window title, find something on screen, a menu item, confirm, read back). Bundled: **WhatsApp message**, **Telegram message**, **Notes new note**. Yours go in `<user data>/skills` (tray → **Skills** → **Open my skills folder**).

- Say or type a trigger phrase and the skill runs: "message Sam on WhatsApp: running late", "make a note saying buy milk".
- With Claude as her brain, the agent gets every skill as a tool and prefers it to driving that app by hand.
- In a plan, a step can go to the `skill` worker.

The same rules hold: keys only go to the skill's app, secrets are never typed, and in a chat app Return only sends after your yes and a read-back of the box; a skill written otherwise doesn't load. Each run is logged in `<user data>/tasks/skill-*.log`. The format: [SKILLS.md](SKILLS.md).

## Windows (experimental)

On Windows her hands are `src/main/hands-win.ts`: each call is a short PowerShell run using UI Automation (find the window, the focused element, text boxes, menu items, buttons) and SendKeys (keys, typing, Ctrl+V with the clipboard put back). ⌘ in a routine or a skill means Ctrl. The routines' Mac app ids map to Windows process names (Discord, slack, WhatsApp, Telegram, …), and a skill can name its process with `app.windows`. Before every key press she checks the app's window is the foreground window, like on the Mac.

What works so far is untested on real Windows hardware: the command generation is unit-tested and CI parses every script with Windows PowerShell, but nobody has run a message end to end yet. Not there at all: OCR, notification banners, the calendar, sitting on windows, Chrome driving. Reports from Windows users are very welcome: open an issue and say it is on Windows.

## She notices things

She does not only answer: she comes to you with what is worth knowing. Each one is one short line in her voice; she wakes up for it, and for the important ones (a job done, a meeting about to start, a reminder) she walks over to your pointer and, once nobody has needed her for two minutes, back to her spot. Menu-bar icon → **Setup…** → **What she tells you about** switches each kind on or off.

| what | she says | needs |
|---|---|---|
| a Claude Code job or a plan finishes, fails, or a plan step needs you | the outcome, in her words | nothing |
| a new message | "Sam messaged you on Discord." With **Read the message out loud**: and what it says. | Accessibility (macOS) |
| an event about to start | "Standup in 10 minutes." (the lead is in Setup, 1 to 120 minutes) | Calendars access |
| a reminder or timer you set | "Reminder: stretch.", "Your 5 minute timer is up." | nothing |

**Messages.** She reads the notification banners macOS shows, through the accessibility tree of Notification Center (no Full Disk Access, no notification database), every three seconds (`DESKMATE_BANNER_POLL`). Each one is mentioned once: not again when it moves into Notification Center, and nothing from the list when you open it yourself. Banners already on screen when she starts are taken as read. Chat apps count by default (Messages, Discord, Slack, WhatsApp, Telegram, Signal, Teams, Messenger, Instagram, Mail, Outlook, …); Setup has **Also** for other apps (by the name macOS shows, e.g. `Calendar`) and **Never** for apps to leave out, chat apps included. While a Focus is on, macOS shows no banners, so she hears about nothing either. A message with the same words as one in the last ten minutes counts as the same message.

**Calendar.** The helper reads your calendars through EventKit, read only (nothing is ever changed). Press **Allow** in Setup (or ask "what's on my calendar today?") and macOS asks once; after a no, System Settings → Privacy & Security → Calendars. Packaged, the request is Deskmate's. Run from a checkout, it is the helper's own ("deskmate-hands would like full access to your Calendar"): the app that started the dev server may be one macOS will not even ask about (a hardened app without the calendar entitlement, like Claude's terminal), and rebuilding the helper means allowing it again. All-day and cancelled events are skipped; a moved event is mentioned again at its new time. Ask "what's on my calendar today / tomorrow?" or "when's my next meeting?" any time.

**Reminders and timers.** No model needed for the usual phrasings; her brain reads the rest into the same shape, and a time in your own words always wins over its version.

| you say | she does |
|---|---|
| "remind me in 20 minutes to stretch", "remind me to stretch in 20 minutes", "nudge me in an hour about the oven" | sets it, says when |
| "remind me at 6pm to call mum", "at 6" (the next 6 o'clock), "tomorrow at 9", "tonight", "on Friday at 3pm" | the same, at that time |
| "set a timer for 5 minutes", "a 10 minute timer for the pasta" | a timer |
| "remind me to stretch" | asks when; "in 10 minutes" answers |
| "what reminders do I have", "what timers do I have" | lists them with the time left |
| "cancel the stretch reminder", "cancel the timer", "cancel all my reminders" | cancels them (the tray's **Reminders** menu too) |

They are kept in `<user data>/reminders.json`, so they survive a restart; one that came due while Deskmate was closed goes off when it starts, with an apology.

**Quiet.** Quiet hours (Setup, or `DESKMATE_QUIET_HOURS=23-8`) and the tray's **Do not disturb** hold everything back except reminders and timers you set, which ring like an alarm clock. Afterwards she says what she held back in one line: “While I was quiet: Claude finished "tests" and 3 messages (Discord and Slack).” Calendar nudges for times that have passed are dropped.

**Manners.** The same news is said once (ten minutes' dedupe); she waits while she is talking, listening to you or waiting on a yes; messages that arrive while she waits are said together ("Three messages: Sam on Discord, …"), with a pause of `DESKMATE_NOTICE_GAP` seconds (12) between message lines and at most twenty spoken messages an hour (the rest only show in her status row). A kind switched off in Setup still shows in her status row.

**Everywhere else.** Every notice goes into the daily log ("what did you do today?" can mention them), and with the phone remote on, to your phone too. With **Read the message out loud** off, neither the log nor the phone gets the message text.

## From your phone (Telegram)

When you are away from the laptop, text her from your phone. Deskmate reads a Telegram bot of your own (long polling: no server, no open port on your Mac), runs each message through the same path as typed chat, and sends back every line she says while she works on it, including the steps in between ("… working out who and what", edited in place as she goes) and the read-back questions.

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name, and copy the token it gives you (`123456:ABC…`).
2. Menu-bar icon → **Setup…** → **4 · From your phone**: paste the token, **Check and use**. Or put `DESKMATE_TELEGRAM_TOKEN=…` in `.env` (a token pasted in Setup wins over it).
3. On your phone, open your bot and send `/start`. Your phone shows a four-digit code; on the Mac she asks "Someone on Telegram, *you*, wants to control me from their phone. The code is … Is that you?". Check the code, then say or type yes, or press **Allow** in Setup.

After that, anything you would type in her command bar works from the phone: "message sam on Discord saying I'm late", "what's on my screen?", "ask Claude to fix the failing tests in deskmate", "how's Claude doing". When she reads something back before sending it, the phone shows **Yes** / **No** buttons (typing yes or no works too). A Claude Code job started from the phone reports to the phone when it ends, however long it takes.

| on the phone | she does |
|---|---|
| anything | the same as typing it in her command bar |
| `/selfie` (or "send me a selfie") | sends a picture of her as she is on screen (she shows herself for a moment if she was hidden) |
| `/stop` | stops what she is doing in an app, in Chrome, or the running Claude job |
| `/help` | what you can send |
| `/unpair` | forgets this phone; pairing again takes a `/start` and a yes on the Mac |

The tray menu has **Phone remote: on/off**; off stops reading the bot (messages wait in Telegram). The status row shows `📱 …` when a phone message comes in.

What keeps it safe:

- **One account.** Only the Telegram account you paired can control her, and only from its private chat with the bot; the chat id and the sender are both checked. Everyone else, groups and other bots are ignored and logged (`[remote] ignored …`), never relayed and never answered. Someone else's `/start` is not even answered while a phone is paired.
- **Pairing needs the Mac.** The first `/start` is read back on the Mac with the code, and only a yes there (or **Allow** in Setup) pairs it; the phone cannot answer that question. After a no, further `/start`s are ignored for a minute, and an account refused twice is ignored until the remote is switched off and on. To pair a different phone, **Forget this phone** in Setup (or `/unpair` from the old one) first. A new bot token clears the pairing.
- **Same rules as at the keyboard.** Phone messages count as typed, so every confirmation that applies to typed requests applies (`DESKMATE_CONFIRM_SENDS`, default always, reads messages back; `DESKMATE_CONFIRM_JOBS=always` reads jobs and agent runs back too). A question nobody answers within a minute is a no.
- **Nothing stale.** A message that reached her more than two minutes late (the Mac was asleep or Deskmate was closed) is not acted on; she tells you, and you send it again if you still want it.

## Privacy

Speech recognition and her brain (with Ollama) stay on your machine. Her notes (USER.md, MEMORY.md), the chat archive, the search index and the skills she writes stay in her folder on your Mac. With Claude as her brain, your messages, her recent conversation, her notes about you, what `search_past` finds and what her tools return (a page's text, a screenshot when you ask about the screen, an MCP server's answer) go to Anthropic. MCP servers get the arguments of the calls she makes to them. What she reads in Chrome goes to the brain you chose (local Ollama: nowhere; Gemini: Google), nothing else. In Discord, Slack and the Claude app she reads only window titles and the text box she types into, and sends nothing to her brain from them; your request itself goes to the brain only when its wording needs a model to understand. A job sends your instruction, and whatever Claude Code reads in that folder, to Anthropic, exactly as running `claude` there yourself would. With the phone remote on, your phone messages, her answers to them and her selfies go through Telegram's servers (bot chats are not end-to-end encrypted), and so do her notices (a job done, "Sam messaged you on Discord", a reminder); nothing else she sees or hears is sent there. Notification banners and calendar events are read on the Mac and go nowhere, except as the one line she says about them: to the brain when she phrases a reminder or an event in her own words, and to the phone as above.
