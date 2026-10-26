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

/**
 * v3: owner identity, AI secret rename, and local mode for existing installs.
 * - The owner (the "Terno account") is separate from mailboxes: removing its
 *   mailbox only clears account_id. Existing installs adopt their earliest
 *   non-demo account, flagged {"migrated":true} so a future cloud can confirm it.
 * - New installs default to local mode; an install that already has accounts or
 *   settings keeps today's behaviour (localMode:false) until the user opts in.
 */
const OWNER_V3 = /* sql */ `
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'imap')),
  verified_by TEXT NOT NULL CHECK (verified_by IN ('google_oauth', 'imap_login')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  verified_at INTEGER,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  cloud_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE owner_history (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  verified_at INTEGER,
  replaced_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
INSERT INTO owner (id, user_id, email, display_name, provider, verified_by, evidence_json, verified_at, account_id, created_at, updated_at)
  SELECT 1,
         lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
         email, display_name, kind,
         CASE kind WHEN 'gmail' THEN 'google_oauth' ELSE 'imap_login' END,
         '{"migrated":true}', created_at, id, created_at, created_at
  FROM accounts
  WHERE coalesce(json_extract(provider_config, '$.demo'), 0) = 0
  ORDER BY created_at, id
  LIMIT 1;

UPDATE secrets SET name = 'ai:anthropic:apiKey' WHERE name = 'anthropicApiKey';

INSERT INTO settings (key, value_json)
  SELECT 'app', '{}' WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'app') AND EXISTS (SELECT 1 FROM accounts);
UPDATE settings SET value_json = json_set(value_json, '$.localMode', json('false')) WHERE key = 'app';
`;

/**
 * v4: smart categorization (plan 02).
 * - thread_categories is rebuilt (a CHECK can't be altered) to allow 'auto' and
 *   'bulk' and to record the batch an add belongs to (undo). Only its own index
 *   is recreated: no trigger, view or FTS object references it.
 * - cls_examples is the training source of truth, removals included (label -1).
 * - cls_decisions holds suggestions and auto outcomes (safety valve, undo).
 */
const CATEGORIZATION_V4 = /* sql */ `
CREATE TABLE thread_categories_new (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL DEFAULT 'user' CHECK (added_by IN ('user', 'filter', 'agent', 'suggestion', 'auto', 'bulk')),
  added_at INTEGER NOT NULL DEFAULT 0,
  batch_id INTEGER,
  PRIMARY KEY (thread_id, category_id)
) WITHOUT ROWID;
INSERT INTO thread_categories_new (thread_id, category_id, added_by, added_at)
  SELECT thread_id, category_id, added_by, added_at FROM thread_categories;
DROP TABLE thread_categories;
ALTER TABLE thread_categories_new RENAME TO thread_categories;
CREATE INDEX thread_categories_c ON thread_categories(category_id, thread_id);
CREATE INDEX thread_categories_batch ON thread_categories(batch_id) WHERE batch_id IS NOT NULL;

ALTER TABLE categories ADD COLUMN auto_apply INTEGER NOT NULL DEFAULT 1;

-- labeled examples; features = hashed feature vector (core/categorize encodeFeatures)
CREATE TABLE cls_examples (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  label INTEGER NOT NULL CHECK (label IN (-1, 1)),
  weight REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'suggestion', 'bulk', 'agent', 'removal', 'reject')),
  at INTEGER NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  -- 0 for bulk adds past the per-sender content cap: they teach identity only
  content INTEGER NOT NULL DEFAULT 1,
  batch_id INTEGER,
  features BLOB NOT NULL,
  PRIMARY KEY (thread_id, category_id)
) WITHOUT ROWID;
CREATE INDEX cls_examples_cat ON cls_examples(category_id, label);
CREATE INDEX cls_examples_sender ON cls_examples(category_id, sender, at);
-- bulk adds that teach content: at most BULK_CONTENT_CAP per (category, sender), so the cap check is bounded
CREATE INDEX cls_examples_bulk_content ON cls_examples(category_id, sender) WHERE source = 'bulk' AND content = 1;
-- removals are few: the sender back-off reads them once per ingestion slice
CREATE INDEX cls_examples_removals ON cls_examples(at) WHERE label < 0;

CREATE TABLE cls_decisions (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('auto', 'suggest')),
  p REAL NOT NULL,
  explain_json TEXT NOT NULL,
  at INTEGER NOT NULL,
  outcome TEXT CHECK (outcome IN ('kept', 'reverted', 'accepted', 'rejected')),
  PRIMARY KEY (thread_id, category_id)
) WITHOUT ROWID;
CREATE INDEX cls_decisions_pending ON cls_decisions(category_id, at) WHERE kind = 'suggest' AND outcome IS NULL;
-- safety valve: matured outcomes only (read per ingestion slice); pending ones mature at idle
CREATE INDEX cls_decisions_outcomes ON cls_decisions(category_id, outcome) WHERE kind = 'auto' AND outcome IS NOT NULL;
CREATE INDEX cls_decisions_maturing ON cls_decisions(at) WHERE kind = 'auto' AND outcome IS NULL;

CREATE TABLE cat_batches (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);

CREATE TABLE cls_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  features_v INTEGER NOT NULL,
  built_at INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  blob BLOB NOT NULL
);
`;

/**
 * v5: the ⌥-move journal. A move commits its memberships in one transaction
 * and keeps here what it overwrote (source rows with their origin and batch,
 * both categories' examples as training replaces them, decision outcomes) plus per-thread progress of
 * the training it applies afterwards in slices. Undo reads it back.
 */
const MOVES_V5 = `
CREATE TABLE cat_move_threads (
  batch_id INTEGER NOT NULL REFERENCES cat_batches(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  -- 1: not in the destination before the move
  added INTEGER NOT NULL,
  -- 1: was in the source (it gets a removal example)
  moved INTEGER NOT NULL DEFAULT 0,
  -- training (after the move) or example restore (after its undo) done for this thread
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, thread_id)
) WITHOUT ROWID;
CREATE TABLE cat_move_rows (
  batch_id INTEGER NOT NULL REFERENCES cat_batches(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  prev_batch_id INTEGER,
  PRIMARY KEY (batch_id, thread_id)
) WITHOUT ROWID;
CREATE TABLE cat_move_examples (
  batch_id INTEGER NOT NULL REFERENCES cat_batches(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  label INTEGER NOT NULL,
  weight REAL NOT NULL,
  source TEXT NOT NULL,
  at INTEGER NOT NULL,
  sender TEXT NOT NULL,
  content INTEGER NOT NULL,
  example_batch_id INTEGER,
  features BLOB NOT NULL,
  PRIMARY KEY (batch_id, thread_id, category_id)
) WITHOUT ROWID;
CREATE TABLE cat_move_decisions (
  batch_id INTEGER NOT NULL REFERENCES cat_batches(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  outcome TEXT,
  PRIMARY KEY (batch_id, thread_id, category_id)
) WITHOUT ROWID;
`;

/**
 * The FTS5 index over messages + message_bodies. Its rows are the projection
 * (subject, "from_name from_email", recipients, body or ''); every 'delete'
 * command must repeat exactly what is indexed, so:
 * - ingestion writes a message's body row before the message itself, and the
 *   message's insert indexes it with that body (one index write per message);
 * - subject/sender/recipient edits reindex with the current body;
 * - a body arriving, changing or going away reindexes its message (if the
 *   message exists: a body written ahead of its message is indexed with it);
 * - deleting a message (also through cascades) deletes its indexed row with
 *   the body still in place, then the body row.
 */
const FTS_SRC_VIEW = /* sql */ `
CREATE VIEW messages_fts_src AS
  SELECT m.id,
         m.subject,
         m.from_name || ' ' || m.from_email AS from_text,
         m.recipients_text AS recipients,
         coalesce(b.body_text, '') AS body
  FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id;
`;

/**
 * The FTS triggers over messages + message_bodies. With `mark` (v7) they also
 * mark the message dirty for the search outbox: one trigger program per row
 * instead of two. Inserts are the exception: ingestMessages, their only
 * writer, marks a whole slice in one statement.
 */
function ftsTriggers(mark: boolean): string {
  const dirty = (id: string) => (mark ? `\n  INSERT OR IGNORE INTO search_dirty (kind, id) VALUES (0, ${id});` : "");
  // setMessageBody upserts bodies: its conflict clause would override OR IGNORE inside these triggers
  const dirtyBody = (id: string) => (mark ? `\n  INSERT INTO search_dirty (kind, id) SELECT 0, ${id} WHERE NOT EXISTS (SELECT 1 FROM search_dirty WHERE kind = 0 AND id = ${id});` : "");
  return /* sql */ `
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_text, recipients, body)
  VALUES (new.id, new.subject, new.from_name || ' ' || new.from_email, new.recipients_text,
          coalesce((SELECT body_text FROM message_bodies WHERE message_id = new.id), ''));
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, recipients, body)
  VALUES ('delete', old.id, old.subject, old.from_name || ' ' || old.from_email, old.recipients_text,
          coalesce((SELECT body_text FROM message_bodies WHERE message_id = old.id), ''));
  DELETE FROM message_bodies WHERE message_id = old.id;${dirty("old.id")}
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF subject, from_name, from_email, recipients_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, recipients, body)
  VALUES ('delete', old.id, old.subject, old.from_name || ' ' || old.from_email, old.recipients_text,
          coalesce((SELECT body_text FROM message_bodies WHERE message_id = old.id), ''));
  INSERT INTO messages_fts(rowid, subject, from_text, recipients, body)
  VALUES (new.id, new.subject, new.from_name || ' ' || new.from_email, new.recipients_text,
          coalesce((SELECT body_text FROM message_bodies WHERE message_id = new.id), ''));${dirty("new.id")}
END;

CREATE TRIGGER message_bodies_fts_ai AFTER INSERT ON message_bodies
WHEN coalesce(new.body_text, '') != '' AND EXISTS (SELECT 1 FROM messages WHERE id = new.message_id) BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, recipients, body)
  SELECT 'delete', m.id, m.subject, m.from_name || ' ' || m.from_email, m.recipients_text, '' FROM messages m WHERE m.id = new.message_id;
  INSERT INTO messages_fts(rowid, subject, from_text, recipients, body)
  SELECT m.id, m.subject, m.from_name || ' ' || m.from_email, m.recipients_text, new.body_text FROM messages m WHERE m.id = new.message_id;${dirtyBody("new.message_id")}
END;

CREATE TRIGGER message_bodies_fts_au AFTER UPDATE OF body_text ON message_bodies
WHEN coalesce(old.body_text, '') != coalesce(new.body_text, '') AND EXISTS (SELECT 1 FROM messages WHERE id = new.message_id) BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, recipients, body)
  SELECT 'delete', m.id, m.subject, m.from_name || ' ' || m.from_email, m.recipients_text, coalesce(old.body_text, '') FROM messages m WHERE m.id = new.message_id;
  INSERT INTO messages_fts(rowid, subject, from_text, recipients, body)
  SELECT m.id, m.subject, m.from_name || ' ' || m.from_email, m.recipients_text, coalesce(new.body_text, '') FROM messages m WHERE m.id = new.message_id;${dirtyBody("new.message_id")}
END;

CREATE TRIGGER message_bodies_fts_ad AFTER DELETE ON message_bodies
WHEN coalesce(old.body_text, '') != '' AND EXISTS (SELECT 1 FROM messages WHERE id = old.message_id) BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, recipients, body)
  SELECT 'delete', m.id, m.subject, m.from_name || ' ' || m.from_email, m.recipients_text, old.body_text FROM messages m WHERE m.id = old.message_id;
  INSERT INTO messages_fts(rowid, subject, from_text, recipients, body)
  SELECT m.id, m.subject, m.from_name || ' ' || m.from_email, m.recipients_text, '' FROM messages m WHERE m.id = old.message_id;${dirtyBody("old.message_id")}
END;
`;
}

/**
 * v6: bodies move to message_bodies, so list, search and rule scans walk a
 * messages table without the bulk of the text (page-cache fit on the web).
 * The index content is unchanged (same projection), so it isn't rebuilt;
 * only the view and triggers are replaced. body_tail_norm and body_state stay
 * on messages. Messages without a body have no row.
 */
const BODIES_V6 = /* sql */ `
DROP TRIGGER messages_fts_ai;
DROP TRIGGER messages_fts_ad;
DROP TRIGGER messages_fts_au;
DROP VIEW messages_fts_src;

CREATE TABLE message_bodies (
  message_id INTEGER PRIMARY KEY,
  body_text TEXT,
  body_html TEXT
);
INSERT INTO message_bodies (message_id, body_text, body_html)
  SELECT id, body_text, body_html FROM messages WHERE body_text IS NOT NULL OR body_html IS NOT NULL;
ALTER TABLE messages DROP COLUMN body_text;
ALTER TABLE messages DROP COLUMN body_html;
${FTS_SRC_VIEW}${ftsTriggers(false)}`;

/**
 * v7: the search outbox (plans 03/04 reconciliation). Triggers mark the
 * messages and threads whose search projection may have changed, on every
 * table that feeds it (messages, bodies, threads, category membership),
 * cascades included; the before-commit finalizer (outbox.ts) turns them into
 * one revisioned batch of absolute projections or tombstones in the same
 * transaction. The epoch identifies this database's log.
 * Any future rebuild of these tables must recreate their triggers, and new
 * messages and thread aggregates must keep being written by ingestMessages
 * and recomputeThreads.
 */
const OUTBOX_V7 = /* sql */ `
CREATE TABLE search_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  -- size of the retained log
  bytes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO search_state (id, epoch, seq) VALUES (1, lower(hex(randomblob(16))), 0);

CREATE TABLE search_outbox (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  -- JSON IndexChange[]
  changes TEXT NOT NULL
);

-- 0: message, 1: thread. Empty outside a transaction.
CREATE TABLE search_dirty (
  kind INTEGER NOT NULL,
  id INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;

-- a rebuild in progress keeps the log from its start revision
CREATE TABLE search_leases (
  id INTEGER PRIMARY KEY,
  from_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- messages and bodies are marked by their FTS triggers (recreated below) and message inserts by
-- ingestMessages; these columns don't reach FTS
CREATE TRIGGER search_dirty_messages_au AFTER UPDATE OF thread_id, account_id, date, has_attachments, body_state ON messages BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, id) VALUES (0, new.id);
END;
-- thread inserts and aggregate updates all go through recomputeThreads, which marks what it wrote in one
-- statement (a trigger on threads would cost every per-thread UPDATE); deletes, cascades included, here:
CREATE TRIGGER search_dirty_threads_ad AFTER DELETE ON threads BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, id) VALUES (1, old.id);
END;
CREATE TRIGGER search_dirty_categories_ai AFTER INSERT ON thread_categories BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, id) VALUES (1, new.thread_id);
END;
CREATE TRIGGER search_dirty_categories_ad AFTER DELETE ON thread_categories BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, id) VALUES (1, old.thread_id);
END;
CREATE TRIGGER search_dirty_categories_au AFTER UPDATE OF thread_id, category_id ON thread_categories BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, id) VALUES (1, old.thread_id);
  INSERT OR IGNORE INTO search_dirty (kind, id) VALUES (1, new.thread_id);
END;

DROP TRIGGER messages_fts_ai;
DROP TRIGGER messages_fts_ad;
DROP TRIGGER messages_fts_au;
DROP TRIGGER message_bodies_fts_ai;
DROP TRIGGER message_bodies_fts_au;
DROP TRIGGER message_bodies_fts_ad;
${ftsTriggers(true)}
`;

/**
 * v8: moves are exclusive (a thread leaves every other category), so the
 * move journal keeps each removed row with its category. Rows of earlier
 * moves came from the batch's single source.
 */
/**
 * v9: drafts carry their conversation, mode, Bcc, the forwarded message, the
 * quote apart from what the user writes, their open/collapsed state and a
 * revision. Existing drafts are format 1 (bodyText holds everything, quote
 * included) and get their conversation from the message they reply to.
 */
const DRAFTS_V9 = `
ALTER TABLE drafts ADD COLUMN thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN format INTEGER NOT NULL DEFAULT 1;
ALTER TABLE drafts ADD COLUMN mode TEXT NOT NULL DEFAULT 'new';
ALTER TABLE drafts ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE drafts ADD COLUMN subject_edited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN quoted_text TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN include_quote INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN forward_of_message_id INTEGER;
ALTER TABLE drafts ADD COLUMN ui_state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
UPDATE drafts SET mode = 'reply', thread_id = (SELECT thread_id FROM messages WHERE messages.id = drafts.in_reply_to_message_id)
  WHERE in_reply_to_message_id IS NOT NULL;
CREATE INDEX drafts_thread ON drafts(thread_id);
`;

const EXCLUSIVE_MOVES_V8 = `
CREATE TABLE cat_move_rows_v8 (
  batch_id INTEGER NOT NULL REFERENCES cat_batches(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  prev_batch_id INTEGER,
  PRIMARY KEY (batch_id, thread_id, category_id)
) WITHOUT ROWID;
INSERT INTO cat_move_rows_v8 (batch_id, thread_id, category_id, added_by, added_at, prev_batch_id)
  SELECT r.batch_id, r.thread_id, b.scope_json ->> '$.from', r.added_by, r.added_at, r.prev_batch_id
  FROM cat_move_rows r JOIN cat_batches b ON b.id = r.batch_id WHERE b.scope_json ->> '$.from' IS NOT NULL;
DROP TABLE cat_move_rows;
ALTER TABLE cat_move_rows_v8 RENAME TO cat_move_rows;
`;

/**
 * v10: every op takes the next global sequence number (max(seq) + 1); without
 * an index on seq that read scanned every op, so a bulk action queueing
 * thousands paid for all the earlier ones on each insert. And "select all N"
 * pages an account's threads by id: the account indexes are by date.
 */
const OPS_SEQ_V10 = `
CREATE INDEX ops_seq ON ops(seq);
CREATE INDEX threads_account_id ON threads(account_id, id);
`;

/**
 * v11: the unread filter (plan 12). The unread threads by date, carrying
 * every column a view or an account narrows by: a filtered page walks it and
 * tests those in the index, reading only the rows it returns. A view's date
 * index read a table row per thread (an archive of read mail: all of them).
 * And the same by id, for "select all N" pages of a filtered view (they walk
 * ids in order: the whole mailbox, for a few unread threads).
 */
const UNREAD_V11 = `
CREATE INDEX threads_unread ON threads(last_date DESC, id DESC, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE unread_count > 0;
CREATE INDEX threads_unread_id ON threads(id, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE unread_count > 0;
`;

/**
 * v12: the quick filters (plan 15), shaped like v11: threads with
 * attachments and starred threads, by date (pages) and by id (scopes),
 * carrying the columns a view or an account narrows by. Starred gets its own
 * pair because threads_starred leaves out trash and spam.
 */
const FILTERS_V12 = `
CREATE INDEX threads_attach ON threads(last_date DESC, id DESC, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE has_attachments = 1;
CREATE INDEX threads_attach_id ON threads(id, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE has_attachments = 1;
CREATE INDEX threads_starred_f ON threads(last_date DESC, id DESC, account_id, in_inbox, in_trash, in_spam, has_sent) WHERE is_starred = 1;
CREATE INDEX threads_starred_f_id ON threads(id, account_id, in_inbox, in_trash, in_spam, has_sent) WHERE is_starred = 1;
`;

/**
 * v13: rich drafts (plan 16). The written part as mail HTML beside its
 * plain-text alternative; existing drafts are plain ('') and open as their text.
 */
const RICH_DRAFTS_V13 = `
ALTER TABLE drafts ADD COLUMN body_html TEXT NOT NULL DEFAULT '';
`;

/**
 * v14: People and "waiting for your reply" (plan 17). Two thread facts that
 * recomputeThreads keeps with the other aggregates (person NULL: not computed
 * yet), the bulk headers seen at ingest, and the addresses you send from or
 * have written to. Nothing is rewritten here: a background backfill fills
 * them in slices (facts.ts), its progress in settings, its queue the pending
 * index. The filters' indexes are shaped like v11/v12's.
 */
const PEOPLE_V14 = `
ALTER TABLE threads ADD COLUMN person INTEGER;
ALTER TABLE threads ADD COLUMN waiting_since INTEGER;
ALTER TABLE messages ADD COLUMN is_bulk INTEGER NOT NULL DEFAULT 0;
CREATE TABLE correspondents (
  email TEXT PRIMARY KEY,
  -- you send from it (an account's address is yours without a row)
  own INTEGER NOT NULL DEFAULT 0,
  -- you have sent mail to it
  written INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX correspondents_own ON correspondents(email) WHERE own = 1;
CREATE INDEX threads_people ON threads(last_date DESC, id DESC, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE person = 1;
CREATE INDEX threads_people_id ON threads(id, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE person = 1;
CREATE INDEX threads_waiting ON threads(last_date DESC, id DESC, waiting_since, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE waiting_since IS NOT NULL;
CREATE INDEX threads_waiting_id ON threads(id, waiting_since, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE waiting_since IS NOT NULL;
-- the greeting's count: the inbox's waiting threads by date, their accounts in the index (a range of the window, nothing else read)
CREATE INDEX threads_waiting_inbox ON threads(waiting_since, account_id) WHERE in_inbox = 1 AND waiting_since IS NOT NULL;
CREATE INDEX threads_facts_pending ON threads(last_date DESC, id DESC) WHERE person IS NULL;
-- a local copy whose send failed answers nobody: found by its message, not by reading every op ever run
CREATE INDEX ops_failed_sends ON ops(json_extract(target_json, '$.messageIds[0]')) WHERE kind = 'send' AND state = 'failed';
INSERT OR REPLACE INTO settings (key, value_json)
  SELECT 'facts_backfill', CASE WHEN EXISTS (SELECT 1 FROM threads) THEN '{"phase":"senders","after":0}' ELSE '{"phase":"done"}' END;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial schema", sql: SCHEMA_V1 },
  { version: 2, name: "op target index", sql: OP_TARGETS_V2 },
  { version: 3, name: "owner identity, ai secrets, local mode", sql: OWNER_V3 },
  { version: 4, name: "smart categorization", sql: CATEGORIZATION_V4 },
  { version: 5, name: "move journal", sql: MOVES_V5 },
  { version: 6, name: "message bodies", sql: BODIES_V6 },
  { version: 7, name: "search outbox", sql: OUTBOX_V7 },
  { version: 8, name: "exclusive moves", sql: EXCLUSIVE_MOVES_V8 },
  { version: 9, name: "drafts v2", sql: DRAFTS_V9 },
  { version: 10, name: "ops sequence and account id indexes", sql: OPS_SEQ_V10 },
  { version: 11, name: "unread threads index", sql: UNREAD_V11 },
  { version: 12, name: "quick filter indexes", sql: FILTERS_V12 },
  { version: 13, name: "rich drafts", sql: RICH_DRAFTS_V13 },
  { version: 14, name: "people and waiting for your reply", sql: PEOPLE_V14 },
  { version: 15, name: "reply destinations", sql: "ALTER TABLE messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT '[]';" },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * The last migration that changed what the instant search index holds (its
 * snapshots carry it). v8 only touched the move journal: snapshots written
 * at v7 stay valid, so an upgrade restores instead of rebuilding.
 */
export const SEARCH_SCHEMA_VERSION = 7;

export function migrate(db: Db): { from: number; to: number } {
  const from = Number((db.get<{ user_version: number }>("PRAGMA user_version"))!.user_version);
  if (from > SCHEMA_VERSION) {
    throw new Error(`Database schema v${from} is newer than this app (v${SCHEMA_VERSION}). Update Terno.`);
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
