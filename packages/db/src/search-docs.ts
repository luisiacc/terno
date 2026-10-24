import type { SearchMessageDoc, SearchThreadDoc } from "@terno/store";
import type { Db } from "./sqlite";

/**
 * The search projections, read with the same expressions the FTS5 view
 * indexes (messages_fts_src): engines and the oracle see exactly what FTS5 sees.
 */
const MESSAGE_DOC = `SELECT m.id, m.thread_id, m.account_id, m.date, m.subject, m.from_name || ' ' || m.from_email AS from_text,
  m.from_email, m.recipients_text, coalesce(b.body_text, '') AS body, m.has_attachments, m.body_state
  FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id`;

const THREAD_DOC = `SELECT t.id, t.account_id, t.last_date, t.in_inbox, t.has_sent, t.in_trash, t.in_spam, t.is_starred, t.unread_count,
  (SELECT group_concat(category_id) FROM thread_categories WHERE thread_id = t.id) AS cats FROM threads t`;

interface MessageDocRow {
  id: number;
  thread_id: number;
  account_id: number;
  date: number;
  subject: string;
  from_text: string;
  from_email: string;
  recipients_text: string;
  body: string;
  has_attachments: number;
  body_state: SearchMessageDoc["bodyState"];
}

interface ThreadDocRow {
  id: number;
  account_id: number;
  last_date: number;
  in_inbox: number;
  has_sent: number;
  in_trash: number;
  in_spam: number;
  is_starred: number;
  unread_count: number;
  cats: string | null;
}

function toMessageDoc(r: MessageDocRow): SearchMessageDoc {
  return {
    messageId: r.id,
    threadId: r.thread_id,
    accountId: r.account_id,
    date: r.date,
    subject: r.subject,
    fromText: r.from_text,
    fromEmail: r.from_email,
    recipients: r.recipients_text,
    body: r.body,
    hasAttachments: r.has_attachments === 1,
    bodyState: r.body_state,
  };
}

function toThreadDoc(r: ThreadDocRow): SearchThreadDoc {
  return {
    threadId: r.id,
    accountId: r.account_id,
    lastDate: r.last_date,
    inInbox: r.in_inbox === 1,
    hasSent: r.has_sent === 1,
    inTrash: r.in_trash === 1,
    inSpam: r.in_spam === 1,
    isStarred: r.is_starred === 1,
    unreadCount: r.unread_count,
    categoryIds: r.cats ? r.cats.split(",").map(Number).sort((a, b) => a - b) : [],
  };
}

/** Message projections, every message or the given ids (missing ids are simply absent). */
export function messageDocs(db: Db, ids?: readonly number[]): SearchMessageDoc[] {
  const rows = ids
    ? db.all<MessageDocRow>(`${MESSAGE_DOC} WHERE m.id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
    : db.all<MessageDocRow>(`${MESSAGE_DOC} ORDER BY m.id`);
  return rows.map(toMessageDoc);
}

export function threadDocs(db: Db, ids?: readonly number[]): SearchThreadDoc[] {
  const rows = ids
    ? db.all<ThreadDocRow>(`${THREAD_DOC} WHERE t.id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
    : db.all<ThreadDocRow>(`${THREAD_DOC} ORDER BY t.id`);
  return rows.map(toThreadDoc);
}

/** A bounded page in id order, for sliced rebuilds. */
export function messageDocsAfter(db: Db, afterId: number, limit: number): SearchMessageDoc[] {
  return db.all<MessageDocRow>(`${MESSAGE_DOC} WHERE m.id > ? ORDER BY m.id LIMIT ?`, afterId, limit).map(toMessageDoc);
}

export function threadDocsAfter(db: Db, afterId: number, limit: number): SearchThreadDoc[] {
  return db.all<ThreadDocRow>(`${THREAD_DOC} WHERE t.id > ? ORDER BY t.id LIMIT ?`, afterId, limit).map(toThreadDoc);
}
