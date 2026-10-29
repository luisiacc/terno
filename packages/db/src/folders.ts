import type { Folder } from "@terno/core";
import type { ProviderFolder } from "@terno/store";
import { placeholders, type Db } from "./sqlite";

/**
 * Plan 65: an account's own folders and which threads are in them.
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
 * list). Only a newly listed IMAP folder is looked at: the threads located in it, and any rows a past listing
 * left, are rewritten.
 */
export function replaceFolders(db: Db, accountId: number, folders: readonly ProviderFolder[]): { changed: boolean; touched: number[] } {
  return db.tx(() => {
    const before = db.all<FolderRow>("SELECT account_id, key, path_json, selectable FROM folders WHERE account_id = ? ORDER BY position", accountId);
    const same = before.length === folders.length && before.every((r, i) => r.key === folders[i]!.key && r.path_json === JSON.stringify(folders[i]!.path) && (r.selectable === 1) === folders[i]!.selectable);
    if (same) return { changed: false, touched: [] };
    const known = new Set(before.map((r) => r.key));
    db.run("DELETE FROM folders WHERE account_id = ?", accountId);
    folders.forEach((f, position) =>
      db.run("INSERT OR IGNORE INTO folders (account_id, key, path_json, selectable, position) VALUES (?, ?, ?, ?, ?)", accountId, f.key, JSON.stringify(f.path), f.selectable ? 1 : 0, position),
    );
    const touched = new Set<number>();
    if (db.get<{ kind: string }>("SELECT kind FROM accounts WHERE id = ?", accountId)?.kind === "imap") {
      for (const f of folders) {
        if (known.has(f.key)) continue;
        for (const r of db.all<{ thread_id: number }>(
          `SELECT m.thread_id FROM message_locations l INDEXED BY message_locations_uid JOIN messages m ON m.id = l.message_id WHERE l.account_id = ? AND l.mailbox = ?
           UNION SELECT thread_id FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ?`,
          accountId,
          f.key,
          accountId,
          f.key,
        )) touched.add(r.thread_id);
      }
      refreshFolders(db, touched);
    }
    return { changed: true, touched: [...touched] };
  });
}
