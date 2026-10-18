# Skills

A skill teaches her one routine in one app ("message someone on WhatsApp", "start a note") without touching the
core. It is a folder with a `skill.json` recipe and, if you need it, a small handler file. She loads skills at
startup from two places:

| where | what |
|---|---|
| `skills/` in the app (this repository) | the bundled examples: `whatsapp-message`, `telegram-message`, `notes-new-note` |
| `<user data>/skills/` | yours. Tray → **Skills** → **Open my skills folder**. A skill here with the same `name` replaces a bundled one. |

After adding or editing one, use tray → **Skills** → **Reload skills**. The log says which skills loaded and why any
did not (`[skills] … not loaded: step 3 (key): "combo" is missing`).

A loaded skill is used three ways:

1. **Said or typed.** A sentence that matches one of its triggers runs it: "message Sam on WhatsApp: running late".
   Skills are checked before the built-in app routines, since their triggers name their app.
2. **By the Claude agent.** With Claude as her brain, each skill is a tool (`skill_whatsapp_message`) the agent
   can call with its slots instead of driving the app by hand.
3. **In a plan.** The planner can hand a step to the `skill` worker; she matches the step to a skill, or asks her
   brain to pick one and fill in its slots.

## A whole skill

```json
{
  "name": "whatsapp-message",
  "title": "WhatsApp message",
  "description": "Send a WhatsApp message to a person or group",
  "app": { "name": "WhatsApp", "bundleId": "net.whatsapp.WhatsApp", "windows": "WhatsApp" },
  "slots": [
    { "name": "to", "description": "The person or group, as named in WhatsApp" },
    { "name": "text", "description": "Exactly what to send" }
  ],
  "triggers": [
    "whatsapp[:] (message|text|tell|ping) {to}[:|,] [that|saying] {text}",
    "(message|text|tell) {to} (on|in|over|via) whatsapp[:|,] [that|saying] {text}",
    "send {text} to {to} (on|in|over|via) whatsapp"
  ],
  "steps": [
    { "do": "launch", "waitMs": 4000 },
    { "do": "key", "combo": "cmd+f", "note": "File › Search" },
    { "do": "type", "text": "{to}" },
    { "do": "wait", "ms": 1200 },
    { "do": "key", "combo": "return", "send": false, "note": "opens the top search result" },
    { "do": "locate", "text": "{to}", "fail": "I couldn't see a chat with {to} in WhatsApp, so I didn't type anything." },
    { "do": "confirm", "question": "Send \"{text}\" to {to} on WhatsApp?", "no": "Okay, not sent." },
    { "do": "focusInput", "hint": "message" },
    { "do": "paste", "text": "{text}" },
    { "do": "readBack", "text": "{text}" },
    { "do": "key", "combo": "return", "send": true }
  ],
  "done": "Sent to {to} on WhatsApp."
}
```

| field | |
|---|---|
| `name` | Unique id: 2–48 lower-case letters, digits and dashes. |
| `title`, `description` | Shown in the tray, and to the agent and the planner. Write the description as what it does. |
| `app.name`, `app.bundleId` | The app on macOS. Find a bundle id with `osascript -e 'id of app "WhatsApp"'`. |
| `app.windows` | The app's process name on Windows (experimental hands), e.g. `WhatsApp`. Defaults to `app.name`. |
| `app.messaging` | `true` for an app where Return sends something to other people that is not on the built-in list (Discord, Slack, Messages, WhatsApp, Telegram, Mail, Outlook, Teams, Signal). |
| `slots` | The blanks the triggers fill. `optional: true` for ones that may be empty. |
| `triggers` | Phrases that run it (below). |
| `steps` | What her hands do, in order (below). |
| `done` | Her line when it worked. `{slot}` works here, and `{where}` is the chat a `checkTitle` step found. |

Any step may carry a `note` for people reading the file; she ignores it.

## Trigger phrases

| write | matches |
|---|---|
| `{to}`, `{text}` | some words, captured into that slot |
| `(a\|b\|c)` | one of them |
| `[words]` | optional (`[a\|b]`: optionally one of them) |
| anything else | itself, any case; any run of spaces matches any run of spaces |

"Can you", "could you please", "hey" in front and `.`, `!` or `?` at the end are always allowed. Quotes around a
slot come off; for `{to}`, so do "the", "my" and "@". Optional parts are tried present first, which is what lets a
name have several words: in `tell {to} [that] {text}`, "tell the night shift that the build is green" gives
`to = "the night shift"`. Without a word or a `:` to end it, a slot before another slot takes one word, so give
your phrases a separator. Every trigger must use every required slot.

Order matters: the first trigger (of the first skill) that matches wins, so put the more specific phrases first.

## Steps

Every step that presses, types or pastes goes to the skill's own app and is refused if another app has come to
the front (the run stops with "You switched apps, so I stopped").

| `do` | fields | what it does |
|---|---|---|
| `launch` | `waitMs` (3000) | Opens the app or brings it to the front; waits `waitMs` more on a cold start. |
| `key` | `combo`, `send` | A key or chord: `cmd+f`, `cmd+shift+n`, `return`, `escape`, `down`, `tab`. On Windows `cmd` is Ctrl. |
| `type` | `text` | Types it key by key (search boxes). |
| `paste` | `text` | Pastes it through the clipboard and puts the clipboard back (message boxes; faster, handles emoji). |
| `focusInput` | `hint` | Puts the caret in the text box whose label mentions `hint` ("message"), unless a text box already has it. No hint: the last text box. |
| `checkTitle` | `contains`, `timeoutMs` (2500), `fail` | The app's window title must hold every word of `contains` (Discord, Slack and most Electron apps put the chat there). |
| `locate` | `text`, `timeoutMs` (2500), `fail` | Something in the app's window must have that name or value. For apps whose title doesn't change. |
| `menu` | `path` | A menu-bar item by its titles, matched from the end: `["File", "New Note"]`. Fails plainly if it is missing or greyed out. |
| `wait` | `ms` | Up to 10 s. |
| `confirm` | `question`, `no` | Reads the question out and waits for a yes. A no ends the skill with `no` ("Okay, I left it."). After a yes the app is brought back and the last `checkTitle` is checked again. |
| `readBack` | `text` | The focused text box must hold `text` before going on. |

Text fields take `{slot}`. Slot values that look like a password or a card number are refused before anything runs.

### The send rules

These are checked when the skill loads (a skill that breaks them doesn't load) and again while it runs:

- In a messaging app, every `return` / `enter` key says whether it sends (`"send": true`) or only opens something
  such as a search result (`"send": false`).
- Once text has gone into a box reached with `focusInput` (the message box), Return there can only be a send.
- A send needs a `confirm` before it and a `readBack` after the last text went in.

`DESKMATE_CONFIRM_SENDS` (`always` by default) decides whether `confirm` actually asks, the same as for Discord and
Slack messages; `never` skips the question but never the read-back.

## Handlers (code)

A `handler.mjs` (or `handler.js`, `handler.cjs`) beside `skill.json` may export:

```js
// Tidy or fill the slots before the run; return null to refuse.
export function slots(slots, said) {
  return { ...slots, text: slots.text.trim() }
}

// Do the work instead of "steps". ctx.hands only reaches the skill's app; ctx.send() presses Return (or a combo
// you give) only after ctx.confirm() got a yes and a read-back passed.
export async function run(ctx) {
  await ctx.hands.launch()
  if (!(await ctx.confirm(`Send "${ctx.slots.text}" to ${ctx.slots.to}?`))) return { say: 'Okay, not sent.' }
  await ctx.run([
    { do: 'focusInput', hint: 'message' },
    { do: 'paste', text: '{text}' },
    { do: 'readBack', text: '{text}' }
  ])
  await ctx.send()
  return { say: `Sent to ${ctx.slots.to}.` }
}
```

`ctx` has `slots`, `app` (the id her hands use), `hands` (`launch`, `key`, `type`, `paste`, `focusInput`, `focused`,
`windowTitle`, `menu`, `locate`), `run(steps)`, `send(combo?)`, `confirm(question)`, `step(label)` and `log(line)`.
In a messaging app, `ctx.hands.key('return')` is refused once any text has been typed: sending goes through
`ctx.send()`. The bundled Notes skill has a `slots()` handler that drops a trailing "in notes".

**A handler is code that runs inside Deskmate with its full rights.** Bundled skills' handlers always load. A
handler in your user skills folder only loads with `DESKMATE_SKILL_CODE=1` in `.env`; without it that skill is
left out and the log says why. Only turn it on for code you wrote or read.

## Testing a skill

- Write the skill, reload, and check the log line.
- Try it on something harmless first: WhatsApp's "Message yourself" chat, Telegram's Saved Messages, a scratch note.
- Every run writes a log to `<user data>/tasks/skill-<name>-….log` with each step and what the app reported.
- For a pull request, add a case to `test/skills.test.ts`: it runs skills against a fake pair of hands that records
  every key, so you can check what would be pressed, and in which app, without touching a real one.

The bundled examples were written from the apps' own menus and shortcuts (WhatsApp: File › Search ⌘F; Telegram:
Quick Search ⌘K; Notes: File › New Note) and are tested against the fake hands. Chat apps change their layouts
often: if one stops finding the chat box, the log shows which step stopped, and a fix is usually one step.
