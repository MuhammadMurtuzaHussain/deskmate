# Safety: see, limit, stop and pay for what she does

Deskmate works your Mac: it sends messages, moves files, runs Claude Code jobs, browses as you. This page is how you keep that in hand: what she may do and from where, what she did and how to take it back, how to stop everything at once, what it costs, and where your keys live.

## Permission levels

Every tool she has, built-in, a skill or one from a tool server (MCP), has a level:

| level | what happens |
|---|---|
| **allow** | she uses it without asking |
| **ask** | she asks you first, every time: a message or a job is read back; anything else gets "… Go ahead?" |
| **never** | she does not have it: it is left out of her tool list, and refused if a shortcut asks for it |

The defaults follow what a tool could do wrong:

- **allow**: reading and looking (pages, the screen, files by name, your calendar, reminders, her notes, search), opening things, music, reminders and timers, moving her body, moving or renaming a file (it can be undone), cancelling a reminder (it can be put back), tool-server tools.
- **ask**: sending a message (Discord, Slack, Messages, WhatsApp and the other messaging skills), Claude Code jobs, putting a file in the Trash, clicking "buy", "pay", "delete" or "send" in Chrome, running a terminal command or a skill's script, sending a file to your phone.
- **never, whatever you set**: the computer agent does not work Keychain Access, 1Password, Bitwarden, System Settings or a terminal (Terminal, iTerm, Warp, Ghostty).

`DESKMATE_CONFIRM_SENDS` and `DESKMATE_CONFIRM_JOBS` in `.env` still set the base: `DESKMATE_CONFIRM_SENDS=never` makes messages allow by default, `voice` makes them ask only for spoken requests; with `DESKMATE_CONFIRM_JOBS` unset, Claude Code jobs ask.

### Changing them

Setup → **9 · Permissions and safety** lists every tool (risky ones first) with its level:

- **For every request**: pick allow, ask or never for the tool.
- **Only from one place**: "+ only from…" sets a level for requests from one origin: voice at the desk, the command bar and chat, chat apps on your phone, scheduled jobs, the heartbeat. That beats the tool's general level.
- **Stricter from some places**: for each origin, "always ask" or "never" for every risky tool asked for from there. Chat apps and schedules can be stricter than the desk: "never" for scheduled jobs means a job can read and report but never send, delete, buy or run anything.
- **"Yes, always"**: answer one of her questions with "yes, always" (or "always allow this", "don't ask again") and that tool stops asking from where it was asked. It shows up in Setup, where you can take it back.

The levels are kept in `settings.json` under `permissions`.

### What allow does not switch off

The prompt-injection guard ([AGENT.md](AGENT.md#untrusted-text-the-prompt-injection-guard)) sits on top: once a turn has read text from somewhere else (a web page, a message, the screen, a tool server, your phone), anything risky asks you, even a tool set to allow. A message from your phone always counts. A "yes, always" never widens that.

## What she did, and undo

Every tool call is written down in `<user data>/activity/YYYY-MM-DD.jsonl`: when, from where, which tool with which arguments (keys blanked out), what came of it, who said yes (on its own, after your yes, after a read-back, you said no, switched off, waiting for you) and why (the request it was for). The search index reads it too, so "what did you do with my resume last week?" finds it.

- **The Activity window** (tray → "What she did today…", Setup, or `/activity`) lists today's calls, newest first, with Undo where it is honest. Looking-only calls are hidden unless you ask for them.
- **"What did you just do?"** says the last few things she did.
- **"Undo that"** takes back the newest thing that can be taken back. The agent has an `undo` tool too ("put the resume back where it was").

What undo can do, and what it says it cannot:

| she… | undo |
|---|---|
| put a file in the Trash (`trash_file`) | puts it back where it was (refuses if something new is there) |
| moved or renamed a file (`move_file`) | moves it back (never overwrites) |
| opened an app that was not running | quits it |
| opened a website | closes that tab in Chrome |
| put a picture of herself on the clipboard | puts your old clipboard text back |
| set a reminder / cancelled a reminder | removes it / puts it back |
| set up a scheduled job | deletes it |
| sent a message or a file | **can't undo**: a sent message can't be taken back |
| ran a Claude Code job | **can't undo** here: the changes are in the project, and git can take them back |
| ran a command, a script, or did something in an app or in Chrome | **can't undo** |

Her own reach for files stops at yours: she does not move or trash the system, `/Applications`, your Library, hidden folders (`.ssh`, `.aws`…), her own data, or a whole top-level folder like Documents. A file on another disk goes to that disk's Trash, where Finder's Put Back restores it.

## Stop everything

**Control-Option-Escape** (change it in Setup), tray → **Stop everything**, the button in Setup, or saying **"stop everything"**:

- stops the agent turn she is in, the browse or app run, and the plan on the card;
- stops scheduled jobs (a job that comes round is skipped), the heartbeat and the morning brief;
- turns off every chat app;
- then asks whether to stop the Claude Code jobs that are running too (they may be halfway through edits);
- and says so: "Stopped. Nothing runs on its own until you say resume."

You can still talk to her at the desk. Say **"resume"** (or tray → Resume everything) and the schedules, the heartbeat and the chat apps that were on start again. `DESKMATE_STOP_SHORTCUT` sets the shortcut from `.env`.

## Spending

Every Claude and Gemini call is counted: uncached input, cache reads, cache writes and output tokens, priced from a table of list prices per model (Claude Haiku 5.5 $0.10 / $0.50 per million tokens in / out, Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20, Fable 5.1 $10 / $50, older models and Gemini too). It is an estimate; your provider's bill is the real number. Records are in `<user data>/spend/YYYY-MM.jsonl`; a `<user data>/prices.json` with `{ "model-prefix": { "input": …, "output": …, "cacheRead": …, "cacheWrite": … } }` (dollars per million tokens) overrides the table.

- **The tray** shows "Spent today $… · this month $…".
- **Setup → 10 · Spending** shows today, this month, the calls, how much came from the cache, and the split by where it came from: chat at the desk, chat apps, scheduled jobs, the heartbeat, and looking and learning (screen looks, skill drafts).
- **A monthly budget** (Setup, or `DESKMATE_BUDGET` in dollars): at 80% she tells you once; at 100% she stops before the next call and asks "Should I keep going anyway?" at the desk or in the chat app you used. A yes lets the rest of that month go; scheduled jobs, the heartbeat and background looks just stop (the job's log says why).

## Secrets

- **Where they live**: your Anthropic and Gemini keys and the Telegram, Discord and Slack tokens are kept in `<user data>/settings.secrets`, encrypted with a key the system keeps (Electron safeStorage: the login Keychain on macOS, the credential store on Windows, the keyring on Linux), not in `settings.json`. A `settings.json` from an older version is migrated once, on the first start. On a system without a keyring they stay in `settings.json`, which is readable only by you (mode 0600). `DESKMATE_SECRETS=file` keeps them there on purpose (test instances).
- **Redaction**: anything shaped like a key or token (Anthropic, OpenAI, Google, Slack, GitHub, AWS, Telegram, Discord, Stripe, JWTs, private keys, `password: …`) and your own keys and tokens by value are blanked out of the console and task logs, the day log, the chat archive, the activity log, and every line she sends to a chat app.
- **Her memory**: she never writes a key, token or password into her notes, whichever brain picked the fact; she says it belongs in Setup.
- `send_to_me` never sends keys, keychains, `.env` or password files (docs/CHANNELS.md).

## Terminal commands

Off by default. Setup → "Let her run terminal commands" adds a `run_command` tool for small jobs ("how much disk is free?", "convert this with ffmpeg"):

- each command asks first (level ask);
- a deny-list refuses, before anyone is asked: `sudo`/`su`, recursive deletes or permission changes of your home, a top-level folder or the system, `rm -rf *`, anything touching SSH keys, the Keychain, cloud credentials or `.netrc`, piping a download into a shell (`curl … | sh`), erasing or writing to disks, shutting down, disabling system protections, force-pushing;
- it runs in a scratch folder (`<user data>/shell`) or the project you name, with only `PATH`, `HOME`, `LANG` and a few more in its environment: none of her keys;
- output is treated as untrusted data, two minutes at most.

A skill's scripts get the same environment and their arguments go through the same deny-list; you allow each skill's scripts once.

The deny-list is a seat belt, not a sandbox: a command that passes it can still do damage, which is why every one asks.

## How Claude Code jobs are permissioned

Claude Code jobs are not run through the deny-list; they use Claude Code's own permission system:

- A job asks you before it starts (the read-back "Send this to Claude in …?"), as the `claude_code` tool's level is ask.
- It runs `claude -p … --permission-mode acceptEdits` in the project folder: Claude Code may read and edit files inside that folder and run only the commands its own allow list (your `.claude/settings.json` and project settings) permits. Anything else is refused, because nobody is at its keyboard to approve it.
- `DESKMATE_CLAUDE_PERMISSION_MODE` changes the mode (`default`, `plan`, or `bypassPermissions`, which lets it run anything: only for folders you would let anyone loose in). `DESKMATE_CLAUDE_MAX_TURNS` caps how long a job may go.
- Every job's full transcript is in `<user data>/tasks/`, and "stop everything" offers to stop running jobs. Their edits cannot be undone from Deskmate; use git.
