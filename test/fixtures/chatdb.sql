-- A cut-down Messages database (the tables and columns Deskmate reads from ~/Library/Messages/chat.db), for
-- test/imessage.test.ts. Handles: the user is +15550001111 / me@example.com; +15550002222 is on their allowlist;
-- +15559990000 (Eve) and the group are strangers. Texts on recent macOS live in attributedBody (a typedstream blob),
-- so most rows here have text NULL, as the real ones do.
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, display_name TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT, attributedBody BLOB);
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER DEFAULT 0);
CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));

INSERT INTO handle (ROWID, id, service) VALUES (1, '+15550001111', 'iMessage'), (2, '+15550002222', 'iMessage'), (3, '+15559990000', 'iMessage'), (4, 'friend@example.com', 'iMessage');
INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name) VALUES
  (1, 'iMessage;-;+15550001111', 45, '+15550001111', 'iMessage'),
  (2, 'iMessage;-;+15550002222', 45, '+15550002222', 'iMessage'),
  (3, 'iMessage;-;+15559990000', 45, '+15559990000', 'iMessage'),
  (4, 'iMessage;+;chat123456', 43, 'chat123456', 'iMessage');

-- The rows before Deskmate started: never acted on.
INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me) VALUES (1, 'old-1', 'old note to self', 1, 'iMessage', 813999600000000000, 1);
INSERT INTO chat_message_join VALUES (1, 1, 0);
