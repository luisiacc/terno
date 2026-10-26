import { addressKey, threadFacts, weakAddress, type Address, type FactContext, type FactRow, type ThreadFacts } from "@terno/core";
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
  private order: number[] = [];
  private pos = 0;

  constructor(private readonly db: MemDb) {
    db.onRow((table, row, prev) => {
      if (table !== "threads" || !this.pending) return;
      const id = (row ?? prev)!.id as number;
      if (pendingRow(row)) this.pending.add(id);
      else this.pending.delete(id);
    });
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

  /** up to `n` pending threads, newest first */
  next(n: number): number[] {
    const pending = this.set();
    const threads = t(this.db, "threads");
    const out: number[] = [];
    for (let pass = 0; pass < 2 && out.length < n && pending.size > 0; pass++) {
      if (this.pos >= this.order.length) {
        this.order = [...pending].sort((a, b) => threads.get(b)!.last_date - threads.get(a)!.last_date || b - a);
        this.pos = 0;
      }
      while (this.pos < this.order.length && out.length < n) {
        const id = this.order[this.pos++]!;
        if (pending.has(id)) out.push(id);
      }
    }
    return out;
  }
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
  return factsPhase(db).phase === "done" && queue.size === 0;
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

/** Threads holding inbound mail from this address or its +tagged forms (the `from` index's values, walked for the prefix). */
function threadsFrom(db: MemDb, key: string): number[] {
  const messages = t(db, "messages");
  const out = new Set<number>();
  const at = key.lastIndexOf("@");
  const prefix = at > 0 ? `${key.slice(0, at)}+` : null;
  const domain = at > 0 ? key.slice(at) : "";
  const senders = [key];
  if (prefix) for (const v of messages.indexValues("from")) if (typeof v === "string" && v.startsWith(prefix) && v.endsWith(domain)) senders.push(v);
  for (const s of senders) for (const m of messages.by("from", s)) out.add(m.thread_id as number);
  return [...out];
}

export function requeueSender(db: MemDb, key: string): void {
  if (factsPhase(db).phase === "senders") return;
  const ids = threadsFrom(db, key);
  if (ids.length === 0) return;
  if (ids.length <= INLINE_REQUEUE) {
    const ctx = factContext(db, ownAddresses(db));
    for (const id of ids) writeFacts(db, id, factsOf(db, id, ctx));
    return;
  }
  for (const id of ids) writeFacts(db, id, null);
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
    if (to.includes("@") && upsert(db, to, "written") && weakAddress(to)) requeueSender(db, to);
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
}

/** One slice of the backfill, inside the caller's transaction (SQLite's backfillSlice). */
export function backfillSlice(db: MemDb, queue: FactsQueue, limit: number): SliceResult {
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
    return { phase: "senders", processed: Math.max(1, to - state.after), more: true };
  }
  const pending = queue.next(n);
  if (pending.length) {
    const ctx = factContext(db, ownAddresses(db));
    for (const id of pending) writeFacts(db, id, factsOf(db, id, ctx));
    return { phase: state.phase, processed: pending.length, more: true };
  }
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
    for (const x of ids) writeFacts(db, x, factsOf(db, x, ctx));
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
  setPhase(db, t(db, "threads").size > 0 ? { phase: "senders", after: 0 } : { phase: "done" });
}
