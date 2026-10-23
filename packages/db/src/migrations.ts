import type { Db } from "./sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Thread location flags are aggregates over the thread's messages:
 *   in_inbox = any message in inbox (not trash/spam)
 *   in_trash = every message in trash
 *   in_spam  = every non-trash message is spam
 * Views derive from them (see queries.ts VIEW_WHERE). Each hot view has its own
 * partial index ordered (last_date DESC, id DESC) so list pages are index walks.
 */
const SCHEMA_V1 = /* sql */ `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('imap', 'gmail')),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'indigo',
  provider_config TEXT NOT NULL DEFAULT '{}',
  secret_ref TEXT,
  sync_state TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_thread_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  last_date INTEGER NOT NULL DEFAULT 0,
  last_from_name TEXT NOT NULL DEFAULT '',
  last_from_email TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  in_inbox INTEGER NOT NULL DEFAULT 0,
  has_sent INTEGER NOT NULL DEFAULT 0,
  in_trash INTEGER NOT NULL DEFAULT 0,
  in_spam INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX threads_provider ON threads(account_id, provider_thread_id) WHERE provider_thread_id IS NOT NULL;

-- view indexes (global + per account)
CREATE INDEX threads_inbox      ON threads(last_date DESC, id DESC) WHERE in_inbox = 1;
CREATE INDEX threads_acct_inbox ON threads(account_id, last_date DESC, id DESC) WHERE in_inbox = 1;
CREATE INDEX threads_all        ON threads(last_date DESC, id DESC) WHERE in_trash = 0 AND in_spam = 0;
CREATE INDEX threads_acct_all   ON threads(account_id, last_date DESC, id DESC) WHERE in_trash = 0 AND in_spam = 0;
CREATE INDEX threads_archive    ON threads(last_date DESC, id DESC) WHERE in_inbox = 0 AND in_trash = 0 AND in_spam = 0;
CREATE INDEX threads_acct_archive ON threads(account_id, last_date DESC, id DESC) WHERE in_inbox = 0 AND in_trash = 0 AND in_spam = 0;
CREATE INDEX threads_starred    ON threads(last_date DESC, id DESC) WHERE is_starred = 1 AND in_trash = 0 AND in_spam = 0;
CREATE INDEX threads_sent       ON threads(last_date DESC, id DESC) WHERE has_sent = 1 AND in_trash = 0 AND in_spam = 0;
CREATE INDEX threads_trash      ON threads(last_date DESC, id DESC) WHERE in_trash = 1;
CREATE INDEX threads_spam       ON threads(last_date DESC, id DESC) WHERE in_spam = 1 AND in_trash = 0;
CREATE INDEX threads_order      ON threads(last_date DESC, id DESC);
CREATE INDEX threads_unread_inbox ON threads(account_id) WHERE in_inbox = 1 AND unread_count > 0;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  provider_msg_id TEXT,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  from_domain TEXT NOT NULL DEFAULT '',
  from_name_norm TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  recipients_text TEXT NOT NULL DEFAULT '',
  recipients_norm TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  subject_norm TEXT NOT NULL DEFAULT '',
  date INTEGER NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  body_html TEXT,
  -- last BODY_TAIL_TOKENS normalized tokens, space-joined (exact body endsWith in SQL)
  body_tail_norm TEXT NOT NULL DEFAULT '',
  body_state TEXT NOT NULL DEFAULT 'none' CHECK (body_state IN ('none', 'partial', 'full')),
  list_id TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  in_inbox INTEGER NOT NULL DEFAULT 0,
  is_sent INTEGER NOT NULL DEFAULT 0,
  is_draft INTEGER NOT NULL DEFAULT 0,
  is_trash INTEGER NOT NULL DEFAULT 0,
  is_spam INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  gmail_labels TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX messages_provider ON messages(account_id, provider_msg_id) WHERE provider_msg_id IS NOT NULL;
CREATE INDEX messages_thread ON messages(thread_id, date, id);
CREATE INDEX messages_rfc ON messages(account_id, rfc_message_id) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX messages_from ON messages(from_email);
CREATE INDEX messages_domain ON messages(from_domain);
CREATE INDEX messages_list ON messages(list_id) WHERE list_id IS NOT NULL;
CREATE INDEX messages_date ON messages(date);
CREATE INDEX messages_body_pending ON messages(account_id, date DESC) WHERE body_state != 'full';

-- who references whom (threading out-of-order arrivals)
CREATE TABLE message_refs (
  account_id INTEGER NOT NULL,
  ref TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, ref, message_id)
) WITHOUT ROWID;
CREATE INDEX message_refs_msg ON message_refs(message_id);

-- IMAP identity: (mailbox, uidvalidity, uid). A message may live in several mailboxes.
CREATE TABLE message_locations (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  mailbox TEXT NOT NULL,
  uidvalidity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (message_id, mailbox)
);
CREATE UNIQUE INDEX message_locations_uid ON message_locations(account_id, mailbox, uidvalidity, uid);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,
  provider_ref TEXT
);
CREATE INDEX attachments_message ON attachments(message_id);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE thread_categories (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL DEFAULT 'user' CHECK (added_by IN ('user', 'filter', 'agent', 'suggestion')),
  added_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, category_id)
) WITHOUT ROWID;
CREATE INDEX thread_categories_c ON thread_categories(category_id, thread_id);

CREATE TABLE filters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL CHECK (source IN ('manual', 'ai', 'learned')),
  rule_json TEXT NOT NULL,
  learned_key TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_applied_at INTEGER
);

-- prevents applying the same filter twice to a message (e.g. re-evaluation when bodies arrive)
CREATE TABLE filter_applications (
  filter_id INTEGER NOT NULL REFERENCES filters(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (filter_id, message_id)
) WITHOUT ROWID;

CREATE TABLE ops (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_json TEXT NOT NULL DEFAULT '{}',
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ops_ready ON ops(state, next_attempt_at) WHERE state IN ('queued', 'running');
CREATE INDEX ops_account ON ops(account_id, seq);

CREATE TABLE user_actions (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER,
  action TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_domain TEXT NOT NULL,
  list_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX user_actions_at ON user_actions(at);

CREATE TABLE dismissed_suggestions (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  in_reply_to_message_id INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
) WITHOUT ROWID;

-- encrypted blobs (safeStorage); plaintext never touches disk
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  blob BLOB NOT NULL
) WITHOUT ROWID;

-- External-content FTS over a view. The triggers below must project exactly
-- the same expressions as the view, or 'delete' commands corrupt the index.
CREATE VIEW messages_fts_src AS
  SELECT id,
         subject,
         from_name || ' ' || from_email AS from_text,
         recipients_text AS recipients,
         coalesce(body_text, '') AS body
  FROM messages;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_text, recipients, body,
  content = 'messages_fts_src',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_text, recipients, body)
  VALUES (new.id, new.subject, new.from_name || ' ' || new.from_email, new.recipients_text, coalesce(new.body_text, ''));
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, recipients, body)
  VALUES ('delete', old.id, old.subject, old.from_name || ' ' || old.from_email, old.recipients_text, coalesce(old.body_text, ''));
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF subject, from_name, from_email, recipients_text, body_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, recipients, body)
  VALUES ('delete', old.id, old.subject, old.from_name || ' ' || old.from_email, old.recipients_text, coalesce(old.body_text, ''));
  INSERT INTO messages_fts(rowid, subject, from_text, recipients, body)
  VALUES (new.id, new.subject, new.from_name || ' ' || new.from_email, new.recipients_text, coalesce(new.body_text, ''));
END;
`;

/**
 * v2: index of which messages each unsettled op targets. Superseding older ops
 * and the sync's pending-op guard become indexed lookups instead of scanning
 * and JSON-parsing every queued op (quadratic when many ops pile up offline).
 */
const OP_TARGETS_V2 = /* sql */ `
CREATE TABLE op_targets (
  op_id TEXT NOT NULL REFERENCES ops(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  grp TEXT NOT NULL,
  PRIMARY KEY (op_id, message_id)
) WITHOUT ROWID;
CREATE INDEX op_targets_msg ON op_targets(message_id, grp);
INSERT OR IGNORE INTO op_targets (op_id, message_id, grp)
  SELECT o.id, j.value,
         CASE WHEN o.kind IN ('markRead','markUnread') THEN 'read'
              WHEN o.kind IN ('star','unstar') THEN 'star'
              WHEN o.kind IN ('archive','trash','spam','notSpam','moveToInbox') THEN 'location'
              ELSE o.kind END
  FROM ops o, json_each(o.target_json, '$.messageIds') j
  WHERE o.state IN ('queued', 'running');
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial schema", sql: SCHEMA_V1 },
  { version: 2, name: "op target index", sql: OP_TARGETS_V2 },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function migrate(db: Db): { from: number; to: number } {
  const from = Number((db.get<{ user_version: number }>("PRAGMA user_version"))!.user_version);
  if (from > SCHEMA_VERSION) {
    throw new Error(`Database schema v${from} is newer than this app (v${SCHEMA_VERSION}). Update Única.`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  if (from !== SCHEMA_VERSION) db.exec("PRAGMA optimize");
  return { from, to: SCHEMA_VERSION };
}
