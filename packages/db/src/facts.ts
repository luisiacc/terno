import { addressKey, automatedLevel, threadFactsNewestFirst, type Address, type ArrivalRow, type FactContext, type FactRow, type ThreadFacts } from "@terno/core";
import type { Db } from "./sqlite";

/**
 * Plan 17's thread facts on SQLite: who a conversation is from (`person`)
 * and since when it waits for your reply (`waiting_since`), kept by
 * recomputeThreads with the other aggregates; the addresses you send from
 * and write to (`correspondents`), kept from your sent mail; and the
 * backfill, one transaction per slice:
 *
 * - `senders`: correspondents from the sent mail stored before v14, by id;
 * - then the pending queue (facts NULL), newest first, until it is empty;
 * - `rescan`: every thread by id, rewriting only facts that changed, after
 *   something changed what counts as yours (an alias, an account);
 * - `done`.
 *
 * Every write of the facts outside recomputeThreads marks the thread dirty
 * for the search outbox in the same transaction (v7 has no thread trigger).
 */

export type FactsPhase =
  | { phase: "senders"; after: number }
  | { phase: "threads"; rescan?: boolean }
  | { phase: "rescan"; after: number }
  | { phase: "done" };

const KEY = "facts_backfill";
/** A requeue this small is recomputed in the same unit (the count never blinks); a larger one goes to the backfill. */
export const INLINE_REQUEUE = 200;
/** Messages read per step of a newest-first walk. */
const WALK_PAGE = 16;

/** The backfill's progress; absent (a database that never needed one) is done. */
export function factsPhase(db: Db): FactsPhase {
  const r = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", KEY);
  return r ? (JSON.parse(r.value_json) as FactsPhase) : { phase: "done" };
}

function setPhase(db: Db, p: FactsPhase): void {
  db.run("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)", KEY, JSON.stringify(p));
}

const hasPending = (db: Db) => db.get("SELECT 1 FROM threads INDEXED BY threads_facts_pending WHERE person IS NULL LIMIT 1") !== undefined;

/** Every thread's facts are current: the counts may say how many wait. */
export function factsReady(db: Db): boolean {
  return factsPhase(db).phase === "done" && !hasPending(db) && senderJobs(db).length === 0;
}

/** Your addresses (plan 17 §2.1): every account's, and every address your sent mail came from. */
export function ownAddresses(db: Db): Set<string> {
  const own = new Set<string>();
  for (const r of db.all<{ email: string }>("SELECT email FROM accounts")) own.add(addressKey(r.email));
  for (const r of db.all<{ email: string }>("SELECT email FROM correspondents INDEXED BY correspondents_own WHERE own = 1")) own.add(r.email);
  return own;
}

/** A local copy whose send failed (only `local:` rows are asked: they exist until the server has the message). */
function failedSend(db: Db, messageId: number): boolean {
  return db.get("SELECT 1 FROM ops WHERE kind = 'send' AND state = 'failed' AND json_extract(target_json, '$.messageIds[0]') = ? LIMIT 1", messageId) !== undefined;
}

/** What threadFacts asks the database. */
export function factContext(db: Db, own: ReadonlySet<string>): FactContext {
  return {
    own: (key) => own.has(key),
    written: (key) => db.get<{ written: number }>("SELECT written FROM correspondents WHERE email = ?", key)?.written === 1,
    failedSend: (id) => failedSend(db, id),
    details: (id) => db.get<{ to_json: string; cc_json: string; rfc_message_id: string | null }>("SELECT to_json, cc_json, rfc_message_id FROM messages WHERE id = ?", id) ?? { to_json: "[]", cc_json: "[]", rfc_message_id: null },
    answered: (rfcMessageId) => {
      // message_refs is keyed by (account_id, ref): a probe per account in one statement, the thread's own account
      // included (a Gmail thread id can put a reply in another thread of the same account)
      for (const m of db.all<{ id: number; is_sent: number; is_draft: number; from_email: string; provider_msg_id: string | null }>(
        "SELECT m.id, m.is_sent, m.is_draft, m.from_email, m.provider_msg_id FROM message_refs r JOIN messages m ON m.id = r.message_id WHERE r.account_id IN (SELECT id FROM accounts) AND r.ref = ?",
        rfcMessageId,
      )) {
        if (m.is_draft || !(m.is_sent || own.has(addressKey(m.from_email)))) continue;
        if (m.provider_msg_id?.startsWith("local:") && failedSend(db, m.id)) continue;
        return true;
      }
      return false;
    },
  };
}

/**
 * The message columns the facts read, as recomputeThreads selects them beside
 * its own, kept short: every message of a touched thread goes through them on
 * each ingest. Gmail's labels come as the one category that decides (the same
 * lists as core's automatedLevel; the conformance oracle reads the raw
 * labels), a local copy as its prefix; To, Cc and the Message-ID are read
 * for the newest message only (`details`).
 */
export const FACT_COLUMNS = `is_draft, is_bulk, list_id,
  CASE WHEN gmail_labels IS NULL THEN NULL
       WHEN instr(gmail_labels, 'CATEGORY_PROMOTIONS') OR instr(gmail_labels, 'CATEGORY_SOCIAL') OR instr(gmail_labels, 'CATEGORY_FORUMS') THEN 'CATEGORY_PROMOTIONS'
       WHEN instr(gmail_labels, 'CATEGORY_UPDATES') THEN 'CATEGORY_UPDATES' END AS gmail_labels,
  CASE WHEN provider_msg_id LIKE 'local:%' THEN 'local:' END AS provider_msg_id`;

/** The context for a recompute: null while the backfill still collects your addresses (facts stay NULL meanwhile). */
export function recomputeContext(db: Db): FactContext | null {
  return factsPhase(db).phase === "senders" ? null : factContext(db, ownAddresses(db));
}

/** One thread's facts from its messages newest first, through messages_thread, a page at a time (Codex R10). */
export function factsOf(db: Db, threadId: number, ctx: FactContext): ThreadFacts {
  const sql = `SELECT id, date, from_email, is_sent, is_trash, is_spam, ${FACT_COLUMNS} FROM messages INDEXED BY messages_thread WHERE thread_id = ?`;
  let page: FactRow[] = db.all<FactRow>(`${sql} ORDER BY date DESC, id DESC LIMIT ${WALK_PAGE}`, threadId);
  let i = 0;
  return threadFactsNewestFirst(() => {
    if (i === page.length && page.length === WALK_PAGE) {
      const last = page[page.length - 1]!;
      // a row value: a range of the index (an OR would read the thread's rows from the start)
      page = db.all<FactRow>(`${sql} AND (date, id) < (?, ?) ORDER BY date DESC, id DESC LIMIT ${WALK_PAGE}`, threadId, last.date, last.id);
      i = 0;
    }
    return page[i++];
  }, ctx);
}

/** Writes facts that changed, marking the thread for the search outbox; true when it wrote. */
function writeFacts(db: Db, threadId: number, f: ThreadFacts | null): boolean {
  const changed = db.run("UPDATE threads SET person = ?, waiting_since = ? WHERE id = ? AND (person IS NOT ? OR waiting_since IS NOT ?)", f?.person ?? null, f?.waitingSince ?? null, threadId, f?.person ?? null, f?.waitingSince ?? null).changes > 0;
  if (changed) db.run("INSERT OR IGNORE INTO search_dirty (kind, id) VALUES (1, ?)", threadId);
  return changed;
}

/** Threads holding inbound mail from this address or its +tagged forms (messages_from: one seek and one range). */
/**
 * The messages from an address and its +tagged forms, in (from_email, id)
 * order past a cursor: one range of messages_from per stage (0: the address,
 * 1: `local+…` with its domain), at most `limit` rows.
 */
/** A sender's messages: one address past an id, and a range of addresses (both seeks of messages_from; the plans are tested) */
export const SENDER_SQL = {
  address: "SELECT id, thread_id, from_email FROM messages WHERE from_email = ? AND id > ? ORDER BY id LIMIT ?",
  range: "SELECT id, thread_id, from_email FROM messages WHERE from_email > ? AND from_email < ? ORDER BY from_email, id LIMIT ?",
};

function messagesFrom(db: Db, key: string, stage: 0 | 1, after: { from: string; id: number }, limit: number): { id: number; thread_id: number; from_email: string }[] {
  if (stage === 0) return db.all(SENDER_SQL.address, key, after.id, limit);
  const at = key.lastIndexOf("@");
  if (at <= 0) return [];
  const local = key.slice(0, at);
  // the address the cursor is in, past its id (a seek on both: Codex review 2, #4), then the next addresses of the range
  const rows: { id: number; thread_id: number; from_email: string }[] = after.from > `${local}+` ? db.all(SENDER_SQL.address, after.from, after.id, limit) : [];
  if (rows.length < limit) {
    const from = after.from > `${local}+` ? after.from : `${local}+`;
    rows.push(...db.all<{ id: number; thread_id: number; from_email: string }>(SENDER_SQL.range, from, `${local},`, limit - rows.length));
  }
  return rows;
}

/** A sender's threads to recompute, persisted: bounded slices of its messages (Codex review 1, #2). */
interface SenderJob {
  email: string;
  stage: 0 | 1;
  from: string;
  id: number;
}

const SENDERS_KEY = "facts_senders";

function senderJobs(db: Db): SenderJob[] {
  const r = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", SENDERS_KEY);
  return r ? (JSON.parse(r.value_json) as SenderJob[]) : [];
}

function setSenderJobs(db: Db, jobs: SenderJob[]): void {
  if (jobs.length) db.run("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)", SENDERS_KEY, JSON.stringify(jobs));
  else db.run("DELETE FROM settings WHERE key = ?", SENDERS_KEY);
}

/**
 * What you know about an address changed (you wrote to it): its threads'
 * facts are recomputed now when they are few (a bounded look tells), or by
 * the backfill, a slice of its messages at a time. Their facts stay as they
 * were meanwhile, and the waiting count reads unknown. Returns whether a job
 * was queued.
 */
export function requeueSender(db: Db, key: string): boolean {
  if (factsPhase(db).phase === "senders") return false; // nothing is computed yet: nothing to correct
  const exact = messagesFrom(db, key, 0, { from: "", id: 0 }, INLINE_REQUEUE + 1);
  // the +tagged range may hold other domains' rows too: its raw length decides, the domain filters after
  const tagged = exact.length > INLINE_REQUEUE ? [] : messagesFrom(db, key, 1, { from: "", id: 0 }, INLINE_REQUEUE + 1);
  if (exact.length + tagged.length <= INLINE_REQUEUE) {
    const domain = key.slice(key.lastIndexOf("@"));
    const ids = new Set([...exact, ...tagged.filter((m) => m.from_email.endsWith(domain))].map((m) => m.thread_id));
    if (ids.size === 0) return false;
    const ctx = factContext(db, ownAddresses(db));
    for (const id of ids) writeFacts(db, id, factsOf(db, id, ctx));
    return false;
  }
  setSenderJobs(db, [...senderJobs(db).filter((j) => j.email !== key), { email: key, stage: 0, from: "", id: 0 }]);
  return true;
}

/** One slice of the first sender job: up to `n` of its messages' threads recomputed; the job moves on or ends. */
function senderSlice(db: Db, n: number): number {
  const jobs = senderJobs(db);
  const job = jobs[0]!;
  const rows = messagesFrom(db, job.email, job.stage, { from: job.from, id: job.id }, n);
  const ctx = factContext(db, ownAddresses(db));
  const at = job.email.lastIndexOf("@");
  for (const id of new Set(rows.filter((m) => job.stage === 0 || m.from_email.endsWith(job.email.slice(at))).map((m) => m.thread_id))) writeFacts(db, id, factsOf(db, id, ctx));
  const last = rows[rows.length - 1];
  if (rows.length === n && last) jobs[0] = { ...job, from: last.from_email, id: last.id };
  else if (job.stage === 0) jobs[0] = { ...job, stage: 1, from: "", id: 0 };
  else jobs.shift();
  setSenderJobs(db, jobs);
  return Math.max(1, rows.length);
}

/** Something changed what counts as yours (an alias, an account): every thread's facts are checked again, in slices. */
export function startRescan(db: Db): void {
  const p = factsPhase(db);
  // while senders are collected nothing is computed yet: the queue gets everything with what is known by then;
  // and with no thread there is nothing to check (the first account of an install)
  if (p.phase === "senders" || db.get("SELECT 1 FROM threads LIMIT 1") === undefined) return;
  if (p.phase === "threads") setPhase(db, { phase: "threads", rescan: true });
  else setPhase(db, { phase: "rescan", after: 0 });
}

/**
 * A sent message of yours was stored, or became sent (plan 17 §2.1, Codex
 * R6: only sent, non-draft mail teaches, in ingest and the backfill alike):
 * its From is yours, its recipients are people you wrote to. Returns
 * whether threads went to the backfill (a rescan, or a large requeue).
 */
export function noteSentMail(db: Db, from: string, recipients: readonly Address[]): boolean {
  let queued = false;
  const key = addressKey(from);
  if (key.includes("@") && db.run("INSERT INTO correspondents (email, own) VALUES (?, 1) ON CONFLICT (email) DO UPDATE SET own = 1 WHERE own = 0", key).changes > 0) {
    // a new address of yours changes "mine" and the Cc rule anywhere (Codex R3); an account's own address was already yours
    if (!db.get("SELECT 1 FROM accounts WHERE lower(email) = ?", key)) {
      startRescan(db);
      queued = true;
    }
  }
  for (const a of recipients) {
    const to = addressKey(a.email);
    if (!to.includes("@")) continue;
    if (db.run("INSERT INTO correspondents (email, written) VALUES (?, 1) ON CONFLICT (email) DO UPDATE SET written = 1 WHERE written = 0", to).changes === 0) continue;
    // writing to it can change who it is (a role address, or one Gmail filed under Updates: Codex review 1, #5); a no-reply address stays one
    if (automatedLevel({ from_email: to, list_id: null, is_bulk: 0, gmail_labels: null, is_spam: 0 }) !== 2 && requeueSender(db, to)) queued = true;
  }
  return queued;
}

/** Threads, in every account, holding a message these references name: a reply of yours may have answered them (Codex R7). */
export function answeredThreads(db: Db, refs: readonly string[]): number[] {
  if (refs.length === 0) return [];
  // messages_rfc is (account_id, rfc_message_id): every account × every reference, probed in one statement
  return db
    .all<{ thread_id: number }>("SELECT DISTINCT thread_id FROM messages WHERE account_id IN (SELECT id FROM accounts) AND rfc_message_id IN (SELECT value FROM json_each(?))", JSON.stringify(refs))
    .map((r) => r.thread_id);
}

/**
 * A stored message became sent or stopped being a draft, or the reverse
 * (flag updates, Codex R4): sent mail teaches as at ingest, and the threads
 * its references name are what it may answer or stop answering.
 */
export function ownMailChanged(db: Db, messageId: number): number[] {
  const m = db.get<{ is_sent: number; is_draft: number; from_email: string; to_json: string; cc_json: string; bcc_json: string; references_json: string; in_reply_to: string | null }>(
    "SELECT is_sent, is_draft, from_email, to_json, cc_json, bcc_json, references_json, in_reply_to FROM messages WHERE id = ?",
    messageId,
  );
  if (!m) return [];
  if (m.is_sent && !m.is_draft) {
    const recipients = [m.to_json, m.cc_json, m.bcc_json].flatMap(parseAddresses).map((email) => ({ name: "", email }));
    noteSentMail(db, m.from_email, recipients);
  }
  const refs = JSON.parse(m.references_json) as string[];
  if (m.in_reply_to) refs.push(m.in_reply_to);
  return answeredThreads(db, refs);
}

/** The references of these messages that are yours: what deleting them, or their send failing, may un-answer. */
export function referencesOfOwn(db: Db, messageIds: readonly number[]): string[] {
  if (messageIds.length === 0) return [];
  const own = ownAddresses(db);
  const refs = new Set<string>();
  for (const m of db.all<{ is_sent: number; from_email: string; references_json: string; in_reply_to: string | null }>(
    "SELECT is_sent, from_email, references_json, in_reply_to FROM messages WHERE id IN (SELECT value FROM json_each(?))",
    JSON.stringify(messageIds),
  )) {
    if (!m.is_sent && !own.has(addressKey(m.from_email))) continue;
    for (const r of JSON.parse(m.references_json) as string[]) refs.add(r);
    if (m.in_reply_to) refs.add(m.in_reply_to);
  }
  return [...refs];
}

function parseAddresses(json: string): string[] {
  try {
    const list = JSON.parse(json) as { email?: unknown }[];
    return Array.isArray(list) ? list.flatMap((a) => (typeof a?.email === "string" ? [a.email] : [])) : [];
  } catch {
    return [];
  }
}

export interface SliceResult {
  phase: FactsPhase["phase"];
  /** message ids (senders) or threads looked at */
  processed: number;
  /** more work is left */
  more: boolean;
  /** the kind of the next slice, when this one ended a phase of message ids (the runner sizes each kind apart) */
  next?: "senders" | "threads";
}

/**
 * One slice of the backfill (plan 17 §5), inside the caller's transaction:
 * at most `limit` message ids (senders) or threads, each thread a bounded
 * newest-first walk.
 */
export function backfillSlice(db: Db, limit: number): SliceResult {
  const n = Math.max(1, Math.floor(limit));
  const state = factsPhase(db);
  if (state.phase === "senders") {
    const max = db.get<{ m: number | null }>("SELECT max(id) AS m FROM messages")!.m ?? 0;
    const to = Math.min(max, state.after + n);
    for (const m of db.all<{ from_email: string; to_json: string; cc_json: string; bcc_json: string }>(
      "SELECT from_email, to_json, cc_json, bcc_json FROM messages WHERE id > ? AND id <= ? AND is_sent = 1 AND is_draft = 0",
      state.after,
      to,
    )) {
      const key = addressKey(m.from_email);
      if (key.includes("@")) db.run("INSERT INTO correspondents (email, own) VALUES (?, 1) ON CONFLICT (email) DO UPDATE SET own = 1 WHERE own = 0", key);
      for (const json of [m.to_json, m.cc_json, m.bcc_json]) {
        for (const a of parseAddresses(json)) {
          const k = addressKey(a);
          if (k.includes("@")) db.run("INSERT INTO correspondents (email, written) VALUES (?, 1) ON CONFLICT (email) DO UPDATE SET written = 1 WHERE written = 0", k);
        }
      }
    }
    // the threads computed meanwhile were written NULL: the queue holds them, and a rescan isn't needed for them
    setPhase(db, to >= max ? { phase: "threads" } : { ...state, after: to });
    return { phase: "senders", processed: Math.max(1, to - state.after), more: true, next: to >= max ? "threads" : "senders" };
  }
  if (senderJobs(db).length) return { phase: state.phase, processed: senderSlice(db, n), more: true };
  const pending = db.all<{ id: number }>("SELECT id FROM threads INDEXED BY threads_facts_pending WHERE person IS NULL ORDER BY last_date DESC, id DESC LIMIT ?", n).map((r) => r.id);
  if (pending.length) {
    const ctx = factContext(db, ownAddresses(db));
    for (const id of pending) writeFacts(db, id, factsOf(db, id, ctx));
    return { phase: state.phase, processed: pending.length, more: true };
  }
  if (state.phase === "threads") {
    setPhase(db, state.rescan ? { phase: "rescan", after: 0 } : { phase: "done" });
    return { phase: state.phase, processed: 0, more: !!state.rescan };
  }
  if (state.phase === "rescan") {
    const ids = db.all<{ id: number }>("SELECT id FROM threads WHERE id > ? ORDER BY id LIMIT ?", state.after, n).map((r) => r.id);
    const ctx = factContext(db, ownAddresses(db));
    for (const id of ids) writeFacts(db, id, factsOf(db, id, ctx));
    const done = ids.length < n;
    setPhase(db, done ? { phase: "done" } : { phase: "rescan", after: ids[ids.length - 1]! });
    return { phase: "rescan", processed: Math.max(1, ids.length), more: !done };
  }
  return { phase: "done", processed: 0, more: false };
}

/** Nothing to do: the phase is done and the queue is empty (two index probes). */
export function factsIdle(db: Db): boolean {
  return factsReady(db);
}

/** Test-only: the state right after v14 (no facts, no correspondents, the backfill from its start). */
export function resetFacts(db: Db): void {
  db.tx(() => {
    db.run("INSERT OR IGNORE INTO search_dirty (kind, id) SELECT 1, id FROM threads WHERE person IS NOT NULL OR waiting_since IS NOT NULL");
    db.run("UPDATE threads SET person = NULL, waiting_since = NULL");
    db.run("DELETE FROM correspondents");
    setSenderJobs(db, []);
    setPhase(db, db.get("SELECT 1 FROM threads LIMIT 1") ? { phase: "senders", after: 0 } : { phase: "done" });
  });
}

/**
 * Plan 41: newly inserted messages as they are now, for the notification rule. By primary
 * key and one correspondent per sender: what it costs follows the ids, never the mailbox.
 */
export function arrivalRows(db: Db, ids: readonly number[]): ArrivalRow[] {
  if (ids.length === 0) return [];
  const rows = db.all<{ id: number; thread_id: number; account_id: number; date: number; from_name: string; from_email: string; subject: string; snippet: string; is_read: number; is_sent: number; is_draft: number; in_inbox: number; thread_inbox: number; thread_sent: number; body_state: string; attachments_captured: number; is_trash: number; is_spam: number; list_id: string | null; is_bulk: number; gmail_labels: string | null }>(
    `SELECT m.id, m.thread_id, m.account_id, m.date, m.from_name, m.from_email, m.subject, m.snippet, m.is_read, m.is_sent, m.is_draft, m.in_inbox,
       t.in_inbox AS thread_inbox, t.has_sent AS thread_sent, m.body_state, m.attachments_captured, m.is_trash, m.is_spam, m.list_id, m.is_bulk, m.gmail_labels
     FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(ids),
  );
  if (rows.length === 0) return [];
  const own = ownAddresses(db);
  const written = new Map<string, boolean>();
  const writtenTo = (key: string) => {
    let w = written.get(key);
    if (w === undefined) written.set(key, (w = db.get<{ written: number }>("SELECT written FROM correspondents WHERE email = ?", key)?.written === 1));
    return w;
  };
  return rows.map((r) => {
    const key = addressKey(r.from_email);
    return {
      id: r.id,
      threadId: r.thread_id,
      accountId: r.account_id,
      date: r.date,
      fromName: r.from_name,
      fromEmail: r.from_email,
      subject: r.subject,
      snippet: r.snippet,
      isRead: r.is_read === 1,
      isSent: r.is_sent === 1,
      isDraft: r.is_draft === 1,
      inInbox: r.in_inbox === 1 && r.thread_inbox === 1,
      isTrash: r.is_trash === 1,
      isSpam: r.is_spam === 1,
      listId: r.list_id,
      isBulk: r.is_bulk === 1,
      gmailLabels: r.gmail_labels,
      own: own.has(key),
      written: writtenTo(key),
      yourConversation: r.thread_sent === 1,
      // what IMAP's body capture still wants (a body too big to capture never comes: not pending)
      bodyPending: r.body_state !== "full" && r.attachments_captured !== 2,
    };
  });
}
