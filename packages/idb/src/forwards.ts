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
  type ForwardRuleRef,
} from "@terno/core";
import { forwardAction, membershipForwards, nextCategoryState, nextFilterState, readRuleState, ruleCurrent, type AddedBy, type ForwardClaim, type ForwardHold, type ForwardRow, type ForwardRuleState } from "@terno/store";
import { T, type Ctx, type R } from "./mail";

/** Plan 116's forwards on IndexedDB, like SQL's (packages/db/src/forwards.ts). */

const toRow = (r: R): ForwardRow => ({
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
  filesUntil: r.files_until ?? null,
  filesMissing: r.files_missing === 1,
  opIds: JSON.parse(r.op_ids_json) as (string | null)[],
  reason: r.reason ?? null,
  createdAt: r.created_at,
  claimedAt: r.claimed_at ?? null,
  at: r.at,
});

interface Rule {
  ref: ForwardRuleRef;
  state: ForwardRuleState;
  to: Address[];
  filterEnabled: boolean;
}

function categoryRule(c: Ctx, id: number): Rule | null {
  const state = readRuleState(T(c, "categories").get(id)?.forward_json);
  return state ? { ref: { kind: "category", id }, state, to: state.addresses ?? [], filterEnabled: true } : null;
}

function filterRule(c: Ctx, id: number): Rule | null {
  const r = T(c, "filters").get(id);
  const state = readRuleState(r?.forward_json);
  const action = r ? forwardAction(JSON.parse(r.rule_json) as FilterRule) : null;
  return state && action ? { ref: { kind: "filter", id }, state, to: forwardAddresses(action.to), filterEnabled: r!.enabled === 1 } : null;
}

const ruleOf = (c: Ctx, ref: ForwardRuleRef) => (ref.kind === "category" ? categoryRule(c, ref.id) : filterRule(c, ref.id));

function liveRules(c: Ctx): Rule[] {
  const out: Rule[] = [];
  for (const r of T(c, "categories").all()) {
    if (!r.forward_json) continue;
    const rule = categoryRule(c, r.id);
    if (rule?.state.enabled) out.push(rule);
  }
  for (const r of T(c, "filters").all()) {
    if (!r.forward_json || r.enabled !== 1) continue;
    const rule = filterRule(c, r.id);
    if (rule?.state.enabled) out.push(rule);
  }
  return out;
}

export const forwardsActive = (c: Ctx): boolean => liveRules(c).length > 0;

function settle(c: Ctx, row: R, state: "cancelled" | "failed", reason: string | null, now: number): void {
  T(c, "forwards").update(row, { state, reason, at: now });
  for (const claim of T(c, "forward_recipients").by("fk_forward_id", row.id)) T(c, "forward_recipients").deleteRow(claim);
}

function cancelRule(c: Ctx, ref: ForwardRuleRef, reason: string, now: number): number {
  let n = 0;
  for (const r of T(c, "forwards").by("rule", ref.kind, ref.id)) {
    if (r.state !== "waiting" && r.state !== "held") continue;
    settle(c, r, "cancelled", reason, now);
    n++;
  }
  return n;
}

export function setCategoryForward(c: Ctx, categoryId: number, forward: CategoryForward | null, now: number): { changed: boolean } | null {
  const categories = T(c, "categories");
  const row = categories.get(categoryId);
  if (!row) return null;
  const prev = readRuleState(row.forward_json);
  const next = nextCategoryState(prev, forward, now);
  categories.update(row, { forward_json: next ? JSON.stringify(next) : null });
  const changed = !next || !next.enabled || next.rev !== prev?.rev;
  if (prev && changed) cancelRule(c, { kind: "category", id: categoryId }, "forward.reason.ruleChanged", now);
  return { changed };
}

/** A filter was saved (mail.ts saveFilter): its state, and its forwards made under another revision stop waiting. */
export function saveFilterForward(c: Ctx, id: number, wasEnabled: boolean, now: number): void {
  const row = T(c, "filters").get(id);
  if (!row) return;
  const next = nextFilterState(readRuleState(row.forward_json), JSON.parse(row.rule_json) as FilterRule, row.enabled === 1, wasEnabled, now);
  T(c, "filters").update(row, { forward_json: next ? JSON.stringify(next) : null });
  const rule = filterRule(c, id);
  for (const r of T(c, "forwards").by("rule", "filter", id)) {
    if ((r.state === "waiting" || r.state === "held") && (!rule || !ruleCurrent(rule.state, r.rev, rule.filterEnabled))) settle(c, r, "cancelled", "forward.reason.ruleChanged", now);
  }
}

function ownAddresses(c: Ctx): Set<string> {
  const own = new Set<string>();
  for (const a of T(c, "accounts").all()) own.add(String(a.email).toLowerCase());
  for (const k of T(c, "correspondents").keysBy("own", 1)) own.add(String(k).toLowerCase());
  return own;
}

/** Ingest's part (in its command): live mail it inserted that may be forwarded. */
export function markEligible(c: Ctx, messageIds: readonly number[], now: number): void {
  if (!messageIds.length) return;
  const messages = T(c, "messages");
  const eligible = T(c, "forward_eligible");
  const own = ownAddresses(c);
  for (const id of messageIds) {
    const m = messages.get(id);
    if (!m || m.is_sent || m.is_draft || m.date < now - FORWARD_MAX_AGE_MS || own.has(String(m.from_email).toLowerCase()) || eligible.has(id)) continue;
    eligible.insert({ message_id: id, arrived_at: now });
  }
}

export function planForwards(c: Ctx, p: { messageIds?: readonly number[]; threadIds?: readonly number[]; filed?: readonly number[]; agentFiles: boolean; now: number }): ForwardRow[] {
  const rules = liveRules(c);
  if (!rules.length) return [];
  const floor = p.now - FORWARD_ELIGIBLE_MS;
  const messages = T(c, "messages");
  const eligibleTable = T(c, "forward_eligible");
  const candidates = new Set<number>(p.messageIds ?? []);
  for (const t of p.threadIds ?? []) for (const k of messages.keysBy("fk_thread_id", t)) candidates.add(Number(k));
  const filed = new Set(p.filed ?? []);
  const forwards = T(c, "forwards");
  const made: ForwardRow[] = [];
  for (const messageId of [...candidates].sort((a, b) => a - b)) {
    const e = eligibleTable.get(messageId);
    const m = messages.get(messageId);
    if (!e || !m || e.arrived_at < floor || m.is_trash || m.is_spam) continue;
    for (const rule of rules) {
      if (e.arrived_at < rule.state.since) continue;
      if (rule.ref.kind === "category") {
        const membership = T(c, "thread_categories").get(m.thread_id, rule.ref.id);
        if (!membership || !membershipForwards({ addedBy: membership.added_by as AddedBy, addedAt: membership.added_at ?? 0 }, e.arrived_at, { filed: filed.has(m.thread_id), agentFiles: p.agentFiles })) continue;
      } else {
        const applied = T(c, "filter_applications").get(rule.ref.id, messageId);
        if (!applied || applied.applied_at > e.arrived_at + FORWARD_FILTER_LAG_MS) continue;
      }
      const existing = forwards.by("message_rule", messageId, rule.ref.kind, rule.ref.id)[0];
      if (existing && !(existing.state === "cancelled" && existing.reason === "forward.reason.left" && filed.has(m.thread_id))) continue;
      if (existing) forwards.deleteRow(existing);
      const row: R = {
        id: undefined, message_id: messageId, thread_id: m.thread_id, account_id: m.account_id, rule_kind: rule.ref.kind, rule_id: rule.ref.id, rev: rule.state.rev,
        to_json: JSON.stringify(rule.to), state: "waiting", due_at: p.now + FORWARD_DELAY_MS, files_until: null, files_missing: 0, op_ids_json: "[]", reason: null,
        created_at: p.now, claimed_at: null, at: p.now,
      };
      forwards.insert(row);
      made.push(toRow(row));
    }
  }
  return made;
}

export function eligiblePage(c: Ctx, now: number, after: number, limit: number): number[] {
  const out: number[] = [];
  for (const r of T(c, "forward_eligible").all()) if (r.message_id > after && r.arrived_at >= now - FORWARD_ELIGIBLE_MS) out.push(r.message_id);
  return out.sort((a, b) => a - b).slice(0, limit);
}

export function getForward(c: Ctx, id: number): ForwardRow | null {
  const r = T(c, "forwards").get(id);
  return r ? toRow(r) : null;
}

const OPEN = new Set(["waiting", "held", "sending", "queued"]);

export function listForwards(c: Ctx, limit: number): ForwardRow[] {
  const open: R[] = [], settled: R[] = [];
  for (const r of T(c, "forwards").all()) (OPEN.has(r.state) ? open : r.state === "cancelled" || r.state === "failed" ? settled : null)?.push(r);
  open.sort((a, b) => b.id - a.id);
  settled.sort((a, b) => b.at - a.at || b.id - a.id);
  const first = open.slice(0, limit);
  return [...first, ...settled.slice(0, Math.max(0, limit - first.length))].map(toRow);
}

function madeLately(c: Ctx, ref: ForwardRuleRef, now: number): number {
  let n = 0;
  for (const r of T(c, "forwards").by("rule", ref.kind, ref.id)) if (r.claimed_at != null && r.claimed_at >= now - FORWARD_CAP_WINDOW_MS) n++;
  return n;
}

export function forwardHolds(c: Ctx, now: number): ForwardHold[] {
  const held = new Map<string, { rule: ForwardRuleRef; held: number }>();
  for (const r of T(c, "forwards").by("state", "held")) {
    const key = `${r.rule_kind}:${r.rule_id}`;
    const h = held.get(key) ?? { rule: { kind: r.rule_kind, id: r.rule_id }, held: 0 };
    h.held++;
    held.set(key, h);
  }
  return [...held.values()].map((h) => ({ ...h, count: madeLately(c, h.rule, now) }));
}

export function nextForwardDue(c: Ctx): number | null {
  let due: number | null = null;
  for (const r of T(c, "forwards").by("state", "waiting")) if (due === null || r.due_at < due) due = r.due_at;
  return due;
}

export function cancelForwards(c: Ctx, ids: readonly number[], now: number): ForwardRow[] {
  const out: ForwardRow[] = [];
  for (const id of new Set(ids)) {
    const r = T(c, "forwards").get(id);
    if (r?.state !== "waiting" && r?.state !== "held") continue;
    settle(c, r, "cancelled", null, now);
    out.push(getForward(c, id)!);
  }
  return out;
}

export function claimForward(c: Ctx, id: number, now: number, o: { filesMissing: boolean; own: readonly string[] }): ForwardClaim {
  const forwards = T(c, "forwards");
  const raw = forwards.get(id);
  if (!raw || raw.state !== "waiting" || raw.due_at > now) return { kind: "none" };
  const cancel = (reason: string): ForwardClaim => {
    settle(c, raw, "cancelled", reason, now);
    return { kind: "cancelled", row: getForward(c, id)! };
  };
  const ref: ForwardRuleRef = { kind: raw.rule_kind, id: raw.rule_id };
  const rule = ruleOf(c, ref);
  if (!rule || !ruleCurrent(rule.state, raw.rev, rule.filterEnabled)) return cancel("forward.reason.ruleChanged");
  const m = T(c, "messages").get(raw.message_id);
  if (!m) return cancel("forward.reason.gone");
  if (m.is_trash || m.is_spam) return cancel("forward.reason.trash");
  if (ref.kind === "category" && !T(c, "thread_categories").has(m.thread_id, ref.id)) return cancel("forward.reason.left");
  if (rule.state.approvedUntil < now && madeLately(c, ref, now) >= FORWARD_CAP) {
    forwards.update(raw, { state: "held", at: now });
    return { kind: "held", row: getForward(c, id)! };
  }
  const skip = new Set([String(m.from_email).toLowerCase(), ...o.own.map((e) => e.toLowerCase())]);
  const claims = T(c, "forward_recipients");
  const to: Address[] = [];
  for (const a of forwardAddresses(JSON.parse(raw.to_json) as Address[])) {
    const address = a.email.toLowerCase();
    if (skip.has(address)) continue;
    const owner = claims.get(raw.message_id, address);
    if (owner && owner.forward_id !== id) continue;
    if (!owner) claims.insert({ message_id: raw.message_id, address, forward_id: id });
    to.push(a);
  }
  if (!to.length) return cancel("forward.reason.alreadySent");
  const chunks = forwardChunks(to);
  forwards.update(raw, { state: "sending", to_json: JSON.stringify(to), op_ids_json: JSON.stringify(chunks.map(() => null)), files_missing: o.filesMissing ? 1 : 0, claimed_at: raw.claimed_at ?? now, reason: null, at: now });
  return { kind: "go", row: getForward(c, id)!, chunks, filesMissing: o.filesMissing };
}

export function waitForFiles(c: Ctx, id: number, until: number, now: number): boolean {
  const r = T(c, "forwards").get(id);
  if (r?.state !== "waiting") return false;
  T(c, "forwards").update(r, { due_at: until, files_until: until, at: now });
  return true;
}

export function forwardSendOpen(c: Ctx, f: { id: number; chunk: number }): boolean {
  const r = T(c, "forwards").get(f.id);
  if (r?.state !== "sending") return false;
  const ops = JSON.parse(r.op_ids_json) as (string | null)[];
  return f.chunk >= 0 && f.chunk < ops.length && ops[f.chunk] === null;
}

export function linkForwardSend(c: Ctx, f: { id: number; chunk: number }, opId: string, now: number): void {
  const r = T(c, "forwards").get(f.id)!;
  const ops = JSON.parse(r.op_ids_json) as (string | null)[];
  ops[f.chunk] = opId;
  T(c, "forwards").update(r, { op_ids_json: JSON.stringify(ops), state: ops.every(Boolean) ? "queued" : "sending", at: now });
}

export function failForward(c: Ctx, id: number, reason: string, now: number): void {
  const r = T(c, "forwards").get(id);
  if (r?.state !== "sending") return;
  const ops = JSON.parse(r.op_ids_json) as (string | null)[];
  if (ops.some(Boolean)) {
    T(c, "forwards").update(r, { state: "queued", op_ids_json: JSON.stringify(ops.filter(Boolean)), reason, at: now });
    return;
  }
  settle(c, r, "failed", reason, now);
}

export function retryForward(c: Ctx, id: number, now: number, failedOps: readonly string[]): ForwardRow | null {
  const r = T(c, "forwards").get(id);
  if (!r) return null;
  const ops = JSON.parse(r.op_ids_json) as (string | null)[];
  const failed = new Set(failedOps);
  const retryable = r.state === "failed" || (r.state === "queued" && ops.length > 0 && ops.every((op) => op !== null && failed.has(op)));
  if (!retryable) return null;
  T(c, "forwards").update(r, { state: "waiting", due_at: now, files_until: null, op_ids_json: "[]", reason: null, at: now });
  return getForward(c, id);
}

function setRuleState(c: Ctx, ref: ForwardRuleRef, patch: Partial<ForwardRuleState>): boolean {
  const table = T(c, ref.kind === "category" ? "categories" : "filters");
  const row = table.get(ref.id);
  const state = readRuleState(row?.forward_json);
  if (!row || !state) return false;
  table.update(row, { forward_json: JSON.stringify({ ...state, ...patch }) });
  return true;
}

export function approveRule(c: Ctx, ref: ForwardRuleRef, now: number): number {
  if (!setRuleState(c, ref, { approvedUntil: now + FORWARD_APPROVAL_MS })) return 0;
  let n = 0;
  for (const r of T(c, "forwards").by("rule", ref.kind, ref.id)) {
    if (r.state !== "held") continue;
    T(c, "forwards").update(r, { state: "waiting", due_at: now + FORWARD_DELAY_MS, at: now });
    n++;
  }
  return n;
}

export function stopRule(c: Ctx, ref: ForwardRuleRef, now: number): number {
  setRuleState(c, ref, { enabled: false });
  return cancelRule(c, ref, "forward.reason.stopped", now);
}

export function pruneForwards(c: Ctx, now: number): { cancelled: number } {
  const eligible = T(c, "forward_eligible");
  for (const r of eligible.all()) if (r.arrived_at < now - FORWARD_ELIGIBLE_MS) eligible.deleteRow(r);
  const forwards = T(c, "forwards");
  let cancelled = 0;
  for (const r of forwards.by("state", "held")) {
    if (r.at >= now - FORWARD_HELD_MS) continue;
    settle(c, r, "cancelled", "forward.reason.unanswered", now);
    cancelled++;
  }
  for (const r of forwards.all()) {
    if ((r.state === "cancelled" || r.state === "failed" || r.state === "queued") && r.at < now - FORWARD_HISTORY_MS) forwards.deleteRow(r);
  }
  const claims = T(c, "forward_recipients");
  for (const r of claims.all()) {
    const owner = forwards.get(r.forward_id);
    if (!eligible.has(r.message_id) && owner && (owner.state === "queued" || owner.state === "cancelled" || owner.state === "failed")) claims.deleteRow(r);
  }
  return { cancelled };
}
