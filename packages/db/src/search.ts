import { isFullEmail, normalizeText, parseSearch, tokenize, type MessageTerm, type SearchQuery, type View } from "@unica/core";
import { pageFrom, SUMMARY_COLUMNS, VIEW_WHERE, type Cursor, type Page, type SummaryRow } from "./queries";
import { placeholders, type Db, type Param } from "./sqlite";

export interface SearchParams {
  query: string;
  accountId?: number;
  categoryId?: number;
  cursor?: Cursor;
  limit: number;
  now?: number;
}

export type SearchStrategy = "fts" | "fts-exclude" | "sender-index" | "date-index" | "walk" | "empty";

export interface SearchResult extends Page {
  strategy: SearchStrategy;
}

const FTS_COLUMN: Record<MessageTerm["field"], string | null> = {
  text: null,
  from: "from_text",
  to: "recipients",
  subject: "subject",
};

/** Quote a term as an FTS5 string (double quotes doubled), with optional prefix star. */
function ftsPhrase(value: string, prefix: boolean): string | null {
  // Terms without any token characters would form an empty phrase.
  if (tokenize(value).length === 0) return null;
  const quoted = `"${value.replaceAll('"', '""')}"`;
  return prefix ? `${quoted} *` : quoted;
}

function ftsTerm(term: MessageTerm): string | null {
  const phrase = ftsPhrase(term.value, term.prefix);
  if (!phrase) return null;
  const column = FTS_COLUMN[term.field];
  return column ? `${column} : ${phrase}` : phrase;
}

interface Compiled {
  /** FTS MATCH expression for positive terms (with NOT clauses appended), if any */
  match: string | null;
  /** FTS expression of negative terms when there are no positive ones */
  excludeMatch: string | null;
  /** message-level SQL predicates on alias m (same-message semantics) */
  messageWhere: string[];
  messageParams: Param[];
  senderEquals: string | null;
  /** thread-level predicates on alias t */
  threadWhere: string[];
  threadParams: Param[];
  view: View;
  impossible: boolean;
}

interface ScopeLookup {
  accounts: { id: number; email: string; display_name: string }[];
  categories: { id: number; name: string }[];
}

function loadScope(db: Db): ScopeLookup {
  return {
    accounts: db.all("SELECT id, email, display_name FROM accounts"),
    categories: db.all("SELECT id, name FROM categories"),
  };
}

export function compileSearch(q: SearchQuery, params: SearchParams, scope: ScopeLookup): Compiled {
  const c: Compiled = {
    match: null,
    excludeMatch: null,
    messageWhere: [],
    messageParams: [],
    senderEquals: null,
    threadWhere: [],
    threadParams: [],
    view: q.view ?? "all",
    impossible: false,
  };

  const positive: string[] = [];
  const negative: string[] = [];
  for (const term of q.terms) {
    if (term.field === "from" && isFullEmail(term.value)) {
      const email = normalizeText(term.value);
      if (term.negate) {
        c.messageWhere.push("m.from_email != ?");
        c.messageParams.push(email);
      } else if (c.senderEquals === null) {
        c.senderEquals = email;
      } else if (c.senderEquals !== email) {
        c.impossible = true; // a message has a single sender
      }
      continue;
    }
    const expr = ftsTerm(term);
    if (!expr) continue;
    (term.negate ? negative : positive).push(expr);
  }
  if (positive.length > 0) {
    c.match = [positive.join(" AND "), ...negative].join(" NOT ");
  } else if (negative.length > 0) {
    c.excludeMatch = negative.join(" OR ");
  }
  if (c.senderEquals !== null) {
    c.messageWhere.push("m.from_email = ?");
    c.messageParams.push(c.senderEquals);
  }
  if (q.hasAttachment !== undefined) c.messageWhere.push(`m.has_attachments = ${q.hasAttachment ? 1 : 0}`);
  if (q.before !== undefined) {
    c.messageWhere.push("m.date < ?");
    c.messageParams.push(q.before);
  }
  if (q.after !== undefined) {
    c.messageWhere.push("m.date >= ?");
    c.messageParams.push(q.after);
  }

  // Thread-level scope
  const accountIds = new Set<number>();
  if (params.accountId !== undefined) accountIds.add(params.accountId);
  for (const token of q.accounts) {
    const matches = scope.accounts.filter(
      (a) => normalizeText(a.email).includes(token) || normalizeText(a.display_name).includes(token),
    );
    if (matches.length === 0) c.impossible = true;
    // account:x narrows to the accounts matching x
    if (params.accountId !== undefined) {
      if (!matches.some((m) => m.id === params.accountId)) c.impossible = true;
    } else {
      for (const m of matches) accountIds.add(m.id);
    }
  }
  if (accountIds.size > 0) {
    c.threadWhere.push(`t.account_id IN (${placeholders(accountIds.size)})`);
    c.threadParams.push(...accountIds);
  }
  const categoryIds: number[] = [];
  if (params.categoryId !== undefined) categoryIds.push(params.categoryId);
  for (const token of q.categories) {
    const match = scope.categories.find((cat) => normalizeText(cat.name) === token) ??
      scope.categories.find((cat) => normalizeText(cat.name).startsWith(token));
    if (!match) c.impossible = true;
    else categoryIds.push(match.id);
  }
  // every requested category must contain the thread
  for (const id of new Set(categoryIds)) {
    c.threadWhere.push("EXISTS (SELECT 1 FROM thread_categories tc WHERE tc.thread_id = t.id AND tc.category_id = ?)");
    c.threadParams.push(id);
  }
  if (q.unread !== undefined) c.threadWhere.push(q.unread ? "t.unread_count > 0" : "t.unread_count = 0");
  if (q.starred !== undefined) c.threadWhere.push(`t.is_starred = ${q.starred ? 1 : 0}`);
  return c;
}

function threadClause(c: Compiled, cursor: Cursor | undefined): { where: string; params: Param[] } {
  const where = [VIEW_WHERE[c.view], ...c.threadWhere];
  const params = [...c.threadParams];
  if (cursor) {
    where.push("(t.last_date, t.id) < (?, ?)");
    params.push(cursor.lastDate, cursor.id);
  }
  return { where: where.join(" AND "), params };
}

/**
 * Picks a strategy by selectivity, not syntax:
 *  - free text            → materialize FTS hits (deduped thread ids), then order threads
 *  - exact sender address → materialize hits through the sender index
 *  - only "before:" dates → materialize through the message date index
 *  - otherwise            → walk the view's chronological index with an EXISTS probe
 * Message predicates are applied before deduplication (same-message semantics),
 * and hits are never LIMITed before thread filtering.
 */
export function searchThreads(db: Db, params: SearchParams): SearchResult {
  const q = parseSearch(params.query, params.now);
  const c = compileSearch(q, params, loadScope(db));
  if (c.impossible) return { items: [], nextCursor: null, strategy: "empty" };
  const { where, params: tParams } = threadClause(c, params.cursor);
  const limit = params.limit + 1;
  const mWhere = c.messageWhere.length ? ` AND ${c.messageWhere.join(" AND ")}` : "";

  let strategy: SearchStrategy;
  let rows: SummaryRow[];
  if (c.match) {
    strategy = "fts";
    rows = db.all<SummaryRow>(
      `WITH hits AS MATERIALIZED (
         SELECT DISTINCT m.thread_id AS tid FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ?${mWhere}
       )
       SELECT ${SUMMARY_COLUMNS} FROM hits JOIN threads t ON t.id = hits.tid
       WHERE ${where} ORDER BY t.last_date DESC, t.id DESC LIMIT ?`,
      c.match,
      ...c.messageParams,
      ...tParams,
      limit,
    );
  } else if (c.senderEquals !== null) {
    strategy = "sender-index";
    rows = db.all<SummaryRow>(
      `WITH hits AS MATERIALIZED (
         SELECT DISTINCT m.thread_id AS tid FROM messages m INDEXED BY messages_from WHERE 1${mWhere}
       )
       SELECT ${SUMMARY_COLUMNS} FROM hits JOIN threads t ON t.id = hits.tid
       WHERE ${where}${c.excludeMatch ? " AND " + excludeClause() : ""}
       ORDER BY t.last_date DESC, t.id DESC LIMIT ?`,
      ...c.messageParams,
      ...tParams,
      ...(c.excludeMatch ? [c.excludeMatch] : []),
      limit,
    );
  } else if (q.before !== undefined && q.after === undefined) {
    strategy = "date-index";
    rows = db.all<SummaryRow>(
      `WITH hits AS MATERIALIZED (
         SELECT DISTINCT m.thread_id AS tid FROM messages m INDEXED BY messages_date WHERE 1${mWhere}
       )
       SELECT ${SUMMARY_COLUMNS} FROM hits JOIN threads t ON t.id = hits.tid
       WHERE ${where}${c.excludeMatch ? " AND " + excludeClause() : ""}
       ORDER BY t.last_date DESC, t.id DESC LIMIT ?`,
      ...c.messageParams,
      ...tParams,
      ...(c.excludeMatch ? [c.excludeMatch] : []),
      limit,
    );
  } else {
    strategy = c.excludeMatch ? "fts-exclude" : "walk";
    const extra: string[] = [];
    const extraParams: Param[] = [];
    if (c.messageWhere.length) {
      // has:attachment alone is exactly the thread aggregate; avoid the probe
      if (c.messageWhere.length === 1 && c.messageWhere[0] === "m.has_attachments = 1") {
        extra.push("t.has_attachments = 1");
      } else {
        extra.push(`EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id${mWhere})`);
        extraParams.push(...c.messageParams);
      }
    }
    if (c.excludeMatch) {
      extra.push(excludeClause());
      extraParams.push(c.excludeMatch);
    }
    rows = db.all<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM threads t WHERE ${where}${extra.length ? " AND " + extra.join(" AND ") : ""}
       ORDER BY t.last_date DESC, t.id DESC LIMIT ?`,
      ...tParams,
      ...extraParams,
      limit,
    );
  }
  return { ...pageFrom(rows, params.limit), strategy };
}

/** Threads with no message matching the negated terms (FTS5 NOT needs a positive left side). */
function excludeClause(): string {
  return `t.id NOT IN (SELECT m2.thread_id FROM messages_fts JOIN messages m2 ON m2.id = messages_fts.rowid
                       WHERE messages_fts MATCH ?)`;
}

/** True while some messages still lack a full body (search may be incomplete). */
export function searchIsComplete(db: Db): boolean {
  return db.get("SELECT 1 FROM messages WHERE body_state != 'full' LIMIT 1") === undefined;
}
