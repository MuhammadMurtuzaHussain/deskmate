# Chat apps: reach her from your phone

Text her from the chat apps you already use, wherever you are: Telegram, Discord, iMessage, Slack, or Signal. Every
message goes through the same path as typing in her command bar, and everything she says while she works on it comes
back to the chat it came from: the steps as she goes, the read-back questions (with **Yes** / **No** buttons where the
app has them), the answer, pictures and files you ask for.

Each app is **off until you set it up**, and **only you** can reach her through it. Nothing listens on your Mac: every
channel connects out (a long poll, a WebSocket, a database read), so there is no server and no open port.

| app | how it connects | how you become the owner | strangers get |
|---|---|---|---|
| Telegram | Bot API long polling, a bot of your own | send `/start`, say yes on the Mac | one "not paired" line a day, nothing more |
| Discord | gateway WebSocket (direct messages only), a bot of your own | DM the bot the code Setup shows | one "not paired" line a day |
| iMessage | reads `~/Library/Messages/chat.db`, answers through Messages | your own handles, typed into Setup | silence |
| Slack | Socket Mode WebSocket, an app of your own | DM the app the code Setup shows | one "not paired" line a day |
| Signal | `signal-cli` linked to your account as a second device | your own number, typed into Setup | silence |
| WhatsApp | not available: [why](#whatsapp) | | |

Set them up in **Setup → 4 · From your phone** (menu-bar icon → Setup…). The tray menu's **Chat apps** submenu shows
each one's state (on, off, not paired, stopped and why) and switches it on and off.

## What you can send

Anything you would type in her command bar: "message sam on Discord saying I'm late", "what's on my screen?", "ask
Claude to fix the failing tests in deskmate", "every weekday at 9 summarise my Slack". And a few things that only make
sense from the phone:

| from the phone | she does |
|---|---|
| "send me a screenshot" | sends a picture of your screen right now (her own window greyed out) |
| "send me the PDF I just downloaded", "send me my CV" | finds it (the newest one in Downloads, or by name), reads it back with its name, size and folder, and sends it only after your yes |
| a voice note | transcribes it with her local Whisper (nothing leaves the Mac for that), shows you what she heard (`🎤 "…"`), then does it |
| `/selfie` | a picture of her as she is on screen |
| `/stop` | stops what she is doing |
| `/help` | what you can send |
| `/unpair` | forgets this chat (Telegram, Discord, Slack); pairing again needs the Mac |

**Voice replies** (optional): tray → Chat apps → *Answer voice notes with a voice note*, or the switch in Setup. When
you send a voice note she answers in text and also with a clip in her voice (Kokoro).

A Claude Code job started from a chat reports back there when it ends, however long it takes. What she tells you on
her own (a job done, a reminder, a scheduled run while you are away, a question a scheduled run needs answered) goes to
the chat app you used last.

## Setting each one up

### Telegram

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name, and copy the token
   (`123456:ABC…`).
2. Setup → **Telegram**: paste it, **Check and use**. (Or `DESKMATE_TELEGRAM_TOKEN=…` in `.env`; a token pasted in
   Setup wins.)
3. On your phone, open your bot and send `/start`. The phone shows a four-digit code; on the Mac she asks "Someone on
   Telegram, *you*, wants to control me from their phone. The code is … Is that you?". Check the code, then say or type
   yes, or press **Allow** in Setup.

### Discord

1. At [discord.com/developers/applications](https://discord.com/developers/applications): **New Application** → **Bot**
   → **Reset Token**, and copy it. No privileged intents are needed: bots get the text of direct messages sent to them
   without the Message Content intent, and she only asks for direct messages.
2. **Installation** → turn on **User Install**, open the install link, and add the app to your account, so you can DM
   it. (Or add the bot to a private server of yours and DM it from the member list.)
3. Setup → **Discord**: paste the token, **Check and use**, then **Pair**. Setup shows a six-digit code for ten minutes:
   DM it to the bot. That account is now the owner.

Messages in servers are never acted on, even from you.

### iMessage (macOS)

She reads the Messages database on your Mac and answers in the same chat through the Messages app.

1. Setup → **iMessage**: your own phone number (with the country code, `+1…`) and your Apple ID email, one per line.
   Add any other number of yours (a work phone) if you want to text her from it.
2. macOS keeps the Messages database private: **System Settings → Privacy & Security → Full Disk Access** → turn on
   Deskmate (Electron when you run from source). Setup tells you when it is missing.
3. Messages needs Automation permission once, to answer (macOS asks the first time she sends).

To reach her, **text yourself** from your iPhone (start a conversation with your own number or Apple ID). She answers in
that chat.

What she reads, and what she never does:

- Only rows newer than the newest one when she started: nothing old is ever acted on.
- Only two kinds of message reach her: one you sent to yourself, and one that came in from a handle on your list, in a
  one-to-one chat. Everything else (your texts to friends, anyone writing to you, group chats, reactions) is skipped
  without being read further or logged. She never answers anyone who is not on your list.
- A message that came in from a listed handle counts only over iMessage, whose senders Apple checks. An SMS (or RCS)
  "from" one of your numbers is ignored: a text message's sender can be forged.
- Her own replies show up in the database too; she recognises them and does not read them as yours. A note to self
  that shows up twice (the sent and the received copy) is acted on once.

### Slack

1. At [api.slack.com/apps](https://api.slack.com/apps): **Create New App** → **From a manifest**, pick your workspace,
   and paste this:

   ```yaml
   display_information:
     name: Deskmate
   features:
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     bot_user:
       display_name: Deskmate
   oauth_config:
     scopes:
       bot: [chat:write, im:history, im:read, files:read, files:write]
   settings:
     event_subscriptions:
       bot_events: [message.im]
     socket_mode_enabled: true
   ```

2. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`, under OAuth & Permissions).
3. **Basic Information → App-Level Tokens → Generate**, with the `connections:write` scope; copy it (`xapp-…`).
4. Setup → **Slack**: paste both, **Check and use**, then **Pair**, and DM the app the code.

Only direct messages to the app are read; channels are not.

### Signal

Signal has no bot API, so this uses [signal-cli](https://github.com/AsamK/signal-cli), linked to your own account as
a second device, like Signal Desktop. Deskmate never links it for you.

1. `brew install signal-cli`
2. `signal-cli link -n Deskmate`, and scan the code it prints with Signal on your phone (**Settings → Linked devices**).
3. Setup → **Signal**: your number (`+1…`), and any other numbers of yours. **Check and use**.

To reach her, message yourself (**Note to Self**). She runs `signal-cli -a <your number> jsonRpc` while Signal is on,
and answers there. Messages from anyone not on your list, and group messages, are never answered. signal-cli is
unofficial software; it uses Signal's own protocol library and is widely used, but read its README before you link it.

### WhatsApp

Not available, on purpose:

- **The official WhatsApp Business Platform** (Cloud API) needs a Meta business account, a phone number that is not
  your own WhatsApp number, and a public HTTPS webhook for incoming messages (Deskmate opens no port; a tunnel would put
  your Mac on the internet). And since 15 January 2026 the WhatsApp Business Solution terms bar general-purpose AI
  assistants whose main job is the assistant itself, which is what she is.
- **Unofficial WhatsApp Web clients** (Baileys, whatsapp-web.js) log in as a linked device on your own number by
  reverse-engineering the protocol. That breaks WhatsApp's terms, numbers that use them get banned, and the library
  would hold a live session with every chat you have.

Neither can be done responsibly today. She can still *send* WhatsApp messages for you from the Mac (the bundled
WhatsApp skill drives the desktop app after your yes); she just cannot be reached through it. Use Telegram, Signal or
iMessage from your phone instead.

## What keeps it safe

- **One owner per app.** On Telegram, Discord and Slack only the paired account, in its private chat with the bot, can
  reach her: both the chat and the sender are checked. On iMessage and Signal only your own handles. Pairing always
  needs the Mac: a yes there (Telegram), or a code only the Mac shows that works once, for ten minutes, with three
  tries per account (Discord, Slack). After a refused `/start`, more are ignored for a minute; an account refused twice
  is ignored until the app is switched off and on.
- **Strangers never reach her.** Anyone else gets at most one short line a day ("This is a private Deskmate…") on the
  bot apps, and nothing at all on iMessage and Signal. Their messages never go to her brain. Group chats are ignored.
- **Same rules as at the keyboard, and then some.** A message from a chat app counts as typed, so every read-back that
  applies to typed requests applies. On top of that, the turn is marked as coming over the network (the injection
  guard, docs/AGENT.md): anything that sends, deletes, buys, starts a Claude job or writes through a tool server asks
  you first, on the phone. A question nobody answers within a minute is a no.
- **Files leave only after a yes.** "Send me …" reads back the file's name, size and folder first, every time. Files
  that hold keys or passwords are never sent (`~/.ssh`, `~/.aws`, `~/.gnupg`, keychains, the Messages folder, her own
  settings, `.env`, `.pem`/`.key` files, `id_rsa` and kin), and nothing over 25 MB.
- **Nothing stale.** A message that reached her more than two minutes late (the Mac was asleep, Deskmate was closed) is
  not acted on; she tells you, and you send it again if you still want it.
- **Tokens stay in her settings file** (`<user data>/settings.json`, readable only by you) and are never logged; log
  lines that could echo a URL with a token in it are scrubbed.

## Privacy

What you send her and what she answers goes through that app's servers: Telegram (bot chats are not end-to-end
encrypted), Discord, Slack, Apple (iMessage, end-to-end encrypted), or Signal (end-to-end encrypted). So do the
screenshots and files you ask for, and her notices to the app you used last. With Claude as her brain, your message and
what her tools find go to Anthropic, as when you type. Voice notes are transcribed on your Mac.

## For developers

- `src/main/channels/`: `channel.ts` (the Channel interface), `hub.ts` (pairing, owners, strangers, routing, voice
  notes), one file per app, `sendfile.ts` (which file "the PDF I just downloaded" is, and what is never sent).
- Testing without accounts: `DESKMATE_TELEGRAM_API_URL`, `DESKMATE_DISCORD_API_URL` and `DESKMATE_SLACK_API_URL` point
  the channels at fake APIs; `DESKMATE_CHAT_DB` reads a fixture Messages database, and `DESKMATE_DEBUG_IMESSAGE_SEND`
  writes what she would send to a file instead of the Messages app. `npm test` covers the hub, each app against fakes,
  and chat.db parsing against `test/fixtures/chatdb*.sql`.
