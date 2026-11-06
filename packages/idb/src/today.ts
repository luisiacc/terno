import { waitingCutoff, type DigestItem } from "@terno/core";
import { type DigestFact, type DigestStored } from "@terno/store";
import { inboxHiddenTest, T, type Ctx, type R } from "./mail";

/** Plan 145 on IndexedDB, like SQL's (packages/db/src/today.ts). */

export function waitingPage(c: Ctx, o: { now: number; after: { lastDate: number; id: number } | null; limit: number }): { id: number; lastDate: number }[] {
  const threads = T(c, "threads");
  const cutoff = waitingCutoff(o.now);
  const hidden = inboxHiddenTest(c);
  const out: { id: number; lastDate: number }[] = [];
  // the Waiting filter's own date order (revision 11)
  for (const id of c.filterOrders.waiting.current(threads)) {
    const t = threads.get(id)!;
    if (t.last_date < cutoff) break;
    if (t.waiting_since < cutoff || t.in_inbox !== 1 || hidden?.(id)) continue;
    if (o.after && (t.last_date > o.after.lastDate || (t.last_date === o.after.lastDate && id >= o.after.id))) continue;
    out.push({ id, lastDate: t.last_date });
    if (out.length >= o.limit) break;
  }
  return out;
}

export function waitingAmong(c: Ctx, threadIds: readonly number[], now: number): number[] {
  const threads = T(c, "threads");
  const cutoff = waitingCutoff(now);
  const hidden = inboxHiddenTest(c);
  return threadIds.filter((id) => {
    const t = threads.get(id);
    return !!t && t.waiting_since !== null && t.waiting_since !== undefined && t.last_date >= cutoff && t.waiting_since >= cutoff && t.in_inbox === 1 && !hidden?.(id);
  });
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
    facts.push({ threadId: t.id, messageId: id, arrivedAt: m.created_at, lastDate: t.last_date, messageCount: t.message_count, from: m.from_name || m.from_email, subject: m.subject, snippet: m.snippet });
  }
  return { facts, oldest };
}

export function digestLive(c: Ctx, threadIds: readonly number[]): number[] {
  const threads = T(c, "threads");
  return threadIds.filter((id) => {
    const t = threads.get(id);
    return !!t && t.in_inbox === 1 && t.unread_count > 0;
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

export const pendingDigestDays = (c: Ctx): string[] => [...T(c, "ai_digests").all()].filter((r) => r.state === "pending").map((r) => String(r.day)).sort();

export function pruneDigests(c: Ctx, keepFrom: string): void {
  const table = T(c, "ai_digests");
  for (const r of table.all()) if (r.day < keepFrom) table.delete(r.day);
}

export function clearDigests(c: Ctx): void {
  const table = T(c, "ai_digests");
  for (const r of table.all()) table.delete(r.day);
}
