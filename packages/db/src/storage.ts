import { storageBucket, storageGoes as goes, type StorageThreadRow } from "@terno/core";
import type { StorageRemove, StorageRemoval } from "@terno/store";
import { deleteMessages } from "./ingest";
import { sqlAssets } from "./attachments";
import { placeholders, type Db } from "./sqlite";

/** Plan 69: the settings key of a compaction waiting for the next open (desktop). */
export const COMPACT_KEY = "storage.compact";

interface Row {
  id: number;
  account_id: number;
  last_date: number;
  in_inbox: number;
  in_trash: number;
  in_spam: number;
  has_sent: number;
  is_starred: number;
  messages: number;
  /** its newest message of any kind: a thread's own last_date prefers what is shown, and Trash's newer mail would hide (Codex code review #2) */
  newest: number | null;
  bytes: number;
  held: number;
}

/**
 * A message held by its own columns. A star or a message you sent count even in Trash and Spam, where the thread's
 * own flags ignore them (Codex code review #1). No index serves it: one cost every ingest 3% of its throughput, to
 * spare a huge thread's re-check a scan its unit's recompute already does.
 */
const HELD = "m.is_draft = 1 OR m.is_starred = 1 OR m.is_sent = 1 OR m.provider_msg_id IS NULL OR substr(m.provider_msg_id, 1, 6) = 'local:' OR EXISTS (SELECT 1 FROM imap_identity_holds h WHERE h.message_id=m.id)";

/**
 * The report's row, one indexed aggregate per thread: its messages, what they take here (measured: headers, bodies
 * and attachments as stored, base64; `octet_length` reads a value's size, never the value), and whether one of them
 * is held by its own columns (a star, even in Trash where the thread's flag ignores it; a draft, local or unsent).
 */
const SELECT = /* sql */ `
SELECT t.id, t.account_id, t.last_date, t.in_inbox, t.in_trash, t.in_spam, t.has_sent, t.is_starred,
  count(m.id) AS messages, max(m.date) AS newest,
  coalesce(sum(
    octet_length(m.subject) + octet_length(m.snippet) + octet_length(m.to_json) + octet_length(m.cc_json) + octet_length(m.references_json)
    + coalesce((SELECT coalesce(octet_length(b.body_text), 0) + coalesce(octet_length(b.body_html), 0) FROM message_bodies b WHERE b.message_id = m.id), 0)
    + coalesce((SELECT sum((a.size + 2) / 3 * 4) FROM attachment_links l JOIN attachment_assets a ON a.id = l.asset_id WHERE l.message_id = m.id), 0)
  ), 0) AS bytes,
  coalesce(max(${HELD}), 0) AS held
FROM %THREADS% t LEFT JOIN messages m ON m.thread_id = t.id
GROUP BY t.id ORDER BY t.id`;

/** What a removal re-checks in its unit: the same, without measuring anything (a large thread is read once, cheaply). */
const CHECK = /* sql */ `
SELECT t.id, t.account_id, t.last_date, t.in_inbox, t.in_trash, t.in_spam, t.has_sent, t.is_starred,
  (SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS messages, 0 AS bytes,
  (SELECT max(m.date) FROM messages m WHERE m.thread_id = t.id) AS newest,
  EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND (${HELD})) AS held
FROM threads t WHERE t.id IN (%IDS%) ORDER BY t.id`;

/**
 * Threads with a change still on its way to the server: an op not settled (queued, running, or unknown until the
 * user decides), or a flag the server took but hasn't confirmed (Codex R4). Few at any time: read once a call.
 */
function unsettled(db: Db): Set<number> {
  return new Set(
    db
      .all<{ thread_id: number }>(
        `SELECT m.thread_id FROM ops o JOIN op_targets ot ON ot.op_id = o.id JOIN messages m ON m.id = ot.message_id WHERE o.state IN ('queued', 'running', 'unknown')
         UNION SELECT m.thread_id FROM message_flag_intents fi JOIN messages m ON m.id = fi.message_id WHERE fi.pending_count > 0 OR fi.needs_snapshot = 1`,
      )
      .map((r) => r.thread_id),
  );
}

/** Threads a draft is on: its own, or the one of the message it answers or forwards (drafts are few). */
function drafted(db: Db): Set<number> {
  return new Set(
    db
      .all<{ thread_id: number }>(
        `SELECT thread_id FROM drafts WHERE thread_id IS NOT NULL
         UNION SELECT m.thread_id FROM drafts d JOIN messages m ON m.id IN (d.in_reply_to_message_id, d.forward_of_message_id)`,
      )
      .map((r) => r.thread_id),
  );
}

/**
 * Accounts whose mail stays: one that must sign in again (what is stored may be stale for long), or one that never
 * finished a sync (what the server holds isn't established yet) (Codex R2).
 */
function signedOut(db: Db): Set<number> {
  const out = new Set<number>();
  for (const a of db.all<{ id: number; sync_state: string }>("SELECT id, sync_state FROM accounts")) {
    try {
      const s = JSON.parse(a.sync_state) as { authRequired?: boolean; authScope?: string | null; lastSyncAt?: number | null };
      if ((s.authRequired && s.authScope !== "send") || s.lastSyncAt == null) out.add(a.id);
    } catch {
      out.add(a.id);
    }
  }
  return out;
}

function toRows(db: Db, rows: Row[]): StorageThreadRow[] {
  if (!rows.length) return [];
  const drafts = drafted(db);
  const out = signedOut(db);
  const pending = unsettled(db);
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    bucket: storageBucket({ inInbox: r.in_inbox === 1, inTrash: r.in_trash === 1, inSpam: r.in_spam === 1, hasSent: r.has_sent === 1 }),
    lastDate: r.newest ?? r.last_date,
    kept: r.is_starred === 1 || r.has_sent === 1 || r.held === 1 || drafts.has(r.id) || pending.has(r.id) || out.has(r.account_id),
    messages: r.messages,
    bytes: r.bytes,
  }));
}

export function storageThreads(db: Db, after: number, limit: number): StorageThreadRow[] {
  return toRows(db, db.all<Row>(SELECT.replace("%THREADS%", "(SELECT * FROM threads WHERE id > ? ORDER BY id LIMIT ?)"), after, limit));
}

/** One unit: the threads that may go now, then at most `maxMessages` of their messages, oldest first. */
export function removeStorage(db: Db, r: StorageRemove): StorageRemoval {
  return db.tx(() => {
    const ids = [...new Set(r.threadIds)];
    const eligible = ids.length ? toRows(db, db.all<Row>(CHECK.replace("%IDS%", placeholders(ids.length)), ...ids)).filter((t) => goes(t, r)) : [];
    const total = eligible.reduce((n, t) => n + t.messages, 0);
    if (!eligible.length || r.maxMessages <= 0) return { touched: [], threads: 0, messages: 0, remaining: total, removed: [], partial: [] };
    const threadIds = eligible.map((t) => t.id);
    const victims = db.all<{ id: number; account_id: number; provider_msg_id: string }>(
      `SELECT id, account_id, provider_msg_id FROM messages WHERE thread_id IN (${placeholders(threadIds.length)}) ORDER BY date, id LIMIT ?`,
      ...threadIds,
      r.maxMessages,
    );
    const messageIds = victims.map((m) => m.id);
    const assets = new Set<string>();
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      for (const a of db.all<{ asset_id: string }>(`SELECT DISTINCT asset_id FROM attachment_links WHERE message_id IN (${placeholders(chunk.length)})`, ...chunk)) assets.add(a.asset_id);
    }
    const touched = deleteMessages(db, messageIds);
    // what they alone pinned is collectable now: nothing can bring these messages back to claim it (Codex R3)
    sqlAssets(db).expireGrace([...assets]);
    const partial = threadIds.filter((id) => db.get("SELECT 1 FROM threads WHERE id = ?", id));
    const removed = new Map<number, string[]>();
    for (const m of victims) {
      let list = removed.get(m.account_id);
      if (!list) removed.set(m.account_id, (list = []));
      list.push(m.provider_msg_id);
    }
    return {
      touched: [...touched],
      threads: threadIds.length - partial.length,
      messages: messageIds.length,
      remaining: total - messageIds.length,
      removed: [...removed].map(([accountId, providerMsgIds]) => ({ accountId, providerMsgIds })),
      partial,
    };
  });
}

/** What the file takes, from SQLite's own page counts (the WAL is the checkpoint's to give back). */
export function footprint(db: Db): { bytes: number; free: number } {
  const size = Number(db.get<{ page_size: number }>("PRAGMA page_size")!.page_size);
  const pages = Number(db.get<{ page_count: number }>("PRAGMA page_count")!.page_count);
  const free = Number(db.get<{ freelist_count: number }>("PRAGMA freelist_count")!.freelist_count);
  return { bytes: pages * size, free: free * size };
}

export const incrementalVacuum = (db: Db): boolean => Number(db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")!.auto_vacuum) === 2;

/**
 * Up to `pages` free pages given back. `exec` steps the pragma to its end (a statement stepped once frees one
 * page: Codex R9); `more` while the freelist still shrinks.
 */
export function compactPages(db: Db, pages: number): { more: boolean } {
  const before = footprint(db).free;
  if (!before) return { more: false };
  db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
  const after = footprint(db).free;
  return { more: after > 0 && after < before };
}
