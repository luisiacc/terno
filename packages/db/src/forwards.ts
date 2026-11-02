import {
  FORWARD_APPROVAL_MS,
  FORWARD_CAP,
  FORWARD_CAP_WINDOW_MS,
  FORWARD_DELAY_MS,
  FORWARD_ELIGIBLE_MS,
  FORWARD_FILTER_LAG_MS,
  FORWARD_HELD_MS,
  FORWARD_HISTORY_MS,
  FORWARD_MAX_AGE_MS,
  forwardAddresses,
  forwardChunks,
  type Address,
  type CategoryForward,
  type FilterRule,
  type ForwardRuleKind,
  type ForwardRuleRef,
} from "@terno/core";
import { forwardAction, membershipForwards, nextCategoryState, readRuleState, ruleCurrent, type AddedBy, type ForwardClaim, type ForwardHold, type ForwardRow, type ForwardRowState, type ForwardRuleState } from "@terno/store";
import type { Db } from "./sqlite";

/** Plan 116's forwards on SQLite (v44): see packages/store/src/forwards.ts. */

interface Raw {
  id: number;
  message_id: number;
  thread_id: number;
  account_id: number;
  rule_kind: ForwardRuleKind;
  rule_id: number;
  rev: number;
  to_json: string;
  state: ForwardRowState;
  due_at: number;
  files_until: number | null;
  files_missing: number;
  op_ids_json: string;
  reason: string | null;
  created_at: number;
  claimed_at: number | null;
  at: number;
}

const toRow = (r: Raw): ForwardRow => ({
  id: r.id,
  messageId: r.message_id,
  threadId: r.thread_id,
  accountId: r.account_id,
  ruleKind: r.rule_kind,
  ruleId: r.rule_id,
  rev: r.rev,
  to: JSON.parse(r.to_json) as Address[],
  state: r.state,
  dueAt: r.due_at,
  filesUntil: r.files_until,
  filesMissing: r.files_missing === 1,
  opIds: JSON.parse(r.op_ids_json) as (string | null)[],
  reason: r.reason,
  createdAt: r.created_at,
  claimedAt: r.claimed_at,
  at: r.at,
});

const ids = (list: readonly number[]) => JSON.stringify(list);

interface Rule {
  ref: ForwardRuleRef;
  state: ForwardRuleState;
  to: Address[];
  /** a filter's own switch */
  filterEnabled: boolean;
}

function categoryRule(db: Db, id: number): Rule | null {
  const r = db.get<{ forward_json: string | null }>("SELECT forward_json FROM categories WHERE id = ?", id);
  const state = readRuleState(r?.forward_json);
  return state ? { ref: { kind: "category", id }, state, to: state.addresses ?? [], filterEnabled: true } : null;
}

function filterRule(db: Db, id: number): Rule | null {
  const r = db.get<{ forward_json: string | null; rule_json: string; enabled: number }>("SELECT forward_json, rule_json, enabled FROM filters WHERE id = ?", id);
  const state = readRuleState(r?.forward_json);
  const action = r ? forwardAction(JSON.parse(r.rule_json) as FilterRule) : null;
  return state && action ? { ref: { kind: "filter", id }, state, to: forwardAddresses(action.to), filterEnabled: r!.enabled === 1 } : null;
}

const ruleOf = (db: Db, ref: ForwardRuleRef) => (ref.kind === "category" ? categoryRule(db, ref.id) : filterRule(db, ref.id));

/** The rules that forward now (a handful: categories and filters with a trigger). */
function liveRules(db: Db): Rule[] {
  const out: Rule[] = [];
  for (const r of db.all<{ id: number }>("SELECT id FROM categories WHERE forward_json IS NOT NULL")) {
    const rule = categoryRule(db, r.id);
    if (rule?.state.enabled) out.push(rule);
  }
  for (const r of db.all<{ id: number }>("SELECT id FROM filters WHERE forward_json IS NOT NULL AND enabled = 1")) {
    const rule = filterRule(db, r.id);
    if (rule?.state.enabled) out.push(rule);
  }
  return out;
}

export function forwardsActive(db: Db): boolean {
  return liveRules(db).length > 0;
}

/** Cancels a rule's waiting and held forwards (it changed, or was turned off). */
function cancelRule(db: Db, ref: ForwardRuleRef, reason: string, now: number): number {
  const cancelled = db.all<{ id: number }>("SELECT id FROM forwards WHERE rule_kind = ? AND rule_id = ? AND state IN ('waiting', 'held')", ref.kind, ref.id);
  for (const r of cancelled) settle(db, r.id, "cancelled", reason, now);
  return cancelled.length;
}

/** Settles a forward that never went: its claims (recipients it owns) go with it. */
function settle(db: Db, id: number, state: "cancelled" | "failed", reason: string | null, now: number): void {
  db.run("UPDATE forwards SET state = ?, reason = ?, at = ? WHERE id = ?", state, reason, now, id);
  db.run("DELETE FROM forward_recipients WHERE forward_id = ?", id);
}

export function setCategoryForward(db: Db, categoryId: number, forward: CategoryForward | null, now: number): { changed: boolean } | null {
  return db.tx(() => {
    const row = db.get<{ forward_json: string | null }>("SELECT forward_json FROM categories WHERE id = ?", categoryId);
    if (!row) return null;
    const prev = readRuleState(row.forward_json);
    const next = nextCategoryState(prev, forward, now);
    db.run("UPDATE categories SET forward_json = ? WHERE id = ?", next ? JSON.stringify(next) : null, categoryId);
    const changed = !next || !next.enabled || next.rev !== prev?.rev;
    if (prev && changed) cancelRule(db, { kind: "category", id: categoryId }, "forward.reason.ruleChanged", now);
    return { changed };
  });
}

/** A filter was saved or deleted: its forwards made under another revision stop waiting. */
export function filterForwardChanged(db: Db, filterId: number, now: number): void {
  const rule = filterRule(db, filterId);
  for (const r of db.all<{ id: number; rev: number }>("SELECT id, rev FROM forwards WHERE rule_kind = 'filter' AND rule_id = ? AND state IN ('waiting', 'held')", filterId)) {
    if (!rule || !ruleCurrent(rule.state, r.rev, rule.filterEnabled)) settle(db, r.id, "cancelled", "forward.reason.ruleChanged", now);
  }
}

/** Ingest's part (in its transaction): live mail it inserted that may be forwarded. */
export function markEligible(db: Db, messageIds: readonly number[], now: number): void {
  if (!messageIds.length) return;
  db.run(
    `INSERT OR IGNORE INTO forward_eligible (message_id, arrived_at)
     SELECT m.id, ? FROM messages m
     WHERE m.id IN (SELECT value FROM json_each(?)) AND m.is_sent = 0 AND m.is_draft = 0 AND m.date >= ?
       AND lower(m.from_email) NOT IN (SELECT lower(email) FROM accounts)
       AND NOT EXISTS (SELECT 1 FROM correspondents c WHERE c.email = lower(m.from_email) AND c.own = 1)`,
    now,
    ids(messageIds),
    now - FORWARD_MAX_AGE_MS,
  );
}

interface Eligible {
  message_id: number;
  arrived_at: number;
  thread_id: number;
  account_id: number;
}

export function planForwards(db: Db, p: { messageIds?: readonly number[]; threadIds?: readonly number[]; filed?: readonly number[]; agentFiles: boolean; now: number }): ForwardRow[] {
  return db.tx(() => {
    const rules = liveRules(db);
    if (!rules.length) return [];
    const floor = p.now - FORWARD_ELIGIBLE_MS;
    const eligible: Eligible[] = [];
    const base = "SELECT e.message_id, e.arrived_at, m.thread_id, m.account_id FROM forward_eligible e JOIN messages m ON m.id = e.message_id WHERE e.arrived_at >= ? AND m.is_trash = 0 AND m.is_spam = 0";
    if (p.messageIds?.length) eligible.push(...db.all<Eligible>(`${base} AND e.message_id IN (SELECT value FROM json_each(?))`, floor, ids(p.messageIds)));
    if (p.threadIds?.length) eligible.push(...db.all<Eligible>(`${base} AND m.thread_id IN (SELECT value FROM json_each(?))`, floor, ids(p.threadIds)));
    if (!eligible.length) return [];
    const filed = new Set(p.filed ?? []);
    const made: ForwardRow[] = [];
    const seen = new Set<number>();
    for (const e of eligible) {
      if (seen.has(e.message_id)) continue;
      seen.add(e.message_id);
      for (const rule of rules) {
        if (e.arrived_at < rule.state.since) continue;
        if (rule.ref.kind === "category") {
          const m = db.get<{ added_by: AddedBy; added_at: number }>("SELECT added_by, added_at FROM thread_categories WHERE thread_id = ? AND category_id = ?", e.thread_id, rule.ref.id);
          if (!m || !membershipForwards({ addedBy: m.added_by, addedAt: m.added_at }, e.arrived_at, { filed: filed.has(e.thread_id), agentFiles: p.agentFiles })) continue;
        } else if (!db.get("SELECT 1 FROM filter_applications WHERE filter_id = ? AND message_id = ? AND applied_at <= ?", rule.ref.id, e.message_id, e.arrived_at + FORWARD_FILTER_LAG_MS)) continue;
        const existing = db.get<Raw>("SELECT * FROM forwards WHERE message_id = ? AND rule_kind = ? AND rule_id = ?", e.message_id, rule.ref.kind, rule.ref.id);
        // a forward Terno cancelled because the mail left the category goes again when the user files it back by hand
        if (existing && !(existing.state === "cancelled" && existing.reason === "forward.reason.left" && filed.has(e.thread_id))) continue;
        if (existing) db.run("DELETE FROM forwards WHERE id = ?", existing.id);
        const id = Number(db.run(
          `INSERT INTO forwards (message_id, thread_id, account_id, rule_kind, rule_id, rev, to_json, state, due_at, op_ids_json, created_at, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, '[]', ?, ?)`,
          e.message_id, e.thread_id, e.account_id, rule.ref.kind, rule.ref.id, rule.state.rev, JSON.stringify(rule.to), p.now + FORWARD_DELAY_MS, p.now, p.now,
        ).lastInsertRowid);
        made.push(getForward(db, id)!);
      }
    }
    return made;
  });
}

export function eligiblePage(db: Db, now: number, after: number, limit: number): number[] {
  return db.all<{ message_id: number }>("SELECT message_id FROM forward_eligible WHERE message_id > ? AND arrived_at >= ? ORDER BY message_id LIMIT ?", after, now - FORWARD_ELIGIBLE_MS, limit).map((r) => r.message_id);
}

export function getForward(db: Db, id: number): ForwardRow | null {
  const r = db.get<Raw>("SELECT * FROM forwards WHERE id = ?", id);
  return r ? toRow(r) : null;
}

export function listForwards(db: Db, limit: number): ForwardRow[] {
  const open = db.all<Raw>("SELECT * FROM forwards WHERE state IN ('waiting', 'held', 'sending', 'queued') ORDER BY id DESC LIMIT ?", limit);
  const settled = db.all<Raw>("SELECT * FROM forwards WHERE state IN ('cancelled', 'failed') ORDER BY at DESC, id DESC LIMIT ?", Math.max(0, limit - open.length));
  return [...open, ...settled].map(toRow);
}

/** Forwards a rule made in the cap's window (claimed: on their way or gone). */
const madeLately = (db: Db, ref: ForwardRuleRef, now: number) =>
  db.get<{ n: number }>("SELECT COUNT(*) AS n FROM forwards WHERE rule_kind = ? AND rule_id = ? AND claimed_at >= ?", ref.kind, ref.id, now - FORWARD_CAP_WINDOW_MS)!.n;

export function forwardHolds(db: Db, now: number): ForwardHold[] {
  return db.all<{ rule_kind: ForwardRuleKind; rule_id: number; held: number }>("SELECT rule_kind, rule_id, COUNT(*) AS held FROM forwards WHERE state = 'held' GROUP BY rule_kind, rule_id").map((r) => {
    const rule: ForwardRuleRef = { kind: r.rule_kind, id: r.rule_id };
    return { rule, held: r.held, count: madeLately(db, rule, now) };
  });
}

export function nextForwardDue(db: Db): number | null {
  return db.get<{ due: number | null }>("SELECT MIN(due_at) AS due FROM forwards WHERE state = 'waiting'")?.due ?? null;
}

export function cancelForwards(db: Db, list: readonly number[], now: number): ForwardRow[] {
  return db.tx(() => {
    const out: ForwardRow[] = [];
    for (const id of new Set(list)) {
      const r = db.get<{ state: ForwardRowState }>("SELECT state FROM forwards WHERE id = ?", id);
      if (r?.state !== "waiting" && r?.state !== "held") continue;
      settle(db, id, "cancelled", null, now);
      out.push(getForward(db, id)!);
    }
    return out;
  });
}

export function claimForward(db: Db, id: number, now: number, o: { filesMissing: boolean; own: readonly string[] }): ForwardClaim {
  return db.tx((): ForwardClaim => {
    const raw = db.get<Raw>("SELECT * FROM forwards WHERE id = ?", id);
    if (!raw || raw.state !== "waiting" || raw.due_at > now) return { kind: "none" };
    const cancel = (reason: string): ForwardClaim => {
      settle(db, id, "cancelled", reason, now);
      return { kind: "cancelled", row: getForward(db, id)! };
    };
    const ref: ForwardRuleRef = { kind: raw.rule_kind, id: raw.rule_id };
    const rule = ruleOf(db, ref);
    if (!rule || !ruleCurrent(rule.state, raw.rev, rule.filterEnabled)) return cancel("forward.reason.ruleChanged");
    const m = db.get<{ is_trash: number; is_spam: number; thread_id: number; from_email: string }>("SELECT is_trash, is_spam, thread_id, from_email FROM messages WHERE id = ?", raw.message_id);
    if (!m) return cancel("forward.reason.gone");
    if (m.is_trash || m.is_spam) return cancel("forward.reason.trash");
    if (ref.kind === "category" && !db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", m.thread_id, ref.id)) return cancel("forward.reason.left");
    if (rule.state.approvedUntil < now && madeLately(db, ref, now) >= FORWARD_CAP) {
      db.run("UPDATE forwards SET state = 'held', at = ? WHERE id = ?", now, id);
      return { kind: "held", row: getForward(db, id)! };
    }
    // never to the sender, nor to myself; an address another forward of this message owns is that one's
    const skip = new Set([m.from_email.toLowerCase(), ...o.own.map((e) => e.toLowerCase())]);
    const to: Address[] = [];
    for (const a of forwardAddresses(JSON.parse(raw.to_json) as Address[])) {
      const address = a.email.toLowerCase();
      if (skip.has(address)) continue;
      const owner = db.get<{ forward_id: number }>("SELECT forward_id FROM forward_recipients WHERE message_id = ? AND address = ?", raw.message_id, address);
      if (owner && owner.forward_id !== id) continue;
      if (!owner) db.run("INSERT INTO forward_recipients (message_id, address, forward_id) VALUES (?, ?, ?)", raw.message_id, address, id);
      to.push(a);
    }
    if (!to.length) return cancel("forward.reason.alreadySent");
    const chunks = forwardChunks(to);
    db.run(
      "UPDATE forwards SET state = 'sending', to_json = ?, op_ids_json = ?, files_missing = ?, claimed_at = coalesce(claimed_at, ?), reason = NULL, at = ? WHERE id = ?",
      JSON.stringify(to), JSON.stringify(chunks.map(() => null)), o.filesMissing ? 1 : 0, now, now, id,
    );
    return { kind: "go", row: getForward(db, id)!, chunks, filesMissing: o.filesMissing };
  });
}

export function waitForFiles(db: Db, id: number, until: number, now: number): boolean {
  return db.run("UPDATE forwards SET due_at = ?, files_until = ?, at = ? WHERE id = ? AND state = 'waiting'", until, until, now, id).changes > 0;
}

/** queueSend's fence (in its transaction): this send of a claimed forward isn't queued yet. */
export function forwardSendOpen(db: Db, f: { id: number; chunk: number }): boolean {
  const r = db.get<{ state: ForwardRowState; op_ids_json: string }>("SELECT state, op_ids_json FROM forwards WHERE id = ?", f.id);
  if (r?.state !== "sending") return false;
  const ops = JSON.parse(r.op_ids_json) as (string | null)[];
  return f.chunk >= 0 && f.chunk < ops.length && ops[f.chunk] === null;
}

/** queueSend's link (in its transaction): the send is queued; every send queued, the forward is too. */
export function linkForwardSend(db: Db, f: { id: number; chunk: number }, opId: string, now: number): void {
  const r = db.get<{ op_ids_json: string }>("SELECT op_ids_json FROM forwards WHERE id = ?", f.id)!;
  const ops = JSON.parse(r.op_ids_json) as (string | null)[];
  ops[f.chunk] = opId;
  db.run("UPDATE forwards SET op_ids_json = ?, state = ?, at = ? WHERE id = ?", JSON.stringify(ops), ops.every(Boolean) ? "queued" : "sending", now, f.id);
}

export function failForward(db: Db, id: number, reason: string, now: number): void {
  db.tx(() => {
    const r = db.get<{ state: ForwardRowState; op_ids_json: string }>("SELECT state, op_ids_json FROM forwards WHERE id = ?", id);
    if (r?.state !== "sending") return;
    const ops = JSON.parse(r.op_ids_json) as (string | null)[];
    // a send already queued goes on (its op says how it went); the forward is failed only when none was
    if (ops.some(Boolean)) {
      db.run("UPDATE forwards SET state = 'queued', op_ids_json = ?, reason = ?, at = ? WHERE id = ?", JSON.stringify(ops.filter(Boolean)), reason, now, id);
      return;
    }
    settle(db, id, "failed", reason, now);
  });
}

export function retryForward(db: Db, id: number, now: number, failedOps: readonly string[]): ForwardRow | null {
  return db.tx(() => {
    const r = db.get<Raw>("SELECT * FROM forwards WHERE id = ?", id);
    if (!r) return null;
    const ops = JSON.parse(r.op_ids_json) as (string | null)[];
    const failed = new Set(failedOps);
    // only when nothing could have gone: never a send that was accepted or whose outcome is unknown
    const retryable = r.state === "failed" || (r.state === "queued" && ops.length > 0 && ops.every((op) => op !== null && failed.has(op)));
    if (!retryable) return null;
    db.run("UPDATE forwards SET state = 'waiting', due_at = ?, files_until = NULL, op_ids_json = '[]', reason = NULL, at = ? WHERE id = ?", now, now, id);
    return getForward(db, id);
  });
}

function setRuleState(db: Db, ref: ForwardRuleRef, patch: Partial<ForwardRuleState>): boolean {
  const table = ref.kind === "category" ? "categories" : "filters";
  const row = db.get<{ forward_json: string | null }>(`SELECT forward_json FROM ${table} WHERE id = ?`, ref.id);
  const state = readRuleState(row?.forward_json);
  if (!state) return false;
  db.run(`UPDATE ${table} SET forward_json = ? WHERE id = ?`, JSON.stringify({ ...state, ...patch }), ref.id);
  return true;
}

export function approveRule(db: Db, ref: ForwardRuleRef, now: number): number {
  return db.tx(() => {
    if (!setRuleState(db, ref, { approvedUntil: now + FORWARD_APPROVAL_MS })) return 0;
    return Number(db.run("UPDATE forwards SET state = 'waiting', due_at = ?, at = ? WHERE rule_kind = ? AND rule_id = ? AND state = 'held'", now + FORWARD_DELAY_MS, now, ref.kind, ref.id).changes);
  });
}

export function stopRule(db: Db, ref: ForwardRuleRef, now: number): number {
  return db.tx(() => {
    setRuleState(db, ref, { enabled: false });
    return cancelRule(db, ref, "forward.reason.stopped", now);
  });
}

export function pruneForwards(db: Db, now: number): { cancelled: number } {
  return db.tx(() => {
    db.run("DELETE FROM forward_eligible WHERE arrived_at < ?", now - FORWARD_ELIGIBLE_MS);
    const stale = db.all<{ id: number }>("SELECT id FROM forwards WHERE state = 'held' AND at < ?", now - FORWARD_HELD_MS);
    for (const r of stale) settle(db, r.id, "cancelled", "forward.reason.unanswered", now);
    // settled history (a queued forward's ops say how it went, until the ops themselves are pruned)
    db.run("DELETE FROM forwards WHERE state IN ('cancelled', 'failed', 'queued') AND at < ?", now - FORWARD_HISTORY_MS);
    // claims outlive their message's eligibility only while their forward is on its way
    db.run(
      `DELETE FROM forward_recipients WHERE message_id NOT IN (SELECT message_id FROM forward_eligible)
       AND forward_id IN (SELECT id FROM forwards WHERE state IN ('queued', 'cancelled', 'failed'))`,
    );
    return { cancelled: stale.length };
  });
}

/** Plan 95: a mailbox restored from a backup sends nothing it had waiting. */
export function quarantineForwards(db: Db, reason: string, now: number): number {
  const open = db.all<{ id: number }>("SELECT id FROM forwards WHERE state IN ('waiting', 'held', 'sending')");
  for (const r of open) settle(db, r.id, "cancelled", reason, now);
  return open.length;
}
