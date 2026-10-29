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
SELECT t.id, t.account_id, k.folder, t.last_date, t.unread_count > 0 FROM threads t, (
  SELECT j.value AS folder FROM messages m, json_each(CASE WHEN json_valid(m.gmail_labels) THEN m.gmail_labels ELSE '[]' END) j
   WHERE m.thread_id = ?1 AND m.is_trash = 0 AND m.is_spam = 0 AND m.gmail_labels IS NOT NULL AND j.value LIKE 'Label\\_%' ESCAPE '\\'
  UNION
  SELECT l.mailbox FROM messages m JOIN message_locations l ON l.message_id = m.id JOIN folders f ON f.account_id = l.account_id AND f.key = l.mailbox
   WHERE m.thread_id = ?1 AND m.is_trash = 0 AND m.is_spam = 0
) k WHERE t.id = ?1`;

/** Rewrites these threads' folder memberships from their messages (a thread that's gone has none: the cascade). */
export function refreshFolders(db: Db, threadIds: Iterable<number>): void {
  for (const threadId of threadIds) {
    db.run("DELETE FROM thread_folders WHERE thread_id = ?", threadId);
    db.run(MEMBERSHIP, threadId);
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
 * An account's list now. Nothing is written when it's the same. A newly listed IMAP folder whose mailbox
 * already has locations (rare: a role it no longer holds) brings those threads in; one no longer listed has its
 * threads rewritten (an IMAP folder's memberships go; a Gmail label's follow the labels, listed or not).
 */
export function replaceFolders(db: Db, accountId: number, folders: readonly ProviderFolder[]): { changed: boolean; touched: number[] } {
  return db.tx(() => {
    const before = db.all<FolderRow>("SELECT account_id, key, path_json, selectable FROM folders WHERE account_id = ? ORDER BY position", accountId);
    const same = before.length === folders.length && before.every((r, i) => r.key === folders[i]!.key && r.path_json === JSON.stringify(folders[i]!.path) && (r.selectable === 1) === folders[i]!.selectable);
    if (same) return { changed: false, touched: [] };
    const known = new Set(before.map((r) => r.key));
    const now = new Set(folders.map((f) => f.key));
    db.run("DELETE FROM folders WHERE account_id = ?", accountId);
    folders.forEach((f, position) =>
      db.run("INSERT OR IGNORE INTO folders (account_id, key, path_json, selectable, position) VALUES (?, ?, ?, ?, ?)", accountId, f.key, JSON.stringify(f.path), f.selectable ? 1 : 0, position),
    );
    const added = [...now].filter((k) => !known.has(k));
    const removed = [...known].filter((k) => !now.has(k));
    const touched = new Set<number>();
    for (const key of added) {
      for (const r of db.all<{ thread_id: number }>("SELECT DISTINCT m.thread_id FROM message_locations l JOIN messages m ON m.id = l.message_id WHERE l.account_id = ? AND l.mailbox = ?", accountId, key)) touched.add(r.thread_id);
    }
    for (const key of removed) {
      for (const r of db.all<{ thread_id: number }>("SELECT thread_id FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ?", accountId, key)) touched.add(r.thread_id);
    }
    refreshFolders(db, touched);
    return { changed: true, touched: [...touched] };
  });
}
