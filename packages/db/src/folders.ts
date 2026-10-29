import type { Folder } from "@terno/core";
import type { ProviderFolder } from "@terno/store";
import { placeholders, type Db } from "./sqlite";

/**
 * Plan 68: an account's own folders and which threads are in them.
 *
 * Membership is the store's, written in the same transaction as what decides it: recomputeThreads (ingest,
 * flag and label updates, actions, deletion) and every IMAP location write. A thread is in a folder when one
 * of its messages (not in trash or spam) carries the folder's key:
 *  - Gmail: a user label id (`Label_*`) in its labels, listed or not yet, so nothing waits for /labels;
 *  - IMAP: a location in a mailbox the account lists as a folder (role mailboxes never are).
 * `last_date` and `unread` are the thread's, so pages and counts never touch threads.
 */
const MEMBERSHIP = /* sql */ `
INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread)
SELECT t.id, t.account_id, k.folder, t.last_date, t.unread_count > 0 FROM (
  SELECT m.thread_id AS tid, j.value AS folder FROM messages m, json_each(CASE WHEN json_valid(m.gmail_labels) THEN m.gmail_labels ELSE '[]' END) j
   WHERE m.thread_id IN (SELECT value FROM json_each(?1)) AND m.is_trash = 0 AND m.is_spam = 0
     AND instr(m.gmail_labels, 'Label_') > 0 AND j.value LIKE 'Label\\_%' ESCAPE '\\'
  UNION
  SELECT m.thread_id, l.mailbox FROM messages m JOIN message_locations l ON l.message_id = m.id JOIN folders f ON f.account_id = l.account_id AND f.key = l.mailbox
   WHERE m.thread_id IN (SELECT value FROM json_each(?1)) AND m.is_trash = 0 AND m.is_spam = 0
) k JOIN threads t ON t.id = k.tid`;

/**
 * Rewrites these threads' folder memberships from their messages, set at a time (a thread that's gone has none:
 * the cascade). A message whose labels hold no user label is never parsed; with no folder listed, no location is read.
 */
export function refreshFolders(db: Db, threadIds: Iterable<number>): void {
  const ids = [...threadIds];
  if (!ids.length) return;
  const json = JSON.stringify(ids);
  db.run("DELETE FROM thread_folders WHERE thread_id IN (SELECT value FROM json_each(?))", json);
  db.run(MEMBERSHIP, json);
}

/** A message's user labels (Gmail `Label_*`) from its raw labels; anything malformed has none. */
export function userLabels(raw: string): string[] {
  try {
    const labels: unknown = JSON.parse(raw);
    return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string" && l.startsWith("Label_")) : [];
  } catch {
    return [];
  }
}

/** What recomputeThreads folded for a thread's folders: its labels (from messages not in trash or spam) and aggregates. */
export interface FoldedThread {
  id: number;
  accountId: number;
  lastDate: number;
  unread: 0 | 1;
  labels: Set<string>;
}

/**
 * recomputeThreads' side of membership: the labels it already read, the locations of accounts that list folders
 * (one read), the rows there are (one read); then only the differences are written. A thread in no folder,
 * the common case, costs the two reads of its batch and no write.
 */
export function writeFolders(db: Db, threads: readonly FoldedThread[]): void {
  if (!threads.length) return;
  const json = JSON.stringify(threads.map((t) => t.id));
  const want = new Map(threads.map((t) => [t.id, new Set(t.labels)]));
  if (db.get("SELECT 1 FROM folders LIMIT 1")) {
    for (const r of db.all<{ thread_id: number; mailbox: string }>(
      `SELECT m.thread_id, l.mailbox FROM messages m JOIN message_locations l ON l.message_id = m.id JOIN folders f ON f.account_id = l.account_id AND f.key = l.mailbox
       WHERE m.thread_id IN (SELECT value FROM json_each(?)) AND m.is_trash = 0 AND m.is_spam = 0`,
      json,
    )) want.get(r.thread_id)?.add(r.mailbox);
  }
  const have = new Map<number, Map<string, { last_date: number; unread: number }>>();
  for (const r of db.all<{ thread_id: number; folder: string; last_date: number; unread: number }>("SELECT thread_id, folder, last_date, unread FROM thread_folders WHERE thread_id IN (SELECT value FROM json_each(?))", json)) {
    let rows = have.get(r.thread_id);
    if (!rows) have.set(r.thread_id, (rows = new Map()));
    rows.set(r.folder, r);
  }
  for (const t of threads) {
    const keys = want.get(t.id)!;
    const rows = have.get(t.id);
    for (const [folder, r] of rows ?? []) {
      if (!keys.has(folder)) db.run("DELETE FROM thread_folders WHERE thread_id = ? AND folder = ?", t.id, folder);
      else if (r.last_date !== t.lastDate || r.unread !== t.unread) db.run("UPDATE thread_folders SET last_date = ?, unread = ? WHERE thread_id = ? AND folder = ?", t.lastDate, t.unread, t.id, folder);
    }
    for (const folder of keys) if (!rows?.has(folder)) db.run("INSERT INTO thread_folders (thread_id, account_id, folder, last_date, unread) VALUES (?, ?, ?, ?, ?)", t.id, t.accountId, folder, t.lastDate, t.unread);
  }
}

/** The threads of these messages, for a membership refresh after their locations changed. */
export function threadsOfMessages(db: Db, messageIds: readonly number[]): number[] {
  const out = new Set<number>();
  for (let i = 0; i < messageIds.length; i += 500) {
    const chunk = messageIds.slice(i, i + 500);
    for (const r of db.all<{ thread_id: number }>(`SELECT DISTINCT thread_id FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk)) out.add(r.thread_id);
  }
  return [...out];
}

/** Whether a mailbox is one of the account's listed folders (a role mailbox's locations decide no membership). */
export function isFolder(db: Db, accountId: number, key: string): boolean {
  return db.get("SELECT 1 FROM folders WHERE account_id = ? AND key = ?", accountId, key) !== undefined;
}

interface FolderRow {
  account_id: number;
  key: string;
  path_json: string;
  selectable: number;
}

const toFolder = (r: FolderRow): Folder => ({ accountId: r.account_id, key: r.key, path: JSON.parse(r.path_json) as string[], selectable: r.selectable === 1 });

export function listFolders(db: Db): Folder[] {
  return db.all<FolderRow>("SELECT account_id, key, path_json, selectable FROM folders ORDER BY account_id, position").map(toFolder);
}

/**
 * An account's list now; nothing is written when it's the same. Memberships never wait on the list (Codex R1):
 * Gmail's follow the labels, and a folder no longer listed keeps its rows unseen (every read goes through the
 * list). A newly listed IMAP folder gets a rebuild job instead of a rebuild here (Codex R5: one transaction over a
 * big folder held the backend): `rebuildFolders` runs it a slice at a time, resumable.
 */
export function replaceFolders(db: Db, accountId: number, folders: readonly ProviderFolder[]): { changed: boolean; touched: number[] } {
  return db.tx(() => {
    // by key, the differences only (Codex R14: a rename in 10,000 folders rewrote them all): a new folder goes after
    // the others (the order is the sidebar's to draw, by path), a renamed one changes in place, a gone one goes
    const before = new Map(db.all<FolderRow & { position: number }>("SELECT account_id, key, path_json, selectable, position FROM folders WHERE account_id = ?", accountId).map((r) => [r.key, r]));
    const known = new Set(before.keys());
    const next = new Set<string>();
    let position = Math.max(-1, ...[...before.values()].map((r) => r.position));
    let changed = false;
    for (const f of folders) {
      if (next.has(f.key)) continue;
      next.add(f.key);
      const path = JSON.stringify(f.path);
      const was = before.get(f.key);
      if (!was) {
        db.run("INSERT INTO folders (account_id, key, path_json, selectable, position) VALUES (?, ?, ?, ?, ?)", accountId, f.key, path, f.selectable ? 1 : 0, ++position);
        changed = true;
      } else if (was.path_json !== path || (was.selectable === 1) !== f.selectable) {
        db.run("UPDATE folders SET path_json = ?, selectable = ? WHERE account_id = ? AND key = ?", path, f.selectable ? 1 : 0, accountId, f.key);
        changed = true;
      }
    }
    for (const key of known) {
      if (next.has(key)) continue;
      db.run("DELETE FROM folders WHERE account_id = ? AND key = ?", accountId, key);
      changed = true;
    }
    if (!changed) return { changed: false, touched: [] };
    // a job for a folder no longer listed has nothing to do
    db.run("DELETE FROM folder_rebuilds WHERE account_id = ? AND key NOT IN (SELECT key FROM folders WHERE account_id = ?)", accountId, accountId);
    if (db.get<{ kind: string }>("SELECT kind FROM accounts WHERE id = ?", accountId)?.kind === "imap") {
      for (const f of folders) {
        if (known.has(f.key)) continue;
        // only where there's something to rebuild: its mailbox has locations, or rows a past listing left
        const any =
          db.get("SELECT 1 FROM message_locations INDEXED BY message_locations_uid WHERE account_id = ? AND mailbox = ? LIMIT 1", accountId, f.key) ??
          db.get("SELECT 1 FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ? LIMIT 1", accountId, f.key);
        if (any) db.run("INSERT OR REPLACE INTO folder_rebuilds (account_id, key, phase, after_uidvalidity, after_uid) VALUES (?, ?, 0, 0, 0)", accountId, f.key);
      }
    }
    return { changed: true, touched: [] };
  });
}

/**
 * One slice of a pending rebuild (Codex R5): first the folder's old rows go (`limit` at a time), then its locations
 * are walked in UID order and their threads refolded (`limit` at a time). Each slice is its own transaction, its
 * progress saved with it, so a quit resumes where it was. Location writes meanwhile keep membership as ever.
 */
/** a slice of the upgrade's backfill: these messages' user labels as their threads' memberships */
const MESSAGE_LABELS = /* sql */ `
INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread)
SELECT t.id, t.account_id, j.value, t.last_date, t.unread_count > 0
FROM (SELECT thread_id, gmail_labels FROM messages WHERE id > ?1 AND id <= ?2 AND gmail_labels IS NOT NULL AND is_trash = 0 AND is_spam = 0 AND instr(gmail_labels, 'Label_') > 0) m
JOIN threads t ON t.id = m.thread_id, json_each(CASE WHEN json_valid(m.gmail_labels) THEN m.gmail_labels ELSE '[]' END) j
WHERE j.value LIKE 'Label\\_%' ESCAPE '\\'
RETURNING thread_id`;

/**
 * The upgrade's slice (schema 24): the memberships of a mailbox from before, a few messages at a time, whatever
 * their threads (Codex R14: one conversation of 50,000 is many slices, never one), added beside any a sync wrote
 * meanwhile (those are already right; a label is a membership if any message carries it).
 */
function backfill(db: Db, limit: number, left: () => boolean): { more: boolean; touched: number[] } {
  const fill = db.get<{ after_message_id: number }>("SELECT after_message_id FROM folder_backfill LIMIT 1");
  if (!fill) return { more: false, touched: [] };
  const n = Math.max(1, Math.floor(limit / 5));
  const range = db.get<{ last: number | null; c: number }>("SELECT max(id) AS last, count(*) AS c FROM (SELECT id FROM messages WHERE id > ? ORDER BY id LIMIT ?)", fill.after_message_id, n)!;
  const touched = range.last === null ? [] : [...new Set(db.all<{ thread_id: number }>(MESSAGE_LABELS, fill.after_message_id, range.last).map((r) => r.thread_id))];
  if (range.c < n) db.run("DELETE FROM folder_backfill");
  else db.run("UPDATE folder_backfill SET after_message_id = ?", range.last);
  return { more: left(), touched };
}

export function rebuildFolders(db: Db, limit: number): { more: boolean; touched: number[] } {
  return db.tx(() => {
    const job = db.get<{ account_id: number; key: string; phase: number; after_uidvalidity: number; after_uid: number }>("SELECT account_id, key, phase, after_uidvalidity, after_uid FROM folder_rebuilds LIMIT 1");
    const left = () => db.get("SELECT 1 FROM folder_rebuilds UNION ALL SELECT 1 FROM folder_backfill LIMIT 1") !== undefined;
    if (!job) return backfill(db, limit, left);
    const done = () => db.run("DELETE FROM folder_rebuilds WHERE account_id = ? AND key = ?", job.account_id, job.key);
    if (!isFolder(db, job.account_id, job.key)) {
      done();
      return { more: left(), touched: [] };
    }
    if (job.phase === 0) {
      const gone = db.all<{ thread_id: number }>(
        "DELETE FROM thread_folders WHERE folder = ? AND thread_id IN (SELECT thread_id FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ? LIMIT ?) RETURNING thread_id",
        job.key,
        job.account_id,
        job.key,
        limit,
      );
      if (gone.length < limit) db.run("UPDATE folder_rebuilds SET phase = 1 WHERE account_id = ? AND key = ?", job.account_id, job.key);
      return { more: true, touched: gone.map((r) => r.thread_id) };
    }
    const rows = db.all<{ message_id: number; uidvalidity: number; uid: number }>(
      `SELECT message_id, uidvalidity, uid FROM message_locations INDEXED BY message_locations_uid
       WHERE account_id = ? AND mailbox = ? AND (uidvalidity, uid) > (?, ?) ORDER BY uidvalidity, uid LIMIT ?`,
      job.account_id,
      job.key,
      job.after_uidvalidity,
      job.after_uid,
      limit,
    );
    // this folder's rows only (its old ones went in phase 0): from the batch's messages, never a refold of their
    // whole threads (Codex R11: a long conversation re-read per slice)
    const ids = JSON.stringify(rows.map((r) => r.message_id));
    const threads = db
      .all<{ thread_id: number }>(
        `INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread)
         SELECT DISTINCT t.id, t.account_id, ?, t.last_date, t.unread_count > 0 FROM messages m JOIN threads t ON t.id = m.thread_id
         WHERE m.id IN (SELECT value FROM json_each(?)) AND m.is_trash = 0 AND m.is_spam = 0 RETURNING thread_id`,
        job.key,
        ids,
      )
      .map((r) => r.thread_id);
    const last = rows.at(-1);
    if (rows.length < limit) done();
    else db.run("UPDATE folder_rebuilds SET after_uidvalidity = ?, after_uid = ? WHERE account_id = ? AND key = ?", last!.uidvalidity, last!.uid, job.account_id, job.key);
    return { more: left(), touched: threads };
  });
}
