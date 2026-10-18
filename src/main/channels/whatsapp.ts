// WhatsApp is not a channel yet, on purpose. The two ways in, and why neither is shipped:
//
// 1. The official WhatsApp Business Platform (Cloud API). It needs a Meta business account, a phone number that is
//    not the user's own WhatsApp number, and a public HTTPS webhook for incoming messages (Deskmate has no server
//    and opens no port; a tunnel would put her on the internet). And since 15 January 2026 the WhatsApp Business
//    Solution terms bar general-purpose AI assistants whose main job is the assistant itself, which is what she is.
// 2. An unofficial WhatsApp Web client (Baileys, whatsapp-web.js). It logs in as a linked device on the user's own
//    number by reverse-engineering the protocol. That breaks WhatsApp's terms, numbers that use it get banned, and the
//    library would hold a live session with every chat the user has.
//
// Neither can be done responsibly today, so WhatsApp stays a stub that explains this in Setup and the tray (see
// docs/CHANNELS.md). Telegram, Discord, iMessage, Slack and Signal reach her from a phone instead.

export const WHATSAPP_REASON =
  "Not available: WhatsApp's official API bars general-purpose AI assistants and needs a public webhook, and unofficial clients get numbers banned. Use Telegram, Signal or iMessage instead."
