import { BODY_TAIL_TOKENS, baseSubject, emailDomain, featuresFromBlob, normalizeText, trailingTokens, type Address } from "@unica/core";
import type { ModelDelta } from "./categorize";
import { placeholders, type Db } from "./sqlite";
import { pruneOpTargets } from "./repos";

export interface IncomingAttachment {
  filename: string;
  mime: string;
  size: number;
  contentId?: string | null;
  providerRef?: string | null;
}

export interface IncomingLocation {
  mailbox: string;
  uidvalidity: number;
  uid: number;
  flags: string[];
}

export interface IncomingMessage {
  accountId: number;
  providerMsgId: string | null;
  /** Gmail threadId; when null, threading uses RFC headers */
  providerThreadId: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  date: number;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyState: "none" | "partial" | "full";
  listId: string | null;
  isRead: boolean;
  isStarred: boolean;
  inInbox: boolean;
  isSent: boolean;
  isDraft: boolean;
  isTrash: boolean;
  isSpam: boolean;
  hasAttachments: boolean;
  gmailLabels?: string[] | null;
  size: number;
  attachments?: IncomingAttachment[];
  locations?: IncomingLocation[];
}

export interface IngestResult {
  inserted: number[];
  updated: number[];
  touchedThreads: Set<number>;
  /** thread ids that were merged away (deleted) into another thread */
  mergedThreads: Map<number, number>;
  /** existing messages whose body became complete in this batch (body filters must re-run) */
  bodyCompleted: number[];
  /** in-memory model changes (thread merges reconcile training examples): apply after commit */
  deltas: ModelDelta[];
}

export function recipientsText(to: Address[], cc: Address[], bcc: Address[]): string {
  return [...to, ...cc, ...bcc].map((a) => (a.name ? `${a.name} ${a.email}` : a.email)).join(" ");
}

const SNIPPET_MAX = 200;
export function makeSnippet(text: string | null | undefined): string {
  if (!text) return "";
  const collapsed = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > SNIPPET_MAX ? `${collapsed.slice(0, SNIPPET_MAX - 1)}…` : collapsed;
}

function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim().replace(/^<|>$/g, "").trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Finds or creates the thread for a new message. Uses the provider thread id
 * when present (Gmail); otherwise RFC 5322 Message-ID / In-Reply-To / References,
 * including messages that arrived earlier and reference *this* one. Never merges
 * on subject alone: a false merge makes destructive triage dangerous.
 */
function resolveThread(db: Db, msg: IncomingMessage, rfcId: string | null, refs: string[], result: IngestResult): number {
  if (msg.providerThreadId) {
    const existing = db.get<{ id: number }>(
      "SELECT id FROM threads WHERE account_id = ? AND provider_thread_id = ?",
      msg.accountId,
      msg.providerThreadId,
    );
    if (existing) return existing.id;
    return db.run("INSERT INTO threads (account_id, provider_thread_id) VALUES (?, ?)", msg.accountId, msg.providerThreadId)
      .lastInsertRowid;
  }

  const candidates = new Set<number>();
  if (refs.length > 0) {
    for (const row of db.all<{ thread_id: number }>(
      `SELECT DISTINCT thread_id FROM messages WHERE account_id = ? AND rfc_message_id IN (${placeholders(refs.length)})`,
      msg.accountId,
      ...refs,
    )) {
      candidates.add(row.thread_id);
    }
  }
  if (rfcId) {
    for (const row of db.all<{ thread_id: number }>(
      `SELECT DISTINCT m.thread_id FROM message_refs r JOIN messages m ON m.id = r.message_id
       WHERE r.account_id = ? AND r.ref = ?`,
      msg.accountId,
      rfcId,
    )) {
      candidates.add(row.thread_id);
    }
  }
  if (candidates.size === 0) {
    return db.run("INSERT INTO threads (account_id) VALUES (?)", msg.accountId).lastInsertRowid;
  }
  const sorted = [...candidates].sort((a, b) => a - b);
  const keep = sorted[0]!;
  for (const other of sorted.slice(1)) mergeThreads(db, keep, other, result);
  return keep;
}

/**
 * Gives a local thread its provider thread id (e.g. the Gmail threadId of a
 * conversation we started). If another local thread already has that id, the
 * two are merged so replies don't split the conversation. Returns the surviving id.
 */
export function adoptProviderThread(db: Db, threadId: number, accountId: number, providerThreadId: string, result?: IngestResult, deltas?: ModelDelta[]): number {
  const current = db.get<{ provider_thread_id: string | null }>("SELECT provider_thread_id FROM threads WHERE id = ?", threadId);
  if (!current || current.provider_thread_id === providerThreadId) return threadId;
  if (current.provider_thread_id) return threadId; // never re-home a thread that already has an identity
  const other = db.get<{ id: number }>("SELECT id FROM threads WHERE account_id = ? AND provider_thread_id = ?", accountId, providerThreadId);
  const res = result ?? { inserted: [], updated: [], touchedThreads: new Set<number>(), mergedThreads: new Map(), bodyCompleted: [], deltas: [] };
  if (other) {
    const [keep, drop] = other.id < threadId ? [other.id, threadId] : [threadId, other.id];
    db.run("UPDATE threads SET provider_thread_id = NULL WHERE id = ?", drop);
    mergeThreads(db, keep, drop, res);
    db.run("UPDATE threads SET provider_thread_id = ? WHERE id = ?", providerThreadId, keep);
    if (!result) {
      recomputeThreads(db, [keep]);
      deltas?.push(...res.deltas);
    }
    return keep;
  }
  db.run("UPDATE threads SET provider_thread_id = ? WHERE id = ?", providerThreadId, threadId);
  return threadId;
}

/**
 * Moves every message and category of `from` into `into` and deletes `from`.
 * Per category the newest explicit decision (training example) of either
 * half wins: a removal is never undone by the other half's membership, and
 * the losing example leaves the training set (an untrain delta).
 */
export function mergeThreads(db: Db, into: number, from: number, result: IngestResult): void {
  db.run("UPDATE messages SET thread_id = ? WHERE thread_id = ?", into, from);
  const examples = db.all<{ thread_id: number; category_id: number; label: number; weight: number; at: number; content: number; features: Uint8Array }>(
    "SELECT thread_id, category_id, label, weight, at, content, features FROM cls_examples WHERE thread_id IN (?, ?)",
    into,
    from,
  );
  const winners = new Map<number, (typeof examples)[number]>();
  for (const e of examples) {
    const other = winners.get(e.category_id);
    const newer = !other || e.at > other.at || (e.at === other.at && e.thread_id === into);
    const loser = newer ? other : e;
    if (newer) winners.set(e.category_id, e);
    if (!loser) continue;
    db.run("DELETE FROM cls_examples WHERE thread_id = ? AND category_id = ?", loser.thread_id, loser.category_id);
    result.deltas.push({
      op: "untrain",
      example: { categoryId: loser.category_id, label: loser.label > 0 ? 1 : -1, weight: loser.weight, at: loser.at, content: loser.content === 1, features: featuresFromBlob(loser.features) },
    });
  }
  db.run("UPDATE OR IGNORE cls_examples SET thread_id = ? WHERE thread_id = ?", into, from);
  db.run(
    `INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at, batch_id)
     SELECT ?, category_id, added_by, added_at, batch_id FROM thread_categories WHERE thread_id = ?`,
    into,
    from,
  );
  for (const [categoryId, e] of winners) {
    if (e.label < 0) db.run("DELETE FROM thread_categories WHERE thread_id = ? AND category_id = ?", into, categoryId);
  }
  db.run("UPDATE OR IGNORE cls_decisions SET thread_id = ? WHERE thread_id = ?", into, from);
  db.run("DELETE FROM threads WHERE id = ?", from);
  result.touchedThreads.delete(from);
  result.touchedThreads.add(into);
  result.mergedThreads.set(from, into);
}

const INSERT_MESSAGE = `
INSERT INTO messages (
  id, account_id, thread_id, provider_msg_id, rfc_message_id, in_reply_to, references_json,
  from_name, from_email, from_domain, from_name_norm, to_json, cc_json, bcc_json,
  recipients_text, recipients_norm, subject, subject_norm, date, snippet,
  body_text, body_html, body_tail_norm, body_state, list_id, is_read, is_starred, in_inbox, is_sent,
  is_draft, is_trash, is_spam, has_attachments, gmail_labels, size, created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * Message ids are never reused (SQLite would reuse the max rowid after a
 * delete): ops, filter claims and the UI refer to messages by id, so a stale
 * reference must never resolve to an unrelated new message.
 */
function nextMessageIdAllocator(db: Db): { next(): number; persist(): void } {
  const stored = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'message_id_hwm'");
  let hwm = Math.max(stored ? Number(JSON.parse(stored.value_json)) : 0, db.get<{ m: number | null }>("SELECT max(id) AS m FROM messages")!.m ?? 0);
  return {
    next: () => ++hwm,
    persist: () => db.run("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('message_id_hwm', ?)", JSON.stringify(hwm)),
  };
}

/**
 * Upserts a batch of messages in ONE transaction. Existing messages (same
 * account + provider id) get their flags/body/locations refreshed; new ones are
 * threaded. Thread aggregates are recomputed once per touched thread at the
 * end, never per message, so long threads don't make imports quadratic.
 */
export function ingestMessages(db: Db, messages: readonly IncomingMessage[], now = Date.now()): IngestResult {
  const result: IngestResult = { inserted: [], updated: [], touchedThreads: new Set(), mergedThreads: new Map(), bodyCompleted: [], deltas: [] };
  db.tx(() => {
    const ids = nextMessageIdAllocator(db);
    for (const msg of messages) {
      let existing = msg.providerMsgId
        ? db.get<{ id: number; thread_id: number }>(
            "SELECT id, thread_id FROM messages WHERE account_id = ? AND provider_msg_id = ?",
            msg.accountId,
            msg.providerMsgId,
          )
        : undefined;
      // The server copy of a message we sent: adopt the optimistic local row instead of duplicating it.
      const rfcLookup = normalizeMessageId(msg.rfcMessageId);
      if (!existing && rfcLookup) {
        existing = db.get<{ id: number; thread_id: number }>(
          "SELECT id, thread_id FROM messages WHERE account_id = ? AND rfc_message_id = ? AND provider_msg_id LIKE 'local:%'",
          msg.accountId,
          rfcLookup,
        );
        if (existing) db.run("UPDATE messages SET provider_msg_id = ? WHERE id = ?", msg.providerMsgId, existing.id);
      }
      if (existing) {
        const before = db.get<{ body_state: string }>("SELECT body_state FROM messages WHERE id = ?", existing.id)!;
        updateExisting(db, existing.id, msg);
        if (before.body_state !== "full" && msg.bodyState === "full") result.bodyCompleted.push(existing.id);
        let threadId = existing.thread_id;
        if (msg.providerThreadId) threadId = adoptProviderThread(db, threadId, msg.accountId, msg.providerThreadId, result);
        result.updated.push(existing.id);
        result.touchedThreads.add(threadId);
        continue;
      }
      const rfcId = normalizeMessageId(msg.rfcMessageId);
      const refs = [...new Set([msg.inReplyTo, ...msg.references].map(normalizeMessageId).filter((r): r is string => !!r && r !== rfcId))];
      const threadId = resolveThread(db, msg, rfcId, refs, result);
      const fromEmail = normalizeText(msg.from.email.trim());
      const recipients = recipientsText(msg.to, msg.cc, msg.bcc);
      const id = db.run(
        INSERT_MESSAGE,
        ids.next(),
        msg.accountId,
        threadId,
        msg.providerMsgId,
        rfcId,
        normalizeMessageId(msg.inReplyTo),
        JSON.stringify(refs),
        msg.from.name,
        fromEmail,
        normalizeText(emailDomain(fromEmail)),
        normalizeText(msg.from.name),
        JSON.stringify(msg.to),
        JSON.stringify(msg.cc),
        JSON.stringify(msg.bcc),
        recipients,
        normalizeText(recipients),
        msg.subject,
        normalizeText(msg.subject),
        msg.date,
        msg.snippet ? makeSnippet(msg.snippet) : makeSnippet(msg.bodyText),
        msg.bodyText,
        msg.bodyHtml,
        bodyTail(msg.bodyText),
        msg.bodyState,
        msg.listId ? normalizeText(msg.listId) : null,
        b(msg.isRead),
        b(msg.isStarred),
        b(msg.inInbox),
        b(msg.isSent),
        b(msg.isDraft),
        b(msg.isTrash),
        b(msg.isSpam),
        b(msg.hasAttachments),
        msg.gmailLabels ? JSON.stringify(msg.gmailLabels) : null,
        msg.size,
        now,
      ).lastInsertRowid;
      for (const ref of refs) {
        db.run("INSERT OR IGNORE INTO message_refs (account_id, ref, message_id) VALUES (?, ?, ?)", msg.accountId, ref, id);
      }
      for (const a of msg.attachments ?? []) {
        db.run(
          "INSERT INTO attachments (message_id, filename, mime, size, content_id, provider_ref) VALUES (?,?,?,?,?,?)",
          id,
          a.filename,
          a.mime,
          a.size,
          a.contentId ?? null,
          a.providerRef ?? null,
        );
      }
      upsertLocations(db, id, msg);
      result.inserted.push(id);
      result.touchedThreads.add(threadId);
    }
    recomputeThreads(db, result.touchedThreads);
    ids.persist();
  });
  return result;
}

export function bodyTail(body: string | null): string {
  return body ? trailingTokens(body, BODY_TAIL_TOKENS).join(" ") : "";
}

function b(v: boolean): number {
  return v ? 1 : 0;
}

function updateExisting(db: Db, id: number, msg: IncomingMessage): void {
  db.run(
    `UPDATE messages SET is_read = ?, is_starred = ?, in_inbox = ?, is_sent = ?, is_draft = ?, is_trash = ?,
       is_spam = ?, gmail_labels = coalesce(?, gmail_labels) WHERE id = ?`,
    b(msg.isRead),
    b(msg.isStarred),
    b(msg.inInbox),
    b(msg.isSent),
    b(msg.isDraft),
    b(msg.isTrash),
    b(msg.isSpam),
    msg.gmailLabels ? JSON.stringify(msg.gmailLabels) : null,
    id,
  );
  if (msg.bodyState === "full") {
    setMessageBody(db, id, msg.bodyText, msg.bodyHtml, "full");
  }
  upsertLocations(db, id, msg);
}

function upsertLocations(db: Db, messageId: number, msg: IncomingMessage): void {
  for (const loc of msg.locations ?? []) {
    db.run(
      `INSERT INTO message_locations (message_id, account_id, mailbox, uidvalidity, uid, flags) VALUES (?,?,?,?,?,?)
       ON CONFLICT (message_id, mailbox) DO UPDATE SET uidvalidity = excluded.uidvalidity, uid = excluded.uid, flags = excluded.flags`,
      messageId,
      msg.accountId,
      loc.mailbox,
      loc.uidvalidity,
      loc.uid,
      JSON.stringify(loc.flags),
    );
  }
}

/** Stores a downloaded body; the FTS update trigger reindexes the message. */
export function setMessageBody(
  db: Db,
  messageId: number,
  bodyText: string | null,
  bodyHtml: string | null,
  state: "partial" | "full",
): void {
  db.run(
    `UPDATE messages SET body_text = ?, body_html = ?, body_tail_norm = ?, body_state = ?,
       snippet = CASE WHEN snippet = '' THEN ? ELSE snippet END WHERE id = ?`,
    bodyText,
    bodyHtml,
    bodyTail(bodyText),
    state,
    makeSnippet(bodyText),
    messageId,
  );
}

interface ThreadAgg {
  c: number;
  unread: number;
  att: number;
  starred: number;
  inbox: number;
  sent: number;
  trash_all: number;
  visible: number;
  visible_nonspam: number;
}

interface LatestRow {
  date: number;
  from_name: string;
  from_email: string;
  snippet: string;
}

/**
 * Recomputes the derived columns of the given threads from their messages.
 * Threads left without messages are deleted.
 */
export function recomputeThreads(db: Db, threadIds: Iterable<number>): void {
  for (const threadId of threadIds) {
    const agg = db.get<ThreadAgg>(
      `SELECT count(*) AS c,
              coalesce(sum(is_read = 0 AND is_trash = 0), 0) AS unread,
              coalesce(max(has_attachments), 0) AS att,
              coalesce(max(is_starred AND is_trash = 0), 0) AS starred,
              coalesce(max(in_inbox AND is_trash = 0 AND is_spam = 0), 0) AS inbox,
              coalesce(max(is_sent AND is_trash = 0 AND is_spam = 0), 0) AS sent,
              coalesce(min(is_trash), 0) AS trash_all,
              coalesce(sum(is_trash = 0), 0) AS visible,
              coalesce(sum(is_trash = 0 AND is_spam = 0), 0) AS visible_nonspam
       FROM messages WHERE thread_id = ?`,
      threadId,
    )!;
    if (agg.c === 0) {
      db.run("DELETE FROM threads WHERE id = ?", threadId);
      continue;
    }
    // Latest message: prefer messages that are neither trash nor spam; ties broken by id.
    const latest = db.get<LatestRow>(
      `SELECT date, from_name, from_email, snippet FROM messages WHERE thread_id = ?
       ORDER BY (is_trash OR is_spam) ASC, date DESC, id DESC LIMIT 1`,
      threadId,
    )!;
    // The list shows the other party, not me: latest received sender, falling back to the latest message.
    const counterpart = db.get<{ from_name: string; from_email: string }>(
      `SELECT from_name, from_email FROM messages WHERE thread_id = ? AND is_sent = 0
       ORDER BY (is_trash OR is_spam) ASC, date DESC, id DESC LIMIT 1`,
      threadId,
    );
    if (counterpart) {
      latest.from_name = counterpart.from_name;
      latest.from_email = counterpart.from_email;
    }
    const first = db.get<{ subject: string }>(
      "SELECT subject FROM messages WHERE thread_id = ? ORDER BY date ASC, id ASC LIMIT 1",
      threadId,
    )!;
    const inSpam = agg.visible > 0 && agg.visible_nonspam === 0 ? 1 : 0;
    db.run(
      `UPDATE threads SET subject = ?, snippet = ?, last_date = ?, last_from_name = ?, last_from_email = ?,
         message_count = ?, unread_count = ?, has_attachments = ?, is_starred = ?, in_inbox = ?,
         has_sent = ?, in_trash = ?, in_spam = ?
       WHERE id = ?`,
      baseSubject(first.subject) || first.subject,
      latest.snippet,
      latest.date,
      latest.from_name,
      latest.from_email,
      agg.c,
      agg.unread,
      agg.att,
      agg.starred,
      agg.inbox,
      agg.sent,
      agg.trash_all,
      inSpam,
      threadId,
    );
  }
}

/** Deletes messages (e.g. IMAP expunge with no remaining locations) and fixes their threads. */
export function deleteMessages(db: Db, messageIds: readonly number[]): Set<number> {
  const touched = new Set<number>();
  if (messageIds.length === 0) return touched;
  db.tx(() => {
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      for (const r of db.all<{ thread_id: number }>(
        `SELECT DISTINCT thread_id FROM messages WHERE id IN (${placeholders(chunk.length)})`,
        ...chunk,
      )) {
        touched.add(r.thread_id);
      }
      db.run(`DELETE FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk);
      pruneOpTargets(db, chunk);
    }
    recomputeThreads(db, touched);
  });
  return touched;
}
