import { canonicalMessageId } from "@terno/core";
import { LINK_COPIES_MAX, type MailStore } from "@terno/store";
import type { Db } from "./sqlite";

/** Plan 201: the messages a link's Message-ID names, in every account (messages_rfc per account), first stored first. */
export function findLinked(db: Db, rfcMessageId: string): Awaited<ReturnType<MailStore["links"]["find"]>> {
  const id = canonicalMessageId(rfcMessageId);
  if (!id) return [];
  return db
    .all<{ id: number; thread_id: number; account_id: number; is_spam: number; is_trash: number }>(
      `SELECT id, thread_id, account_id, is_spam, is_trash FROM messages
        WHERE account_id IN (SELECT id FROM accounts) AND rfc_message_id = ? ORDER BY id LIMIT ?`,
      id,
      LINK_COPIES_MAX,
    )
    .map((m) => ({ id: m.id, threadId: m.thread_id, accountId: m.account_id, spam: m.is_spam === 1, trash: m.is_trash === 1 }));
}

/**
 * Plan 201: each conversation's link: its newest message with a Message-ID (no drafts) outside Spam and Trash; one in
 * Spam or Trash only when the whole conversation is there (a mixed one never links to what its summary leaves out).
 * One messages_thread walk each.
 */
export function newestLinked(db: Db, threadIds: readonly number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const threadId of new Set(threadIds)) {
    // drafts count for whether anything is outside Spam and Trash, never as the link (Codex code review #1)
    const r = db.get<{ r: string | null; is_draft: number }>(
      `SELECT rfc_message_id AS r, is_draft FROM messages INDEXED BY messages_thread
        WHERE thread_id = ?
        ORDER BY (is_spam OR is_trash), is_draft, rfc_message_id IS NULL, date DESC, id DESC LIMIT 1`,
      threadId,
    );
    // the first row is outside Spam and Trash whenever any message is: then only it can be the link
    if (r?.r && !r.is_draft) out.set(threadId, r.r);
  }
  return out;
}
