import { addressKey, automatedLevel, FACTS_WINDOW, newestMessages, threadFacts, type Address, type ArrivalRow, type FactContext, type FactRow, type ThreadFacts } from "@terno/core";
import type { MemDb, Row, Table } from "./mem";

/**
 * Plan 17's thread facts on IndexedDB, mirroring packages/db's facts.ts on
 * the in-memory rows (same columns, same phases, same rules): `person` and
 * `waiting_since` on threads (absent or null: not computed yet), the
 * addresses you send from and write to in `correspondents`, and the backfill.
 * Rows are in memory, so a thread's facts are one linear pass over its
 * messages (no walk needed); the search outbox sees every thread row a
 * command writes, so nothing is marked by hand.
 */

type R = Row & Record<string, any>;

export type FactsPhase = { phase: "senders"; after: number } | { phase: "threads"; rescan?: boolean } | { phase: "rescan"; after: number } | { phase: "done" };

const KEY = "facts_backfill";
/** A requeue this small is recomputed in the same unit; a larger one goes to the backfill (SQLite's INLINE_REQUEUE). */
export const INLINE_REQUEUE = 200;

const t = (db: MemDb, name: string): Table<R> => db.table<R>(name);

export const pendingRow = (row: Record<string, unknown> | null | undefined): boolean => !!row && row.person == null;

/**
 * The threads whose facts aren't computed (the queue), kept from row
 * changes like ScopeIndex: built on first use (thread rows load before the
 * store exists), then followed. Walked newest first from a list made once;
 * when the list runs out and threads are still pending, it is made again.
 */
export class FactsQueue {
  private pending: Set<number> | null = null;
  /** where the walk of the recency order stopped (the first backfill) */
  private cursor: { lastDate: number; id: number } | null = null;
  /** where the walk by id stopped, when the recency order isn't built yet (it would take a sort of every thread) */
  private idCursor: number | null = null;
  /** a conversation too long for one slice, read a chunk of messages a slice (memory only: a restart reads it again) */
  big: { thread: number; keys: IterableIterator<unknown>; rows: FactRow[]; changed: boolean } | null = null;

  constructor(private readonly db: MemDb) {
    db.onRow((table, row, prev) => {
      if (table === "messages") {
        // a message of the long conversation being read came, went or changed: read it again
        if (this.big && (row?.thread_id === this.big.thread || prev?.thread_id === this.big.thread)) this.big.changed = true;
        return;
      }
      if (table !== "threads" || !this.pending) return;
      const id = (row ?? prev)!.id as number;
      if (pendingRow(row)) this.pending.add(id);
      else this.pending.delete(id);
    });
  }

  /** is this thread pending (its facts not computed)? */
  has(id: number): boolean {
    return this.set().has(id);
  }

  private set(): Set<number> {
    if (!this.pending) {
      this.pending = new Set();
      for (const r of t(this.db, "threads").all()) if (pendingRow(r)) this.pending.add(r.id as number);
    }
    return this.pending;
  }

  get size(): number {
    return this.set().size;
  }

  /**
   * Up to `n` pending threads, newest first. Few pending (a requeue): sorted
   * on the spot. Many (the first backfill): the store's recency order walked
   * from where the last slice stopped (a keyset cursor), a bounded number of
   * steps a slice; sorting 145,000 ids by date in one slice would stall.
   */
  next(n: number, recency: RecencyOrder): number[] {
    const pending = this.set();
    if (pending.size === 0) return [];
    const threads = t(this.db, "threads");
    if (pending.size <= SORT_UNDER) return [...pending].sort((a, b) => threads.get(b)!.last_date - threads.get(a)!.last_date || b - a).slice(0, n);
    const out: number[] = [];
    if (!recency.ready) {
      // the recency order isn't built (nothing has listed yet): newest ids first, which is about newest mail
      // first, never a sort of every thread (Codex review 2, #1)
      let id = this.idCursor ?? threads.highestKey();
      for (let steps = 0; id > 0 && out.length < n && steps < n * 64; id--, steps++) if (pending.has(id)) out.push(id);
      this.idCursor = id > 0 ? id : null;
      return out;
    }
    const ids = recency.current(threads);
    let i = this.cursor ? recency.after(threads, this.cursor) : 0;
    for (let steps = 0; i < ids.length && out.length < n && steps < n * 64; i++, steps++) if (pending.has(ids[i]!)) out.push(ids[i]!);
    const last = i < ids.length && i > 0 ? threads.get(ids[i - 1]!) : undefined;
    // past the end: from the top again (threads that came in above the cursor)
    this.cursor = last ? { lastDate: last.last_date as number, id: last.id as number } : null;
    return out;
  }
}

/** More messages than this and a conversation is read in chunks of this many, a chunk a slice (Codex review 2, #3). */
export const BIG_THREAD = 4096;

/**
 * A thread's facts, or, for a conversation too long to read in one slice,
 * back to the queue: the backfill reads it in chunks (requeues, sender
 * jobs and rescans never read one whole).
 */
function computeOrDefer(db: MemDb, id: number, ctx: FactContext): void {
  writeFacts(db, id, t(db, "messages").count("fk_thread_id", id) > BIG_THREAD ? null : factsOf(db, id, ctx));
}

/**
 * One chunk of the long conversation being read: its messages' newest
 * FACTS_WINDOW kept so far; at the end, the facts from them (the newest
 * window of the thread: what threadFacts reads). A change to the thread
 * meanwhile reads it again; a thread no longer pending (ingest computed it)
 * is let go. Returns the messages read.
 */
function bigSlice(db: MemDb, queue: FactsQueue, ctx: FactContext): number {
  const big = queue.big!;
  if (!queue.has(big.thread)) {
    queue.big = null;
    return 1;
  }
  if (big.changed) queue.big = { thread: big.thread, keys: t(db, "messages").keysBy("fk_thread_id", big.thread), rows: [], changed: false };
  const scan = queue.big!;
  const messages = t(db, "messages");
  const chunk: FactRow[] = [];
  let done = false;
  while (chunk.length < BIG_THREAD) {
    const k = scan.keys.next();
    if (k.done) {
      done = true;
      break;
    }
    const m = messages.get(k.value);
    if (m) chunk.push(m as unknown as FactRow);
  }
  scan.rows = newestMessages([...scan.rows, ...chunk], FACTS_WINDOW);
  if (done) {
    writeFacts(db, scan.thread, threadFacts(scan.rows, ctx));
    queue.big = null;
  }
  return Math.max(1, chunk.length);
}

/** Under this many pending threads the queue sorts them; above, it walks the recency order. */
const SORT_UNDER = 4096;

/** The store's recency order of every thread (mail.ts's ThreadOrder), kept current from row changes. */
export interface RecencyOrder {
  /** built and current enough that walking it needs no sort */
  readonly ready: boolean;
  current(threads: Table<R>): readonly number[];
  after(threads: Table<R>, cursor: { lastDate: number; id: number }): number;
}

/** The backfill's progress; absent (a database that never needed one) is done. */
export function factsPhase(db: MemDb): FactsPhase {
  const r = t(db, "settings").get(KEY);
  return r ? (JSON.parse(r.value_json) as FactsPhase) : { phase: "done" };
}

function setPhase(db: MemDb, p: FactsPhase): void {
  t(db, "settings").put({ key: KEY, value_json: JSON.stringify(p) });
}

export function factsReady(db: MemDb, queue: FactsQueue): boolean {
  return factsPhase(db).phase === "done" && queue.size === 0 && senderJobs(db).length === 0;
}

/** Your addresses: every account's, and every address your sent mail came from. */
export function ownAddresses(db: MemDb): Set<string> {
  const own = new Set<string>();
  for (const a of t(db, "accounts").all()) own.add(addressKey(a.email));
  for (const c of t(db, "correspondents").by("own", 1)) own.add(c.email);
  return own;
}

function failedSend(db: MemDb, messageId: number): boolean {
  for (const op of t(db, "ops").by("state", "failed")) {
    if (op.kind === "send" && (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.[0] === messageId) return true;
  }
  return false;
}

export function factContext(db: MemDb, own: ReadonlySet<string>): FactContext {
  const correspondents = t(db, "correspondents");
  const messages = t(db, "messages");
  return {
    own: (key) => own.has(key),
    written: (key) => correspondents.get(key)?.written === 1,
    failedSend: (id) => failedSend(db, id),
    answered: (rfcMessageId) => {
      for (const a of t(db, "accounts").all()) {
        for (const ref of t(db, "message_refs").by("ref", a.id, rfcMessageId)) {
          const m = messages.get(ref.message_id);
          if (!m || m.is_draft || !(m.is_sent || own.has(addressKey(m.from_email)))) continue;
          if (String(m.provider_msg_id ?? "").startsWith("local:") && failedSend(db, m.id)) continue;
          return true;
        }
      }
      return false;
    },
  };
}

/** The context for a recompute: null while the backfill still collects your addresses. */
export function recomputeContext(db: MemDb): FactContext | null {
  return factsPhase(db).phase === "senders" ? null : factContext(db, ownAddresses(db));
}

export function factsOf(db: MemDb, threadId: number, ctx: FactContext): ThreadFacts {
  return threadFacts(t(db, "messages").by("fk_thread_id", threadId) as unknown as FactRow[], ctx);
}

function writeFacts(db: MemDb, threadId: number, f: ThreadFacts | null): void {
  const threads = t(db, "threads");
  const row = threads.get(threadId);
  if (!row) return;
  const person = f?.person ?? null;
  const waiting = f?.waitingSince ?? null;
  if ((row.person ?? null) === person && (row.waiting_since ?? null) === waiting) return;
  threads.update(row, { person, waiting_since: waiting });
}

/**
 * The +tagged senders by the address they reduce to, for the senders the
 * `from` index holds: built once (a walk of its values), then followed from
 * row changes, so a requeue never walks every sender (SQLite seeks a range).
 * A sender whose mail went stays listed: its count is simply 0.
 */
const tagged = new WeakMap<MemDb, Map<string, Set<string>>>();

function taggedOf(db: MemDb): Map<string, Set<string>> {
  let map = tagged.get(db);
  if (!map) {
    const m = new Map<string, Set<string>>();
    const add = (from: unknown) => {
      if (typeof from !== "string" || !from.includes("+")) return;
      const key = addressKey(from);
      if (key === from) return;
      let set = m.get(key);
      if (!set) m.set(key, (set = new Set()));
      set.add(from);
    };
    for (const v of t(db, "messages").indexValues("from")) add(v);
    db.onRow((table, row) => {
      if (table === "messages" && row) add(row.from_email);
    });
    tagged.set(db, (map = m));
  }
  return map;
}

/** An address and its +tagged forms. */
function sendersLike(db: MemDb, key: string): string[] {
  return [key, ...(taggedOf(db).get(key) ?? [])];
}

/**
 * A sender's threads to recompute, persisted (SQLite's SenderJob): its
 * addresses in turn, and a count of its slices (`seq`), committed with each.
 * Within one, a live walk of the `from` index's keys (memory only, Codex
 * review 2, #2): each slice reads the next `n`, never the sender's whole
 * history. The walk is trusted only while it was made for the committed
 * count and the same key set (Codex reviews 3–5): after a rolled-back slice
 * (replays included), a key set the index let go (all the address's mail
 * went, even in a reverted command) or a restart, the address is walked
 * again from its start in the same bounded slices (recomputing is
 * idempotent; an update moving a key to the set's end is visited again).
 */
interface SenderJob {
  email: string;
  senders: string[];
  i: number;
  /** advanced by every slice, never reset: a walk made for another value is one a rollback undid (Codex review 5) */
  seq: number;
}

const walks = new WeakMap<MemDb, Map<string, { set: ReadonlySet<unknown> | undefined; keys: IterableIterator<unknown>; seq: number }>>();

const SENDERS_KEY = "facts_senders";

function senderJobs(db: MemDb): SenderJob[] {
  const r = t(db, "settings").get(SENDERS_KEY);
  return r ? (JSON.parse(r.value_json) as SenderJob[]) : [];
}

function setSenderJobs(db: MemDb, jobs: SenderJob[]): void {
  if (jobs.length) t(db, "settings").put({ key: SENDERS_KEY, value_json: JSON.stringify(jobs) });
  else t(db, "settings").delete(SENDERS_KEY);
}

/**
 * What you know about an address changed (you wrote to it): few threads are
 * recomputed now; more go to a job the backfill runs in slices (Codex
 * review 1, #2). Their facts stay as they were meanwhile.
 */
export function requeueSender(db: MemDb, key: string): void {
  if (factsPhase(db).phase === "senders") return;
  const messages = t(db, "messages");
  const senders = sendersLike(db, key);
  let rows = 0;
  for (const s of senders) rows += messages.count("from", s);
  if (rows === 0) return;
  if (rows <= INLINE_REQUEUE) {
    const ctx = factContext(db, ownAddresses(db));
    for (const id of new Set(senders.flatMap((s) => messages.by("from", s).map((m) => m.thread_id as number)))) computeOrDefer(db, id, ctx);
    return;
  }
  setSenderJobs(db, [...senderJobs(db).filter((j) => j.email !== key), { email: key, senders, i: 0, seq: 0 }]);
  walks.get(db)?.delete(key);
}

/** One slice of the first sender job: the next `n` of its messages, their threads recomputed. */
function senderSlice(db: MemDb, n: number): number {
  const jobs = senderJobs(db);
  const job = jobs[0]!;
  const messages = t(db, "messages");
  let mine = walks.get(db);
  if (!mine) walks.set(db, (mine = new Map()));
  const sender = job.senders[job.i]!;
  const set = messages.bucket("from", sender);
  let walk = mine.get(job.email);
  if (!walk || walk.set !== set || walk.seq !== job.seq) {
    // the walk disagrees with what committed (a rollback, a key set the index let go, a restart): the address
    // again from its start, in the same bounded slices (Codex review 4: skipping to `pos` could skip a key an
    // update moved, and would be unbounded); recomputing what was done is idempotent
    mine.set(job.email, (walk = { set, keys: messages.keysBy("from", sender), seq: job.seq }));
  }
  const threads = new Set<number>();
  let read = 0;
  let done = false;
  while (read < n) {
    const k = walk.keys.next();
    if (k.done) {
      done = true;
      break;
    }
    read++;
    const m = messages.get(k.value);
    if (m) threads.add(m.thread_id as number);
  }
  walk.seq = job.seq + 1;
  const ctx = factContext(db, ownAddresses(db));
  for (const thread of threads) computeOrDefer(db, thread, ctx);
  if (done) {
    mine.delete(job.email);
    if (job.i + 1 < job.senders.length) jobs[0] = { ...job, i: job.i + 1, seq: walk.seq };
    else jobs.shift();
  } else jobs[0] = { ...job, seq: walk.seq };
  setSenderJobs(db, jobs);
  return Math.max(1, read);
}

export function startRescan(db: MemDb): void {
  const p = factsPhase(db);
  if (p.phase === "senders" || t(db, "threads").size === 0) return;
  if (p.phase === "threads") setPhase(db, { phase: "threads", rescan: true });
  else setPhase(db, { phase: "rescan", after: 0 });
}

function upsert(db: MemDb, email: string, column: "own" | "written"): boolean {
  const table = t(db, "correspondents");
  const row = table.get(email);
  if (row?.[column] === 1) return false;
  if (row) table.update(row, { [column]: 1 });
  else table.insert({ email, own: column === "own" ? 1 : 0, written: column === "written" ? 1 : 0 });
  return true;
}

/** A sent message of yours: its From is yours, its recipients are people you wrote to (SQLite's noteSentMail). */
export function noteSentMail(db: MemDb, from: string, recipients: readonly Address[]): void {
  const key = addressKey(from);
  if (key.includes("@") && upsert(db, key, "own")) {
    let account = false;
    for (const a of t(db, "accounts").all()) if (String(a.email).toLowerCase() === key) account = true;
    if (!account) startRescan(db);
  }
  for (const a of recipients) {
    const to = addressKey(a.email);
    // writing to it can change who it is (a role address, or one Gmail filed under Updates: Codex review 1, #5); a no-reply address stays one
    if (to.includes("@") && upsert(db, to, "written") && automatedLevel({ from_email: to, list_id: null, is_bulk: 0, gmail_labels: null, is_spam: 0 }) !== 2) requeueSender(db, to);
  }
}

/** Threads, in every account, holding a message these references name. */
export function answeredThreads(db: MemDb, refs: readonly string[]): number[] {
  const out = new Set<number>();
  const messages = t(db, "messages");
  for (const a of t(db, "accounts").all()) for (const ref of refs) for (const m of messages.by("rfc", a.id, ref)) out.add(m.thread_id as number);
  return [...out];
}

function parseAddresses(json: string): string[] {
  try {
    const list = JSON.parse(json) as { email?: unknown }[];
    return Array.isArray(list) ? list.flatMap((a) => (typeof a?.email === "string" ? [a.email] : [])) : [];
  } catch {
    return [];
  }
}

const refsOf = (m: R): string[] => [...(JSON.parse(m.references_json) as string[]), ...(m.in_reply_to ? [m.in_reply_to as string] : [])];

/** A stored message became sent, or a draft, or the reverse: SQLite's ownMailChanged. */
export function ownMailChanged(db: MemDb, messageId: number): number[] {
  const m = t(db, "messages").get(messageId);
  if (!m) return [];
  if (m.is_sent && !m.is_draft) noteSentMail(db, m.from_email, [m.to_json, m.cc_json, m.bcc_json].flatMap(parseAddresses).map((email) => ({ name: "", email })));
  return answeredThreads(db, refsOf(m));
}

/** The references of these messages that are yours. */
export function referencesOfOwn(db: MemDb, messageIds: readonly number[]): string[] {
  const own = ownAddresses(db);
  const messages = t(db, "messages");
  const refs = new Set<string>();
  for (const id of messageIds) {
    const m = messages.get(id);
    if (!m || (!m.is_sent && !own.has(addressKey(m.from_email)))) continue;
    for (const r of refsOf(m)) refs.add(r);
  }
  return [...refs];
}

export interface SliceResult {
  phase: FactsPhase["phase"];
  processed: number;
  more: boolean;
  next?: "senders" | "threads";
}

/** One slice of the backfill, inside the caller's transaction (SQLite's backfillSlice). */
export function backfillSlice(db: MemDb, queue: FactsQueue, recency: RecencyOrder, limit: number): SliceResult {
  const n = Math.max(1, Math.floor(limit));
  const state = factsPhase(db);
  if (state.phase === "senders") {
    const messages = t(db, "messages");
    const max = messages.highestKey();
    const to = Math.min(max, state.after + n);
    for (let id = state.after + 1; id <= to; id++) {
      const m = messages.get(id);
      if (!m || !m.is_sent || m.is_draft) continue;
      const key = addressKey(m.from_email);
      if (key.includes("@")) upsert(db, key, "own");
      for (const json of [m.to_json, m.cc_json, m.bcc_json]) {
        for (const a of parseAddresses(json)) {
          const k = addressKey(a);
          if (k.includes("@")) upsert(db, k, "written");
        }
      }
    }
    setPhase(db, to >= max ? { phase: "threads" } : { phase: "senders", after: to });
    return { phase: "senders", processed: Math.max(1, to - state.after), more: true, next: to >= max ? "threads" : "senders" };
  }
  if (senderJobs(db).length) return { phase: state.phase, processed: senderSlice(db, n), more: true };
  // a long conversation being read goes on first: a chunk of its messages is this slice
  if (queue.big) return { phase: state.phase, processed: Math.ceil(bigSlice(db, queue, factContext(db, ownAddresses(db))) / 16), more: true };
  const pending = queue.next(n, recency);
  if (pending.length) {
    const ctx = factContext(db, ownAddresses(db));
    const messages = t(db, "messages");
    for (const id of pending) {
      if (messages.count("fk_thread_id", id) > BIG_THREAD) {
        // too long for a slice: read in chunks from the next slice on; the rest of these wait for theirs
        queue.big = { thread: id, keys: messages.keysBy("fk_thread_id", id), rows: [], changed: false };
        break;
      }
      writeFacts(db, id, factsOf(db, id, ctx));
    }
    return { phase: state.phase, processed: pending.length, more: true };
  }
  // the walk's steps ran out on computed threads: the next slice goes on from there
  if (queue.size > 0) return { phase: state.phase, processed: n, more: true };
  if (state.phase === "threads") {
    setPhase(db, state.rescan ? { phase: "rescan", after: 0 } : { phase: "done" });
    return { phase: "threads", processed: 0, more: !!state.rescan };
  }
  if (state.phase === "rescan") {
    // ids ascending past the cursor: the threads' keys from their high-water mark down are dense enough to walk
    const threads = t(db, "threads");
    const ids: number[] = [];
    const top = threads.highestKey();
    let id = state.after;
    for (let steps = 0; ids.length < n && id < top && steps < n * 16; steps++) {
      id++;
      if (threads.has(id)) ids.push(id);
    }
    const ctx = factContext(db, ownAddresses(db));
    for (const x of ids) computeOrDefer(db, x, ctx);
    const done = id >= top;
    setPhase(db, done ? { phase: "done" } : { phase: "rescan", after: id });
    return { phase: "rescan", processed: Math.max(1, ids.length), more: !done };
  }
  return { phase: "done", processed: 0, more: false };
}

/** Test-only: the state right after the upgrade. */
export function resetFacts(db: MemDb): void {
  // a Map visits a replaced entry once and skips deleted ones: changing rows while walking is safe
  for (const r of t(db, "threads").all()) if (r.person != null || r.waiting_since != null) t(db, "threads").update(r, { person: null, waiting_since: null });
  for (const r of t(db, "correspondents").all()) t(db, "correspondents").delete(r.email);
  setSenderJobs(db, []);
  setPhase(db, t(db, "threads").size > 0 ? { phase: "senders", after: 0 } : { phase: "done" });
}

/** Plan 38: newly inserted messages as they are now (SQLite's arrivalRows): by key, one correspondent per sender. */
export function arrivalRows(db: MemDb, ids: readonly number[]): ArrivalRow[] {
  const messages = t(db, "messages");
  const threads = t(db, "threads");
  const correspondents = t(db, "correspondents");
  let own: Set<string> | null = null;
  const out: ArrivalRow[] = [];
  for (const id of ids) {
    const m = messages.get(id);
    const thread = m ? threads.get(m.thread_id) : undefined;
    if (!m || !thread) continue;
    own ??= ownAddresses(db);
    const key = addressKey(m.from_email);
    out.push({
      id: m.id,
      threadId: m.thread_id,
      accountId: m.account_id,
      date: m.date,
      fromName: m.from_name ?? "",
      fromEmail: m.from_email ?? "",
      subject: m.subject ?? "",
      snippet: m.snippet ?? "",
      isRead: m.is_read === 1,
      isSent: m.is_sent === 1,
      isDraft: m.is_draft === 1,
      inInbox: m.in_inbox === 1 && thread.in_inbox === 1,
      isTrash: m.is_trash === 1,
      isSpam: m.is_spam === 1,
      listId: m.list_id ?? null,
      isBulk: m.is_bulk === 1,
      gmailLabels: m.gmail_labels ?? null,
      own: own.has(key),
      written: correspondents.get(key)?.written === 1,
      yourConversation: thread.has_sent === 1,
    });
  }
  return out;
}
