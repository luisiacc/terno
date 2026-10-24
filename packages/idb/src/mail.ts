import {
  accountPrefs,
  baseSubject,
  BODY_TAIL_TOKENS,
  emailDomain,
  evaluateRule,
  featuresFromBlob,
  normalizeText,
  trailingTokens,
  type Account,
  type AccountKind,
  type AccountPatch,
  type AccountPrefs,
  type AccountSyncState,
  type Address,
  type AttachmentInfo,
  type Category,
  type CategoryColor,
  type Counts,
  type Filter,
  type FilterRule,
  type MessageDetail,
  type OpState,
  type RuleMessage,
  type ThreadAction,
  type ThreadDetail,
  type ThreadSummary,
  type UserActionKind,
  type View,
  withAccountPrefs,
} from "@unica/core";
import type { OwnerIdentity } from "@unica/core/rpc";
import { AWAITING_AUTH, type DraftInput, type DraftRow, type IncomingMessage, type ListParams, type ModelDelta, type OpRow, type OwnerClaim, type MessageState, type Page, type ScopeParams, type SearchMessageDoc, type SearchThreadDoc } from "@unica/store";
import type { MemDb, Row, Table } from "./mem";

/**
 * The store commands' building blocks, ported from packages/db (same names,
 * same semantics, same columns) onto the in-memory tables. Booleans are 0/1
 * and JSON columns are strings, as in SQLite, so each function reads like
 * the SQL it mirrors; the conformance suite holds both to one contract.
 */

export type R = Row & Record<string, any>;

export interface Ctx {
  db: MemDb;
  uuid(): string;
  order: ThreadOrder;
  /** a message's stored body: written by this command, read ahead of it, or absent; throws if it wasn't read ahead */
  body(messageId: number): { body_text: string | null; body_html: string | null } | null;
}

export const T = (c: Ctx, name: string): Table<R> => c.db.table<R>(name);

// ───────────────────────────── recency order ─────────────────────────────

/**
 * Threads by (last_date DESC, id DESC): the order every list and search
 * page walks. Kept current from row changes (undo included): a few changes
 * are placed by binary search, many (an import slice) re-sort once.
 */
export class ThreadOrder {
  private ids: number[] = [];
  private readonly lastDate = new Map<number, number>();
  private readonly pending = new Set<number>();
  /** rows loaded before this order existed: sort them all once */
  private stale = true;

  constructor(db: MemDb) {
    db.onRow((table, row, prev) => {
      if (table !== "threads") return;
      const id = (row ?? prev)!.id as number;
      if (row && prev && row.last_date === prev.last_date) return;
      this.pending.add(id);
    });
  }

  private cmp = (a: number, b: number) => this.lastDate.get(b)! - this.lastDate.get(a)! || b - a;

  private position(id: number): number {
    let lo = 0;
    let hi = this.ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cmp(this.ids[mid]!, id) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** the order, brought up to date with the rows */
  current(threads: Table<R>): readonly number[] {
    if (this.pending.size === 0 && !this.stale) return this.ids;
    if (this.stale || this.pending.size > 64) {
      this.stale = false;
      this.lastDate.clear();
      this.ids = [];
      for (const t of threads.all()) {
        this.lastDate.set(t.id, t.last_date);
        this.ids.push(t.id);
      }
      this.ids.sort(this.cmp);
    } else {
      for (const id of this.pending) {
        if (this.lastDate.has(id)) {
          const at = this.position(id);
          if (this.ids[at] === id) this.ids.splice(at, 1);
          else this.ids.splice(this.ids.indexOf(id), 1);
          this.lastDate.delete(id);
        }
        const row = threads.get(id);
        if (!row) continue;
        this.lastDate.set(id, row.last_date);
        this.ids.splice(this.position(id), 0, id);
      }
    }
    this.pending.clear();
    return this.ids;
  }

  /** index of the first thread strictly after the keyset cursor */
  after(threads: Table<R>, cursor: { lastDate: number; id: number }): number {
    const ids = this.current(threads);
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const d = this.lastDate.get(ids[mid]!)!;
      // still at or before the cursor: (d, id) >= (cursor) in DESC order means d > lastDate or (d == lastDate and id >= cursor.id)
      if (d > cursor.lastDate || (d === cursor.lastDate && ids[mid]! >= cursor.id)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

// ───────────────────────────── settings ─────────────────────────────

export function getSetting<V>(c: Ctx, key: string, fallback: V): V {
  const r = T(c, "settings").get(key);
  return r ? (JSON.parse(r.value_json) as V) : fallback;
}

export function setSetting(c: Ctx, key: string, value: unknown): void {
  T(c, "settings").put({ key, value_json: JSON.stringify(value) });
}

// ───────────────────────────── ingestion ─────────────────────────────

export interface IngestResult {
  inserted: number[];
  updated: number[];
  touchedThreads: Set<number>;
  mergedThreads: Map<number, number>;
  bodyCompleted: number[];
  deltas: ModelDelta[];
}

export function recipientsText(to: Address[], cc: Address[], bcc: Address[]): string {
  return [...to, ...cc, ...bcc].map((a) => (a.name ? `${a.name} ${a.email}` : a.email)).join(" ");
}

const SNIPPET_MAX = 200;

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

export function bodyTail(body: string | null): string {
  return body ? trailingTokens(body, BODY_TAIL_TOKENS).join(" ") : "";
}

const b = (v: boolean) => (v ? 1 : 0);

function newThread(c: Ctx, accountId: number, providerThreadId: string | null): number {
  const row: R = {
    id: undefined,
    account_id: accountId,
    provider_thread_id: providerThreadId,
    subject: "",
    snippet: "",
    last_date: 0,
    last_from_name: "",
    last_from_email: "",
    message_count: 0,
    unread_count: 0,
    has_attachments: 0,
    is_starred: 0,
    in_inbox: 0,
    has_sent: 0,
    in_trash: 0,
    in_spam: 0,
  };
  T(c, "threads").insert(row);
  return row.id as number;
}

function resolveThread(c: Ctx, msg: IncomingMessage, rfcId: string | null, refs: string[], result: IngestResult): number {
  const threads = T(c, "threads");
  if (msg.providerThreadId) {
    const existing = threads.by("provider", msg.accountId, msg.providerThreadId)[0];
    if (existing) return existing.id;
    return newThread(c, msg.accountId, msg.providerThreadId);
  }
  const messages = T(c, "messages");
  const candidates = new Set<number>();
  for (const ref of refs) for (const m of messages.by("rfc", msg.accountId, ref)) candidates.add(m.thread_id);
  if (rfcId) for (const r of T(c, "message_refs").by("ref", msg.accountId, rfcId)) candidates.add(messages.get(r.message_id)!.thread_id);
  if (candidates.size === 0) return newThread(c, msg.accountId, null);
  const sorted = [...candidates].sort((x, y) => x - y);
  const keep = sorted[0]!;
  for (const other of sorted.slice(1)) mergeThreads(c, keep, other, result);
  return keep;
}

export function adoptProviderThread(c: Ctx, threadId: number, accountId: number, providerThreadId: string, result?: IngestResult, deltas?: ModelDelta[]): number {
  const threads = T(c, "threads");
  const current = threads.get(threadId);
  if (!current || current.provider_thread_id === providerThreadId) return threadId;
  if (current.provider_thread_id) return threadId;
  const other = threads.by("provider", accountId, providerThreadId)[0];
  const res = result ?? { inserted: [], updated: [], touchedThreads: new Set<number>(), mergedThreads: new Map(), bodyCompleted: [], deltas: [] };
  if (other) {
    const [keep, drop] = other.id < threadId ? [other.id, threadId] : [threadId, other.id];
    threads.update(threads.get(drop)!, { provider_thread_id: null });
    mergeThreads(c, keep, drop, res);
    threads.update(threads.get(keep)!, { provider_thread_id: providerThreadId });
    if (!result) {
      recomputeThreads(c, [keep]);
      deltas?.push(...res.deltas);
    }
    return keep;
  }
  threads.update(current, { provider_thread_id: providerThreadId });
  return threadId;
}

/** Moves `from` into `into`: messages, categories (the newest explicit decision per category wins), decisions. */
export function mergeThreads(c: Ctx, into: number, from: number, result: IngestResult): void {
  const messages = T(c, "messages");
  for (const m of messages.by("fk_thread_id", from)) messages.update(m, { thread_id: into });
  const examples = T(c, "cls_examples");
  const both = [...examples.by("fk_thread_id", into), ...examples.by("fk_thread_id", from)];
  const winners = new Map<number, R>();
  for (const e of both) {
    const other = winners.get(e.category_id);
    const newer = !other || e.at > other.at || (e.at === other.at && e.thread_id === into);
    const loser = newer ? other : e;
    if (newer) winners.set(e.category_id, e);
    if (!loser) continue;
    examples.delete(loser.thread_id, loser.category_id);
    result.deltas.push({
      op: "untrain",
      example: { categoryId: loser.category_id, label: loser.label > 0 ? 1 : -1, weight: loser.weight, at: loser.at, content: loser.content === 1, features: featuresFromBlob(loser.features) },
      key: [loser.thread_id, loser.category_id],
    });
  }
  // UPDATE OR IGNORE: rows whose new key already exists stay behind (and go with the thread)
  for (const e of examples.by("fk_thread_id", from)) if (!examples.has(into, e.category_id)) examples.update(e, { thread_id: into });
  const memberships = T(c, "thread_categories");
  for (const tc of memberships.by("fk_thread_id", from)) memberships.insert({ ...tc, thread_id: into });
  for (const [categoryId, e] of winners) if (e.label < 0) memberships.delete(into, categoryId);
  const decisions = T(c, "cls_decisions");
  for (const d of decisions.by("fk_thread_id", from)) if (!decisions.has(into, d.category_id)) decisions.update(d, { thread_id: into });
  T(c, "threads").delete(from);
  result.touchedThreads.delete(from);
  result.touchedThreads.add(into);
  result.mergedThreads.set(from, into);
}

/** Message ids are never reused (a high-water mark, like SQL's message_id_hwm). */
function messageIdAllocator(c: Ctx): { next(): number; persist(): void } {
  let hwm = Math.max(getSetting(c, "message_id_hwm", 0), T(c, "messages").highestKey());
  return { next: () => ++hwm, persist: () => setSetting(c, "message_id_hwm", hwm) };
}


export function ingestMessages(c: Ctx, batch: readonly IncomingMessage[], now: number): IngestResult {
  const result: IngestResult = { inserted: [], updated: [], touchedThreads: new Set(), mergedThreads: new Map(), bodyCompleted: [], deltas: [] };
  const messages = T(c, "messages");
  c.db.tx(() => {
    const ids = messageIdAllocator(c);
    for (const msg of batch) {
      const rfcLookup = normalizeMessageId(msg.rfcMessageId);
      const byProvider = msg.providerMsgId === null ? undefined : messages.by("provider", msg.accountId, msg.providerMsgId)[0];
      const byLocal = byProvider || !rfcLookup ? undefined : messages.by("rfc", msg.accountId, rfcLookup).filter((m) => String(m.provider_msg_id ?? "").startsWith("local:")).sort((x, y) => x.id - y.id)[0];
      let existing = byProvider ?? byLocal;
      if (existing && !byProvider) existing = messages.update(existing, { provider_msg_id: msg.providerMsgId });
      if (existing) {
        const before = existing.body_state;
        updateExisting(c, existing, msg);
        if (before !== "full" && msg.bodyState === "full") result.bodyCompleted.push(existing.id);
        let threadId = messages.get(existing.id)!.thread_id as number;
        if (msg.providerThreadId) threadId = adoptProviderThread(c, threadId, msg.accountId, msg.providerThreadId, result);
        result.updated.push(existing.id);
        result.touchedThreads.add(threadId);
        continue;
      }
      const rfcId = normalizeMessageId(msg.rfcMessageId);
      const refs = [...new Set([msg.inReplyTo, ...msg.references].map(normalizeMessageId).filter((r): r is string => !!r && r !== rfcId))];
      const threadId = resolveThread(c, msg, rfcId, refs, result);
      const fromEmail = normalizeText(msg.from.email.trim());
      const recipients = recipientsText(msg.to, msg.cc, msg.bcc);
      const id = ids.next();
      messages.insert({
        id,
        account_id: msg.accountId,
        thread_id: threadId,
        provider_msg_id: msg.providerMsgId,
        rfc_message_id: rfcId,
        in_reply_to: normalizeMessageId(msg.inReplyTo),
        references_json: JSON.stringify(refs),
        from_name: msg.from.name,
        from_email: fromEmail,
        from_domain: normalizeText(emailDomain(fromEmail)),
        from_name_norm: normalizeText(msg.from.name),
        to_json: JSON.stringify(msg.to),
        cc_json: JSON.stringify(msg.cc),
        bcc_json: JSON.stringify(msg.bcc),
        recipients_text: recipients,
        recipients_norm: normalizeText(recipients),
        subject: msg.subject,
        subject_norm: normalizeText(msg.subject),
        date: msg.date,
        snippet: msg.snippet ? makeSnippet(msg.snippet) : makeSnippet(msg.bodyText),
        body_tail_norm: bodyTail(msg.bodyText),
        body_state: msg.bodyState,
        list_id: msg.listId ? normalizeText(msg.listId) : null,
        is_read: b(msg.isRead),
        is_starred: b(msg.isStarred),
        in_inbox: b(msg.inInbox),
        is_sent: b(msg.isSent),
        is_draft: b(msg.isDraft),
        is_trash: b(msg.isTrash),
        is_spam: b(msg.isSpam),
        has_attachments: b(msg.hasAttachments),
        gmail_labels: msg.gmailLabels ? JSON.stringify(msg.gmailLabels) : null,
        size: msg.size,
        created_at: now,
      });
      if (msg.bodyText !== null || msg.bodyHtml !== null) T(c, "message_bodies").put({ message_id: id, body_text: msg.bodyText, body_html: msg.bodyHtml });
      else T(c, "message_bodies").markAbsent(id);
      for (const ref of refs) T(c, "message_refs").insert({ account_id: msg.accountId, ref, message_id: id });
      for (const a of msg.attachments ?? []) {
        T(c, "attachments").insert({ id: undefined, message_id: id, filename: a.filename, mime: a.mime, size: a.size, content_id: a.contentId ?? null, provider_ref: a.providerRef ?? null });
      }
      upsertLocations(c, id, msg);
      result.inserted.push(id);
      result.touchedThreads.add(threadId);
    }
    recomputeThreads(c, result.touchedThreads);
    ids.persist();
  });
  return result;
}

function updateExisting(c: Ctx, row: R, msg: IncomingMessage): void {
  T(c, "messages").update(row, {
    is_read: b(msg.isRead),
    is_starred: b(msg.isStarred),
    in_inbox: b(msg.inInbox),
    is_sent: b(msg.isSent),
    is_draft: b(msg.isDraft),
    is_trash: b(msg.isTrash),
    is_spam: b(msg.isSpam),
    gmail_labels: msg.gmailLabels ? JSON.stringify(msg.gmailLabels) : row.gmail_labels,
  });
  if (msg.bodyState === "full") setMessageBody(c, row.id, msg.bodyText, msg.bodyHtml, "full");
  upsertLocations(c, row.id, msg);
}

function upsertLocations(c: Ctx, messageId: number, msg: IncomingMessage): void {
  for (const loc of msg.locations ?? []) {
    T(c, "message_locations").put({ message_id: messageId, account_id: msg.accountId, mailbox: loc.mailbox, uidvalidity: loc.uidvalidity, uid: loc.uid, flags: JSON.stringify(loc.flags) });
  }
}

export function setMessageBody(c: Ctx, messageId: number, bodyText: string | null, bodyHtml: string | null, state: "partial" | "full"): void {
  const messages = T(c, "messages");
  const row = messages.get(messageId);
  if (!row) return;
  messages.update(row, { body_tail_norm: bodyTail(bodyText), body_state: state, snippet: row.snippet === "" ? makeSnippet(bodyText) : row.snippet });
  if (bodyText === null && bodyHtml === null) T(c, "message_bodies").delete(messageId);
  else T(c, "message_bodies").put({ message_id: messageId, body_text: bodyText, body_html: bodyHtml });
}

function newer(x: R, y: R): boolean {
  const hx = x.is_trash || x.is_spam ? 1 : 0;
  const hy = y.is_trash || y.is_spam ? 1 : 0;
  return hx !== hy ? hx < hy : x.date !== y.date ? x.date > y.date : x.id > y.id;
}

/** Recomputes the derived columns of the given threads from their messages; empty threads go. */
export function recomputeThreads(c: Ctx, threadIds: Iterable<number>): void {
  const threads = T(c, "threads");
  const messages = T(c, "messages");
  for (const threadId of threadIds) {
    const rows = messages.by("fk_thread_id", threadId);
    const thread = threads.get(threadId);
    if (rows.length === 0) {
      if (thread) threads.delete(threadId);
      continue;
    }
    if (!thread) continue;
    let unread = 0;
    let att = 0;
    let starred = 0;
    let inbox = 0;
    let sent = 0;
    let trashAll = 1;
    let visible = 0;
    let visibleNonspam = 0;
    let latest = rows[0]!;
    let counterpart: R | null = null;
    let first = rows[0]!;
    for (const m of rows) {
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
      if (!m.is_sent && (!counterpart || newer(m, counterpart))) counterpart = m;
      if (m.date < first.date || (m.date === first.date && m.id < first.id)) first = m;
    }
    threads.update(thread, {
      subject: baseSubject(first.subject) || first.subject,
      snippet: latest.snippet,
      last_date: latest.date,
      last_from_name: (counterpart ?? latest).from_name,
      last_from_email: (counterpart ?? latest).from_email,
      message_count: rows.length,
      unread_count: unread,
      has_attachments: att,
      is_starred: starred,
      in_inbox: inbox,
      has_sent: sent,
      in_trash: trashAll,
      in_spam: visible > 0 && visibleNonspam === 0 ? 1 : 0,
    });
  }
}

export function deleteMessages(c: Ctx, messageIds: readonly number[]): Set<number> {
  const touched = new Set<number>();
  if (messageIds.length === 0) return touched;
  const messages = T(c, "messages");
  c.db.tx(() => {
    for (const id of messageIds) {
      const m = messages.get(id);
      if (!m) continue;
      touched.add(m.thread_id);
      messages.delete(id);
    }
    pruneOpTargets(c, messageIds);
    recomputeThreads(c, touched);
  });
  return touched;
}

// ───────────────────────────── actions ─────────────────────────────

export interface ActionResult {
  threadIds: number[];
  targets: { accountId: number; messageIds: number[] }[];
  /** each changed message as it was before */
  before: MessageState[];
}

function plan(action: ThreadAction, msgs: R[], explicit: boolean): { ids: number[]; set: Partial<R> } {
  const latestPerThread = new Map<number, R>();
  for (const m of msgs) {
    const cur = latestPerThread.get(m.thread_id);
    if (!cur || m.date > cur.date || (m.date === cur.date && m.id > cur.id)) latestPerThread.set(m.thread_id, m);
  }
  const latest = explicit ? msgs : [...latestPerThread.values()];
  const ids = (list: R[]) => list.map((m) => m.id as number);
  switch (action) {
    case "archive":
      return { ids: ids(msgs.filter((m) => m.in_inbox)), set: { in_inbox: 0 } };
    case "trash":
      return { ids: ids(msgs.filter((m) => !m.is_trash)), set: { is_trash: 1, in_inbox: 0 } };
    case "spam":
      return { ids: ids(msgs.filter((m) => !m.is_spam || m.in_inbox)), set: { is_spam: 1, in_inbox: 0 } };
    case "notSpam":
      return { ids: ids(msgs.filter((m) => m.is_spam)), set: { is_spam: 0, in_inbox: 1 } };
    case "moveToInbox": {
      const scope = new Set(msgs.filter((m) => !m.is_sent).map((m) => m.thread_id));
      const chosen = msgs.filter((m) => !m.is_sent || !scope.has(m.thread_id));
      return { ids: ids(chosen.filter((m) => !m.in_inbox || m.is_trash || m.is_spam)), set: { in_inbox: 1, is_trash: 0, is_spam: 0 } };
    }
    case "markRead":
      return { ids: ids(msgs.filter((m) => !m.is_read)), set: { is_read: 1 } };
    case "markUnread":
      return { ids: ids(latest.filter((m) => m.is_read)), set: { is_read: 0 } };
    case "star":
      return { ids: ids(latest.filter((m) => !m.is_starred)), set: { is_starred: 1 } };
    case "unstar":
      return { ids: ids(msgs.filter((m) => m.is_starred)), set: { is_starred: 0 } };
  }
}

export function applyThreadAction(c: Ctx, threadIds: readonly number[], action: ThreadAction): ActionResult {
  const messages = T(c, "messages");
  return c.db.tx(() => applyToMessages(c, threadIds.flatMap((t) => messages.by("fk_thread_id", t)).sort((x, y) => x.id - y.id), action, false));
}

export function applyMessageAction(c: Ctx, messageIds: readonly number[], action: ThreadAction): ActionResult {
  const messages = T(c, "messages");
  return c.db.tx(() => applyToMessages(c, messageIds.map((id) => messages.get(id)).filter((m): m is R => !!m), action, true));
}

function applyToMessages(c: Ctx, msgs: R[], action: ThreadAction, explicit: boolean): ActionResult {
  const { ids, set } = plan(action, msgs, explicit);
  const messages = T(c, "messages");
  const touched = new Set<number>();
  const byAccount = new Map<number, number[]>();
  const before: MessageState[] = [];
  for (const id of ids) {
    const m = messages.get(id)!;
    before.push(stateOf(m));
    messages.update(m, set);
    touched.add(m.thread_id);
    byAccount.set(m.account_id, [...(byAccount.get(m.account_id) ?? []), id]);
  }
  recomputeThreads(c, touched);
  return { threadIds: [...touched], targets: [...byAccount].map(([accountId, messageIds]) => ({ accountId, messageIds })), before };
}

const stateOf = (m: R): MessageState => ({ id: m.id, isRead: !!m.is_read, isStarred: !!m.is_starred, inInbox: !!m.in_inbox, isTrash: !!m.is_trash, isSpam: !!m.is_spam });
type Place = "inbox" | "archive" | "trash" | "spam";
const placeOf = (s: MessageState): Place => (s.isTrash ? "trash" : s.isSpam ? "spam" : s.inInbox ? "inbox" : "archive");
/** The provider ops from one place to another, in order (out of Papelera or Spam goes through the inbox first). */
function placeOps(from: Place, to: Place): ThreadAction[] {
  if (from === to) return [];
  const out: ThreadAction[] = from === "trash" || from === "spam" ? ["moveToInbox"] : [];
  if (to === "inbox") return out.length ? out : ["moveToInbox"];
  out.push(to);
  return out;
}

/** An undo: messages back exactly as they were, and the provider ops that take them there (in order). */
export function restoreMessages(c: Ctx, states: readonly MessageState[]): { threadIds: number[]; ops: { accountId: number; kind: ThreadAction; messageIds: number[] }[] } {
  return c.db.tx(() => {
    const messages = T(c, "messages");
    const steps = [new Map<string, { accountId: number; kind: ThreadAction; messageIds: number[] }>(), new Map<string, { accountId: number; kind: ThreadAction; messageIds: number[] }>()];
    const add = (step: number, accountId: number, kind: ThreadAction, id: number) => {
      const key = `${accountId}:${kind}`;
      const op = steps[step]!.get(key) ?? { accountId, kind, messageIds: [] };
      op.messageIds.push(id);
      steps[step]!.set(key, op);
    };
    const touched = new Set<number>();
    for (const was of [...states].sort((x, y) => x.id - y.id)) {
      const m = messages.get(was.id);
      if (!m) continue;
      const now = stateOf(m);
      if (now.isRead === was.isRead && now.isStarred === was.isStarred && placeOf(now) === placeOf(was)) continue;
      messages.update(m, { is_read: +was.isRead, is_starred: +was.isStarred, in_inbox: +was.inInbox, is_trash: +was.isTrash, is_spam: +was.isSpam });
      touched.add(m.thread_id);
      if (now.isRead !== was.isRead) add(0, m.account_id, was.isRead ? "markRead" : "markUnread", m.id);
      if (now.isStarred !== was.isStarred) add(0, m.account_id, was.isStarred ? "star" : "unstar", m.id);
      placeOps(placeOf(now), placeOf(was)).forEach((kind, step) => add(step, m.account_id, kind, m.id));
    }
    recomputeThreads(c, touched);
    return { threadIds: [...touched], ops: steps.flatMap((s) => [...s.values()]) };
  });
}

// ───────────────────────────── lists, threads, counts ─────────────────────────────

export const VIEW_TEST: Record<View, (t: R) => boolean> = {
  inbox: (t) => t.in_inbox === 1,
  starred: (t) => t.is_starred === 1 && t.in_trash === 0 && t.in_spam === 0,
  sent: (t) => t.has_sent === 1 && t.in_trash === 0 && t.in_spam === 0,
  archive: (t) => t.in_inbox === 0 && t.in_trash === 0 && t.in_spam === 0,
  spam: (t) => t.in_spam === 1 && t.in_trash === 0,
  trash: (t) => t.in_trash === 1,
  all: (t) => t.in_trash === 0 && t.in_spam === 0,
};

export function categoryIdsOf(c: Ctx, threadId: number): number[] {
  return T(c, "thread_categories")
    .by("fk_thread_id", threadId)
    .map((r) => r.category_id as number)
    .sort((x, y) => x - y);
}

export function toSummary(c: Ctx, t: R): ThreadSummary {
  return {
    id: t.id,
    accountId: t.account_id,
    subject: t.subject,
    snippet: t.snippet,
    lastDate: t.last_date,
    fromName: t.last_from_name || t.last_from_email,
    fromEmail: t.last_from_email,
    messageCount: t.message_count,
    unread: t.unread_count > 0,
    starred: t.is_starred === 1,
    hasAttachments: t.has_attachments === 1,
    categoryIds: categoryIdsOf(c, t.id),
  };
}

export function listThreads(c: Ctx, p: ListParams): Page {
  const threads = T(c, "threads");
  const ids = c.order.current(threads);
  const test = VIEW_TEST[p.view];
  const inCategory = p.categoryId === undefined ? null : T(c, "thread_categories");
  const rows: R[] = [];
  for (let i = p.cursor ? c.order.after(threads, p.cursor) : 0; i < ids.length && rows.length <= p.limit; i++) {
    const t = threads.get(ids[i]!)!;
    if (!test(t)) continue;
    if (p.accountId !== undefined && t.account_id !== p.accountId) continue;
    if (inCategory && !inCategory.has(t.id, p.categoryId)) continue;
    rows.push(t);
  }
  const hasMore = rows.length > p.limit;
  const items = (hasMore ? rows.slice(0, p.limit) : rows).map((t) => toSummary(c, t));
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? { lastDate: last.lastDate, id: last.id } : null };
}

/** Every thread id of a view ("select all N"), up to `limit`: a category walks its memberships, not the whole mailbox. */
export function scopeThreadIds(c: Ctx, p: ScopeParams & { limit: number }): number[] {
  const threads = T(c, "threads");
  const test = VIEW_TEST[p.view];
  const out: number[] = [];
  const keep = (t: R | undefined) => !!t && test(t) && (p.accountId === undefined || t.account_id === p.accountId);
  if (p.categoryId !== undefined) {
    for (const m of T(c, "thread_categories").by("fk_category_id", p.categoryId)) {
      if (out.length >= p.limit) break;
      if (keep(threads.get(m.thread_id))) out.push(m.thread_id as number);
    }
    return out;
  }
  for (const t of threads.all()) {
    if (out.length >= p.limit) break;
    if (keep(t)) out.push(t.id as number);
  }
  return out;
}

export function summariesInOrder(c: Ctx, ids: readonly number[]): ThreadSummary[] {
  const threads = T(c, "threads");
  return ids
    .map((id) => threads.get(id))
    .filter((t): t is R => !!t)
    .sort((x, y) => y.last_date - x.last_date || y.id - x.id)
    .map((t) => toSummary(c, t));
}

export function getThread(c: Ctx, threadId: number): ThreadDetail | null {
  const t = T(c, "threads").get(threadId);
  if (!t) return null;
  const messages = T(c, "messages")
    .by("fk_thread_id", threadId)
    .sort((x, y) => x.date - y.date || x.id - y.id);
  const attachments = T(c, "attachments");
  return {
    thread: { ...toSummary(c, t), inInbox: t.in_inbox === 1, inTrash: t.in_trash === 1, inSpam: t.in_spam === 1 },
    messages: messages.map((m): MessageDetail => {
      const body = c.body(m.id);
      return {
        id: m.id,
        threadId: m.thread_id,
        accountId: m.account_id,
        from: { name: m.from_name, email: m.from_email },
        to: JSON.parse(m.to_json),
        cc: JSON.parse(m.cc_json),
        subject: m.subject,
        date: m.date,
        snippet: m.snippet,
        bodyText: body?.body_text ?? null,
        bodyHtml: body?.body_html ?? null,
        bodyState: m.body_state,
        isRead: m.is_read === 1,
        isStarred: m.is_starred === 1,
        isSent: m.is_sent === 1,
        hasAttachments: m.has_attachments === 1,
        rfcMessageId: m.rfc_message_id,
        references: JSON.parse(m.references_json),
        listId: m.list_id,
        attachments: m.has_attachments
          ? attachments
              .by("fk_message_id", m.id)
              .sort((x, y) => x.id - y.id)
              .map((a): AttachmentInfo => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size }))
          : [],
      };
    }),
  };
}

export function pendingSuggestionCounts(c: Ctx): Record<number, number> {
  const out: Record<number, number> = {};
  const threads = T(c, "threads");
  const memberships = T(c, "thread_categories");
  for (const d of T(c, "cls_decisions").by("kind", "suggest")) {
    if (d.outcome !== null) continue;
    const t = threads.get(d.thread_id);
    if (!t || t.in_trash || t.in_spam || memberships.has(d.thread_id, d.category_id)) continue;
    out[d.category_id] = (out[d.category_id] ?? 0) + 1;
  }
  return out;
}

export function getCounts(c: Ctx): Counts {
  const byAccount: Record<number, number> = {};
  let inboxUnread = 0;
  const threads = T(c, "threads");
  for (const t of threads.all()) {
    if (t.in_inbox === 1 && t.unread_count > 0) {
      byAccount[t.account_id] = (byAccount[t.account_id] ?? 0) + 1;
      inboxUnread++;
    }
  }
  const categoryUnread: Record<number, number> = {};
  const categoryTotal: Record<number, number> = {};
  for (const tc of T(c, "thread_categories").all()) {
    const t = threads.get(tc.thread_id)!;
    if (t.in_trash || t.in_spam) continue;
    categoryTotal[tc.category_id] = (categoryTotal[tc.category_id] ?? 0) + 1;
    categoryUnread[tc.category_id] = (categoryUnread[tc.category_id] ?? 0) + (t.unread_count > 0 ? 1 : 0);
  }
  return { inboxUnread, inboxUnreadByAccount: byAccount, categoryUnread, categoryTotal, categorySuggestions: pendingSuggestionCounts(c) };
}

// ───────────────────────────── accounts, categories, filters ─────────────────────────────

const DEFAULT_SYNC: AccountSyncState = { status: "idle", syncedSince: null, bodiesPending: 0, lastError: null, lastSyncAt: null };

const toAccount = (r: R): Account => ({
  id: r.id,
  kind: r.kind,
  email: r.email,
  displayName: r.display_name,
  color: r.color,
  ...accountPrefs(JSON.parse(r.provider_config) as AccountPrefs, r.display_name),
  syncState: { ...DEFAULT_SYNC, ...JSON.parse(r.sync_state) },
});

const byPosition = (x: R, y: R) => x.position - y.position || x.id - y.id;

export function listAccounts(c: Ctx): Account[] {
  return [...T(c, "accounts").all()].sort(byPosition).map(toAccount);
}

export function getAccount(c: Ctx, id: number): Account | null {
  const r = T(c, "accounts").get(id);
  return r ? toAccount(r) : null;
}

export function getAccountConfig<V>(c: Ctx, id: number): { config: V; secretRef: string | null } | null {
  const r = T(c, "accounts").get(id);
  return r ? { config: JSON.parse(r.provider_config) as V, secretRef: r.secret_ref } : null;
}

export function createAccount(c: Ctx, a: { kind: AccountKind; email: string; displayName: string; color: string; providerConfig?: unknown; secretRef?: string | null }, now: number): Account {
  return c.db.tx(() => {
    const accounts = T(c, "accounts");
    const id = Math.max(getSetting(c, "account_id_hwm", 0), accounts.highestKey()) + 1;
    setSetting(c, "account_id_hwm", id);
    let position = -1;
    for (const r of accounts.all()) position = Math.max(position, r.position);
    accounts.insert({ id, kind: a.kind, email: a.email.toLowerCase(), display_name: a.displayName, color: a.color, provider_config: JSON.stringify(a.providerConfig ?? {}), secret_ref: a.secretRef ?? null, sync_state: "{}", position: position + 1, created_at: now });
    return getAccount(c, id)!;
  });
}

export function updateAccount(c: Ctx, id: number, patch: AccountPatch): Account | null {
  const accounts = T(c, "accounts");
  const r = accounts.get(id);
  if (!r) return null;
  const prefs = patch.senderName !== undefined || patch.signature !== undefined || patch.syncWindowDays !== undefined;
  accounts.update(r, {
    ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(prefs ? { provider_config: JSON.stringify(withAccountPrefs(JSON.parse(r.provider_config) as AccountPrefs, patch)) } : {}),
  });
  return getAccount(c, id);
}

export function listCategories(c: Ctx): Category[] {
  return [...T(c, "categories").all()].sort(byPosition).map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position, autoApply: r.auto_apply === 1 }));
}

export function createCategory(c: Ctx, name: string, color: CategoryColor): Category {
  const categories = T(c, "categories");
  let position = -1;
  for (const r of categories.all()) position = Math.max(position, r.position);
  const row: R = { id: undefined, name, color, position: position + 1, auto_apply: 1 };
  categories.insert(row);
  return { id: row.id, name, color, position: position + 1, autoApply: true };
}

export function updateCategory(c: Ctx, id: number, patch: { name?: string; color?: CategoryColor; position?: number; autoApply?: boolean }): Category | null {
  const categories = T(c, "categories");
  const r = categories.get(id);
  if (r) {
    categories.update(r, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.autoApply !== undefined ? { auto_apply: patch.autoApply ? 1 : 0 } : {}),
    });
  }
  return listCategories(c).find((x) => x.id === id) ?? null;
}

const toFilter = (r: R): Filter => ({ id: r.id, name: r.name, enabled: r.enabled === 1, source: r.source, rule: JSON.parse(r.rule_json) as FilterRule, hits: r.hits, createdAt: r.created_at });

export function listFilters(c: Ctx): Filter[] {
  return [...T(c, "filters").all()].sort(byPosition).map(toFilter);
}

export function getFilter(c: Ctx, id: number): Filter | null {
  const r = T(c, "filters").get(id);
  return r ? toFilter(r) : null;
}

export function saveFilter(c: Ctx, f: { id?: number; name: string; enabled: boolean; source: Filter["source"]; rule: FilterRule; learnedKey?: string }, now: number): Filter {
  const filters = T(c, "filters");
  return c.db.tx(() => {
    if (f.id !== undefined) {
      const previous = filters.get(f.id);
      if (!previous) return getFilter(c, f.id)!;
      if (previous.rule_json !== JSON.stringify(f.rule)) for (const a of T(c, "filter_applications").by("fk_filter_id", f.id)) T(c, "filter_applications").deleteRow(a);
      filters.update(previous, { name: f.name, enabled: f.enabled ? 1 : 0, source: f.source, rule_json: JSON.stringify(f.rule) });
      return getFilter(c, f.id)!;
    }
    let position = -1;
    for (const r of filters.all()) position = Math.max(position, r.position);
    const row: R = { id: undefined, name: f.name, enabled: f.enabled ? 1 : 0, source: f.source, rule_json: JSON.stringify(f.rule), learned_key: f.learnedKey ?? null, hits: 0, position: position + 1, created_at: now, last_applied_at: null };
    filters.insert(row);
    return getFilter(c, row.id)!;
  });
}

export function claimFilterApplications(c: Ctx, filterId: number, messageIds: readonly number[], now: number): number[] {
  const fresh: number[] = [];
  const applications = T(c, "filter_applications");
  for (const id of messageIds) if (applications.insert({ filter_id: filterId, message_id: id, applied_at: now })) fresh.push(id);
  if (fresh.length > 0) {
    const filters = T(c, "filters");
    const f = filters.get(filterId);
    if (f) filters.update(f, { hits: f.hits + fresh.length, last_applied_at: now });
  }
  return fresh;
}

// ───────────────────────────── rules ─────────────────────────────

/** core's evaluator per message (the SQL compiler is held to it by the parity suite; here it is the implementation). */
export function ruleMessage(m: R, bodyText: string | null): RuleMessage {
  return { accountId: m.account_id, fromName: m.from_name, fromEmail: m.from_email, recipients: m.recipients_text, subject: m.subject, bodyText, listId: m.list_id, hasAttachments: m.has_attachments === 1, date: m.date };
}

export const ruleNeedsBody = (rule: FilterRule) => rule.conditions.some((cond) => cond.field === "body");

/** Messages (not in trash) matching a rule among the given ones (their bodies read ahead when the rule needs them). */
export function findRuleMatches(c: Ctx, rule: FilterRule, now: number, messageIds: readonly number[]): { messageIds: number[]; threadIds: number[] } {
  const messages = T(c, "messages");
  const needsBody = ruleNeedsBody(rule);
  const ids: number[] = [];
  const threads = new Set<number>();
  for (const id of messageIds) {
    const m = messages.get(id);
    if (!m || m.is_trash) continue;
    if (!evaluateRule(rule, ruleMessage(m, needsBody ? (c.body(id)?.body_text ?? null) : null), now)) continue;
    ids.push(id);
    threads.add(m.thread_id);
  }
  return { messageIds: ids, threadIds: [...threads] };
}

// ───────────────────────────── ops ─────────────────────────────

const OPPOSITE: Record<string, string> = { markRead: "markUnread", markUnread: "markRead", star: "unstar", unstar: "star" };
const SUPERSEDABLE = new Set(["read", "star"]);
const GROUP: Record<string, string> = { markRead: "read", markUnread: "read", star: "star", unstar: "star", archive: "location", trash: "location", spam: "location", notSpam: "location", moveToInbox: "location" };
export const MAX_OP_ATTEMPTS = 8;

const targetOf = (op: R) => JSON.parse(op.target_json) as { messageIds?: number[] } & Record<string, unknown>;

function dropTargets(c: Ctx, opId: string, messageIds?: Iterable<number>): void {
  const targets = T(c, "op_targets");
  if (!messageIds) for (const t of targets.by("fk_op_id", opId)) targets.deleteRow(t);
  else for (const m of messageIds) targets.delete(opId, m);
}

export function enqueueOp(c: Ctx, op: { accountId: number; kind: string; target: { messageIds?: number[] } & Record<string, unknown>; payload?: unknown }, now: number): string | null {
  const ops = T(c, "ops");
  const targetJson = JSON.stringify(op.target);
  const group = GROUP[op.kind];
  return c.db.tx(() => {
    const opposite = OPPOSITE[op.kind];
    if (opposite) {
      const cancel = ops.by("fk_account_id", op.accountId).filter((o) => o.kind === opposite && o.state === "queued" && o.attempts === 0 && o.target_json === targetJson);
      for (const o of cancel) ops.deleteRow(o);
      if (cancel.length > 0) return null;
    }
    if (group && SUPERSEDABLE.has(group) && op.target.messageIds?.length) {
      const mine = new Set(op.target.messageIds);
      const overlapping = new Set<string>();
      for (const m of mine) for (const t of T(c, "op_targets").by("message", m)) if (t.grp === group) overlapping.add(t.op_id);
      for (const id of overlapping) {
        const older = ops.get(id);
        if (!older || older.account_id !== op.accountId || older.state !== "queued") continue;
        const target = targetOf(older);
        const remaining = (target.messageIds ?? []).filter((m) => !mine.has(m));
        if (remaining.length === 0) ops.deleteRow(older);
        else {
          ops.update(older, { target_json: JSON.stringify({ ...target, messageIds: remaining }) });
          dropTargets(c, id, mine);
        }
      }
    }
    const id = c.uuid();
    ops.insert({ id, seq: ops.peak("seq") + 1, account_id: op.accountId, kind: op.kind, target_json: targetJson, payload_json: JSON.stringify(op.payload ?? {}), state: "queued", attempts: 0, next_attempt_at: 0, last_error: null, created_at: now, updated_at: now });
    for (const messageId of new Set(op.target.messageIds ?? [])) T(c, "op_targets").insert({ op_id: id, message_id: messageId, grp: group ?? op.kind });
    return id;
  });
}

const opRow = (r: R): OpRow => ({ id: r.id, seq: r.seq, account_id: r.account_id, kind: r.kind, target_json: r.target_json, payload_json: r.payload_json, state: r.state, attempts: r.attempts, next_attempt_at: r.next_attempt_at, last_error: r.last_error, created_at: r.created_at });

export function claimReadyOps(c: Ctx, now: number, limit: number): OpRow[] {
  const ops = T(c, "ops");
  const targets = T(c, "op_targets");
  return c.db.tx(() => {
    const ready = ops.by("state", "queued").filter((o) => o.next_attempt_at <= now).sort((x, y) => x.seq - y.seq);
    const out: OpRow[] = [];
    for (const o of ready) {
      if (out.length >= limit) break;
      // a location op waits for older unsettled location ops on the same messages
      const blocked = targets.by("fk_op_id", o.id).some(
        (mine) =>
          mine.grp === "location" &&
          targets.by("message", mine.message_id).some((other) => {
            if (other.grp !== "location") return false;
            const o2 = ops.get(other.op_id);
            return !!o2 && o2.seq < o.seq && (o2.state === "queued" || o2.state === "running");
          }),
      );
      if (blocked) continue;
      const running = ops.update(o, { state: "running", attempts: o.attempts + 1, updated_at: now });
      out.push(opRow(running));
    }
    return out;
  });
}

export function getOp(c: Ctx, id: string): OpRow | null {
  const r = T(c, "ops").get(id);
  return r ? opRow(r) : null;
}

export function completeOp(c: Ctx, id: string, now: number): void {
  const ops = T(c, "ops");
  const r = ops.get(id);
  if (r) ops.update(r, { state: "succeeded", last_error: null, updated_at: now });
  dropTargets(c, id);
}

function yieldToNewerOps(c: Ctx, id: string): boolean {
  const ops = T(c, "ops");
  const targets = T(c, "op_targets");
  const op = ops.get(id);
  const group = op ? GROUP[op.kind] : undefined;
  if (!op || !group || !SUPERSEDABLE.has(group)) return true;
  const covered = new Set<number>();
  for (const t1 of targets.by("fk_op_id", id)) {
    for (const t2 of targets.by("message", t1.message_id)) {
      if (t2.grp !== t1.grp) continue;
      const o2 = ops.get(t2.op_id);
      if (o2 && o2.seq > op.seq && o2.account_id === op.account_id && o2.state !== "failed") covered.add(t2.message_id);
    }
  }
  if (covered.size === 0) return true;
  const target = targetOf(op);
  const remaining = (target.messageIds ?? []).filter((m) => !covered.has(m));
  if (remaining.length === 0) {
    ops.deleteRow(op);
    return false;
  }
  ops.update(op, { target_json: JSON.stringify({ ...target, messageIds: remaining }) });
  dropTargets(c, id, covered);
  return true;
}

export function pruneOpTargets(c: Ctx, messageIds: readonly number[]): void {
  if (messageIds.length === 0) return;
  const ops = T(c, "ops");
  const targets = T(c, "op_targets");
  const gone = new Set(messageIds);
  const affected = new Set<string>();
  for (const m of gone) for (const t of targets.by("message", m)) affected.add(t.op_id);
  for (const id of affected) {
    const op = ops.get(id);
    if (!op || !["queued", "running", "unknown"].includes(op.state)) continue;
    const target = targetOf(op);
    const remaining = (target.messageIds ?? []).filter((m) => !gone.has(m));
    if (remaining.length === 0 && op.kind !== "send") ops.deleteRow(op);
    else ops.update(op, { target_json: JSON.stringify({ ...target, messageIds: remaining }) });
  }
  for (const m of gone) for (const t of targets.by("message", m)) targets.deleteRow(t);
}

export function failOp(c: Ctx, id: string, error: string, retryable: boolean, now: number): OpState {
  const ops = T(c, "ops");
  const op = ops.get(id);
  if (!op) return "failed";
  const state: OpState = retryable && op.attempts < MAX_OP_ATTEMPTS ? "queued" : "failed";
  const delay = Math.min(1000 * 2 ** (op.attempts - 1), 300_000);
  ops.update(op, { state, last_error: error, next_attempt_at: now + delay, updated_at: now });
  if (state === "failed") dropTargets(c, id);
  else if (!yieldToNewerOps(c, id)) return "succeeded";
  return state;
}

export function awaitAuthOp(c: Ctx, id: string, error: string, now: number): void {
  const ops = T(c, "ops");
  const op = ops.get(id);
  if (op && op.state === "running") ops.update(op, { state: "queued", attempts: Math.max(op.attempts - 1, 0), next_attempt_at: AWAITING_AUTH, last_error: error, updated_at: now });
}

export function resumeAuthOps(c: Ctx, accountId: number, now: number): string[] {
  const ops = T(c, "ops");
  const out: string[] = [];
  for (const o of ops.by("fk_account_id", accountId)) {
    if (o.state !== "queued" || o.next_attempt_at !== AWAITING_AUTH) continue;
    ops.update(o, { next_attempt_at: 0, updated_at: now });
    out.push(o.id);
  }
  return out;
}

export function markOpUnknown(c: Ctx, id: string, error: string, now: number): void {
  const ops = T(c, "ops");
  const op = ops.get(id);
  if (op) ops.update(op, { state: "unknown", last_error: error, updated_at: now });
}

export function recoverOps(c: Ctx, now: number): { requeued: number; unknown: number } {
  const ops = T(c, "ops");
  return c.db.tx(() => {
    let unknown = 0;
    const running: string[] = [];
    // updates keep their keys: iterating the live map is safe
    for (const o of ops.all()) {
      if (o.state !== "running") continue;
      if (o.kind === "send") {
        ops.update(o, { state: "unknown", last_error: "Interrupted while sending", updated_at: now });
        unknown++;
      } else running.push(o.id);
    }
    for (const id of running) ops.update(ops.get(id)!, { state: "queued", updated_at: now });
    for (const id of running) yieldToNewerOps(c, id);
    return { requeued: running.length, unknown };
  });
}

export function listRecentOps(c: Ctx, limit: number): OpRow[] {
  const since = Date.now() - 3_600_000;
  return [...T(c, "ops").all()]
    .filter((o) => o.state !== "succeeded" || o.updated_at > since)
    .sort((x, y) => y.seq - x.seq)
    .slice(0, limit)
    .map(opRow);
}

export function messagesWithPendingOps(c: Ctx, accountId: number): Set<number> {
  const out = new Set<number>();
  const targets = T(c, "op_targets");
  for (const o of T(c, "ops").by("fk_account_id", accountId)) {
    if (o.state !== "queued" && o.state !== "running") continue;
    for (const t of targets.by("fk_op_id", o.id)) out.add(t.message_id);
  }
  return out;
}

// ───────────────────────────── learning ─────────────────────────────

export function recordUserActions(c: Ctx, threadIds: readonly number[], action: UserActionKind, now: number): void {
  const messages = T(c, "messages");
  for (const threadId of threadIds) {
    const m = messages
      .by("fk_thread_id", threadId)
      .sort((x, y) => x.is_sent - y.is_sent || y.date - x.date || y.id - x.id)[0];
    if (!m) continue;
    T(c, "user_actions").insert({ id: undefined, thread_id: threadId, action, from_email: m.from_email, from_domain: m.from_domain, list_id: m.list_id, at: now });
  }
}

export function loadUserActions(c: Ctx, since: number) {
  return [...T(c, "user_actions").all()]
    .filter((a) => a.at >= since || a.action === "star" || a.action === "reply" || a.action === "markImportant")
    .sort((x, y) => x.id - y.id)
    .map((a) => ({ action: a.action as UserActionKind, fromEmail: a.from_email as string, fromDomain: a.from_domain as string, listId: a.list_id as string | null, at: a.at as number }));
}

// ───────────────────────────── drafts ─────────────────────────────

const draftRow = (r: R): DraftRow => ({
  id: r.id,
  account_id: r.account_id,
  thread_id: r.thread_id ?? null,
  format: r.format ?? 1,
  mode: r.mode ?? "new",
  to_json: r.to_json,
  cc_json: r.cc_json,
  bcc_json: r.bcc_json ?? "[]",
  subject: r.subject,
  subject_edited: r.subject_edited ?? 0,
  body_text: r.body_text,
  quoted_text: r.quoted_text ?? "",
  include_quote: r.include_quote ?? 0,
  in_reply_to_message_id: r.in_reply_to_message_id ?? null,
  forward_of_message_id: r.forward_of_message_id ?? null,
  ui_state: r.ui_state ?? "open",
  revision: r.revision ?? 1,
  updated_at: r.updated_at,
});

/** The same contract as SQL's saveDraft: revisions, stale edits become new drafts, null when gone. */
export function saveDraft(c: Ctx, d: DraftInput, now: number): DraftRow | null {
  const drafts = T(c, "drafts");
  const row = d.id !== undefined ? drafts.get(d.id) : undefined;
  if (d.id !== undefined && !row) return null;
  const inReplyTo = d.inReplyToMessageId !== undefined ? d.inReplyToMessageId : (row?.in_reply_to_message_id ?? null);
  const replyThread = inReplyTo ? ((T(c, "messages").get(inReplyTo)?.thread_id as number | undefined) ?? null) : null;
  const values = {
    account_id: d.accountId,
    thread_id: d.threadId !== undefined ? d.threadId : row ? (row.thread_id ?? null) : replyThread,
    mode: d.mode ?? row?.mode ?? (inReplyTo ? "reply" : "new"),
    to_json: JSON.stringify(d.to),
    cc_json: JSON.stringify(d.cc),
    bcc_json: d.bcc !== undefined ? JSON.stringify(d.bcc) : (row?.bcc_json ?? "[]"),
    subject: d.subject,
    subject_edited: d.subjectEdited !== undefined ? Number(d.subjectEdited) : (row?.subject_edited ?? 0),
    body_text: d.bodyText,
    quoted_text: d.quotedText ?? row?.quoted_text ?? "",
    include_quote: d.includeQuote !== undefined ? Number(d.includeQuote) : (row?.include_quote ?? 0),
    in_reply_to_message_id: inReplyTo,
    forward_of_message_id: d.forwardOfMessageId !== undefined ? d.forwardOfMessageId : (row?.forward_of_message_id ?? null),
    ui_state: d.uiState ?? row?.ui_state ?? "open",
    updated_at: now,
  };
  if (row && (d.baseRevision === undefined || d.baseRevision === row.revision)) return draftRow(drafts.update(row, { ...values, revision: (row.revision ?? 1) + 1 }));
  const fresh: R = { id: undefined, ...values, format: 2, revision: 1 };
  drafts.insert(fresh);
  return draftRow(fresh);
}

/** Every draft, newest first; a reply or forward whose conversation or original is gone comes back as a new message (as in SQL). */
export function listDrafts(c: Ctx): DraftRow[] {
  const messages = T(c, "messages");
  const exists = (id: number | null) => id !== null && messages.get(id) !== undefined;
  return [...T(c, "drafts").all()]
    .sort((x, y) => y.updated_at - x.updated_at || y.id - x.id)
    .map(draftRow)
    .map((d) => {
      if (d.mode === "new") return d;
      const lost = d.thread_id === null || (d.in_reply_to_message_id !== null && !exists(d.in_reply_to_message_id)) || (d.forward_of_message_id !== null && !exists(d.forward_of_message_id));
      return lost ? { ...d, mode: "new" as const, thread_id: null, in_reply_to_message_id: null, forward_of_message_id: null } : d;
    });
}

// ───────────────────────────── owner ─────────────────────────────

export function getOwner(c: Ctx): OwnerIdentity | null {
  const r = T(c, "owner").get(1);
  if (!r) return null;
  return {
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    provider: r.provider,
    verifiedBy: r.verified_by,
    verifiedAt: r.verified_at,
    migrated: (JSON.parse(r.evidence_json) as { migrated?: boolean }).migrated === true,
    accountId: r.account_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function claimOwner(c: Ctx, claim: OwnerClaim, now: number): boolean {
  return T(c, "owner").insert({
    id: 1,
    user_id: c.uuid(),
    email: claim.email.toLowerCase(),
    display_name: claim.displayName,
    provider: claim.provider,
    verified_by: claim.verifiedBy,
    evidence_json: JSON.stringify(claim.evidence),
    verified_at: now,
    account_id: claim.accountId,
    cloud_json: null,
    created_at: now,
    updated_at: now,
  });
}

export function changeOwner(c: Ctx, claim: OwnerClaim, reason: string, now: number): void {
  const owner = T(c, "owner");
  const current = owner.get(1);
  if (!current) {
    claimOwner(c, claim, now);
    return;
  }
  T(c, "owner_history").insert({ id: undefined, user_id: current.user_id, email: current.email, provider: current.provider, verified_by: current.verified_by, evidence_json: current.evidence_json, verified_at: current.verified_at, replaced_at: now, reason });
  owner.update(current, { email: claim.email.toLowerCase(), display_name: claim.displayName, provider: claim.provider, verified_by: claim.verifiedBy, evidence_json: JSON.stringify(claim.evidence), verified_at: now, account_id: claim.accountId, updated_at: now });
}

// ───────────────────────────── search projections ─────────────────────────────

export function messageDoc(m: R, bodyText: string | null): SearchMessageDoc {
  return {
    messageId: m.id,
    threadId: m.thread_id,
    accountId: m.account_id,
    date: m.date,
    subject: m.subject,
    fromText: `${m.from_name} ${m.from_email}`,
    fromEmail: m.from_email,
    recipients: m.recipients_text,
    body: bodyText ?? "",
    hasAttachments: m.has_attachments === 1,
    bodyState: m.body_state,
  };
}

export function threadDoc(c: Ctx, t: R): SearchThreadDoc {
  return {
    threadId: t.id,
    accountId: t.account_id,
    lastDate: t.last_date,
    inInbox: t.in_inbox === 1,
    hasSent: t.has_sent === 1,
    inTrash: t.in_trash === 1,
    inSpam: t.in_spam === 1,
    isStarred: t.is_starred === 1,
    unreadCount: t.unread_count,
    categoryIds: categoryIdsOf(c, t.id),
  };
}
