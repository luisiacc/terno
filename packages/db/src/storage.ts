import { removable, storageBucket, type StorageBucket, type StorageThreadRow } from "@terno/core";
import type { StorageRemoval } from "@terno/store";
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
  bytes: number;
  held: number;
}

/**
 * What every row needs, one indexed aggregate per thread: its messages and their size, and whether one is held
 * (a draft, local or unsent, an op not settled, a flag not yet confirmed: Codex R4).
 */
const SELECT = /* sql */ `
SELECT t.id, t.account_id, t.last_date, t.in_inbox, t.in_trash, t.in_spam, t.has_sent, t.is_starred,
  count(m.id) AS messages, coalesce(sum(m.size), 0) AS bytes,
  coalesce(max(
    m.is_draft = 1 OR m.provider_msg_id IS NULL OR m.provider_msg_id LIKE 'local:%'
    OR EXISTS (SELECT 1 FROM op_targets ot INDEXED BY op_targets_msg JOIN ops o ON o.id = ot.op_id WHERE ot.message_id = m.id AND o.state IN ('queued', 'running', 'unknown'))
    OR EXISTS (SELECT 1 FROM message_flag_intents fi WHERE fi.message_id = m.id AND (fi.pending_count > 0 OR fi.needs_snapshot = 1))
  ), 0) AS held
FROM %THREADS% t LEFT JOIN messages m ON m.thread_id = t.id
GROUP BY t.id ORDER BY t.id`;

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

/** Accounts that must sign in again: what is stored may be stale for long, so their mail stays (Codex R2). */
function signedOut(db: Db): Set<number> {
  const out = new Set<number>();
  for (const a of db.all<{ id: number; sync_state: string }>("SELECT id, sync_state FROM accounts")) {
    try {
      const s = JSON.parse(a.sync_state) as { authRequired?: boolean; authScope?: string | null };
      if (s.authRequired && s.authScope !== "send") out.add(a.id);
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
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    bucket: storageBucket({ inInbox: r.in_inbox === 1, inTrash: r.in_trash === 1, inSpam: r.in_spam === 1, hasSent: r.has_sent === 1 }),
    lastDate: r.last_date,
    kept: r.is_starred === 1 || r.has_sent === 1 || r.held === 1 || drafts.has(r.id) || out.has(r.account_id),
    messages: r.messages,
    bytes: r.bytes,
  }));
}

export function storageThreads(db: Db, after: number, limit: number): StorageThreadRow[] {
  return toRows(db, db.all<Row>(SELECT.replace("%THREADS%", "(SELECT * FROM threads WHERE id > ? ORDER BY id LIMIT ?)"), after, limit));
}

/** One unit: the threads that may go now, then at most `maxMessages` of their messages, oldest first. */
export function removeStorage(db: Db, r: { threadIds: readonly number[]; buckets: readonly StorageBucket[]; cutoff: number; maxMessages: number }): StorageRemoval {
  return db.tx(() => {
    const ids = [...new Set(r.threadIds)];
    const eligible = ids.length
      ? toRows(db, db.all<Row>(SELECT.replace("%THREADS%", `(SELECT * FROM threads WHERE id IN (${placeholders(ids.length)}))`), ...ids)).filter((t) => removable(t, r.buckets, r.cutoff))
      : [];
    const total = eligible.reduce((n, t) => n + t.messages, 0);
    if (!eligible.length || r.maxMessages <= 0) return { touched: [], threads: 0, messages: 0, remaining: total, removed: [] };
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
    const gone = threadIds.filter((id) => !db.get("SELECT 1 FROM threads WHERE id = ?", id)).length;
    const removed = new Map<number, string[]>();
    for (const m of victims) {
      let list = removed.get(m.account_id);
      if (!list) removed.set(m.account_id, (list = []));
      list.push(m.provider_msg_id);
    }
    return {
      touched: [...touched],
      threads: gone,
      messages: messageIds.length,
      remaining: total - messageIds.length,
      removed: [...removed].map(([accountId, providerMsgIds]) => ({ accountId, providerMsgIds })),
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
