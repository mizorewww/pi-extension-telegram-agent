-- Telegram archive schema. See docs/data-model.md. Applied idempotently at daemon start.
-- Legacy runtime tables are left untouched; new databases use Pi for runtime state.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS raw_updates (
	bot_id TEXT NOT NULL,
	update_id INTEGER NOT NULL,
	received_at INTEGER NOT NULL, -- unix seconds, local receipt time
	json TEXT NOT NULL,
	PRIMARY KEY (bot_id, update_id)
);
CREATE INDEX IF NOT EXISTS idx_raw_updates_received_at ON raw_updates(received_at);

-- Permanent control identities, independent of telemetry retention.
CREATE TABLE IF NOT EXISTS telegram_control_messages (
 chat_id INTEGER NOT NULL,
 message_id INTEGER NOT NULL,
 PRIMARY KEY (chat_id, message_id)
);

-- One unacknowledged routing/control handoff per poller, atomic with ingestion/offset.
CREATE TABLE IF NOT EXISTS pending_telegram_dispatch (
 bot_id TEXT PRIMARY KEY,
 update_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('inserted', 'edited', 'enriched')),
 chat_id INTEGER NOT NULL,
 message_id INTEGER NOT NULL,
 route_version INTEGER NOT NULL,
 FOREIGN KEY (bot_id, update_id) REFERENCES raw_updates(bot_id, update_id)
);

CREATE TABLE IF NOT EXISTS messages (
	chat_id INTEGER NOT NULL,
	message_id INTEGER NOT NULL,
	date INTEGER NOT NULL, -- unix seconds, telegram send time
	thread_id INTEGER,
	sender_id INTEGER,
	display_name TEXT,
	username TEXT,
	sender_tag TEXT,
	sender_chat TEXT,
	is_bot INTEGER NOT NULL DEFAULT 0,
	text TEXT,
	caption TEXT,
	entities TEXT, -- JSON array, raw telegram entities
	rich_message TEXT, -- bounded JSON source; text contains deterministic plain projection
	reply_to_message_id INTEGER,
	reply_to_sender_id INTEGER, -- bounded snapshot from reply_to_message.from/sender_chat
	reply_snapshot TEXT, -- JSON: embedded parent display_name, username, text/caption projection, media
	quote TEXT, -- JSON, selected quote if any
	forward_origin TEXT, -- JSON
	edit_date INTEGER,
	media TEXT, -- JSON: {kind: photo|sticker|..., file_unique_id, file_id, ...}
	first_seen_by TEXT NOT NULL, -- bot id whose poller first delivered this message
	PRIMARY KEY (chat_id, message_id)
);

-- Match lifecycle's TEXT expression: JSON extraction alone has no TEXT affinity,
-- so SQLite cannot seek it when comparing with media.file_unique_id.
CREATE INDEX IF NOT EXISTS idx_messages_media_identity
 ON messages(CAST(json_extract(media, '$.file_unique_id') AS TEXT)) WHERE media IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_revisions (
	chat_id INTEGER NOT NULL,
	message_id INTEGER NOT NULL,
	edit_date INTEGER NOT NULL,
	text TEXT,
	caption TEXT,
	entities TEXT,
	rich_message TEXT,
	PRIMARY KEY (chat_id, message_id, edit_date)
);

-- Append-only provider-facing Telegram event log. `messages` remains the latest UI/read
-- projection; this table is the monotonic ingestion source for agent cursors.
CREATE TABLE IF NOT EXISTS message_events (
	ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
	event_key TEXT NOT NULL UNIQUE,
	chat_id INTEGER NOT NULL,
	message_id INTEGER NOT NULL,
	revision INTEGER NOT NULL,
	kind TEXT NOT NULL, -- message | edit | metadata | media_update | note
	event_date INTEGER NOT NULL,
	payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_events_chat_seq ON message_events(chat_id, ingest_seq);
CREATE INDEX IF NOT EXISTS idx_message_events_message_seq ON message_events(chat_id, message_id, ingest_seq);
CREATE INDEX IF NOT EXISTS idx_message_events_date ON message_events(event_date);

CREATE TRIGGER IF NOT EXISTS trg_messages_event_insert
AFTER INSERT ON messages
BEGIN
	INSERT OR IGNORE INTO message_events
		(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
	VALUES (
		'message:' || NEW.chat_id || ':' || NEW.message_id,
		NEW.chat_id, NEW.message_id, 0, 'message', NEW.date,
		json_object(
			'chat_id', NEW.chat_id, 'message_id', NEW.message_id, 'date', NEW.date,
			'thread_id', NEW.thread_id, 'sender_id', NEW.sender_id,
			'display_name', NEW.display_name, 'username', NEW.username,
			'sender_tag', NEW.sender_tag, 'sender_chat', NEW.sender_chat,
			'is_bot', NEW.is_bot, 'text', NEW.text,
			'caption', NEW.caption, 'entities', NEW.entities, 'rich_message', NEW.rich_message,
			'reply_to_message_id', NEW.reply_to_message_id,
			'reply_to_sender_id', NEW.reply_to_sender_id, 'reply_snapshot', NEW.reply_snapshot, 'quote', NEW.quote,
			'forward_origin', NEW.forward_origin, 'edit_date', NEW.edit_date, 'media', NEW.media
		)
	);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_event_edit
AFTER UPDATE OF text, caption, entities, rich_message, edit_date ON messages
WHEN NEW.edit_date IS NOT NULL AND NEW.edit_date IS NOT OLD.edit_date
BEGIN
	INSERT OR IGNORE INTO message_events
		(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
	VALUES (
		'edit:' || NEW.chat_id || ':' || NEW.message_id || ':' || NEW.edit_date,
		NEW.chat_id, NEW.message_id, NEW.edit_date, 'edit', NEW.edit_date,
		json_object(
			'chat_id', NEW.chat_id, 'message_id', NEW.message_id, 'date', NEW.date,
			'thread_id', NEW.thread_id, 'sender_id', NEW.sender_id,
			'display_name', NEW.display_name, 'username', NEW.username,
			'sender_tag', NEW.sender_tag, 'sender_chat', NEW.sender_chat,
			'is_bot', NEW.is_bot, 'text', NEW.text,
			'caption', NEW.caption, 'entities', NEW.entities, 'rich_message', NEW.rich_message,
			'reply_to_message_id', NEW.reply_to_message_id,
			'reply_to_sender_id', NEW.reply_to_sender_id, 'reply_snapshot', NEW.reply_snapshot, 'quote', NEW.quote,
			'forward_origin', NEW.forward_origin, 'edit_date', NEW.edit_date, 'media', NEW.media
		)
	);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_event_metadata
AFTER UPDATE OF reply_to_sender_id, reply_snapshot ON messages
WHEN (OLD.reply_to_sender_id IS NULL AND NEW.reply_to_sender_id IS NOT NULL)
  OR (OLD.reply_snapshot IS NULL AND NEW.reply_snapshot IS NOT NULL)
BEGIN
	INSERT OR IGNORE INTO message_events
		(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
	VALUES (
		'metadata:' || NEW.chat_id || ':' || NEW.message_id ||
			CASE WHEN OLD.reply_snapshot IS NULL AND NEW.reply_snapshot IS NOT NULL THEN ':reply-content' ELSE ':reply-sender' END,
		NEW.chat_id, NEW.message_id, 1, 'metadata', CAST(strftime('%s','now') AS INTEGER),
		json_object(
			'chat_id', NEW.chat_id, 'message_id', NEW.message_id, 'date', NEW.date,
			'thread_id', NEW.thread_id, 'sender_id', NEW.sender_id,
			'display_name', NEW.display_name, 'username', NEW.username,
			'sender_tag', NEW.sender_tag, 'sender_chat', NEW.sender_chat,
			'is_bot', NEW.is_bot, 'text', NEW.text,
			'caption', NEW.caption, 'entities', NEW.entities, 'rich_message', NEW.rich_message,
			'reply_to_message_id', NEW.reply_to_message_id,
			'reply_to_sender_id', NEW.reply_to_sender_id, 'reply_snapshot', NEW.reply_snapshot, 'quote', NEW.quote,
			'forward_origin', NEW.forward_origin, 'edit_date', NEW.edit_date, 'media', NEW.media
		)
	);
END;

CREATE TABLE IF NOT EXISTS media (
	file_unique_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL, -- photo | sticker | animation | video | document
	mime TEXT,
	local_path TEXT, -- cache-relative source filename; resolved inside configured data/media
	vision TEXT, -- JSON: {model, kind, text, at} — vision-mode description shared by all bots
	sticker_set TEXT,
	sticker_emoji TEXT,
	short_id TEXT UNIQUE -- s<N> catalog id shown to the model for sticker sending
);

-- per-bot telegram file_id -> our media identity (file_id is bot-specific)
CREATE TABLE IF NOT EXISTS media_file_ids (
	bot_id TEXT NOT NULL,
	file_id TEXT NOT NULL,
	file_unique_id TEXT NOT NULL,
	PRIMARY KEY (bot_id, file_id)
);

CREATE TABLE IF NOT EXISTS bot_state (
	bot_id TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (bot_id, key)
);

-- Durable idempotency evidence for insert/enrichment routing windows.
CREATE TABLE IF NOT EXISTS routing_claims (
	chat_id INTEGER NOT NULL,
	message_id INTEGER NOT NULL,
	bot_id TEXT NOT NULL,
	route_version INTEGER NOT NULL,
	reason TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (chat_id, message_id, bot_id, route_version)
);
CREATE INDEX IF NOT EXISTS idx_routing_claims_message ON routing_claims(chat_id, message_id, status);

CREATE TABLE IF NOT EXISTS aliases (
	chat_id INTEGER NOT NULL,
	user_id INTEGER NOT NULL,
	alias TEXT NOT NULL,
	PRIMARY KEY (chat_id, user_id)
);

-- daemon-wide singleton state (router secret, schema version, ...)
CREATE TABLE IF NOT EXISTS daemon_state (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- Substring index over message text for tg_messages (trigram: CJK needs no word breaks; queries of
-- 3+ characters). External content: the rows live in messages and these triggers keep it in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
	text, caption, content = 'messages', content_rowid = 'rowid', tokenize = 'trigram case_sensitive 0'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
	INSERT INTO messages_fts (rowid, text, caption) VALUES (new.rowid, new.text, new.caption);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
	INSERT INTO messages_fts (messages_fts, rowid, text, caption) VALUES ('delete', old.rowid, old.text, old.caption);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF text, caption ON messages BEGIN
	INSERT INTO messages_fts (messages_fts, rowid, text, caption) VALUES ('delete', old.rowid, old.text, old.caption);
	INSERT INTO messages_fts (rowid, text, caption) VALUES (new.rowid, new.text, new.caption);
END;
