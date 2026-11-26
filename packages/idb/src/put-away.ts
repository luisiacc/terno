import { classifierSender, parsePlacementDetail, parseReasons, PUT_AWAY_MS, ruleHash, type Filter, type FilterAction, type Placement, type PlacementDetail, type PlacementEffect, type PutAwayDetail } from "@terno/core";
import type { KeptSender, PutAwayCursor, PutAwayPage, PutAwayWithdrawn } from "@terno/store";
import { summariesInOrder, T, type Ctx, type R } from "./mail";

/**
 * Plan 282: Put away, as packages/db/src/put-away.ts keeps it (the conformance suite holds the two to the same answers).
 * The table is a week's worth, pruned as new rows come, so a read walks it whole.
 */

export interface PlacementNote {
  by: "rule" | "terno";
  effect: PlacementEffect;
  categoryId: number | null;
  detail: DistributiveOmit<PlacementDetail, "fromName">;
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const hiddenIds = (c: Ctx): Set<number> => new Set([...T(c, "categories").all()].filter((r) => r.show_in_inbox === 0).map((r) => r.id as number));

export function hiddenCategorySet(c: Ctx): Set<number> {
  return hiddenIds(c);
}

/** In the Inbox, not in Spam or Trash, in no hidden category. */
export function inboxVisible(c: Ctx, threadIds: Iterable<number>): Set<number> {
  const threads = T(c, "threads");
  const memberships = T(c, "thread_categories");
  const hidden = hiddenIds(c);
  const out = new Set<number>();
  for (const id of new Set(threadIds)) {
    const t = threads.get(id);
    if (!t || t.in_inbox !== 1 || t.in_spam === 1 || t.in_trash === 1) continue;
    if (hidden.size && memberships.by("fk_thread_id", id).some((m) => hidden.has(m.category_id as number))) continue;
    out.add(id);
  }
  return out;
}

export function ruleNote(filter: Filter, action: FilterAction, hidden: ReadonlySet<number>): PlacementNote | null {
  const base = { by: "rule" as const, filterId: filter.id, name: filter.name, auto: filter.auto, source: filter.source, createdAt: filter.createdAt, ruleHash: ruleHash(filter.rule) };
  switch (action.type) {
    case "archive":
    case "trash":
      return { by: "rule", effect: action.type, categoryId: null, detail: { ...base, action: action.type } };
    case "moveToFolder":
      return { by: "rule", effect: "folder", categoryId: null, detail: { ...base, action: "moveToFolder", folder: action.folder } };
    case "addCategory":
      return hidden.has(action.categoryId) ? { by: "rule", effect: "category", categoryId: action.categoryId, detail: { ...base, action: "addCategory", categoryId: action.categoryId } } : null;
    default:
      return null;
  }
}

const ownEmails = (c: Ctx): Set<string> => new Set([...T(c, "accounts").all()].map((a) => String(a.email).toLowerCase()));

/** A conversation's messages from someone else, oldest first */
function inbound(c: Ctx, threadId: number, own: ReadonlySet<number | string>): R[] {
  return T(c, "messages")
    .by("fk_thread_id", threadId)
    .filter((m) => m.is_sent !== 1 && !own.has(String(m.from_email).toLowerCase()))
    .sort((a, b) => a.date - b.date || a.id - b.id);
}

export class PlacementWatch {
  private readonly before: Set<number>;
  private readonly notes = new Map<number, PlacementNote>();

  constructor(private readonly c: Ctx, threadIds: Iterable<number>) {
    this.before = inboxVisible(c, threadIds);
  }

  note(threadIds: Iterable<number>, note: PlacementNote | null): void {
    if (!note) return;
    for (const t of threadIds) {
      if (!this.before.has(t)) continue;
      const prev = this.notes.get(t);
      if (!prev || (prev.by === "terno" && note.by === "rule")) this.notes.set(t, note);
    }
  }

  noteTerno(auto: ReadonlyMap<number, readonly number[]>, hidden: ReadonlySet<number>): void {
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
          detail: { by: "terno", categoryId, reasons: decision?.kind === "auto" ? parseReasons(decision.explain_json) : [], sender: classifierSender(String(root?.from_email ?? "")) },
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
    for (const t of gone) {
      const n = this.notes.get(t)!;
      const newest = inbound(this.c, t, own).at(-1);
      const email = String(newest?.from_email ?? "").toLowerCase();
      const who = email ? correspondents.get(email) : undefined;
      const row = { thread_id: t, at: now, by: n.by, effect: n.effect, category_id: n.categoryId, needs_look: who?.written === 1 && who.own !== 1 ? 1 : 0, detail_json: JSON.stringify({ ...n.detail, fromName: newest ? String(newest.from_name || newest.from_email) : "" }) };
      placements.put(row);
    }
    prunePlacements(this.c, now);
    return gone;
  }
}

export function prunePlacements(c: Ctx, now: number): void {
  const placements = T(c, "placements");
  const old: R[] = [];
  for (const r of placements.all()) if (r.at <= now - PUT_AWAY_MS) old.push(r);
  for (const r of old) placements.deleteRow(r);
}

export function endPlacements(c: Ctx, threadIds: readonly number[]): void {
  const placements = T(c, "placements");
  for (const id of threadIds) placements.delete(id);
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

function live(c: Ctx, now: number): R[] {
  return [...T(c, "placements").all()].filter((r) => r.at > now - PUT_AWAY_MS && holds(c, r));
}

export function placementOf(c: Ctx, threadId: number, now: number): PutAwayDetail | null {
  const row = T(c, "placements").get(threadId);
  if (!row || row.at <= now - PUT_AWAY_MS || !holds(c, row)) return null;
  const p = toPlacement(row);
  if (!p) return null;
  if (p.detail.by !== "rule") return p;
  const filter = T(c, "filters").get(p.detail.filterId);
  return { ...p, ruleLive: !!filter && ruleHash(JSON.parse(filter.rule_json)) === p.detail.ruleHash };
}

export function placementPage(c: Ctx, p: { now: number; after?: PutAwayCursor | null; limit: number }): PutAwayPage {
  const after = p.after;
  const rows = live(c, p.now)
    .filter((r) => !after || before(r, after))
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
    .sort(order);
  const first = rows[0] ? toPlacement(rows[0]) : null;
  return { count: rows.length, first: first ? { threadId: first.threadId, name: first.detail.fromName } : null, through: rows[0]?.at ?? p.after };
}

export function releaseRuleFilings(c: Ctx, threadIds: readonly number[]): { threadId: number; categoryId: number }[] {
  const hidden = hiddenIds(c);
  const memberships = T(c, "thread_categories");
  const out: { threadId: number; categoryId: number }[] = [];
  for (const threadId of new Set(threadIds)) {
    for (const m of memberships.by("fk_thread_id", threadId)) {
      if (m.added_by !== "filter" || !hidden.has(m.category_id)) continue;
      memberships.deleteRow(m);
      out.push({ threadId, categoryId: m.category_id });
    }
  }
  return out;
}

export function refileRuleFilings(c: Ctx, rows: readonly { threadId: number; categoryId: number }[], now: number): void {
  const memberships = T(c, "thread_categories");
  for (const r of rows) {
    if (!T(c, "threads").has(r.threadId) || !T(c, "categories").has(r.categoryId) || memberships.has(r.threadId, r.categoryId)) continue;
    memberships.insert({ thread_id: r.threadId, category_id: r.categoryId, added_by: "filter", added_at: now, batch_id: null });
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

export function keepSender(c: Ctx, p: { categoryId: number; sender: string; threadId: number | null; now: number }): { added: boolean; withdrawn: PutAwayWithdrawn | null } {
  const kept = T(c, "cls_kept_senders");
  const added = !kept.has(p.categoryId, p.sender) && T(c, "categories").has(p.categoryId);
  if (added) kept.insert({ category_id: p.categoryId, sender: p.sender, at: p.now });
  if (p.threadId === null) return { added, withdrawn: null };
  const memberships = T(c, "thread_categories");
  const membership = memberships.get(p.threadId, p.categoryId);
  if (!membership || membership.added_by !== "auto") return { added, withdrawn: null };
  memberships.deleteRow(membership);
  const decisions = T(c, "cls_decisions");
  const decision = decisions.get(p.threadId, p.categoryId);
  const auto = decision && decision.kind === "auto" ? decision : null;
  if (auto) decisions.deleteRow(auto);
  return { added, withdrawn: { threadId: p.threadId, categoryId: p.categoryId, addedAt: membership.added_at, decision: auto ? { p: auto.p, explainJson: auto.explain_json, at: auto.at, outcome: auto.outcome ?? null } : null } };
}

export function unkeepSender(c: Ctx, p: { categoryId: number; sender: string; added: boolean; withdrawn: PutAwayWithdrawn | null }): void {
  if (p.added) T(c, "cls_kept_senders").delete(p.categoryId, p.sender);
  const w = p.withdrawn;
  if (!w || !T(c, "threads").has(w.threadId) || !T(c, "categories").has(w.categoryId)) return;
  const memberships = T(c, "thread_categories");
  if (!memberships.has(w.threadId, w.categoryId)) memberships.insert({ thread_id: w.threadId, category_id: w.categoryId, added_by: "auto", added_at: w.addedAt, batch_id: null });
  if (w.decision) T(c, "cls_decisions").put({ thread_id: w.threadId, category_id: w.categoryId, kind: "auto", p: w.decision.p, explain_json: w.decision.explainJson, at: w.decision.at, outcome: w.decision.outcome });
}

export function removeKeptSender(c: Ctx, categoryId: number, sender: string): boolean {
  return !!T(c, "cls_kept_senders").delete(categoryId, sender);
}
