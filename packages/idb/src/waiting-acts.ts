import { ANSWERED_KINDS, waitingCutoff, type DatedKind, type WaitingDeferred } from "@terno/core";
import { WAITING_CLOSED, waitingWords, type ClosedAt, type WaitingActRecord, type WaitingActState, type WaitingDone, type WaitingSnapshot } from "@terno/store";
import { recomputeContext, refreshFacts, waitingFactsOf } from "./facts";
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

/** As SQL's `followItems`: the reader's requests from the message follow the record from `from` to `to`, only what it did. */
function followItems(c: Ctx, messageId: number, from: WaitingActRecord | null, to: WaitingActRecord | null, now: number): void {
  const items = T(c, "dated_items");
  for (const d of items.by("message", messageId)) {
    if (!ANSWERED_KINDS.includes(d.kind as DatedKind)) continue;
    if (to?.state === "done") {
      if (from?.state === "later" && d.state === "open" && d.deferred_until === from.until) items.update(d, { state: "dismissed", closed_reason: WAITING_CLOSED, closed_at: now, revision: d.revision + 1 });
    } else if (from?.state === "done") {
      if (d.state === "dismissed" && d.closed_reason === WAITING_CLOSED) items.update(d, { state: "open", closed_reason: null, closed_at: null, deferred_until: to?.until ?? d.deferred_until ?? null, revision: d.revision + 1 });
    } else if (from?.state === "later" && d.state === "open" && d.deferred_until === from.until) items.update(d, { deferred_until: to?.until ?? null });
  }
}

export function actOnWaiting(c: Ctx, o: { threadId: number; since: number; rev: number; state: WaitingActState; until: number | null; now: number }): WaitingSnapshot | null {
  const ctx = recomputeContext(c.db);
  if (!ctx) return null;
  const f = waitingFactsOf(c.db, o.threadId, ctx);
  if (f.waitingMessageId === null || f.waitingSince !== o.since) return null;
  const before = recordOf(c, f.waitingMessageId);
  if ((before?.rev ?? 0) !== o.rev) return null;
  const m = T(c, "messages").get(f.waitingMessageId)!;
  const t = T(c, "threads").get(o.threadId)!;
  const next: WaitingActRecord = { messageId: f.waitingMessageId, state: o.state, until: o.state === "later" ? o.until : null, at: o.now, rev: o.rev + 1, who: waitingWords(m.from_name || m.from_email), subject: waitingWords(t.subject), wrote: t.has_sent === 1 };
  write(c, next);
  followItems(c, next.messageId, before, next, o.now);
  if (o.state === "done") refreshFacts(c.db, o.threadId);
  return { messageId: next.messageId, threadId: o.threadId, rev: next.rev, before };
}

export function restoreWaiting(c: Ctx, s: WaitingSnapshot): number | null {
  const current = recordOf(c, s.messageId);
  if (!current || current.rev !== s.rev) return null;
  if (s.before) write(c, s.before);
  else T(c, "waiting_acts").delete(s.messageId);
  followItems(c, s.messageId, current, s.before, current.at);
  const thread = T(c, "messages").get(s.messageId)!.thread_id as number;
  refreshFacts(c.db, thread);
  return thread;
}

/** The records are the user's own acts, few: walked once, each to its message (never a thread's messages). */
export function waitingRevs(c: Ctx, threads: readonly { threadId: number; since: number }[]): Map<number, number> {
  const out = new Map<number, number>();
  const records = T(c, "waiting_acts");
  if (!threads.length || records.size === 0) return out;
  const since = new Map(threads.map((t) => [t.threadId, t.since]));
  const messages = T(c, "messages");
  for (const r of records.all()) {
    const m = messages.get(r.message_id);
    if (m && since.get(m.thread_id) === m.date) out.set(m.thread_id, r.rev);
  }
  return out;
}

export function waitingDeferred(c: Ctx, now: number, limit: number): WaitingDeferred[] {
  const messages = T(c, "messages");
  const threads = T(c, "threads");
  const cutoff = waitingCutoff(now);
  const out: { d: WaitingDeferred; messageId: number }[] = [];
  for (const r of T(c, "waiting_acts").by("later", "later")) {
    if (r.until <= now) continue;
    const m = messages.get(r.message_id);
    const t = m && threads.get(m.thread_id);
    if (!t || t.waiting_since !== m.date || t.waiting_since < cutoff || t.in_inbox !== 1 || t.in_spam || t.in_trash) continue;
    out.push({ d: { threadId: t.id, until: r.until, rev: r.rev, lastDate: t.last_date, hasSent: t.has_sent === 1, waitingSince: t.waiting_since }, messageId: r.message_id });
  }
  return out
    .sort((a, b) => a.d.until - b.d.until || a.messageId - b.messageId)
    .slice(0, limit)
    .map((o) => o.d);
}

export function waitingDonePage(c: Ctx, o: { since: number; after: ClosedAt | null; limit: number }): WaitingDone[] {
  const messages = T(c, "messages");
  return c.closedOrders.waiting.page(T(c, "waiting_acts"), o).flatMap((r) => {
    const m = messages.get(r.message_id);
    return m ? [{ messageId: r.message_id, threadId: m.thread_id, at: r.at, who: r.who ?? "", subject: r.subject ?? "", wrote: r.wrote === 1 }] : [];
  });
}

export function pruneWaiting(c: Ctx, now: number): number {
  const records = T(c, "waiting_acts");
  let n = 0;
  for (const r of records.by("later", "later")) {
    if (r.until > now) continue;
    records.deleteRow(r);
    n++;
  }
  return n;
}
