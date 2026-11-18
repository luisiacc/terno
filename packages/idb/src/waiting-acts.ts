import { ANSWERED_KINDS, type DatedKind } from "@terno/core";
import { WAITING_CLOSED, waitingWords, type ClosedAt, type DatedSnapshot, type WaitingActRecord, type WaitingActState, type WaitingDone, type WaitingRowFacts, type WaitingSnapshot } from "@terno/store";
import { recomputeContext, refreshFacts, waitingFactsOf, writeFacts } from "./facts";
import { T, type Ctx, type R } from "./mail";

/** Plan 215 on IndexedDB (version 38), as SQL's (packages/db/src/waiting-acts.ts). */

const toRecord = (r: R): WaitingActRecord => ({ messageId: r.message_id, state: r.state, until: r.until ?? null, at: r.at, rev: r.rev, who: r.who ?? "", subject: r.subject ?? "", wrote: r.wrote === 1 });
const recordOf = (c: Ctx, messageId: number): WaitingActRecord | null => {
  const r = T(c, "waiting_acts").get(messageId);
  return r ? toRecord(r) : null;
};

function write(c: Ctx, r: WaitingActRecord): void {
  T(c, "waiting_acts").put({ message_id: r.messageId, state: r.state, until: r.until, at: r.at, rev: r.rev, who: r.who, subject: r.subject, wrote: r.wrote ? 1 : 0 });
}

const asked = (d: R): boolean => ANSWERED_KINDS.includes(d.kind as DatedKind);

/** As SQL's `applyItems`: the reader's open requests from the message follow the act, each snapshot kept for its Undo. */
function applyItems(c: Ctx, messageId: number, from: WaitingActRecord | null, to: WaitingActRecord, now: number): DatedSnapshot[] {
  const items = T(c, "dated_items");
  const changed: DatedSnapshot[] = [];
  for (const d of items.by("message", messageId)) {
    if (!asked(d) || d.state !== "open") continue;
    const until = (d.deferred_until ?? null) as number | null;
    if (to.state === "later" && !(until === null || until <= now || (from?.state === "later" && until === from.until))) continue;
    changed.push({ id: d.id, revision: d.revision, state: d.state, deferredUntil: until, closedReason: d.closed_reason ?? null, closedAt: d.closed_at ?? null });
    items.update(d, to.state === "done" ? { state: "dismissed", closed_reason: WAITING_CLOSED, closed_at: now, revision: d.revision + 1 } : { deferred_until: to.until, revision: d.revision + 1 });
  }
  return changed;
}

/** As SQL's `unapplyItems`: what the act changed back at its revision, what the reader stored since as the restored record would have. */
function unapplyItems(c: Ctx, s: WaitingSnapshot, current: WaitingActRecord): void {
  const items = T(c, "dated_items");
  for (const i of s.items) {
    const d = items.get(i.id);
    if (d && d.revision === i.revision + 1) items.update(d, { state: i.state, deferred_until: i.deferredUntil, closed_reason: i.closedReason, closed_at: i.closedAt, revision: i.revision });
  }
  const later = s.before?.state === "later" ? s.before.until : null;
  for (const d of items.by("message", s.messageId)) {
    if (!asked(d) || d.revision !== 0) continue;
    if (current.state === "done") {
      if (s.before?.state !== "done" && d.state === "dismissed" && d.closed_reason === WAITING_CLOSED) items.update(d, { state: "open", closed_reason: null, closed_at: null, deferred_until: later, revision: 1 });
    } else if (d.state === "open" && d.deferred_until === current.until) {
      items.update(d, s.before?.state === "done" ? { state: "dismissed", closed_reason: WAITING_CLOSED, closed_at: s.before.at, revision: 1 } : { deferred_until: later, revision: 1 });
    }
  }
}

export function actOnWaiting(c: Ctx, o: { threadId: number; since: number; message: number; rev: number; state: WaitingActState; until: number | null; now: number }): WaitingSnapshot | null {
  const ctx = recomputeContext(c.db);
  if (!ctx) return null;
  const f = waitingFactsOf(c.db, o.threadId, ctx);
  if (f.waitingMessageId !== o.message || f.waitingSince !== o.since) return null;
  const before = recordOf(c, f.waitingMessageId);
  if ((before?.rev ?? 0) !== o.rev) return null;
  const m = T(c, "messages").get(f.waitingMessageId)!;
  const t = T(c, "threads").get(o.threadId)!;
  const next: WaitingActRecord = { messageId: f.waitingMessageId, state: o.state, until: o.state === "later" ? o.until : null, at: o.now, rev: o.rev + 1, who: waitingWords(m.from_name || m.from_email), subject: waitingWords(t.subject), wrote: t.has_sent === 1 };
  write(c, next);
  const items = applyItems(c, next.messageId, before, next, o.now);
  // its newest message cleared is answered: the walk would say no more than that (one walk an act: Codex code review 1, #8)
  if (o.state === "done") writeFacts(c.db, o.threadId, { person: f.person, waitingSince: null });
  return { messageId: next.messageId, threadId: o.threadId, rev: next.rev, before, items };
}

export function restoreWaiting(c: Ctx, s: WaitingSnapshot): number | null {
  const current = recordOf(c, s.messageId);
  if (!current || current.rev !== s.rev) return null;
  if (s.before) write(c, s.before);
  else T(c, "waiting_acts").delete(s.messageId);
  unapplyItems(c, s, current);
  const thread = T(c, "messages").get(s.messageId)!.thread_id as number;
  refreshFacts(c.db, thread);
  return thread;
}

/** As SQL's: the waiting message is the newest received, shown one at the waiting date (a walk of the thread's keys, in memory). */
function waitingMessage(c: Ctx, threadId: number, since: number): number | null {
  const messages = T(c, "messages");
  let best: number | null = null;
  for (const key of messages.keysBy("fk_thread_id", threadId)) {
    const m = messages.get(key);
    if (m && m.date === since && !m.is_sent && !m.is_draft && !m.is_trash && !m.is_spam && (best === null || m.id > best)) best = m.id;
  }
  return best;
}

export function waitingRows(c: Ctx, threads: readonly { threadId: number; since: number }[], now: number, o: { messages: boolean }): Map<number, WaitingRowFacts> {
  const out = new Map<number, WaitingRowFacts>();
  const records = T(c, "waiting_acts");
  if (!threads.length) return out;
  if (!o.messages) {
    // the count: only a deferral still ahead changes a row; walked from the few deferrals, each to its message's thread
    const since = new Map(threads.map((t) => [t.threadId, t.since]));
    const messages = T(c, "messages");
    for (const r of records.by("later", "later")) {
      if (r.until <= now) continue;
      const m = messages.get(r.message_id);
      if (m && since.get(m.thread_id) === m.date && waitingMessage(c, m.thread_id, m.date) === m.id) out.set(m.thread_id, { message: null, rev: r.rev, until: r.until });
    }
    return out;
  }
  for (const t of threads) {
    const message = waitingMessage(c, t.threadId, t.since);
    if (message === null) continue;
    const r = records.size ? records.get(message) : undefined;
    out.set(t.threadId, { message, rev: r?.rev ?? 0, until: r?.state === "later" && r.until > now ? r.until : null });
  }
  return out;
}

export function waitingMoments(c: Ctx, now: number, limit: number): number[] {
  return T(c, "waiting_acts")
    .by("later", "later")
    .map((r) => r.until as number)
    .filter((at) => at > now)
    .sort((a, b) => a - b)
    .slice(0, limit);
}

export function waitingDonePage(c: Ctx, o: { since: number; after: ClosedAt | null; limit: number }): WaitingDone[] {
  const messages = T(c, "messages");
  return c.closedOrders.waiting.page(T(c, "waiting_acts"), o).flatMap((r) => {
    const m = messages.get(r.message_id);
    return m ? [{ messageId: r.message_id, threadId: m.thread_id, at: r.at, who: r.who ?? "", subject: r.subject ?? "", wrote: r.wrote === 1 }] : [];
  });
}
