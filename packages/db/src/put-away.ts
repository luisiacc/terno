import { classifierSender, parsePlacementDetail, parseReasons, PUT_AWAY_MS, ruleHash, type Filter, type FilterAction, type Placement, type PlacementDetail, type PlacementEffect, type PutAwayDetail } from "@terno/core";
import type { KeptSender, PutAwayCursor, PutAwayPage, PutAwayWithdrawn } from "@terno/store";
import { getSummaries } from "./queries";
import type { Db } from "./sqlite";

/**
 * Plan 282: Put away. A placement is written in the command that took a conversation out of the Inbox view (a rule's
 * action on new mail, the engine's filing into a hidden category), only when the conversation was in it before and is
 * out of it after; one row per conversation, the newest wins, a week's worth. A read keeps it while its effect still
 * holds (still archived, still deleted, still in that hidden category as the rule or the engine put it) and the
 * conversation isn't in Spam; the user's own move ends it (`endPlacements`).
 */

/** What one source did to some conversations, waiting for the command's end to see whether it took them out */
export interface PlacementNote {
  by: "rule" | "terno";
  effect: PlacementEffect;
  categoryId: number | null;
  /** the snapshot, without who the mail is from (read at the end, per conversation) */
  detail: DistributiveOmit<PlacementDetail, "fromName">;
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The conversations of these that are in the Inbox view: in the Inbox, not in Spam or Trash, in no hidden category. */
export function inboxVisible(db: Db, threadIds: Iterable<number>): Set<number> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return new Set();
  return new Set(
    db
      .all<{ id: number }>(
        `SELECT t.id FROM json_each(?) j JOIN threads t ON t.id = j.value
         WHERE t.in_inbox = 1 AND t.in_spam = 0 AND t.in_trash = 0
           AND NOT EXISTS (SELECT 1 FROM thread_categories h JOIN categories c ON c.id = h.category_id WHERE h.thread_id = t.id AND c.show_in_inbox = 0)`,
        JSON.stringify(ids),
      )
      .map((r) => r.id),
  );
}

/** The categories hidden from the Inbox (a handful of rows) */
export function hiddenCategorySet(db: Db): Set<number> {
  return new Set(db.all<{ id: number }>("SELECT id FROM categories WHERE show_in_inbox = 0").map((r) => r.id));
}

/** A rule's action as a placement, or null when it doesn't take mail out of the Inbox (or it's Spam: Spam triggers nothing). */
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

/**
 * One command's placements: what was in the Inbox view when it started, what each source did, and at its end the
 * conversations that left, each with the source that did it (a rule over the engine: the rule is the user's own word).
 */
export class PlacementWatch {
  private readonly before: Set<number>;
  private readonly notes = new Map<number, PlacementNote>();

  constructor(private readonly db: Db, threadIds: Iterable<number>) {
    this.before = inboxVisible(db, threadIds);
  }

  note(threadIds: Iterable<number>, note: PlacementNote | null): void {
    if (!note) return;
    for (const t of threadIds) {
      if (!this.before.has(t)) continue;
      const prev = this.notes.get(t);
      if (!prev || (prev.by === "terno" && note.by === "rule")) this.notes.set(t, note);
    }
  }

  /**
   * The engine's filings this command made (`auto`: category → conversations), into categories hidden from the Inbox: each
   * with its decision's reasons and the sender the decision read (the conversation's first message from someone else).
   */
  noteTerno(auto: ReadonlyMap<number, readonly number[]>, hidden: ReadonlySet<number>): void {
    for (const [categoryId, threadIds] of auto) {
      if (!hidden.has(categoryId)) continue;
      for (const threadId of threadIds) {
        if (!this.before.has(threadId)) continue;
        const decision = this.db.get<{ explain_json: string }>("SELECT explain_json FROM cls_decisions WHERE thread_id = ? AND category_id = ? AND kind = 'auto'", threadId, categoryId);
        const root = this.db.get<{ from_email: string; from_name: string }>(
          `SELECT from_email, from_name FROM messages INDEXED BY messages_thread
           WHERE thread_id = ? AND is_sent = 0 AND lower(from_email) NOT IN (SELECT lower(email) FROM accounts) ORDER BY date, id LIMIT 1`,
          threadId,
        );
        this.note([threadId], {
          by: "terno",
          effect: "category",
          categoryId,
          detail: { by: "terno", categoryId, reasons: parseReasons(decision?.explain_json), sender: classifierSender(root?.from_email ?? "") },
        });
      }
    }
  }

  /** The placements, written; the conversations placed. */
  commit(now: number): number[] {
    if (this.notes.size === 0) return [];
    const after = inboxVisible(this.db, this.notes.keys());
    const gone = [...this.notes.keys()].filter((t) => !after.has(t));
    if (gone.length === 0) return [];
    const from = newestFrom(this.db, gone);
    for (const t of gone) {
      const n = this.notes.get(t)!;
      const f = from.get(t);
      writePlacement(this.db, t, now, n, f?.name ?? "", f?.written ?? false);
    }
    prunePlacements(this.db, now);
    return gone;
  }
}

/** Each conversation's newest message from someone else: their name (or address), and whether you've written to them. */
function newestFrom(db: Db, threadIds: readonly number[]): Map<number, { name: string; written: boolean }> {
  const own = db.all<{ email: string }>("SELECT email FROM accounts").map((r) => r.email.toLowerCase());
  return new Map(
    db
      .all<{ thread_id: number; from_name: string; from_email: string; written: number | null; own: number | null }>(
        `SELECT j.value AS thread_id, m.from_name, m.from_email, c.written, c.own
         FROM json_each(?) j JOIN messages m ON m.id = (
           SELECT r.id FROM messages r INDEXED BY messages_thread
           WHERE r.thread_id = j.value AND r.is_sent = 0 AND lower(r.from_email) NOT IN (SELECT value FROM json_each(?))
           ORDER BY r.date DESC, r.id DESC LIMIT 1)
         LEFT JOIN correspondents c ON c.email = lower(m.from_email)`,
        JSON.stringify(threadIds),
        JSON.stringify(own),
      )
      .map((r) => [r.thread_id, { name: r.from_name || r.from_email, written: r.written === 1 && r.own !== 1 }]),
  );
}

function writePlacement(db: Db, threadId: number, at: number, n: PlacementNote, fromName: string, needsLook: boolean): void {
  const detail = { ...n.detail, fromName } as PlacementDetail;
  db.run(
    "INSERT OR REPLACE INTO placements (thread_id, at, by, effect, category_id, needs_look, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    threadId,
    at,
    n.by,
    n.effect,
    n.categoryId,
    needsLook ? 1 : 0,
    JSON.stringify(detail),
  );
}

/** A week's worth: older rows go as new ones come (no timer). */
export function prunePlacements(db: Db, now: number): void {
  db.run("DELETE FROM placements WHERE at <= ?", now - PUT_AWAY_MS);
}

/** The user's own move (archive, delete, spam, a folder): the conversation is theirs now. */
export function endPlacements(db: Db, threadIds: readonly number[]): void {
  if (threadIds.length === 0) return;
  db.run("DELETE FROM placements WHERE thread_id IN (SELECT value FROM json_each(?))", JSON.stringify(threadIds));
}

/** A placement whose effect still holds, in a conversation that isn't in Spam (alias `p` for placements, `t` for threads) */
const HOLDS = `t.in_spam = 0 AND (
  (p.effect IN ('archive', 'folder') AND t.in_inbox = 0 AND t.in_trash = 0)
  OR (p.effect = 'trash' AND t.in_trash = 1)
  OR (p.effect = 'category' AND EXISTS (
    SELECT 1 FROM thread_categories tc JOIN categories c ON c.id = tc.category_id
    WHERE tc.thread_id = p.thread_id AND tc.category_id = p.category_id AND c.show_in_inbox = 0
      AND tc.added_by = CASE p.by WHEN 'terno' THEN 'auto' ELSE 'filter' END)))`;

interface PlacementRow {
  thread_id: number;
  at: number;
  needs_look: number;
  detail_json: string;
}

function toPlacement(r: PlacementRow): Placement | null {
  const detail = parsePlacementDetail(r.detail_json);
  return detail ? { threadId: r.thread_id, at: r.at, needsLook: r.needs_look === 1, detail } : null;
}

export function placementOf(db: Db, threadId: number, now: number): PutAwayDetail | null {
  const row = db.get<PlacementRow>(
    `SELECT p.thread_id, p.at, p.needs_look, p.detail_json FROM placements p JOIN threads t ON t.id = p.thread_id
     WHERE p.thread_id = ? AND p.at > ? AND ${HOLDS}`,
    threadId,
    now - PUT_AWAY_MS,
  );
  const p = row ? toPlacement(row) : null;
  if (!p) return null;
  if (p.detail.by !== "rule") return p;
  const filter = db.get<{ rule_json: string }>("SELECT rule_json FROM filters WHERE id = ?", p.detail.filterId);
  return { ...p, ruleLive: !!filter && ruleHash(JSON.parse(filter.rule_json)) === p.detail.ruleHash };
}

/** Needs a look first, then the newest; the cursor carries all three keys, so pages only ever append. */
export function placementPage(db: Db, p: { now: number; after?: PutAwayCursor | null; limit: number }): PutAwayPage {
  const a = p.after;
  const rows = db.all<PlacementRow>(
    `SELECT p.thread_id, p.at, p.needs_look, p.detail_json FROM placements p INDEXED BY placements_order JOIN threads t ON t.id = p.thread_id
     WHERE p.at > ? AND ${HOLDS} ${a ? "AND (p.needs_look, p.at, p.thread_id) < (?, ?, ?)" : ""}
     ORDER BY p.needs_look DESC, p.at DESC, p.thread_id DESC LIMIT ?`,
    p.now - PUT_AWAY_MS,
    ...(a ? [a.needsLook ? 1 : 0, a.at, a.threadId] : []),
    p.limit + 1,
  );
  const more = rows.length > p.limit;
  const placements = rows.slice(0, p.limit).flatMap((r) => toPlacement(r) ?? []);
  const summaries = new Map(getSummaries(db, placements.map((x) => x.threadId)).map((t) => [t.id, t]));
  const items = placements.flatMap((placement) => {
    const thread = summaries.get(placement.threadId);
    return thread ? [{ thread, placement }] : [];
  });
  const last = rows[Math.min(rows.length, p.limit) - 1];
  return { items, next: more && last ? { needsLook: last.needs_look === 1, at: last.at, threadId: last.thread_id } : null };
}

/** The Inbox's line: conversations that need a look, put away after `after` (and inside the window); the newest one's sender. */
export function placementsNeedingLook(db: Db, p: { now: number; after: number }): { count: number; first: { threadId: number; name: string } | null; through: number } {
  const since = Math.max(p.after, p.now - PUT_AWAY_MS);
  const rows = db.all<PlacementRow>(
    `SELECT p.thread_id, p.at, p.needs_look, p.detail_json FROM placements p INDEXED BY placements_order JOIN threads t ON t.id = p.thread_id
     WHERE p.needs_look = 1 AND p.at > ? AND ${HOLDS}
     ORDER BY p.needs_look DESC, p.at DESC, p.thread_id DESC`,
    since,
  );
  const first = rows[0] ? toPlacement(rows[0]) : null;
  return { count: rows.length, first: first ? { threadId: first.threadId, name: first.detail.fromName } : null, through: rows[0]?.at ?? p.after };
}

/**
 * Back to Inbox's half a thread action can't do: out of the hidden categories a rule filed these conversations in. No
 * example (the engine didn't file them); the memberships removed, for Undo.
 */
export function releaseRuleFilings(db: Db, threadIds: readonly number[]): { threadId: number; categoryId: number }[] {
  if (threadIds.length === 0) return [];
  return db
    .all<{ thread_id: number; category_id: number }>(
      `DELETE FROM thread_categories WHERE added_by = 'filter' AND thread_id IN (SELECT value FROM json_each(?))
         AND category_id IN (SELECT id FROM categories WHERE show_in_inbox = 0)
       RETURNING thread_id, category_id`,
      JSON.stringify(threadIds),
    )
    .map((r) => ({ threadId: r.thread_id, categoryId: r.category_id }));
}

/** Undo of releaseRuleFilings: the memberships back as the rule made them (a category gone since stays gone). */
export function refileRuleFilings(db: Db, rows: readonly { threadId: number; categoryId: number }[], now: number): void {
  for (const r of rows) {
    db.run(
      `INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at)
       SELECT ?, id, 'filter', ? FROM categories WHERE id = ? AND EXISTS (SELECT 1 FROM threads WHERE id = ?)`,
      r.threadId,
      now,
      r.categoryId,
      r.threadId,
    );
  }
}

// ───────────────────────────── kept senders ─────────────────────────────

/** "Don't file {sender} automatically" (in one category), by the classifier's normalized sender */
export function keptSenderKeys(db: Db): Set<string> {
  return new Set(db.all<{ category_id: number; sender: string }>("SELECT category_id, sender FROM cls_kept_senders").map((r) => `${r.category_id}:${r.sender}`));
}

export function isKeptSender(db: Db, categoryId: number, sender: string): boolean {
  return !!db.get("SELECT 1 FROM cls_kept_senders WHERE category_id = ? AND sender = ?", categoryId, sender);
}

export function listKeptSenders(db: Db): KeptSender[] {
  return db.all<{ category_id: number; sender: string; at: number }>("SELECT category_id, sender, at FROM cls_kept_senders ORDER BY at DESC").map((r) => ({ categoryId: r.category_id, sender: r.sender, at: r.at }));
}

/**
 * Keeps a sender out of a category's automatic filing, and takes this conversation out of it as the engine put it: the
 * membership and its decision go, with no example and no outcome (the safety valve counts neither way).
 */
export function keepSender(db: Db, p: { categoryId: number; sender: string; threadId: number | null; now: number }): { added: boolean; withdrawn: PutAwayWithdrawn | null } {
  const added = db.run("INSERT OR IGNORE INTO cls_kept_senders (category_id, sender, at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM categories WHERE id = ?)", p.categoryId, p.sender, p.now, p.categoryId).changes > 0;
  if (p.threadId === null) return { added, withdrawn: null };
  const membership = db.get<{ added_at: number }>("DELETE FROM thread_categories WHERE thread_id = ? AND category_id = ? AND added_by = 'auto' RETURNING added_at", p.threadId, p.categoryId);
  if (!membership) return { added, withdrawn: null };
  const decision = db.get<{ p: number; explain_json: string; at: number; outcome: string | null }>(
    "DELETE FROM cls_decisions WHERE thread_id = ? AND category_id = ? AND kind = 'auto' RETURNING p, explain_json, at, outcome",
    p.threadId,
    p.categoryId,
  );
  return { added, withdrawn: { threadId: p.threadId, categoryId: p.categoryId, addedAt: membership.added_at, decision: decision ? { p: decision.p, explainJson: decision.explain_json, at: decision.at, outcome: decision.outcome } : null } };
}

/** Undo of keepSender: the sender back to automatic filing (if this added it), the conversation and its decision back. */
export function unkeepSender(db: Db, p: { categoryId: number; sender: string; added: boolean; withdrawn: PutAwayWithdrawn | null }): void {
  if (p.added) db.run("DELETE FROM cls_kept_senders WHERE category_id = ? AND sender = ?", p.categoryId, p.sender);
  const w = p.withdrawn;
  if (!w || !db.get("SELECT 1 FROM threads WHERE id = ?", w.threadId) || !db.get("SELECT 1 FROM categories WHERE id = ?", w.categoryId)) return;
  db.run("INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at) VALUES (?, ?, 'auto', ?)", w.threadId, w.categoryId, w.addedAt);
  if (w.decision) {
    db.run(
      "INSERT OR REPLACE INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at, outcome) VALUES (?, ?, 'auto', ?, ?, ?, ?)",
      w.threadId,
      w.categoryId,
      w.decision.p,
      w.decision.explainJson,
      w.decision.at,
      w.decision.outcome,
    );
  }
}

/** Settings' Remove: the sender back to automatic filing. */
export function removeKeptSender(db: Db, categoryId: number, sender: string): boolean {
  return db.run("DELETE FROM cls_kept_senders WHERE category_id = ? AND sender = ?", categoryId, sender).changes > 0;
}
