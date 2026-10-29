import { cleanFromName, folderRef, listFilterOf, storedAddresses, waitingCutoff } from "@terno/core";
import type {
  AttachmentInfo,
  Counts,
  ListFilter,
  MessageDetail,
  ThreadDetail,
  ThreadSummary,
  View,
  SearchView,
} from "@terno/core";
import { keepInPage, type ListParams, type Page, type ScopeParams } from "@terno/store";
import { placeholders, type Db, type Param } from "./sqlite";
import { factsReady } from "./facts";

export type { Cursor, ListParams, Page } from "@terno/store";

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

/** Plan 64: a search looks everywhere unless it says in:… (Spam and Trash too). */
export const SEARCH_VIEW_WHERE: Record<SearchView, string> = { ...VIEW_WHERE, anywhere: "1" };

export const SUMMARY_COLUMNS = `t.id, t.account_id, t.subject, t.snippet, t.last_date, t.last_from_name,
  t.last_from_email, t.message_count, t.unread_count, t.is_starred, t.has_attachments, t.person, t.waiting_since, t.in_inbox, t.in_spam, t.in_trash,
  EXISTS (SELECT 1 FROM messages s INDEXED BY messages_thread WHERE s.thread_id = t.id AND s.is_spam = 1) AS has_spam,
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
  person: number | null;
  waiting_since: number | null;
  in_inbox: number;
  in_spam: number;
  in_trash: number;
  has_spam: number;
  cats: string | null;
}

export function toSummary(r: SummaryRow): ThreadSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    subject: r.subject,
    snippet: r.snippet,
    lastDate: r.last_date,
    fromName: cleanFromName(r.last_from_name) || r.last_from_email,
    fromEmail: r.last_from_email,
    messageCount: r.message_count,
    unread: r.unread_count > 0,
    starred: r.is_starred === 1,
    hasAttachments: r.has_attachments === 1,
    categoryIds: r.cats ? r.cats.split(",").map(Number) : [],
    person: r.person === 1,
    waitingSince: r.waiting_since,
    inInbox: r.in_inbox === 1,
    inSpam: r.in_spam === 1,
    inTrash: r.in_trash === 1,
    hasSpam: r.has_spam === 1,
  };
}




export function pageFrom(rows: SummaryRow[], limit: number): Page {
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(toSummary);
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? { lastDate: last.lastDate, id: last.id } : null };
}

/**
 * Each quick filter's predicate, textually its partial indexes' (unread:
 * migration v11; attachments and starred: v12; people and waiting: v14), and
 * those indexes: by date for pages, by id for scopes. Waiting has no id
 * index: its window bounds the date index's range (waiting_since <=
 * last_date), so a scope walks that range and orders the few it holds.
 */
interface FilterSql {
  where: string;
  params: Param[];
  byDate: string;
  byId: string | null;
}

const FILTER: Record<Exclude<ListFilter, "waiting">, FilterSql> = {
  unread: { where: "t.unread_count > 0", params: [], byDate: "threads_unread", byId: "threads_unread_id" },
  people: { where: "t.person = 1", params: [], byDate: "threads_people", byId: "threads_people_id" },
  attachments: { where: "t.has_attachments = 1", params: [], byDate: "threads_attach", byId: "threads_attach_id" },
  starred: { where: "t.is_starred = 1", params: [], byDate: "threads_starred_f", byId: "threads_starred_f_id" },
};

/** The Waiting filter at `now`: the threads whose waiting began inside the window (plan 17 §2.4). */
export function waitingSql(now: number | undefined): FilterSql {
  if (now === undefined) throw new Error("the Waiting filter needs the caller's clock (now)");
  const cutoff = waitingCutoff(now);
  return { where: "t.waiting_since IS NOT NULL AND t.last_date >= ? AND t.waiting_since >= ?", params: [cutoff, cutoff], byDate: "threads_waiting", byId: null };
}

function filterSql(filter: ListFilter, now: number | undefined): FilterSql {
  return filter === "waiting" ? waitingSql(now) : FILTER[filter];
}

/** Keyset-paginated list of a view, optionally scoped to an account and/or category. */
export function listThreads(db: Db, p: ListParams): Page {
  const q = listSql(p);
  const page = pageFrom(db.all<SummaryRow>(q.sql, ...q.params), p.limit);
  if (!listFilterOf(p) || !p.keepIds?.length) return page;
  // the kept threads, by key, against the view without the filter
  const k = listSql({ ...p, unreadOnly: false, filter: undefined, limit: p.keepIds.length }, p.keepIds);
  return keepInPage(page, db.all<SummaryRow>(k.sql, ...k.params).map(toSummary));
}

/** The SQL a list page runs (query-plan tests: the unread filter walks threads_unread); `only`: those threads, the ones the page's view holds. */
export function listSql(p: ListParams, only?: readonly number[]): { sql: string; params: Param[] } {
  const where = [VIEW_WHERE[p.view]];
  const params: Param[] = [];
  // unread: pinned to the unread index, which tests view and account in the index (the planner
  // picks a view's date index instead and reads a row per thread, or sorts a category: measured in plan 12)
  const filter = listFilterOf(p);
  const f = filter ? filterSql(filter, p.now) : null;
  // plan 65: a folder walks its memberships by date (outer, CROSS JOIN), filtered or not, and joins the threads
  const threads = f && p.folder === undefined ? `threads t INDEXED BY ${f.byDate}` : "threads t";
  if (f) {
    where.push(f.where);
    params.push(...f.params);
  }
  let from = threads;
  let order = "t.last_date DESC, t.id DESC";
  // the kept threads of a filtered folder: looked up by key, each tested for the folder (never a walk of it, Codex R1)
  const folderPage = p.folder !== undefined && only === undefined;
  // a folder reads through the account's list: one it no longer lists holds nothing (its rows wait unseen)
  if (folderPage) {
    from = `thread_folders tf INDEXED BY thread_folders_date CROSS JOIN ${threads} ON t.id = tf.thread_id`;
    where.unshift("tf.account_id = ? AND tf.folder = ? AND EXISTS (SELECT 1 FROM folders WHERE account_id = ? AND key = ?)");
    params.unshift(p.accountId!, p.folder!, p.accountId!, p.folder!);
    order = "tf.last_date DESC, tf.thread_id DESC";
  } else if (p.folder !== undefined) {
    where.push("EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.thread_id = t.id AND tf.folder = ?) AND EXISTS (SELECT 1 FROM folders WHERE account_id = ? AND key = ?)");
    params.push(p.folder, p.accountId!, p.folder);
  }
  if (p.categoryId !== undefined) {
    from = `thread_categories tc JOIN ${threads} ON t.id = tc.thread_id`;
    where.unshift("tc.category_id = ?");
    params.unshift(p.categoryId);
  }
  if (p.accountId !== undefined) {
    where.push("t.account_id = ?");
    params.push(p.accountId);
  }
  if (p.cursor) {
    where.push(folderPage ? "(tf.last_date, tf.thread_id) < (?, ?)" : "(t.last_date, t.id) < (?, ?)");
    params.push(p.cursor.lastDate, p.cursor.id);
  }
  if (only !== undefined) {
    where.push(`t.id IN (${placeholders(only.length)})`);
    params.push(...only);
  }
  params.push(p.limit + 1);
  return {
    sql: `SELECT ${SUMMARY_COLUMNS} FROM ${from} WHERE ${where.join(" AND ")}
     ORDER BY ${order} LIMIT ?`,
    params,
  };
}

/** What a view (account/category optional) is, for the id-only scope queries: index-backed, no display columns. */
function scopeFrom(p: ScopeParams, paged = false): { from: string; where: string; params: Param[] } {
  const where = [VIEW_WHERE[p.view]];
  const params: Param[] = [];
  // pages walk an index in id order and stop at the limit: the threads by key, an account's by (account_id, id),
  // the unread ones by threads_unread_id (testing view and account in it), a category's memberships by
  // (category_id, thread_id); pinned, so the planner never picks a date index and sorts
  // (a count lets the planner pick: a view's partial index counts fastest; an unread count walks the unread
  // index, testing in it, where a view's index reads a row per thread; a category's counts its memberships)
  // (waiting: the window's range of its date index, ordered by id after; a sort of the threads that wait, never the mailbox)
  const filter = listFilterOf(p);
  const f = filter ? filterSql(filter, p.now) : null;
  let from = f ? `threads t INDEXED BY ${f.byId ?? f.byDate}` : !paged ? "threads t" : p.accountId !== undefined ? "threads t INDEXED BY threads_account_id" : "threads t NOT INDEXED";
  if (p.folder !== undefined) {
    // plan 65: a folder's memberships by (account, folder, thread), outer like a category's
    from = paged ? "thread_folders tf INDEXED BY thread_folders_id CROSS JOIN threads t ON t.id = tf.thread_id" : "thread_folders tf JOIN threads t ON t.id = tf.thread_id";
    where.unshift("tf.account_id = ? AND tf.folder = ? AND EXISTS (SELECT 1 FROM folders WHERE account_id = ? AND key = ?)");
    params.unshift(p.accountId!, p.folder, p.accountId!, p.folder);
  }
  if (p.categoryId !== undefined) {
    // CROSS JOIN keeps the memberships outer (SQLite never reorders it)
    from = paged ? "thread_categories tc INDEXED BY thread_categories_c CROSS JOIN threads t ON t.id = tc.thread_id" : "thread_categories tc JOIN threads t ON t.id = tc.thread_id";
    where.unshift("tc.category_id = ?");
    params.unshift(p.categoryId);
  }
  if (p.accountId !== undefined) {
    where.push("t.account_id = ?");
    params.push(p.accountId);
  }
  if (f) {
    where.push(f.where);
    params.push(...f.params);
  }
  return { from, where: where.join(" AND "), params };
}

/**
 * A view's thread ids above `after`, ascending ("select all N" in keyset
 * pages): a category walks its membership index (category_id, thread_id) in
 * order, any other view the threads by key.
 */
export function scopeThreadIds(db: Db, p: ScopeParams & { after?: number; limit: number }): number[] {
  const q = scopeIdsSql(p);
  return db.all<{ id: number }>(q.sql, ...q.params).map((r) => r.id);
}

/** The SQL a scope page runs (query-plan tests: an index walk in key order, never a sort). */
export function scopeIdsSql(p: ScopeParams & { after?: number; limit: number }): { sql: string; params: Param[] } {
  const s = scopeFrom(p, true);
  const key = p.folder !== undefined ? "tf.thread_id" : p.categoryId !== undefined ? "tc.thread_id" : "t.id";
  return { sql: `SELECT ${key} AS id FROM ${s.from} WHERE ${s.where} AND ${key} > ? ORDER BY ${key} LIMIT ?`, params: [...s.params, p.after ?? 0, p.limit] };
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
  reply_to_json: string;
  subject: string;
  date: number;
  snippet: string;
  body_text: string | null;
  body_html: string | null;
  body_state: "none" | "partial" | "full";
  attachments_captured: number;
  is_read: number;
  is_starred: number;
  is_sent: number;
  has_attachments: number;
  rfc_message_id: string | null;
  references_json: string;
  list_id: string | null;
}

export function getThread(db: Db, threadId: number): ThreadDetail | null {
  // the summary's columns carry the place (plan 64)
  const row = db.get<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM threads t WHERE t.id = ?`,
    threadId,
  );
  if (!row) return null;
  const messages = db.all<MessageRow>(
    `SELECT m.id, m.thread_id, m.account_id, m.from_name, m.from_email, m.to_json, m.cc_json, m.reply_to_json, m.subject, m.date, m.snippet,
            b.body_text, b.body_html, m.body_state, m.attachments_captured, m.is_read, m.is_starred, m.is_sent, m.has_attachments,
            m.rfc_message_id, m.references_json, m.list_id
     FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id WHERE m.thread_id = ? ORDER BY m.date ASC, m.id ASC`,
    threadId,
  );
  const attachments = new Map<number, AttachmentInfo[]>();
  if (messages.some((m) => m.has_attachments)) {
    for (const a of db.all<AttachmentInfo & { message_id: number }>(
      `SELECT a.id, a.message_id, a.filename, a.mime, a.size, a.asset_id AS assetId, a.content_id AS contentId FROM attachments a
       JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ?`,
      threadId,
    )) {
      const list = attachments.get(a.message_id) ?? [];
      list.push({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, assetId: a.assetId ?? undefined, contentId: a.contentId });
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
        // repaired at read (plan 34): mail an older parser stored reads right, no backfill
        ...storedAddresses(m),
        subject: m.subject,
        date: m.date,
        snippet: m.snippet,
        bodyText: m.body_text,
        bodyHtml: m.body_html,
        bodyState: m.body_state,
        attachmentState: m.attachments_captured === 1 ? "complete" : m.attachments_captured === 2 ? "unavailable" : "pending",
        ...(m.attachments_captured === 2 && m.body_state !== "full" ? { bodyUnavailable: "size" as const } : {}),
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
export function getCounts(db: Db, now: number): Counts {
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
  return { inboxUnread, inboxUnreadByAccount: byAccount, categoryUnread, categoryTotal, categorySuggestions: pendingSuggestionCounts(db), ...waitingCounts(db, now), folderUnread: folderUnreadCounts(db) };
}

/** plan 65: unread threads per listed folder ("accountId:key"), from the unread memberships alone. */
export function folderUnreadCounts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.all<{ account_id: number; folder: string; c: number }>(
    `SELECT tf.account_id, tf.folder, count(*) AS c FROM thread_folders tf INDEXED BY thread_folders_unread
     JOIN folders f ON f.account_id = tf.account_id AND f.key = tf.folder WHERE tf.unread = 1 GROUP BY tf.account_id, tf.folder`,
  )) out[folderRef(r.account_id, r.folder)] = r.c;
  return out;
}

/**
 * Inbox threads waiting for your reply (plan 17), per account: the window's range of
 * threads_waiting. Unknown (null) while any thread's facts are pending.
 */
export function waitingCounts(db: Db, now: number): Pick<Counts, "inboxWaiting" | "inboxWaitingByAccount"> {
  if (!factsReady(db)) return { inboxWaiting: null, inboxWaitingByAccount: {} };
  const byAccount: Record<number, number> = {};
  let total = 0;
  // threads_waiting_inbox holds only the inbox's waiting threads: the window is its range (waiting_since <= last_date, so no date test)
  for (const r of db.all<{ account_id: number; c: number }>(
    "SELECT account_id, count(*) AS c FROM threads INDEXED BY threads_waiting_inbox WHERE in_inbox = 1 AND waiting_since IS NOT NULL AND waiting_since >= ? GROUP BY account_id",
    waitingCutoff(now),
  )) {
    byAccount[r.account_id] = r.c;
    total += r.c;
  }
  return { inboxWaiting: total, inboxWaitingByAccount: byAccount };
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
