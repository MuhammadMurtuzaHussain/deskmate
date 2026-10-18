---
name: whatsapp-message
description: Send a WhatsApp message to a person or group from the WhatsApp desktop app on macOS. Use when the user asks to message, text or tell someone on WhatsApp.
license: MIT
compatibility: macOS with the WhatsApp desktop app; Deskmate runs it as the skill_whatsapp_message tool (skill.json)
metadata:
  author: deskmate
---

# WhatsApp message

In Deskmate this is a ready-made routine: call `skill_whatsapp_message` with `to` (the chat as WhatsApp names it)
and `text` (exactly what to send). It reads the message back and waits for a yes before it sends.

## Steps (what the routine does, for any agent doing it by hand)
1. Open WhatsApp, or bring it to the front; a cold start takes a few seconds.
2. Press ⌘F to search the chats and type the person or group.
3. Press Return to open the top result, then check the chat header shows that name.
4. Ask the user before sending, then click into the message box and paste the text.
5. Check the box holds exactly the text, then press Return to send.

## App quirks
- Return in the search field only opens the chat; Return in the message box sends.
- Pasting keeps emoji and line breaks intact; typing does not.

## Edge cases
- No chat matches the name: stop before typing anything and say so.
- Several people share a first name: ask which one, or use the full name as saved.
