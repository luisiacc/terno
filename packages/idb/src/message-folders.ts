import { oneFolderPerMessage, type IncomingMessage } from "@terno/store";
import { T, type Ctx } from "./mail";

/**
 * Plan 259 (stage 0b): where an Outlook message is (the SQL adapter's message-folders.ts). One user folder per message
 * in `message_folders` (a role folder has no row: the flags say which); membership, counts and export read it beside
 * Gmail's labels and IMAP's locations, and nothing of IMAP's ever does. It never waits on the folder list.
 */

/**
 * Ingest's side: a message's folder as the provider reports it, on a new row and on an existing one (a move the delta
 * read saw). Absent keeps what's stored; null takes it out of any user folder. Another provider's is ignored. The
 * caller recomputes the thread in the same unit, which rewrites membership.
 */
export function placeMessage(c: Ctx, messageId: number, msg: IncomingMessage): void {
  if (msg.folder === undefined || !oneFolderPerMessage(T(c, "accounts").get(msg.accountId)?.kind as string | undefined)) return;
  const folders = T(c, "message_folders");
  const was = folders.get(messageId);
  if (msg.folder === null) {
    if (was) folders.deleteRow(was);
  } else if (!was) folders.insert({ message_id: messageId, account_id: msg.accountId, folder: msg.folder });
  else if (was.folder !== msg.folder || was.account_id !== msg.accountId) folders.update(was, { account_id: msg.accountId, folder: msg.folder });
}
