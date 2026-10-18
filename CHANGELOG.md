# Changelog

## Unreleased: trust her near your Mac ([docs/SAFETY.md](docs/SAFETY.md))

**Permission levels**
- Every tool (built-in, skill, MCP) has a level: allow, ask or never. Reading is allow; sending messages, deleting, buying, running commands, Claude Code jobs and files leaving the Mac ask; DENY_APPS stay never. `DESKMATE_CONFIRM_SENDS` / `_JOBS` still set the base.
- Per-tool levels everywhere or only from one origin (voice at the desk, the command bar, chat apps, scheduled jobs, the heartbeat), and a floor per origin for every risky tool ("always ask" or "never" from chat apps or schedules). A tool set to never is left out of her list.
- "Yes, always" to one of her questions makes that tool allow from where it was asked. The injection guard still asks after untrusted text whatever the level.
- Setup → **9 · Permissions and safety**.

**Activity and undo**
- Every tool call in `<user data>/activity/` (time, origin, tool, redacted arguments, result, who said yes, why), searchable with search_past. Tray → **What she did today…** opens the Activity window, with Undo where it is honest.
- "Undo that" and "what did you just do?" by voice; agent tools `undo` and `recent_actions`. Undo puts trashed files back, moves files back, quits apps and closes tabs she opened, restores the clipboard, removes or restores reminders, deletes a job she set up. Sent messages, Claude Code edits and commands say "can't undo".
- New tools `move_file` and `trash_file` (her own Trash folder move, so it can be put back; never overwrites; not the system, hidden folders or a whole top-level folder).

**Spending meter**
- Tokens per Anthropic and Gemini call (uncached, cache reads, cache writes, output) priced per model, by origin (chat, chat apps, scheduled jobs, heartbeat, looking and learning), in `<user data>/spend/`. Today and this month in the tray and Setup → **10 · Spending**.
- A monthly budget (Setup or `DESKMATE_BUDGET`): a heads-up at 80%; at 100% she asks before the next call at the desk or in the chat app, and scheduled jobs and the heartbeat stop.

**Secrets**
- API keys and chat-app tokens move from `settings.json` to an encrypted file keyed by the Keychain (Electron safeStorage), once. Anything key-shaped is redacted from the console, task logs, the day log, the chat archive, the activity log and channel replies; her memory refuses facts with a key in them.

**Kill switch**
- Control-Option-Escape (configurable), tray → **Stop everything**, or "stop everything": stops her turn, browsing, plans, scheduled runs, the heartbeat, the brief and chat apps, then asks about Claude Code jobs. "Resume" turns them back on.

**Shell safety**
- `run_command` (off until Setup turns it on; asks each time) and skill-script arguments go through a deny-list (sudo, recursive deletes of home or system folders, credentials, `curl | sh`, disk wipes, shutdown), run in a scratch or project folder with an environment without her keys. How Claude Code jobs are permissioned is documented.

**Tests and evals**
- `test/safety.test.ts`: permission resolution and the gate in the agent core, redaction, the settings migration with a fake keychain, the activity log, undo of a trash and a move, the price table and budget decisions, the deny-list. 13 new eval tasks (permissions, a phone floor, undo, activity, a refused and an allowed command, the kill switch mid-turn, a key she must not remember). Claude Haiku 5.5 at effort low: 11/11 new agent tasks live (after one fix), 74/76 overall on replay; the misses are the older `remind-hourly` and `slack-then-text`.
- A tool switched off is named in the turn, so she does not do its job another way (the first live run skipped a song with `use_computer` while Spotify was set to never).

## Unreleased: reach her from the chat apps you already use

**Chat apps** ([docs/CHANNELS.md](docs/CHANNELS.md))
- One channel layer for every app (`src/main/channels/`): each connects out and turns what arrives into the same message, and one hub decides who may talk to her, routes the message through the same agent turn, read-backs ("yes" answers them), scheduled-run questions and results, and sends her lines, steps, pictures and files back to the chat they came from. The Telegram remote now runs on it.
- **Discord**: a bot of your own, direct messages only, over the gateway (no privileged intents). Pair by DMing the code Setup shows.
- **iMessage** (macOS): text yourself from your iPhone. She reads new rows in `~/Library/Messages/chat.db` (needs Full Disk Access, which Setup checks and explains) and answers in that chat through Messages. Only notes to self and the handles you list reach her; nobody else is ever read past the sender, logged or answered. Her own replies and the twin row of a note to self are recognised.
- **Slack**: an app of your own in Socket Mode (bot and app-level tokens, a manifest in the docs), DMs only, paired with a code.
- **Signal**: through `signal-cli` linked to your own account, when it is installed: Note to Self and your listed numbers only.
- **WhatsApp**: a documented stub. The official API bars general-purpose AI assistants (since January 2026) and needs a public webhook; unofficial clients get numbers banned. Setup and the tray say why.
- Each app is off until set up. Setup → **4 · From your phone** has a card per app (tokens checked with the service before they are kept, pairing codes, Allow / Refuse, handles, on/off); tray → **Chat apps** shows each one's state and switches it.

**Pairing and safety**
- One owner per app: the paired account in its private chat (Telegram, Discord, Slack), or your own handles (iMessage, Signal). Codes work once, for ten minutes, three tries per account. Strangers get one short "not paired" line a day on the bot apps and silence on iMessage and Signal; group chats are ignored; nothing from them reaches her brain.
- A message from a chat app is marked as coming over the network, so anything that sends, deletes, buys or runs something asks first, on the phone. Tokens live only in her settings file and are scrubbed from log lines.

**From the phone**
- "Send me a screenshot" and "send me the PDF I just downloaded" / "send me my CV" (new tool `send_to_me`, with shortcuts): a file is read back with its name, size and folder and sent only after your yes; keys, keychains, `.env` and password files are never sent.
- Voice notes are transcribed by her local Whisper and echoed back; optionally she answers with a voice note in her Kokoro voice. "Typing…" while she works.

**Evals and tests**
- 6 new eval tasks over chat apps (a screenshot, the latest download, a CV over Discord, a screen check over iMessage, an SSH key refused, an injected message over Slack). Claude Haiku 5.5 at effort low: 61/63 live, 61/63 on replay (the misses are `remind-hourly` and `slack-then-text`, not channel tasks).
- Unit tests for the hub (pairing by yes, by code and by allowlist; strangers and their rate limit; groups; stale messages; commands; voice notes; where lines go; buttons), Telegram, Discord, Slack and Signal against fakes, and chat.db parsing (attributedBody, Apple dates, tapbacks, echoes, twins) against a fixture database.

## Unreleased: she does things on her own schedule

**Scheduled jobs**
- "Every weekday at 9 summarise my Slack", "every Sunday evening plan my week", "every hour check if the build is green": jobs in plain words, kept in `<user data>/schedule.json`. Rules read the usual shapes (weekdays, weekends, named days, clock times and parts of the day, every N minutes or hours with a window, days of the month, the nth weekday, every other day); odder phrasing is filled in by the agent as fields. New agent tools `schedule_job`, `list_jobs`, `change_job` (pause, resume, delete, run now, change); clean phrases go through a shortcut.
- The next run is computed on the wall clock of the job's time zone: daylight saving keeps 9:00 at 9:00, a skipped time runs just after the jump, a repeated one runs once. A run missed while the Mac slept or was off is caught up once (not once per slot), or dropped when more than `DESKMATE_SCHEDULE_CATCHUP_HOURS` late.
- Each run is an isolated agent turn (or a plan on the card). Results are said at the desk, sent to the Telegram remote when you are away, otherwise told when you come back; always in the day log. Every-few-minutes jobs skip quiet hours.
- Scheduled runs follow the guard: anything that sends, deletes, buys or runs asks first (out loud, or on the phone when you are away); with nobody to answer, the step waits for your yes instead of running. Tray → **Scheduled**, Setup → **7 · Scheduled**.

**Heartbeat**
- Every `DESKMATE_HEARTBEAT_MINUTES` (default 30, 0 off) one small Claude call reads your checklist in `<user data>/memory/HEARTBEAT.md` against your calendar, reminders, messages and jobs, and stays silent unless something needs you. No tools, small `max_tokens`, cached prefix; skipped (no call) with an empty checklist, in quiet hours, when busy, or idle overnight. Token use per beat in `<user data>/log/heartbeat-usage.jsonl`.

**Morning brief** (opt-in in Setup)
- On the first unlock, wake or return after the hour you set: today's calendar, reminders, overnight job results, messages and one line from her notes, said short and shown on a card.

**Also**
- Setup → **What she tells you about** has a switch for scheduled results and check-ins. Shortcut turns leave a note in the conversation history of which tool ran, so a follow-up knows ("delete that job").

**Evals and tests**
- 13 new eval tasks on scheduling and scheduled runs. Claude Haiku 5.5 at effort low: 56/57 live, 56/57 on replay.
- Unit tests for next-run computation (weekdays, intervals with windows, months, daylight saving in New York and Dublin, skipped and repeated hours), catch-up after sleep, phrase parsing, the run router (desk, phone, away, quiet hours, busy, plans), waiting steps, heartbeat silence and skip rules, and the brief.

## Unreleased: she remembers, and gets better with use

**Memory you can read and edit**
- Her notes about you are two Markdown files in `<user data>/memory/`: `USER.md` (who you are, what you like, the people you message, your projects) and `MEMORY.md` (facts and lessons), each with a size cap. Both are in her prompt every turn, in the cached part. New agent tools `update_memory` and `forget` beside `remember`, which now files a note under a section; when a file is full she merges or drops notes first. Your own lines and headings are kept as you wrote them.
- Small talk still fades in days. The facts she kept before move into the files once, on the first launch. `/forget` empties the files and keeps `.bak` copies. Tray → **Open her memory**; Setup → **What she remembers and knows**.
- Shortcuts leave "text my sister", "fix the form on my portfolio" and "my usual music" to the agent, which has her notes.

**Search the past**
- `search_past`: SQLite FTS5 (Node's built-in `node:sqlite`, nothing to install) over a new chat archive (`<user data>/chats/`), her day logs and her plans. "What did I ask you about the dentist last week?", "what did you send sam yesterday?". Indexed incrementally before each search; rebuilt from the files when missing or broken. Results count as untrusted text.

**Skills in the open SKILL.md format**
- Skills written for agentskills.io, OpenClaw's ClawHub or Hermes Agent load from `skills/` and `<user data>/skills/`: a folder with a SKILL.md (YAML frontmatter with `name` and `description`, then instructions) and optional scripts and references. Only names and descriptions are in her prompt; `read_skill` loads one when a request matches. `run_skill_script` runs a skill's scripts, only with `DESKMATE_SKILL_CODE=1` and your yes for that skill (asked again when its scripts change).
- The bundled WhatsApp, Telegram and Notes routines each have a SKILL.md now; their `skill.json` still runs them.

**Skills she writes herself**
- After a task that took five or more tool calls and worked, she drafts a SKILL.md (steps, app quirks, edge cases) into `<user data>/skills/drafts/`, shows it on the card beside her and asks in one line. It becomes a skill she uses only after your yes: said, on the card, in the tray or in Setup. When she follows a skill and finds a better way, she proposes the update the same way. Everything is logged in her day log. `DESKMATE_LEARN_SKILLS=0` turns it off.

**Fixes**
- "Remind me … at 8pm, … at 8:15pm" no longer becomes one garbled reminder through the shortcut; several clock times go to the agent.

**Evals and tests**
- 12 new eval tasks (a preference from her notes, keeping, changing and forgetting a note, searching the past, picking the right skill). Claude Haiku 5.5 at effort low: 41/44 live, 42/44 on replay.
- Unit tests for the memory files and the move from JSON, FTS indexing (appends, half-written lines, rewrites, deleted files, a missing or broken database), the YAML frontmatter and SKILL.md loading, and drafting, approving and rejecting skills.

## Unreleased: one brain with every tool (the agent core)

**The agent core**
- With Claude as her brain, one tool-use loop handles everything that is not small talk: every worker is a tool (Discord, Slack and Messages, Spotify, the Claude app, Claude Code jobs, browsing and the page in Chrome, opening and finding files, the agent that works any app, a look at the screen, reminders, plans, the calendar, her day log, recent message notifications, her body, memory, every skill). She chains them ("find my resume and open it") and says what happened.
- The regex routing is now only zero-latency shortcuts for unambiguous commands, running the same tools through the same checks; anything with a second step, a repeat or a judgment call goes to the agent. Gemini and Ollama keep the older routing, and so does a Claude brain that cannot be reached. `DESKMATE_AGENT_CORE=0` turns it off; `DESKMATE_AGENT_ROUNDS` caps a turn.
- Repeating reminders: every hour, day, weekday or week.

**MCP tool servers**
- `<user data>/mcp.json` in Claude Desktop's shape: local servers over stdio, remote ones over streamable HTTP (SSE as a fallback). Their tools reach her as `<server>__<tool>`; each call goes into her day log. Setup → **Tool servers**: state, tool count, a switch per server, Edit and Reload.

**Prompt-injection guard**
- Text from screens (accessibility and OCR), web pages, messages, notifications and MCP servers is wrapped as untrusted data in every prompt, with tag-like text defused. A turn that read any, or came from the phone remote, cannot send, delete, buy, start a Claude Code job or write through an MCP server without your yes, whatever the read-back settings say; nor can it add to her memory.
- The computer agent asks before shortcuts that delete (⌘⌫ and its kin).

**Evals**
- `npm run eval`: 32 realistic requests against fake hands, scored on tool choice, arguments, safety and her reply; replays recorded answers, or `--live` against the API. Claude Haiku 5.5 at effort low: 31/32.

**Under the hood**
- `src/main/core.ts` (the loop and the guard), `tools.ts` (the registry and the `WorkerHost` interface), `fastpath.ts`, `untrusted.ts`, `mcp.ts`; tests with a scripted model, fake hands and a stdio MCP server.

## Earlier, unreleased: she plans it out, she notices things, she makes herself at home, and she learns skills

**Skills: app routines anyone can add**
- A skill is a folder with a `skill.json`: the app, trigger phrases with slots (`"(message|text) {to} on whatsapp[:] {text}"`), and steps made of her hands' primitives (launch, key, type, paste, focus the message box, check the window title, find something on screen, a menu item, wait, confirm, read back), plus her line when it's done. An optional handler file can tidy the slots or do the work in code.
- Loaded at startup from `skills/` in the app and `<user data>/skills` (yours replace bundled ones of the same name). Tray → **Skills**: the list, **Open my skills folder**, **Reload skills**, and the guide.
- A phrase that matches a trigger runs the skill (checked before the built-in app routines); the Claude agent gets each skill as a tool; plans can hand a step to the new `skill` worker, which matches the step to a skill or has her brain pick one and fill its slots.
- The safety rules are the runner's: keys only reach the skill's app, off-limits apps can't be targets, secret-looking text is refused, and in a chat app Return after typing only sends after a yes and a read-back. A skill that breaks those rules doesn't load, and the log says why. Handlers from your own skills folder only load with `DESKMATE_SKILL_CODE=1`.
- Bundled: WhatsApp message, Telegram message, Notes new note. Guide: docs/SKILLS.md.

**Windows hands (experimental)**
- `src/main/hands-win.ts`: the same hands on Windows through PowerShell, UI Automation and SendKeys: launch or bring an app forward, the foreground window and its title, the focused element and text boxes, keys, typing, pasting with the clipboard restored, menus, a numbered look at the window, and finding things in it. Picked automatically on Windows. ⌘ in routines and skills means Ctrl; the routines' Mac app ids map to Windows process names. Nothing anyone typed is ever put into the PowerShell source (arguments travel as base64 JSON).
- Not tested on a real PC yet: the command generation is unit-tested and CI parses every script with Windows PowerShell.

**Launch**
- A new README ("an agent with a face"): what she does, the safety model, install, quickstart, skills, characters, brains, privacy, how she compares with terminal and chat agents and with companion apps, roadmap. Fresh screenshots of the bundled characters only.
- SECURITY.md (what keeps her safe, what she never does, how to report a problem), CONTRIBUTING.md (dev setup, testing beside your own copy, writing a skill, code layout), CODE_OF_CONDUCT.md, issue and pull request templates.
- A static landing page in `docs/site/` (no build step, works offline) and docs/LAUNCH.md (name options, launch checklist, demo video shot list, macOS signing and notarization).
- CI runs the typecheck and the tests on macOS, Windows and Ubuntu.

**Under the hood**
- `DesktopHands`: the interface both hands implement; the safety lists and title / message-box checks moved to `src/main/checks.ts`, shared by the routines, the agent and skills.
- Tests for skills (loading, validation, trigger phrases, slots, runs against a fake pair of hands that records every key) and for the Windows command generation: 84 in all.
- The old screenshots of a private model are gone from `docs/`.


**She makes herself at home (desktop moments)**
- "Lie down on this window": she lies on her front along its top edge, chin on her hands, calves kicking slowly, and rides along when you move it (3D). Live2D characters lie down the way they sit, with the model's `lie` or `sit` toggle and her head propped and rocking.
- "Hide" / "peek-a-boo": she slips behind the left or right edge of the screen and leans back in with her head tilted and a little wave. Hide waits until "come out" / "found you"; peek-a-boo pops out and comes home after half a minute.
- Pointer play: hold the pointer by her head for two seconds and she reaches up and swats at it (3D: the arm on its side; Live2D: a pounce with head and eyes), now and then with a word about it. At most once every 40 s, never while she is busy or talking (`DESKMATE_CURSOR_PLAY=0`).
- Left alone a while (4 minutes, `DESKMATE_RESTLESS_MINUTES`), she lies down on the front window or peeks out from the screen edge on her own (`DESKMATE_IDLE_MOVES=0`).
- Bored while Claude works: a Claude Code job that runs a few minutes (`DESKMATE_BORED_MINUTES`, 3) has her yawn and slouch, sit on the terminal or the Claude app if it is in front, and doze off; when it ends she wakes and says "okay, back to work" before she reports.
- Motion clips for her body: `animations` named `idle`, `walk`, `sit` or `lie` (Mixamo `.fbx` or `.vrma`) play in those states over the procedural pose.
- The menu-bar icon's **Her body** has **Lie down on the front window** and **Peek-a-boo**.

**Characters, the easy way**
- Setup → **Characters** (menu-bar icon → **Characters…**): a card with a picture for every character (made on first view with the same capture as her selfie, cached in `<user data>/thumbs`); click one to switch.
- Voice (Kokoro presets from the local voice server), speed, camera zoom and personality for the character on your desk, saved to `<user data>/character/<id>/local.json` and `persona.md`.
- **Add a character…**: a `.vrm`, a Live2D model or its folder, a `.pmx`, a rigged `.fbx` / `.glb` / `.dae`, or a `.zip` with one inside. She is copied into your user-data folder with `character.json` written for you: VRM expression presets, Live2D expression names in English, pinyin, Chinese and Japanese mapped to her emotions, pose toggles (a watermark toggle always on), the VRM licence read from its metadata with a warning when the avatar is for its author only, and a neutral starter personality.
- **Remove her** for characters you added (her folder goes to the Trash).
- Models under the user-data folder load through `deskmate://character/<id>/…`; relative model paths in `character.json` mean "in this character's folder". `local.json` now merges `voice`, `camera`, `physics`, `idle` and `dance` key by key.
- VRM characters use custom expressions named in `expressions` (e.g. `"shy": "Blush"`) besides the five presets.

**She notices things**
- Notices: a short line in her voice when something happens, without being asked; she wakes up for it and walks over to your pointer for the important ones, then goes home. Repeats are dropped, messages that pile up are said together, and spoken messages are capped per hour.
- Claude Code jobs and plans finishing (or a plan step failing) come as notices.
- New messages: she reads the notification banners macOS shows (Notification Center's accessibility tree; no Full Disk Access) and says who messaged you on which app. Reading the message itself is a setting. Chat apps by default, with Also / Never app lists.
- Calendar: a nudge before events (10 minutes by default), and "what's on my calendar today / tomorrow?", "when's my next meeting?". Read only, through EventKit.
- Reminders and timers: "remind me in 20 minutes to stretch", "remind me at 6pm to call mum", "set a timer for 5 minutes", "what reminders do I have", "cancel the stretch reminder". Kept across restarts; listed and cancellable from the tray.
- Quiet hours (`DESKMATE_QUIET_HOURS`, or Setup) and a tray **Do not disturb**: she holds things back and tells you after in one line; reminders still ring.
- Notices go into the daily log, and to your phone when the phone remote is on.
- Setup: **What she tells you about**.

**She plans it out**

- Plans for bigger goals: steps with a worker each (the Mac agent, Chrome, Claude Code, app routines, find, open, ask, a summary), shown on a card beside her, run only after a go, with voice edits ("skip step 2", "change step 3 to …", "add a step …"), pause / resume / retry / stop, results handed from step to step, and a pause with the reason when a step fails.
- A daily log of what she did, and "what did you do today?" / "yesterday?".
- Live2D: a model's own walk motion (motions.walk) and always-on pose toggles (poses.base).

## 0.6.0: she works your Mac, and lives on your desktop

**Claude as her brain, and an agent for your Mac**
- Pick Claude in the setup window with your Anthropic key (Opus 5.5 by default; Sonnet 5.5 and Haiku 5.5 are quicker and cheaper), with an effort setting. The key is checked by listing the models it can use.
- With Claude she gets an agent for multi-step jobs in any app ("open Spotify and play my liked songs", "in Notes, start a shopping list"): it reads the window, clicks, types, checks each step, and asks before anything that sends, posts, deletes or pays. It can read the screen with OCR (Vision) for apps whose accessibility tree says little.

**She works your apps (macOS)**
- Discord and Slack messages, prompts for the Claude app: she opens the app, finds the chat, checks the window shows the right one, reads the message back, and sends on your yes. Uses a small Swift helper (`deskmate-hands`) bundled in the app; needs Accessibility.
- Messages (iMessage): "text Note Pad that I'm on my way" finds the chat by name, asks which one when two match, reads it back, sends through Messages' scripting.
- Spotify: play, pause, next, previous and "what's playing" right away; "play X on spotify" goes to the agent with a Claude brain.
- A picture of her: "take a selfie" saves a trimmed portrait to ~/Pictures/Deskmate and copies it; "and send a photo of yourself" attaches it on Messages, Discord and Slack.
- Messages and Spotify need only macOS's Automation prompt (the first time), not Accessibility.

**Command bar and setup window**
- ⌥Space (Alt+Space) anywhere opens a command bar: type what you want, Enter; her answer and her "send it?" questions show right under it.
- A first-run setup window for her brain (Claude, a local Ollama model it finds, or a Gemini key), her voice, the permissions she needs, and the phone remote. Menu-bar icon → **Setup…** brings it back. Setup's brain choice is saved and wins over `.env`.
- Her chat panel tucks away until you hover over her; news shows as a short status line.

**Ears**
- Wake word ("Mika, …") and barge-in: talk over her and she stops and listens.

**She lives on your desktop**
- "Come here", "go home", "sit on this window" (she sits on its top edge, legs dangling, and rides along when you move it), "go to sleep", "walk around". "Where's my resume?": she finds it, opens Finder on it, walks over and points at it with a pulsing ring. Carry her by the head and she dangles. Left alone for ten minutes she dozes off.
- New: after 3 to 6 minutes on a window she stretches, hops down and walks home (`DESKMATE_SIT_MINUTES`, 0 = until told). "Stand up" / "get down" hops her straight down.
- New: small idle touches: now and then a glance at your pointer, a yawn, rarely a stretch (`DESKMATE_IDLE_TOUCHES=0` turns them off).
- Full body on 3D characters; Live2D characters lean, bob, look, and use the model's own pose toggles. Fixed: on Live2D the idle sway, tap bounce, dance beat and walk bob ran on the wrong clock and barely moved.

**Characters**
- Rigged FBX, Collada and glTF characters load through the VRM pipeline: the skeleton is mapped onto the VRM humanoid by bone names (3ds Max Biped, Mixamo, Unreal, Blender-style), so idle, walking, sitting, pointing and dancing all work. `camera.zoom` frames her closer.

**From your phone**
- Text her through your own Telegram bot: messages, "what's on my screen?", Claude jobs, `/selfie`. Her lines come back to the phone, "send it?" gets Yes / No buttons, and only the one account you paired (with a yes on the Mac) can control her. Tray: **Phone remote: on/off**.

**Updates**
- The tray shows **Update available: vX.Y.Z** when a newer release is on GitHub (checked at launch and every 6 hours; `DESKMATE_UPDATE_CHECK=0` turns it off). It opens the release page; nothing installs by itself.

**Packaging**
- The macOS build bundles `deskmate-hands` (universal) in `Contents/Resources/bin`. The Automation prompt now says what she controls (Chrome, Spotify, Messages). Builds are still unsigned.

## 0.5.0 and earlier

See the [GitHub releases](https://github.com/MuhammadMurtuzaHussain/deskmate/releases).
