import { oneFolderPerMessage, type IncomingMessage } from "@terno/store";
import type { Db } from "./sqlite";

/**
 * Plan 259 (stage 0b): where an Outlook message is (the IndexedDB adapter's message-folders.ts). Graph keeps a message
 * in exactly one folder, so `message_folders` holds one user folder per message (a role folder has no row: the
 * message's flags say which), and a move is one write. Membership, counts and export read it beside Gmail's labels and
 * IMAP's locations; nothing that is IMAP's (identity holds, dispatch, UID walks, aliases, capture locators) ever does.
 * Like Gmail's labels and unlike IMAP's locations, it never waits on the folder list: Graph's folder ids are what a
 * folder's key is, and survive renames.
 */

/** Whether an account keeps a message in one folder, read once per account for the caller's batch. */
export function oneFolderAccounts(db: Db): (accountId: number) => boolean {
  const known = new Map<number, boolean>();
  return (accountId) => {
    let one = known.get(accountId);
    if (one === undefined) known.set(accountId, (one = oneFolderPerMessage(db.get<{ kind: string }>("SELECT kind FROM accounts WHERE id = ?", accountId)?.kind)));
    return one;
  };
}

/**
 * Ingest's side: a message's folder as the provider reports it, on a new row and on an existing one (a move the
 * delta read saw). Absent keeps what's stored; null takes it out of any user folder. Another provider's is ignored.
 * The caller recomputes the thread in the same transaction, which rewrites membership.
 */
export function placeMessage(db: Db, messageId: number, msg: IncomingMessage, oneFolder: (accountId: number) => boolean): void {
  if (msg.folder === undefined || !oneFolder(msg.accountId)) return;
  if (msg.folder === null) db.run("DELETE FROM message_folders WHERE message_id = ?", messageId);
  else db.run(
    `INSERT INTO message_folders (message_id, account_id, folder) VALUES (?, ?, ?)
     ON CONFLICT (message_id) DO UPDATE SET account_id = excluded.account_id, folder = excluded.folder WHERE account_id != excluded.account_id OR folder != excluded.folder`,
    messageId, msg.accountId, msg.folder,
  );
}

/**
 * These threads' messages' folders (outside trash and spam): by the thread index then one probe of the primary key a
 * message (CROSS JOIN keeps that order: never a walk of every Outlook message). `ids`: a JSON array parameter.
 */
const messageFoldersOf = (columns: string, ids: string) => /* sql */ `
  SELECT ${columns} FROM messages m INDEXED BY messages_thread CROSS JOIN message_folders f ON f.message_id = m.id
   WHERE m.thread_id IN (SELECT value FROM json_each(${ids})) AND m.is_trash = 0 AND m.is_spam = 0`;
/** as (tid, folder): a thread's memberships */
export const IN_MESSAGE_FOLDERS = (ids: string) => messageFoldersOf("m.thread_id AS tid, f.folder AS folder", ids);
/** as (id, folder): each message's, for a pending move replayed over it */
export const MESSAGE_FOLDERS = (ids: string) => messageFoldersOf("m.id AS id, f.folder AS folder", ids);

/** Is any message in a folder of its own (an Outlook account's)? One probe: none, and membership reads nothing more. */
export const anyMessageFolders = (db: Db): boolean => db.get("SELECT 1 FROM message_folders LIMIT 1") !== undefined;
