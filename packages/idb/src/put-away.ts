import { addressKey, classifierSender, parsePlacementDetail, parseReasons, PUT_AWAY_MS, ruleHash, type Placement, type PutAwayDetail } from "@terno/core";
import { clipText, explainingNote, type KeptSender, type PlacementNote, type PutAwayCursor, type PutAwayMembership, type PutAwayPage, type PutAwayWithdrawn } from "@terno/store";
import { hiddenCategories, tabHiddenTest } from "./inbox-hidden";
import { summariesInOrder, T, type Ctx, type R } from "./mail";

/**
 * Plan 282: Put away, as packages/db/src/put-away.ts keeps it (the conformance suite holds the two to the same answers).
 * The table is a week's worth, pruned as new rows come (at most once an hour), so a read walks it whole.
 */

const hiddenIds = (c: Ctx): Set<number> => hiddenCategories(c.db) ?? new Set();

export function hiddenCategorySet(c: Ctx): Set<number> {
  return hiddenIds(c);
}

/** As the Inbox shows it: in the Inbox, not in Spam or Trash, in no hidden category, not in a tab its account keeps apart. */
export function inboxVisible(c: Ctx, threadIds: Iterable<number>): Set<number> {
  const threads = T(c, "threads");
  const memberships = T(c, "thread_categories");
  const hidden = hiddenIds(c);
  const tabbed = tabHiddenTest(c.db);
  const out = new Set<number>();
  for (const id of new Set(threadIds)) {
    const t = threads.get(id);
    if (!t || t.in_inbox !== 1 || t.in_spam === 1 || t.in_trash === 1 || tabbed?.(t)) continue;
    if (hidden.size && memberships.by("fk_thread_id", id).some((m) => hidden.has(m.category_id as number))) continue;
    out.add(id);
  }
  return out;
}

const ownEmails = (c: Ctx): Set<string> => new Set([...T(c, "accounts").all()].map((a) => String(a.email).toLowerCase()));

/** A conversation's messages from someone else, oldest first */
function inbound(c: Ctx, threadId: number, own: ReadonlySet<string>): R[] {
  return T(c, "messages")
    .by("fk_thread_id", threadId)
    .filter((m) => m.is_sent !== 1 && !own.has(String(m.from_email).toLowerCase()))
    .sort((a, b) => a.date - b.date || a.id - b.id);
}

export class PlacementWatch {
  private readonly before: Set<number>;
  private readonly notes = new Map<number, PlacementNote[]>();
  private hiddenSet: Set<number> | null = null;

  constructor(private readonly c: Ctx, threadIds: Iterable<number>) {
    this.before = inboxVisible(c, threadIds);
  }

  hidden(): ReadonlySet<number> {
    return (this.hiddenSet ??= hiddenIds(this.c));
  }

  note(threadIds: Iterable<number>, note: PlacementNote | null): void {
    if (!note) return;
    for (const t of threadIds) {
      if (!this.before.has(t)) continue;
      const list = this.notes.get(t);
      if (list) list.push(note);
      else this.notes.set(t, [note]);
    }
  }

  noteTerno(auto: ReadonlyMap<number, readonly number[]>): void {
    if (auto.size === 0) return;
    const hidden = this.hidden();
    const decisions = T(this.c, "cls_decisions");
    const own = ownEmails(this.c);
    for (const [categoryId, threadIds] of auto) {
      if (!hidden.has(categoryId)) continue;
      for (const threadId of threadIds) {
        if (!this.before.has(threadId)) continue;
        const decision = decisions.get(threadId, categoryId);
        const root = inbound(this.c, threadId, own)[0];
        this.note([threadId], {
          by: "terno",
          effect: "category",
          categoryId,
          detail: { by: "terno", categoryId, reasons: decision?.kind === "auto" ? parseReasons(decision.explain_json) : [], sender: classifierSender(String(root?.from_email ?? "")), senderName: clipText(String(root?.from_name || root?.from_email || "")) },
        });
      }
    }
  }

  commit(now: number): number[] {
    if (this.notes.size === 0) return [];
    const after = inboxVisible(this.c, this.notes.keys());
    const gone = [...this.notes.keys()].filter((t) => !after.has(t));
    if (gone.length === 0) return [];
    const own = ownEmails(this.c);
    const correspondents = T(this.c, "correspondents");
    const placements = T(this.c, "placements");
    const placed: number[] = [];
    for (const t of gone) {
      const n = explainingNote(this.notes.get(t)!, holdsNow(this.c, t));
      if (!n) continue;
      const newest = inbound(this.c, t, own).at(-1);
      const email = addressKey(String(newest?.from_email ?? ""));
      const who = email ? correspondents.get(email) : undefined;
      const fromName = newest ? clipText(String(newest.from_name || newest.from_email)) : "";
      placements.put({ thread_id: t, at: now, by: n.by, effect: n.effect, category_id: n.categoryId, needs_look: who?.written === 1 && who.own !== 1 ? 1 : 0, detail_json: JSON.stringify({ ...n.detail, fromName }) });
      placed.push(t);
    }
    prunePlacements(this.c, now);
    return placed;
  }
}

/** Whether a note's effect holds on this conversation now (the same test a read makes) */
function holdsNow(c: Ctx, threadId: number): (n: PlacementNote) => boolean {
  const t = T(c, "threads").get(threadId);
  if (!t || t.in_spam === 1) return () => false;
  const hidden = hiddenIds(c);
  const filed = new Set(T(c, "thread_categories").by("fk_thread_id", threadId).filter((m) => hidden.has(m.category_id)).map((m) => `${m.category_id}:${m.added_by}`));
  return (n) => (n.effect === "trash" ? t.in_trash === 1 : n.effect === "category" ? filed.has(`${n.categoryId}:${n.by === "terno" ? "auto" : "filter"}`) : t.in_inbox === 0 && t.in_trash !== 1);
}

/** When each store last pruned: the walk of the table runs at most once an hour (the read ignores old rows anyway) */
const pruned = new WeakMap<Ctx, number>();

export function prunePlacements(c: Ctx, now: number): void {
  if ((pruned.get(c) ?? -Infinity) > now - 3_600_000) return;
  pruned.set(c, now);
  const placements = T(c, "placements");
  const old: R[] = [];
  for (const r of placements.all()) if (r.at <= now - PUT_AWAY_MS) old.push(r);
  for (const r of old) placements.deleteRow(r);
}

export function endPlacements(c: Ctx, threadIds: readonly number[]): void {
  const placements = T(c, "placements");
  for (const id of threadIds) placements.delete(id);
}

/** Of these, the put-away conversations back in the Inbox view (a user's move out of it ends their placement) */
export function placedVisible(c: Ctx, threadIds: readonly number[]): Set<number> {
  const placements = T(c, "placements");
  const placed = threadIds.filter((id) => placements.has(id));
  return placed.length ? inboxVisible(c, placed) : new Set();
}

/** The placement's effect still holds, and the conversation isn't in Spam */
function holds(c: Ctx, p: R): boolean {
  const t = T(c, "threads").get(p.thread_id);
  if (!t || t.in_spam === 1) return false;
  if (p.effect === "archive" || p.effect === "folder") return t.in_inbox === 0 && t.in_trash !== 1;
  if (p.effect === "trash") return t.in_trash === 1;
  if (p.effect !== "category" || p.category_id == null) return false;
  const category = T(c, "categories").get(p.category_id);
  const membership = T(c, "thread_categories").get(p.thread_id, p.category_id);
  return !!category && category.show_in_inbox === 0 && !!membership && membership.added_by === (p.by === "terno" ? "auto" : "filter");
}

function toPlacement(r: R): Placement | null {
  const detail = parsePlacementDetail(r.detail_json);
  return detail ? { threadId: r.thread_id, at: r.at, needsLook: r.needs_look === 1, detail } : null;
}

/** Needs a look first, then newest, then thread id: as SQLite's placements_order */
const order = (a: R, b: R) => b.needs_look - a.needs_look || b.at - a.at || b.thread_id - a.thread_id;
const before = (r: R, k: PutAwayCursor) => {
  const n = k.needsLook ? 1 : 0;
  return r.needs_look !== n ? r.needs_look < n : r.at !== k.at ? r.at < k.at : r.thread_id < k.threadId;
};

export function placementOf(c: Ctx, threadId: number, now: number): PutAwayDetail | null {
  const row = T(c, "placements").get(threadId);
  if (!row || row.at <= now - PUT_AWAY_MS || !holds(c, row)) return null;
  const p = toPlacement(row);
  if (!p) return null;
  if (p.detail.by !== "rule") return { ...p, senderKept: isKeptSender(c, p.detail.categoryId, p.detail.sender) };
  const filter = T(c, "filters").get(p.detail.filterId);
  const live = !!filter && ruleHash(JSON.parse(filter.rule_json)) === p.detail.ruleHash;
  return { ...p, ruleLive: live, ruleEnabled: live && filter!.enabled === 1 };
}

/** A rule's placements that still hold (that rule as it was), newest first */
export function placementsByRule(c: Ctx, filterId: number, hash: string, now: number): { threadId: number; at: number }[] {
  return [...T(c, "placements").all()]
    .filter((r) => r.by === "rule" && r.at > now - PUT_AWAY_MS)
    .filter((r) => { const d = toPlacement(r)?.detail; return d?.by === "rule" && d.filterId === filterId && d.ruleHash === hash && holds(c, r); })
    .sort((a, b) => b.at - a.at || b.thread_id - a.thread_id)
    .map((r) => ({ threadId: r.thread_id, at: r.at }));
}

export function placementPage(c: Ctx, p: { now: number; after?: PutAwayCursor | null; limit: number }): PutAwayPage {
  const after = p.after;
  const rows = [...T(c, "placements").all()]
    .filter((r) => r.at > p.now - PUT_AWAY_MS && (!after || before(r, after)) && holds(c, r))
    .sort(order)
    .slice(0, p.limit + 1);
  const more = rows.length > p.limit;
  const page = rows.slice(0, p.limit);
  const placements = page.flatMap((r) => toPlacement(r) ?? []);
  const summaries = new Map(summariesInOrder(c, placements.map((x) => x.threadId)).map((t) => [t.id, t]));
  const items = placements.flatMap((placement) => {
    const thread = summaries.get(placement.threadId);
    return thread ? [{ thread, placement }] : [];
  });
  const last = page.at(-1);
  return { items, next: more && last ? { needsLook: last.needs_look === 1, at: last.at, threadId: last.thread_id } : null };
}

export function placementsNeedingLook(c: Ctx, p: { now: number; after: number }): { count: number; first: { threadId: number; name: string } | null; through: number } {
  const since = Math.max(p.after, p.now - PUT_AWAY_MS);
  const rows = [...T(c, "placements").all()]
    .filter((r) => r.needs_look === 1 && r.at > since && holds(c, r))
    .sort(order)
    .flatMap((r) => toPlacement(r) ?? []);
  const first = rows[0];
  return { count: rows.length, first: first ? { threadId: first.threadId, name: first.detail.fromName } : null, through: first?.at ?? p.after };
}

export function releaseHiddenFilings(c: Ctx, threadIds: readonly number[]): PutAwayMembership[] {
  const hidden = hiddenIds(c);
  const memberships = T(c, "thread_categories");
  const out: PutAwayMembership[] = [];
  for (const threadId of new Set(threadIds)) {
    for (const m of memberships.by("fk_thread_id", threadId)) {
      if (!hidden.has(m.category_id)) continue;
      memberships.deleteRow(m);
      out.push({ threadId, categoryId: m.category_id, addedBy: m.added_by, addedAt: m.added_at, batchId: m.batch_id ?? null });
    }
  }
  return out;
}

export function refileHiddenFilings(c: Ctx, rows: readonly PutAwayMembership[]): void {
  const memberships = T(c, "thread_categories");
  const batches = T(c, "cat_batches");
  for (const r of rows) {
    if (!T(c, "threads").has(r.threadId) || !T(c, "categories").has(r.categoryId) || memberships.has(r.threadId, r.categoryId)) continue;
    memberships.insert({ thread_id: r.threadId, category_id: r.categoryId, added_by: r.addedBy, added_at: r.addedAt, batch_id: r.batchId !== null && batches.has(r.batchId) ? r.batchId : null });
  }
}

export function keptSenderKeys(c: Ctx): Set<string> {
  return new Set([...T(c, "cls_kept_senders").all()].map((r) => `${r.category_id}:${r.sender}`));
}

export function isKeptSender(c: Ctx, categoryId: number, sender: string): boolean {
  return T(c, "cls_kept_senders").has(categoryId, sender);
}

export function listKeptSenders(c: Ctx): KeptSender[] {
  return [...T(c, "cls_kept_senders").all()].sort((a, b) => b.at - a.at).map((r) => ({ categoryId: r.category_id, sender: r.sender, at: r.at }));
}

export function keepSender(c: Ctx, p: { categoryId: number; sender: string; threadId: number | null; now: number }): { added: boolean; at: number; withdrawn: PutAwayWithdrawn | null } {
  const kept = T(c, "cls_kept_senders");
  const added = !kept.has(p.categoryId, p.sender) && T(c, "categories").has(p.categoryId);
  if (added) kept.insert({ category_id: p.categoryId, sender: p.sender, at: p.now });
  if (p.threadId === null) return { added, at: p.now, withdrawn: null };
  const memberships = T(c, "thread_categories");
  const membership = memberships.get(p.threadId, p.categoryId);
  if (!membership || membership.added_by !== "auto") return { added, at: p.now, withdrawn: null };
  memberships.deleteRow(membership);
  const decisions = T(c, "cls_decisions");
  const decision = decisions.get(p.threadId, p.categoryId);
  const auto = decision && decision.kind === "auto" ? decision : null;
  if (auto) decisions.deleteRow(auto);
  return { added, at: p.now, withdrawn: { threadId: p.threadId, categoryId: p.categoryId, addedAt: membership.added_at, batchId: membership.batch_id ?? null, decision: auto ? { p: auto.p, explainJson: auto.explain_json, at: auto.at, outcome: auto.outcome ?? null } : null } };
}

export function unkeepSender(c: Ctx, p: { categoryId: number; sender: string; added: boolean; at: number; withdrawn: PutAwayWithdrawn | null }): void {
  const kept = T(c, "cls_kept_senders");
  if (p.added && kept.get(p.categoryId, p.sender)?.at === p.at) kept.delete(p.categoryId, p.sender);
  const w = p.withdrawn;
  if (!w || !T(c, "threads").has(w.threadId) || !T(c, "categories").has(w.categoryId)) return;
  const memberships = T(c, "thread_categories");
  if (!memberships.has(w.threadId, w.categoryId)) memberships.insert({ thread_id: w.threadId, category_id: w.categoryId, added_by: "auto", added_at: w.addedAt, batch_id: w.batchId !== null && T(c, "cat_batches").has(w.batchId) ? w.batchId : null });
  const decisions = T(c, "cls_decisions");
  if (w.decision && !decisions.has(w.threadId, w.categoryId)) decisions.insert({ thread_id: w.threadId, category_id: w.categoryId, kind: "auto", p: w.decision.p, explain_json: w.decision.explainJson, at: w.decision.at, outcome: w.decision.outcome });
}

export function removeKeptSender(c: Ctx, categoryId: number, sender: string): boolean {
  return !!T(c, "cls_kept_senders").delete(categoryId, sender);
}
