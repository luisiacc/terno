import { addressKey, isAcknowledgment, looksLikeAcknowledgment, parseRef, refKey, saysNoReplyNeeded, waitingCutoff, type DatedRow, type DigestItem, type FollowupRow, type ItemRef } from "@terno/core";
import { DATED_NOTHING_ASKED_SINCE, NEEDS_WALK, needsYou, summaryAsksNothing, type DigestFact, type DigestStored, type ItemChanges, type ItemSnapshots, type WaitingRow } from "@terno/store";
import { datedRow, mutedSenders, restoreDated, updateDated } from "./dated";
import { followupRow, restoreFollowups, updateFollowup } from "./followups";
import { inboxHiddenTest, T, type Ctx, type R } from "./mail";
import { ownAddresses } from "./facts";
import { shownKeys } from "./shown-senders";

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
  /** plan 240: the threads of senders always shown, which only what was handled takes out */
  always: Set<number>;
}

/** The newest waiting threads, in the Waiting filter's own date order (revision 11). */
export function needsWalk(c: Ctx, now: number): NeedsWalk {
  const threads = T(c, "threads");
  const correspondents = T(c, "correspondents");
  const cutoff = waitingCutoff(now);
  const hidden = inboxHiddenTest(c);
  // plan 240: a sender said to be always shown outranks the Inbox's hiding, as SQL's
  const always = shownKeys(c);
  const isShown = (from: unknown) => always.size > 0 && always.has(addressKey(String(from)));
  // as SQL's (Codex code review): who it waits on is the waiting message's sender, the thread's last being yours when a
  // synced draft is newest (asked only then, and only with a sender shown)
  const own = always.size ? ownAddresses(c.db) : null;
  const waitingFrom = (id: number, t: R): string => {
    if (!own?.has(addressKey(String(t.last_from_email)))) return String(t.last_from_email);
    const m = T(c, "messages").by("fk_thread_id", id).filter((x) => x.date === t.waiting_since && !x.is_draft && !x.is_sent).sort((a, b) => b.id - a.id)[0];
    return String(m?.from_email ?? t.last_from_email);
  };
  const rows: WaitingRow[] = [];
  for (const id of c.filterOrders.waiting.current(threads)) {
    const t = threads.get(id)!;
    if (t.last_date < cutoff) break;
    if (t.waiting_since < cutoff || t.in_inbox !== 1) continue;
    const from = waitingFrom(id, t);
    if (hidden?.(id) && !isShown(from)) continue;
    rows.push({ id, lastDate: t.last_date, waitingSince: t.waiting_since, from, subject: String(t.subject), hasSent: t.has_sent === 1 });
    if (rows.length >= NEEDS_WALK) break;
  }
  // plan 210 (iteration 4): as SQL's, a muted sender's conversations aren't waiting on you, nothing recorded for them; left
  // out here, before any acknowledgment's body is read ahead for them (Codex's code review)
  const muted = mutedSenders(c);
  const needs = needsYou(rows, (key) => correspondents.get(key) as { written: number; own: number } | undefined, (key) => always.has(key)).filter((r) => !(muted.size && muted.has(addressKey(r.from))));
  const acks = new Map<number, number>();
  for (const r of needs) {
    // plan 240 (Codex review 12): a shown sender's isn't judged an acknowledgment, so its body isn't read ahead
    if (isShown(r.from) || !looksLikeAcknowledgment(threads.get(r.id)?.snippet as string | null | undefined)) continue;
    const last = shown(c, r.id).filter((m) => !m.is_sent).sort((a, b) => b.date - a.date || b.id - a.id)[0];
    if (last) acks.set(r.id, last.id as number);
  }
  return { now, rows: needs, acks, always: new Set(needs.filter((r) => isShown(r.from)).map((r) => r.id)) };
}

/** What a walk lets in that's still waiting on the reader, its acknowledgments' bodies read ahead: never wider than `needsYou`. */
function needsRows(c: Ctx, walk: NeedsWalk): WaitingRow[] {
  return walk.rows.filter((r) => stillWaiting(c, r.id, walk.acks.get(r.id), walk.now, walk.always.has(r.id)));
}

const shown = (c: Ctx, threadId: number): R[] => T(c, "messages").by("fk_thread_id", threadId).filter((m) => !m.is_draft && !m.is_spam && !m.is_trash);

/** As SQL's (packages/db/src/today.ts): not read with nothing asked, not handled, not an acknowledgment, and no current summary that gives the reader nothing to do. */
function stillWaiting(c: Ctx, threadId: number, ack: number | undefined, now: number, always = false): boolean {
  // the fourth panel read: they said no answer is needed ("No action needed!"), in its first words; plan 240: not for a
  // sender always shown, as SQL's (only what was handled counts)
  if (!always && saysNoReplyNeeded(T(c, "threads").get(threadId)?.snippet as string | null | undefined)) return false;
  // their latest message, found once and only when a rule below needs it
  let latest: R | null | undefined;
  const last = () => (latest !== undefined ? latest : (latest = shown(c, threadId).filter((m) => !m.is_sent).sort((a, b) => b.date - a.date || b.id - a.id)[0] ?? null));
  // plan 210 (iteration 2, the owner: "only when something is asked"): the dated reader read it with nothing asked of the
  // reader, as SQL's
  const read = always ? [] : T(c, "dated_nothing_asked").by("thread", threadId).filter((r) => r.prompt_version >= DATED_NOTHING_ASKED_SINCE);
  if (read.length && read.some((r) => r.message_id === last()?.id)) return false;
  const items = T(c, "dated_items").by("fk_thread_id", threadId).filter((d) => d.state === "done" || d.state === "dismissed" || d.state === "settled" || (d.deferred_until ?? 0) > now);
  if (items.length && items.some((d) => d.message_id === last()?.id)) return false;
  // Codex code review (round 4): a promise of yours there closed since their latest message, with none still open, is the
  // row you handled
  const promises = T(c, "followups").by("fk_thread_id", threadId).filter((f) => f.kind === "promise");
  const open = promises.filter((f) => f.state === "open" || f.state === "due");
  // plan 204 (the fifth panel round): its only open promises put off with Later, it waits for them (Undo brings it back)
  if (open.length && open.every((f) => (f.deferred_until ?? 0) > now)) return false;
  const kept = promises.filter((f) => (f.state === "done" || f.state === "dismissed") && f.closed_at != null);
  if (kept.length && !open.length) {
    const m = last();
    if (m && kept.some((f) => (f.closed_at as number) >= m.date)) return false;
  }
  if (ack !== undefined) {
    const body = c.body(ack);
    if (isAcknowledgment(body?.body_text ?? body?.body_preview ?? null)) return false;
  }
  if (always) return true;
  const summary = T(c, "ai_summaries").get(threadId) as { state: string; prompt_version: number | null; body_json: string | null; generated_at: number | null } | undefined;
  if (!summaryAsksNothing(summary)) return true;
  return shown(c, threadId).some((m) => m.created_at >= summary!.generated_at!);
}

export function waitingPage(c: Ctx, o: { after: { lastDate: number; id: number } | null; limit: number }, walk: NeedsWalk): { id: number; lastDate: number; hasSent: boolean; waitingSince: number }[] {
  const { after } = o;
  return needsRows(c, walk)
    .filter((r) => !after || r.lastDate < after.lastDate || (r.lastDate === after.lastDate && r.id < after.id))
    .slice(0, o.limit)
    .map((r) => ({ id: r.id, lastDate: r.lastDate, hasSent: r.hasSent, waitingSince: r.waitingSince }));
}

export function waitingAmong(c: Ctx, threadIds: readonly number[], walk: NeedsWalk): number[] {
  const wanted = new Set(threadIds);
  return needsRows(c, walk).filter((r) => wanted.has(r.id)).map((r) => r.id);
}

/** Plan 210 (iteration 2): as SQL's (packages/db/src/today.ts): those still here and in neither Spam nor Trash. */
export function liveAmong(c: Ctx, threadIds: readonly number[]): Set<number> {
  const threads = T(c, "threads");
  const out = new Set<number>();
  for (const id of threadIds) {
    const t = threads.get(id);
    if (t && !t.in_spam && !t.in_trash) out.add(id);
  }
  return out;
}

const TABLE = { dated: "dated_items", promise: "followups" } as const;
const isOpen = (source: ItemRef["source"], r: R): boolean => (source === "dated" ? r.state === "open" : r.kind === "promise" && (r.state === "open" || r.state === "due"));

/** Plan 210 (iteration 2): the dated items and promises of these canonical items, any state: by id, and by `same`. */
export function itemMembers(c: Ctx, keys: readonly string[]): { dated: DatedRow[]; promises: FollowupRow[] } {
  // as SQL's: the rows as found, each once, never looked up again
  const found = { dated: new Map<number, R>(), promise: new Map<number, R>() };
  const dated = T(c, "dated_items");
  const followups = T(c, "followups");
  for (const key of new Set(keys)) {
    const ref = parseRef(key);
    if (!ref) continue;
    const own = ref.source === "dated" ? dated.get(ref.id) : followups.get(ref.id);
    if (own && (ref.source === "dated" || own.kind === "promise")) found[ref.source].set(own.id, own);
    for (const r of dated.by("same", key)) found.dated.set(r.id, r);
    for (const r of followups.by("same", key)) if (r.kind === "promise") found.promise.set(r.id, r);
  }
  const sorted = (m: Map<number, R>) => [...m.values()].sort((a, b) => a.id - b.id);
  return { dated: sorted(found.dated).map(datedRow), promises: sorted(found.promise).map(followupRow) };
}

/** Plan 210 (iteration 2): as SQL's: on open rows, never over one set, never a chain; no revision moves (no choice of the user's). */
export function linkItems(c: Ctx, o: { same: readonly { item: ItemRef; sameAs: string }[]; details: readonly { id: number; detailOf: number }[] }): number {
  let n = 0;
  for (const { item, sameAs } of o.same) {
    const target = parseRef(sameAs);
    if (!target || sameAs === refKey(item)) continue;
    const canonical = T(c, TABLE[target.source]).get(target.id);
    if (!canonical || (target.source === "promise" && canonical.kind !== "promise") || canonical.same_as != null) continue;
    if (T(c, "dated_items").count("same", refKey(item)) || T(c, "followups").count("same", refKey(item))) continue;
    const rows = T(c, TABLE[item.source]);
    const r = rows.get(item.id);
    if (!r || r.same_as != null || !isOpen(item.source, r)) continue;
    rows.update(r, { same_as: sameAs });
    n++;
  }
  const dated = T(c, "dated_items");
  for (const d of o.details) {
    const r = dated.get(d.id);
    if (d.id === d.detailOf || !dated.has(d.detailOf) || !r || r.detail_of != null || r.state !== "open") continue;
    dated.update(r, { detail_of: d.detailOf });
    n++;
  }
  return n;
}

const atRevision = (c: Ctx, table: "dated_items" | "followups", id: number, revision: number): boolean => T(c, table).get(id)?.revision === revision;

/** Plan 210 (iteration 2): one act on every item a row is, each at the revision it was seen at, or on none (one command). */
export function actOnItems(c: Ctx, changes: ItemChanges): ItemSnapshots | null {
  if (!changes.dated.every((x) => atRevision(c, "dated_items", x.id, x.revision)) || !changes.promises.every((x) => atRevision(c, "followups", x.id, x.revision))) return null;
  return { dated: changes.dated.map((x) => updateDated(c, x.id, x.revision, x.patch)!), promises: changes.promises.map((x) => updateFollowup(c, x.id, x.revision, x.patch)!) };
}

/** Its Undo: every row still at the revision the act left, or none restored. */
export function restoreItems(c: Ctx, s: ItemSnapshots): boolean {
  if (!s.dated.every((r) => atRevision(c, "dated_items", r.id, r.revision + 1)) || !s.promises.every((r) => atRevision(c, "followups", r.id, r.revision + 1))) return false;
  restoreDated(c, s.dated.map((snapshot) => ({ snapshot, expectRevision: snapshot.revision + 1 })));
  restoreFollowups(c, s.promises.map((snapshot) => ({ snapshot, expectRevision: snapshot.revision + 1 })));
  return true;
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
    facts.push({ threadId: t.id, messageId: id, accountId: t.account_id, arrivedAt: m.created_at, lastDate: t.last_date, messageCount: t.message_count, from: m.from_name || m.from_email, fromEmail: String(m.from_email ?? ""), subject: m.subject, snippet: m.snippet, code: (m.code as string | null | undefined) ?? null });
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

/** Plan 210 (iteration 3): see the store's `fromOf`. */
export function fromOf(c: Ctx, ids: readonly number[]): Map<number, { name: string; email: string }> {
  const messages = T(c, "messages");
  const out = new Map<number, { name: string; email: string }>();
  for (const id of ids) {
    const m = messages.get(id);
    if (m) out.set(id, { name: String(m.from_name ?? ""), email: String(m.from_email ?? "") });
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
