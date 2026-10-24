import type {
  AttachmentInfo,
  Counts,
  MessageDetail,
  ThreadDetail,
  ThreadSummary,
  View,
} from "@unica/core";
import type { ListParams, Page, ScopeParams } from "@unica/store";
import { placeholders, type Db, type Param } from "./sqlite";

export type { Cursor, ListParams, Page } from "@unica/store";

/**
 * WHERE fragments per view. They textually match the partial index predicates
 * in migrations.ts so SQLite's planner can prove the partial indexes usable.
 */
export const VIEW_WHERE: Record<View, string> = {
  inbox: "t.in_inbox = 1",
  starred: "t.is_starred = 1 AND t.in_trash = 0 AND t.in_spam = 0",
  sent: "t.has_sent = 1 AND t.in_trash = 0 AND t.in_spam = 0",
  archive: "t.in_inbox = 0 AND t.in_trash = 0 AND t.in_spam = 0",
  spam: "t.in_spam = 1 AND t.in_trash = 0",
  trash: "t.in_trash = 1",
  all: "t.in_trash = 0 AND t.in_spam = 0",
};

export const SUMMARY_COLUMNS = `t.id, t.account_id, t.subject, t.snippet, t.last_date, t.last_from_name,
  t.last_from_email, t.message_count, t.unread_count, t.is_starred, t.has_attachments,
  (SELECT group_concat(category_id) FROM thread_categories WHERE thread_id = t.id) AS cats`;

export interface SummaryRow {
  id: number;
  account_id: number;
  subject: string;
  snippet: string;
  last_date: number;
  last_from_name: string;
  last_from_email: string;
  message_count: number;
  unread_count: number;
  is_starred: number;
  has_attachments: number;
  cats: string | null;
}

export function toSummary(r: SummaryRow): ThreadSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    subject: r.subject,
    snippet: r.snippet,
    lastDate: r.last_date,
    fromName: r.last_from_name || r.last_from_email,
    fromEmail: r.last_from_email,
    messageCount: r.message_count,
    unread: r.unread_count > 0,
    starred: r.is_starred === 1,
    hasAttachments: r.has_attachments === 1,
    categoryIds: r.cats ? r.cats.split(",").map(Number) : [],
  };
}




export function pageFrom(rows: SummaryRow[], limit: number): Page {
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(toSummary);
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? { lastDate: last.lastDate, id: last.id } : null };
}

/** Keyset-paginated list of a view, optionally scoped to an account and/or category. */
export function listThreads(db: Db, p: ListParams): Page {
  const where = [VIEW_WHERE[p.view]];
  const params: Param[] = [];
  let from = "threads t";
  if (p.categoryId !== undefined) {
    from = "thread_categories tc JOIN threads t ON t.id = tc.thread_id";
    where.unshift("tc.category_id = ?");
    params.push(p.categoryId);
  }
  if (p.accountId !== undefined) {
    where.push("t.account_id = ?");
    params.push(p.accountId);
  }
  if (p.cursor) {
    where.push("(t.last_date, t.id) < (?, ?)");
    params.push(p.cursor.lastDate, p.cursor.id);
  }
  params.push(p.limit + 1);
  const rows = db.all<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM ${from} WHERE ${where.join(" AND ")}
     ORDER BY t.last_date DESC, t.id DESC LIMIT ?`,
    ...params,
  );
  return pageFrom(rows, p.limit);
}

/** What a view (account/category optional) is, for the id-only scope queries: index-backed, no display columns. */
function scopeFrom(p: ScopeParams): { from: string; where: string; params: Param[] } {
  const where = [VIEW_WHERE[p.view]];
  const params: Param[] = [];
  let from = "threads t";
  if (p.categoryId !== undefined) {
    // through the membership index (category_id, thread_id), then the thread by key
    from = "thread_categories tc JOIN threads t ON t.id = tc.thread_id";
    where.unshift("tc.category_id = ?");
    params.push(p.categoryId);
  }
  if (p.accountId !== undefined) {
    where.push("t.account_id = ?");
    params.push(p.accountId);
  }
  return { from, where: where.join(" AND "), params };
}

/** Every thread id of a view ("select all N"), up to `limit`, in no particular order. */
export function scopeThreadIds(db: Db, p: ScopeParams & { limit: number }): number[] {
  const s = scopeFrom(p);
  return db.all<{ id: number }>(`SELECT t.id FROM ${s.from} WHERE ${s.where} LIMIT ?`, ...s.params, p.limit).map((r) => r.id);
}

/** How many threads a view holds, counted (up to `limit`). */
export function countScopeThreads(db: Db, p: ScopeParams & { limit: number }): number {
  const s = scopeFrom(p);
  return db.get<{ c: number }>(`SELECT count(*) AS c FROM (SELECT 1 FROM ${s.from} WHERE ${s.where} LIMIT ?)`, ...s.params, p.limit)!.c;
}

export function getSummaries(db: Db, threadIds: readonly number[]): ThreadSummary[] {
  if (threadIds.length === 0) return [];
  const rows = db.all<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM threads t WHERE t.id IN (${placeholders(threadIds.length)})
     ORDER BY t.last_date DESC, t.id DESC`,
    ...threadIds,
  );
  return rows.map(toSummary);
}

interface MessageRow {
  id: number;
  thread_id: number;
  account_id: number;
  from_name: string;
  from_email: string;
  to_json: string;
  cc_json: string;
  subject: string;
  date: number;
  snippet: string;
  body_text: string | null;
  body_html: string | null;
  body_state: "none" | "partial" | "full";
  is_read: number;
  is_starred: number;
  is_sent: number;
  has_attachments: number;
  rfc_message_id: string | null;
  references_json: string;
  list_id: string | null;
}

export function getThread(db: Db, threadId: number): ThreadDetail | null {
  const row = db.get<SummaryRow & { in_inbox: number; in_trash: number; in_spam: number }>(
    `SELECT ${SUMMARY_COLUMNS}, t.in_inbox, t.in_trash, t.in_spam FROM threads t WHERE t.id = ?`,
    threadId,
  );
  if (!row) return null;
  const messages = db.all<MessageRow>(
    `SELECT m.id, m.thread_id, m.account_id, m.from_name, m.from_email, m.to_json, m.cc_json, m.subject, m.date, m.snippet,
            b.body_text, b.body_html, m.body_state, m.is_read, m.is_starred, m.is_sent, m.has_attachments,
            m.rfc_message_id, m.references_json, m.list_id
     FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id WHERE m.thread_id = ? ORDER BY m.date ASC, m.id ASC`,
    threadId,
  );
  const attachments = new Map<number, AttachmentInfo[]>();
  if (messages.some((m) => m.has_attachments)) {
    for (const a of db.all<AttachmentInfo & { message_id: number }>(
      `SELECT a.id, a.message_id, a.filename, a.mime, a.size FROM attachments a
       JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ?`,
      threadId,
    )) {
      const list = attachments.get(a.message_id) ?? [];
      list.push({ id: a.id, filename: a.filename, mime: a.mime, size: a.size });
      attachments.set(a.message_id, list);
    }
  }
  return {
    thread: { ...toSummary(row), inInbox: row.in_inbox === 1, inTrash: row.in_trash === 1, inSpam: row.in_spam === 1 },
    messages: messages.map(
      (m): MessageDetail => ({
        id: m.id,
        threadId: m.thread_id,
        accountId: m.account_id,
        from: { name: m.from_name, email: m.from_email },
        to: JSON.parse(m.to_json),
        cc: JSON.parse(m.cc_json),
        subject: m.subject,
        date: m.date,
        snippet: m.snippet,
        bodyText: m.body_text,
        bodyHtml: m.body_html,
        bodyState: m.body_state,
        isRead: m.is_read === 1,
        isStarred: m.is_starred === 1,
        isSent: m.is_sent === 1,
        hasAttachments: m.has_attachments === 1,
        rfcMessageId: m.rfc_message_id,
        references: JSON.parse(m.references_json),
        listId: m.list_id,
        attachments: attachments.get(m.id) ?? [],
      }),
    ),
  };
}

/** Sidebar counts. Unread semantics: unread THREADS. */
export function getCounts(db: Db): Counts {
  const byAccount: Record<number, number> = {};
  let inboxUnread = 0;
  for (const r of db.all<{ account_id: number; c: number }>(
    "SELECT account_id, count(*) AS c FROM threads WHERE in_inbox = 1 AND unread_count > 0 GROUP BY account_id",
  )) {
    byAccount[r.account_id] = r.c;
    inboxUnread += r.c;
  }
  const categoryUnread: Record<number, number> = {};
  const categoryTotal: Record<number, number> = {};
  for (const r of db.all<{ category_id: number; total: number; unread: number }>(
    `SELECT tc.category_id, count(*) AS total, sum(t.unread_count > 0) AS unread
     FROM thread_categories tc JOIN threads t ON t.id = tc.thread_id
     WHERE t.in_trash = 0 AND t.in_spam = 0 GROUP BY tc.category_id`,
  )) {
    categoryTotal[r.category_id] = r.total;
    categoryUnread[r.category_id] = r.unread;
  }
  return { inboxUnread, inboxUnreadByAccount: byAccount, categoryUnread, categoryTotal, categorySuggestions: pendingSuggestionCounts(db) };
}

/** Suggestions waiting for an answer, per category ("Revisar (N)"). */
export function pendingSuggestionCounts(db: Db): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of db.all<{ category_id: number; n: number }>(
    `SELECT d.category_id, count(*) AS n FROM cls_decisions d INDEXED BY cls_decisions_pending JOIN threads t ON t.id = d.thread_id
     WHERE d.kind = 'suggest' AND d.outcome IS NULL AND t.in_trash = 0 AND t.in_spam = 0
       AND NOT EXISTS (SELECT 1 FROM thread_categories tc WHERE tc.thread_id = d.thread_id AND tc.category_id = d.category_id)
     GROUP BY d.category_id`,
  )) {
    out[r.category_id] = r.n;
  }
  return out;
}
