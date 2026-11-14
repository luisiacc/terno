import { isAcknowledgment, looksLikeAcknowledgment, waitingCutoff, type DigestItem } from "@terno/core";
import { NEEDS_WALK, needsYou, summaryAsksNothing, type DigestFact, type DigestStored, type WaitingRow } from "@terno/store";
import { inboxHiddenTest, T, type Ctx, type R } from "./mail";

/** Plan 145 on IndexedDB, like SQL's (packages/db/src/today.ts). */

/**
 * What Needs you reads, in two steps (plan 204, the second panel round: plan 145's rule, tighter). The walk: the newest
 * waiting threads `needsYou` lets in, and the message whose text decides whether each that starts like an
 * acknowledgment only is one. The store reads those bodies ahead, then `needsRows` decides.
 */
export interface NeedsWalk {
  now: number;
  rows: WaitingRow[];
  /** thread → its last message from someone else, for those whose snippet starts like an acknowledgment */
  acks: Map<number, number>;
}

/** The newest waiting threads, in the Waiting filter's own date order (revision 11). */
export function needsWalk(c: Ctx, now: number): NeedsWalk {
  const threads = T(c, "threads");
  const correspondents = T(c, "correspondents");
  const cutoff = waitingCutoff(now);
  const hidden = inboxHiddenTest(c);
  const rows: WaitingRow[] = [];
  for (const id of c.filterOrders.waiting.current(threads)) {
    const t = threads.get(id)!;
    if (t.last_date < cutoff) break;
    if (t.waiting_since < cutoff || t.in_inbox !== 1 || hidden?.(id)) continue;
    rows.push({ id, lastDate: t.last_date, from: String(t.last_from_email), subject: String(t.subject), hasSent: t.has_sent === 1 });
    if (rows.length >= NEEDS_WALK) break;
  }
  const needs = needsYou(rows, (key) => correspondents.get(key) as { written: number; own: number } | undefined);
  const acks = new Map<number, number>();
  for (const r of needs) {
    if (!looksLikeAcknowledgment(threads.get(r.id)?.snippet as string | null | undefined)) continue;
    const last = shown(c, r.id).filter((m) => !m.is_sent).sort((a, b) => b.date - a.date || b.id - a.id)[0];
    if (last) acks.set(r.id, last.id as number);
  }
  return { now, rows: needs, acks };
}

/** What a walk lets in that's still waiting on the reader, its acknowledgments' bodies read ahead: never wider than `needsYou`. */
function needsRows(c: Ctx, walk: NeedsWalk): WaitingRow[] {
  return walk.rows.filter((r) => stillWaiting(c, r.id, walk.acks.get(r.id), walk.now));
}

const shown = (c: Ctx, threadId: number): R[] => T(c, "messages").by("fk_thread_id", threadId).filter((m) => !m.is_draft && !m.is_spam && !m.is_trash);

/** As SQL's (packages/db/src/today.ts): not handled, not an acknowledgment, and no current summary that gives the reader nothing to do. */
function stillWaiting(c: Ctx, threadId: number, ack: number | undefined, now: number): boolean {
  const items = T(c, "dated_items").by("fk_thread_id", threadId).filter((d) => d.state === "done" || d.state === "dismissed" || d.state === "settled" || (d.deferred_until ?? 0) > now);
  if (items.length) {
    const last = shown(c, threadId).filter((m) => !m.is_sent).sort((a, b) => b.date - a.date || b.id - a.id)[0];
    if (last && items.some((d) => d.message_id === last.id)) return false;
  }
  if (ack !== undefined) {
    const body = c.body(ack);
    if (isAcknowledgment(body?.body_text ?? body?.body_preview ?? null)) return false;
  }
  const summary = T(c, "ai_summaries").get(threadId) as { state: string; prompt_version: number | null; body_json: string | null; generated_at: number | null } | undefined;
  if (!summaryAsksNothing(summary)) return true;
  return shown(c, threadId).some((m) => m.created_at >= summary!.generated_at!);
}

export function waitingPage(c: Ctx, o: { after: { lastDate: number; id: number } | null; limit: number }, walk: NeedsWalk): { id: number; lastDate: number; hasSent: boolean }[] {
  const { after } = o;
  return needsRows(c, walk)
    .filter((r) => !after || r.lastDate < after.lastDate || (r.lastDate === after.lastDate && r.id < after.id))
    .slice(0, o.limit)
    .map((r) => ({ id: r.id, lastDate: r.lastDate, hasSent: r.hasSent }));
}

export function waitingAmong(c: Ctx, threadIds: readonly number[], walk: NeedsWalk): number[] {
  const wanted = new Set(threadIds);
  return needsRows(c, walk).filter((r) => wanted.has(r.id)).map((r) => r.id);
}

export function countWith(c: Ctx, threadIds: readonly number[], walk: NeedsWalk): { needs: number; extra: number } {
  const rows = needsRows(c, walk);
  const waiting = new Set(rows.map((r) => r.id));
  const threads = T(c, "threads");
  let extra = 0;
  for (const id of new Set(threadIds)) {
    const t = threads.get(id);
    if (t && !t.in_spam && !t.in_trash && !waiting.has(id)) extra++;
  }
  return { needs: rows.length, extra };
}

export function needsCount(c: Ctx, walk: NeedsWalk): number {
  return needsRows(c, walk).length;
}

export function digestFacts(c: Ctx, messageIds: readonly number[]): { facts: DigestFact[]; oldest: number | null } {
  const messages = T(c, "messages");
  const threads = T(c, "threads");
  let oldest: number | null = null;
  const facts: DigestFact[] = [];
  for (const id of [...messageIds].sort((a, b) => b - a)) {
    const m = messages.get(id);
    if (!m) continue;
    if (oldest === null || m.created_at < oldest) oldest = m.created_at;
    const t = threads.get(m.thread_id);
    if (!t || m.is_read || m.is_sent || m.is_draft || m.is_spam || m.is_trash) continue;
    if (m.list_id === null && !m.is_bulk) continue;
    if (m.date !== t.last_date || t.in_inbox !== 1 || t.tab === 2 || t.person !== 0 || t.is_starred || t.has_sent || t.in_spam || t.in_trash) continue;
    if (typeof m.gmail_labels === "string" && m.gmail_labels.includes("CATEGORY_UPDATES")) continue;
    facts.push({ threadId: t.id, messageId: id, arrivedAt: m.created_at, lastDate: t.last_date, messageCount: t.message_count, from: m.from_name || m.from_email, fromEmail: String(m.from_email ?? ""), subject: m.subject, snippet: m.snippet });
  }
  return { facts, oldest };
}

export const messagesHere = (c: Ctx, ids: readonly number[]): number[] => ids.filter((id) => !!T(c, "messages").get(id));

export function senders(c: Ctx, ids: readonly number[]): Map<number, string> {
  const messages = T(c, "messages");
  const out = new Map<number, string>();
  for (const id of ids) {
    const m = messages.get(id);
    if (m) out.set(id, String(m.from_email ?? ""));
  }
  return out;
}

export function digestLive(c: Ctx, threadIds: readonly number[]): number[] {
  const threads = T(c, "threads");
  return threadIds.filter((id) => {
    const t = threads.get(id);
    return !!t && t.in_inbox === 1 && t.unread_count > 0;
  });
}

export function digestRead(c: Ctx, threadIds: readonly number[]): number[] {
  const threads = T(c, "threads");
  return threadIds.filter((id) => {
    const t = threads.get(id);
    return !!t && t.in_inbox === 1 && t.unread_count === 0;
  });
}

const stored = (r: R): DigestStored => {
  const body = r.body_json ? (JSON.parse(r.body_json) as { items: DigestItem[]; pending: DigestItem[] }) : { items: [], pending: [] };
  return { day: r.day, state: r.state, items: body.items, pending: body.pending, attempts: r.attempts ?? 0, errorKind: r.error_kind ?? null, watermark: { at: r.watermark_at ?? 0, id: r.watermark_id ?? 0 }, model: r.model ?? null, provider: r.provider ?? null, promptVersion: r.prompt_version ?? null, generatedAt: r.generated_at ?? null };
};

export const getDigest = (c: Ctx, day: string): DigestStored | null => {
  const r = T(c, "ai_digests").get(day);
  return r ? stored(r) : null;
};

export function latestDigest(c: Ctx, day: string): DigestStored | null {
  let best: R | null = null;
  for (const r of T(c, "ai_digests").all()) if (r.day <= day && (!best || r.day > best.day)) best = r;
  return best ? stored(best) : null;
}

export function beginDigest(c: Ctx, day: string, watermark: { at: number; id: number }, pending: readonly DigestItem[]): boolean {
  const table = T(c, "ai_digests");
  if (table.get(day)) return false;
  table.insert({ day, state: "pending", body_json: JSON.stringify({ items: [], pending }), attempts: 0, error_kind: null, watermark_at: watermark.at, watermark_id: watermark.id, model: null, provider: null, prompt_version: null, generated_at: null });
  return true;
}

export function writeDigest(c: Ctx, w: DigestStored): void {
  const table = T(c, "ai_digests");
  const r = table.get(w.day);
  if (r) table.update(r, { state: w.state, body_json: JSON.stringify({ items: w.items, pending: w.pending }), attempts: w.attempts, error_kind: w.errorKind, model: w.model, provider: w.provider, prompt_version: w.promptVersion, generated_at: w.generatedAt });
}

export const allDigests = (c: Ctx): DigestStored[] => [...T(c, "ai_digests").all()].map(stored).sort((a, b) => a.day.localeCompare(b.day));
export const pendingDigestDays = (c: Ctx): string[] => [...T(c, "ai_digests").all()].filter((r) => r.state === "pending").map((r) => String(r.day)).sort();

export function pruneDigests(c: Ctx, keepFrom: string): void {
  const table = T(c, "ai_digests");
  for (const r of table.all()) if (r.day < keepFrom) table.delete(r.day);
}

export function clearDigests(c: Ctx): void {
  const table = T(c, "ai_digests");
  for (const r of table.all()) table.delete(r.day);
}
