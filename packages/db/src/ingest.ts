import { userLabels, writeFolders, type FoldedThread } from "./folders";
import { replaceAttachments } from "./attachments";
import { addressKey, BODY_TAIL_TOKENS, baseSubject, emailDomain, featuresFromBlob, normalizeText, threadFacts, trailingTokens, type Address, type FactContext, type FactRow } from "@terno/core";
import { acceptFlagObservation, flagObservationValid, type LocalFlagField, type FlagObservation, type IncomingMessage, type ModelDelta } from "@terno/store";
import { sqlFlags } from "./flag-intents";

export type { IncomingAttachment, IncomingLocation, IncomingMessage } from "@terno/store";
import { placeholders, type Db } from "./sqlite";
import { pendingFlagFields, pruneOpTargets } from "./repos";
import { answeredThreads, FACT_COLUMNS, noteSentMail, noteSentMailPrepared, ownAddresses, ownMailChanged, recomputeContext, referencesOfOwn } from "./facts";




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
/** Unquoted lines, whitespace collapsed, cut at SNIPPET_MAX; reads a long body only as far as the snippet needs. */
export function makeSnippet(text: string | null | undefined): string {
  if (!text) return "";
  let joined = "";
  let first = true;
  for (let start = 0; start <= text.length; ) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.trimStart().startsWith(">")) continue;
    joined += first ? line : ` ${line}`;
    first = false;
    if (joined.length > SNIPPET_MAX) {
      const head = longHead(joined);
      if (head) return head;
    }
  }
  return longHead(joined) ?? joined.replace(/\s+/g, " ").trim();
}

/**
 * The cut snippet if the collapsed text is longer than SNIPPET_MAX. Collapsing
 * a prefix gives a prefix of the collapsed whole, so only as much text as the
 * snippet needs is scanned.
 */
function longHead(joined: string): string | null {
  for (let size = SNIPPET_MAX + 56; ; size *= 4) {
    const head = joined.slice(0, size).replace(/\s+/g, " ").trimStart();
    if (head.length > SNIPPET_MAX) return `${head.slice(0, SNIPPET_MAX - 1)}…`;
    if (size >= joined.length) return null;
  }
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
      key: [loser.thread_id, loser.category_id],
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
  body_tail_norm, body_state, list_id, is_read, is_starred, in_inbox, is_sent,
  is_draft, is_trash, is_spam, has_attachments, gmail_labels, size, created_at, is_bulk, reply_to_json
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

/** Staging and ingestion must select the same account-bound message revision. */
export function findIngestMessage(db: Db, msg: Pick<IncomingMessage, "accountId" | "providerMsgId" | "rfcMessageId">): { id: number; thread_id: number; by_provider: number } | undefined {
  return db.get(
    `SELECT id, thread_id, provider_msg_id IS ?2 AS by_provider FROM messages
     WHERE account_id = ?1 AND (provider_msg_id = ?2 OR (rfc_message_id = ?3 AND provider_msg_id LIKE 'local:%' AND (SELECT kind FROM accounts WHERE id=?1) <> 'imap'))
     ORDER BY by_provider DESC, id LIMIT 1`,
    msg.accountId, msg.providerMsgId, normalizeMessageId(msg.rfcMessageId),
  );
}

/** Upserts and threads one batch atomically; recomputes aggregates once per touched thread. */
export function ingestMessages(db: Db, messages: readonly IncomingMessage[], now = Date.now(), observation?: FlagObservation, preparedRecipients?: { text: string; normalized: string; toJson: string; ccJson: string; bccJson: string; ftsTokens?: string; correspondentChunks?: string[][] }): IngestResult {
  const result: IngestResult = { inserted: [], updated: [], touchedThreads: new Set(), mergedThreads: new Map(), bodyCompleted: [], deltas: [] };
  let own: Set<string> | null = null;
  db.tx(() => {
    const ids = nextMessageIdAllocator(db);
    for (const msg of messages) {
      // the same provider message, else the server copy of a message we sent (adopt the optimistic local row
      // instead of duplicating it): one lookup for both
      const existing = findIngestMessage(db, msg);
      if (existing && db.get("SELECT 1 FROM imap_identity_holds WHERE message_id=?", existing.id)) continue;
      if (existing && !existing.by_provider) db.run("UPDATE messages SET provider_msg_id = ? WHERE id = ?", msg.providerMsgId, existing.id);
      if (existing) {
        const before = db.get<{ body_state: string; is_sent: number; is_draft: number }>("SELECT body_state, is_sent, is_draft FROM messages WHERE id = ?", existing.id)!;
        updateExisting(db, existing.id, msg, observation);
        if (before.body_state !== "full" && msg.bodyState === "full") result.bodyCompleted.push(existing.id);
        // plan 17 (Codex review 1, #4): a draft that comes back sent (or the reverse) is your mail appearing or going
        if (before.is_sent !== b(msg.isSent) || before.is_draft !== b(msg.isDraft)) {
          own = null;
          for (const t of ownMailChanged(db, existing.id)) result.touchedThreads.add(t);
        }
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
      const recipients = preparedRecipients?.text ?? recipientsText(msg.to, msg.cc, msg.bcc);
      const allocated = ids.next();
      // the body goes in first: the message's insert trigger indexes it in the same write
      if (msg.bodyText !== null || msg.bodyHtml !== null) {
        db.run("INSERT INTO message_bodies (message_id, body_text, body_html) VALUES (?, ?, ?)", allocated, msg.bodyText, msg.bodyHtml);
      }
      if (preparedRecipients?.ftsTokens !== undefined) db.run("INSERT INTO recipient_fts_stage(message_id,tokens) VALUES(?,?)", allocated, preparedRecipients.ftsTokens);
      const id = db.run(
        INSERT_MESSAGE,
        allocated,
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
        preparedRecipients?.toJson ?? JSON.stringify(msg.to),
        preparedRecipients?.ccJson ?? JSON.stringify(msg.cc),
        preparedRecipients?.bccJson ?? JSON.stringify(msg.bcc),
        recipients,
        preparedRecipients?.normalized ?? normalizeText(recipients),
        msg.subject,
        normalizeText(msg.subject),
        msg.date,
        msg.snippet ? makeSnippet(msg.snippet) : makeSnippet(msg.bodyText),
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
        b(msg.bulk ?? false),
        JSON.stringify(msg.replyTo ?? []),
      ).lastInsertRowid;
      if (preparedRecipients?.ftsTokens !== undefined) db.run("DELETE FROM recipient_fts_stage WHERE message_id=?", allocated);
      if (refs.length === 1) db.run("INSERT OR IGNORE INTO message_refs (account_id, ref, message_id) VALUES (?, ?, ?)", msg.accountId, refs[0]!, id);
      else if (refs.length > 1) db.run("INSERT OR IGNORE INTO message_refs (account_id, ref, message_id) SELECT ?, value, ? FROM json_each(?)", msg.accountId, id, JSON.stringify(refs));
      // plan 17: sent mail teaches your addresses and who you write to; mail of yours may answer another thread
      if (!msg.isDraft) {
        own ??= ownAddresses(db);
        if (msg.isSent) {
          if (preparedRecipients?.correspondentChunks) noteSentMailPrepared(db, fromEmail, preparedRecipients.correspondentChunks);
          else noteSentMail(db, fromEmail, [...msg.to, ...msg.cc, ...msg.bcc]);
          own.add(addressKey(fromEmail));
        }
        if (refs.length && (msg.isSent || own.has(addressKey(fromEmail)))) for (const t of answeredThreads(db, refs)) result.touchedThreads.add(t);
      }
      if (msg.attachments !== undefined && !msg.captureUnavailable) replaceAttachments(db, id, msg.attachments);
      if (msg.captureUnavailable) db.run("UPDATE messages SET attachments_captured = 2 WHERE id = ?", id);
      upsertLocations(db, id, msg);
      result.inserted.push(id);
      result.touchedThreads.add(threadId);
    }
    // the search outbox (other message writes are marked by triggers)
    if (result.inserted.length) db.run("INSERT OR IGNORE INTO search_dirty (kind, id) SELECT 0, value FROM json_each(?)", JSON.stringify(result.inserted));
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

function updateExisting(db: Db, id: number, msg: IncomingMessage, observation?: FlagObservation): void {
  const pending = pendingFlagFields(db, msg.accountId, [id]).get(id);
  const protectedField = (field: LocalFlagField) => pending?.has(field) || !acceptFlagObservation(sqlFlags(db), id, field, observation);
  if (!observation || flagObservationValid(sqlFlags(db), msg.accountId, observation)) db.run(
    `UPDATE messages SET is_read = CASE WHEN ? THEN is_read ELSE ? END,
       is_starred = CASE WHEN ? THEN is_starred ELSE ? END, in_inbox = CASE WHEN ? THEN in_inbox ELSE ? END,
       is_sent = ?, is_draft = ?, is_trash = CASE WHEN ? THEN is_trash ELSE ? END,
       is_spam = CASE WHEN ? THEN is_spam ELSE ? END,
       gmail_labels = coalesce(?, gmail_labels), reply_to_json = coalesce(?, reply_to_json) WHERE id = ?`,
    b(!!protectedField("isRead")),
    b(msg.isRead),
    b(!!protectedField("isStarred")),
    b(msg.isStarred),
    b(!!protectedField("inInbox")),
    b(msg.inInbox),
    b(msg.isSent),
    b(msg.isDraft),
    b(!!protectedField("isTrash")),
    b(msg.isTrash),
    b(!!protectedField("isSpam")),
    b(msg.isSpam),
    msg.gmailLabels ? JSON.stringify(msg.gmailLabels) : null,
    msg.replyTo === undefined ? null : JSON.stringify(msg.replyTo),
    id,
  );
  if (msg.bodyState === "full") {
    setMessageBody(db, id, msg.bodyText, msg.bodyHtml, "full");
  }
  if (msg.attachments !== undefined && !msg.captureUnavailable) replaceAttachments(db, id, msg.attachments);
  if (msg.captureUnavailable) db.run("UPDATE messages SET attachments_captured = 2 WHERE id = ?", id);
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

/** Stores a downloaded body; the message_bodies triggers reindex the message. */
export function setMessageBody(
  db: Db,
  messageId: number,
  bodyText: string | null,
  bodyHtml: string | null,
  state: "partial" | "full",
): void {
  const updated = db.run(
    `UPDATE messages SET body_tail_norm = ?, body_state = ?, snippet = CASE WHEN snippet = '' THEN ? ELSE snippet END WHERE id = ?`,
    bodyTail(bodyText),
    state,
    makeSnippet(bodyText),
    messageId,
  );
  if (updated.changes === 0) return;
  if (bodyText === null && bodyHtml === null) db.run("DELETE FROM message_bodies WHERE message_id = ?", messageId);
  else {
    db.run(
      `INSERT INTO message_bodies (message_id, body_text, body_html) VALUES (?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET body_text = excluded.body_text, body_html = excluded.body_html`,
      messageId,
      bodyText,
      bodyHtml,
    );
  }
}

interface ThreadMessage extends FactRow {
  /** plan 68: the raw labels, only when one is a user label (a folder) */
  user_labels: string | null;
  account_id: number;
  from_name: string;
  snippet: string;
  subject: string;
  is_read: number;
  is_starred: number;
  in_inbox: number;
  has_attachments: number;
}

/** (trash or spam) last, then newest, ties broken by id: the order the list summary reads a thread in */
function newer(a: ThreadMessage, b: ThreadMessage): boolean {
  const hiddenA = a.is_trash || a.is_spam ? 1 : 0;
  const hiddenB = b.is_trash || b.is_spam ? 1 : 0;
  return hiddenA !== hiddenB ? hiddenA < hiddenB : a.date !== b.date ? a.date > b.date : a.id > b.id;
}

/**
 * Recomputes the derived columns of the given threads from their messages,
 * plan 17's facts included (NULL while the facts backfill still collects your
 * addresses). Threads left without messages are deleted.
 */
export function recomputeThreads(db: Db, threadIds: Iterable<number>): void {
  const written: number[] = [];
  // plan 68: what each written thread's folders are made of, folded with the rest
  const folded: FoldedThread[] = [];
  // read once per call, on the first thread that has messages
  let facts: FactContext | null | undefined;
  for (const threadId of threadIds) {
    // one read of the thread's messages; the aggregates are folded here
    const messages = db.all<ThreadMessage>(
      `SELECT id, account_id, date, from_name, from_email, snippet, subject, is_read, is_trash, is_spam, is_starred, in_inbox, is_sent, has_attachments, ${FACT_COLUMNS},
         CASE WHEN instr(gmail_labels, 'Label_') THEN gmail_labels END AS user_labels
       FROM messages WHERE thread_id = ?`,
      threadId,
    );
    if (messages.length === 0) {
      db.run("DELETE FROM threads WHERE id = ?", threadId);
      continue;
    }
    let unread = 0;
    let att = 0;
    let starred = 0;
    let inbox = 0;
    let sent = 0;
    let trashAll = 1;
    let visible = 0;
    let visibleNonspam = 0;
    let latest = messages[0]!;
    let counterpart: ThreadMessage | null = null;
    let first = messages[0]!;
    const labels = new Set<string>();
    let accountId = 0;
    for (const m of messages) {
      accountId = m.account_id;
      if (m.user_labels && !m.is_trash && !m.is_spam) for (const l of userLabels(m.user_labels)) labels.add(l);
      if (!m.is_read && !m.is_trash) unread++;
      if (m.has_attachments) att = 1;
      if (m.is_starred && !m.is_trash) starred = 1;
      if (m.in_inbox && !m.is_trash && !m.is_spam) inbox = 1;
      if (m.is_sent && !m.is_trash && !m.is_spam) sent = 1;
      if (!m.is_trash) {
        trashAll = 0;
        visible++;
        if (!m.is_spam) visibleNonspam++;
      }
      if (newer(m, latest)) latest = m;
      // the list shows the other party, not me: latest received sender, falling back to the latest message
      if (!m.is_sent && (!counterpart || newer(m, counterpart))) counterpart = m;
      if (m.date < first.date || (m.date === first.date && m.id < first.id)) first = m;
    }
    const inSpam = visible > 0 && visibleNonspam === 0 ? 1 : 0;
    if (facts === undefined) facts = recomputeContext(db);
    const f = facts ? threadFacts(messages, facts) : null;
    db.run(
      `UPDATE threads SET subject = ?, snippet = ?, last_date = ?, last_from_name = ?, last_from_email = ?,
         message_count = ?, unread_count = ?, has_attachments = ?, is_starred = ?, in_inbox = ?,
         has_sent = ?, in_trash = ?, in_spam = ?, person = ?, waiting_since = ?
       WHERE id = ?`,
      baseSubject(first.subject) || first.subject,
      latest.snippet,
      latest.date,
      (counterpart ?? latest).from_name,
      (counterpart ?? latest).from_email,
      messages.length,
      unread,
      att,
      starred,
      inbox,
      sent,
      trashAll,
      inSpam,
      f ? f.person : null,
      f ? f.waitingSince : null,
      threadId,
    );
    written.push(threadId);
    folded.push({ id: threadId, accountId, lastDate: latest.date, unread: unread > 0 ? 1 : 0, labels });
  }
  // the search outbox: what changed for search is decided when the batch is served
  if (written.length) db.run("INSERT OR IGNORE INTO search_dirty (kind, id) SELECT 1, value FROM json_each(?)", JSON.stringify(written));
  // plan 68: folder memberships, with the aggregates they carry (date, unread); only what changed is written
  writeFolders(db, folded);
}

/** Deletes messages (e.g. IMAP expunge with no remaining locations) and fixes their threads. */
export function deleteMessages(db: Db, messageIds: readonly number[]): Set<number> {
  const touched = new Set<number>();
  if (messageIds.length === 0) return touched;
  db.tx(() => {
    // plan 17 (Codex R5): a reply of yours that goes may leave what it answered waiting again
    const refs = new Set<string>();
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500).filter((id) => !db.get("SELECT 1 FROM imap_identity_holds WHERE message_id=?", id));
      if (!chunk.length) continue;
      for (const r of db.all<{ thread_id: number }>(
        `SELECT DISTINCT thread_id FROM messages WHERE id IN (${placeholders(chunk.length)})`,
        ...chunk,
      )) {
        touched.add(r.thread_id);
      }
      for (const r of referencesOfOwn(db, chunk)) refs.add(r);
      db.run(`DELETE FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk);
      pruneOpTargets(db, chunk);
    }
    for (const t of answeredThreads(db, [...refs])) touched.add(t);
    recomputeThreads(db, touched);
  });
  return touched;
}
