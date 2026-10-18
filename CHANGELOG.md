# Changelog

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
