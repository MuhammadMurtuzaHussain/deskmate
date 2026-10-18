---
name: telegram-message
description: Send a Telegram message to a person, group or channel from the Telegram desktop app on macOS. Use when the user asks to message, text or ping someone on Telegram.
license: MIT
compatibility: macOS with the Telegram desktop app; Deskmate runs it as the skill_telegram_message tool (skill.json)
metadata:
  author: deskmate
---

# Telegram message

In Deskmate this is a ready-made routine: call `skill_telegram_message` with `to` and `text`. It reads the message
back and waits for a yes before it sends.

## Steps (what the routine does, for any agent doing it by hand)
1. Open Telegram, or bring it to the front.
2. Press ⌘K (Quick Search) and type the person, group or channel.
3. Press Return to open the top result, then check the chat shows that name.
4. Ask the user before sending, then focus the message box and paste the text.
5. Check the box holds exactly the text, then press Return to send.

## App quirks
- ⌘K is Telegram's quick switcher; ⌘F searches inside the open chat instead.

## Edge cases
- Channels you only read have no message box: say so instead of typing.
