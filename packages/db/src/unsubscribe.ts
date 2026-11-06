import { addressKey, pickUnsubscribeMessage, UNSUBSCRIBE_LOOKBACK, type UnsubscribeSource } from "@terno/core";
import type { Db } from "./sqlite";
import { ownAddresses } from "./facts";

interface Row {
  id: number;
  account_id: number;
  from_name: string;
  from_email: string;
  unsubscribe: string | null;
}

/** Plan 96: one thread's newest messages by its index, and one body only when none has the header. */
export function unsubscribeSource(db: Db, threadId: number): UnsubscribeSource | null {
  const rows = db.all<Row>(
    `SELECT id, account_id, from_name, from_email, unsubscribe FROM messages
     WHERE thread_id = ? AND is_sent = 0 AND is_draft = 0 AND is_spam = 0 ORDER BY date DESC, id DESC LIMIT ${UNSUBSCRIBE_LOOKBACK}`,
    threadId,
  );
  if (!rows.length) return null;
  const pick = pickUnsubscribeMessage(rows, ownAddresses(db), addressKey);
  if (!pick) return null;
  const body = pick.unsubscribe ? undefined : db.get<{ body_text: string | null; body_html: string | null }>("SELECT body_text, body_html FROM message_bodies WHERE message_id = ?", pick.row.id);
  return {
    messageId: pick.row.id,
    accountId: pick.row.account_id,
    fromName: pick.row.from_name,
    fromEmail: pick.row.from_email,
    unsubscribe: pick.unsubscribe,
    bodyHtml: body?.body_html ?? null,
    bodyText: body?.body_text ?? null,
  };
}
