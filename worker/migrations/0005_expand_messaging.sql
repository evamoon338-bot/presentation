ALTER TABLE messages ADD COLUMN attachment_data TEXT;
ALTER TABLE messages ADD COLUMN attachment_mime TEXT;
ALTER TABLE messages ADD COLUMN attachment_name TEXT;
ALTER TABLE messages ADD COLUMN edited_at TEXT;
ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN forwarded_from_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE group_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE group_conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES group_conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(conversation_id,user_id)
);

CREATE TABLE group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES group_conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  attachment_data TEXT,
  attachment_mime TEXT,
  attachment_name TEXT,
  edited_at TEXT,
  reply_to_id INTEGER REFERENCES group_messages(id) ON DELETE SET NULL,
  forwarded_from_id INTEGER REFERENCES group_messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK(length(emoji) BETWEEN 1 AND 8),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(message_id,user_id,emoji)
);

CREATE TABLE group_message_reactions (
  message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK(length(emoji) BETWEEN 1 AND 8),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(message_id,user_id,emoji)
);

CREATE TABLE chat_presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE chat_typing (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('direct','group')),
  target_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE voice_calls (
  id TEXT PRIMARY KEY,
  caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('ringing','accepted','rejected','ended')),
  offer TEXT NOT NULL,
  answer TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE voice_call_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX group_members_user ON group_conversation_members(user_id,conversation_id);
CREATE INDEX group_messages_conversation ON group_messages(conversation_id,id);
CREATE INDEX voice_calls_callee ON voice_calls(callee_id,status,updated_at);
CREATE INDEX voice_candidates_call ON voice_call_candidates(call_id,id);
