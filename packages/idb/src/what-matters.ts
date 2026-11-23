import { NO_PREFERENCES, type PreferenceVerdict, type PreferencesDraft, type WhatMattersPreferences } from "@terno/core";
import {
  PREFERENCE_VERDICTS_MAX,
  PREFERENCES_DRAFT_KEY,
  PREFERENCES_KEY,
  WANTED_CLOSED_KEEP_MS,
  WANTED_LOOK_MARK_MS,
  WANTED_MARK_MS,
  WANTED_OPEN_MAX,
  WANTED_ORPHAN_KEEP_MS,
  type WantedFinish,
  type WantedLookCandidate,
  type WantedMark,
  type WantedPatch,
  type WantedRow,
  type WantedSnapshot,
} from "@terno/store";
import { received, receivedOwn } from "./ai-summaries";
import { getSetting, setSetting, T, type Ctx, type R } from "./mail";

/**
 * Plan 249 on IndexedDB (version 40), like SQL's (packages/db/src/what-matters.ts). The record, the verdicts and the wanted
 * items are early (the first screen places by them); the marks hang off messages, so what reads or writes them waits for
 * those. A command is one unit, as a SQLite transaction: a refusal writes nothing.
 */

const revisionOf = (c: Ctx): number => getSetting<WhatMattersPreferences>(c, PREFERENCES_KEY, NO_PREFERENCES).revision;

export const getPreferences = (c: Ctx): WhatMattersPreferences => ({ ...NO_PREFERENCES, ...getSetting<WhatMattersPreferences>(c, PREFERENCES_KEY, NO_PREFERENCES) });

export function savePreferences(c: Ctx, next: Omit<WhatMattersPreferences, "revision">, expect: number): WhatMattersPreferences | null {
  if (revisionOf(c) !== expect) return null;
  const saved: WhatMattersPreferences = { ...next, revision: expect + 1 };
  setSetting(c, PREFERENCES_KEY, saved);
  return saved;
}

export const getDraft = (c: Ctx): PreferencesDraft | null => getSetting<PreferencesDraft | null>(c, PREFERENCES_DRAFT_KEY, null);

export function putDraft(c: Ctx, draft: PreferencesDraft): boolean {
  const was = getDraft(c);
  if (was && was.seq > draft.seq) return false;
  setSetting(c, PREFERENCES_DRAFT_KEY, draft);
  return true;
}

// ─── verdicts ──────────────────────────────────────────────────────────────

type Verdict = PreferenceVerdict & { failed: boolean };
const toVerdict = (r: R): Verdict => ({ target: r.target, basis: r.basis, rules: JSON.parse(r.rules) as string[], at: r.at, failed: r.failed === 1 });

export function getVerdicts(c: Ctx, targets: readonly string[]): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const rows = T(c, "preference_verdicts");
  for (const target of targets) {
    const r = rows.get(target);
    if (r) out.set(target, toVerdict(r));
  }
  return out;
}

export function putVerdicts(c: Ctx, list: readonly (PreferenceVerdict & { failed?: boolean })[], expect: number): boolean {
  if (revisionOf(c) !== expect) return false;
  const rows = T(c, "preference_verdicts");
  for (const v of list) rows.put({ target: v.target, basis: v.basis, rules: JSON.stringify(v.rules), failed: v.failed ? 1 : 0, at: v.at });
  return true;
}

/** As SQL's: only when over `max` (the table has no order to seek by: sorted here, a bounded set). */
export function pruneVerdicts(c: Ctx, basis: string, keep: ReadonlySet<string>, max = PREFERENCE_VERDICTS_MAX): number {
  const rows = T(c, "preference_verdicts");
  let over = rows.size - max;
  if (over <= 0) return 0;
  const oldest = [...rows.all()].sort((a, b) => a.at - b.at || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  let n = 0;
  // other bases first (an Undo of Clear would bring one back, but the working set comes first), oldest first
  for (const r of oldest) {
    if (over <= 0) return n;
    if (r.basis === basis) continue;
    rows.deleteRow(r);
    n++;
    over--;
  }
  for (const r of oldest) {
    if (over <= 0) break;
    if (r.basis !== basis || keep.has(r.target)) continue;
    rows.deleteRow(r);
    n++;
    over--;
  }
  return n;
}

export function clearVerdicts(c: Ctx): void {
  const rows = T(c, "preference_verdicts");
  for (const r of rows.all()) rows.deleteRow(r);
}

// ─── wanted items ──────────────────────────────────────────────────────────

const toWanted = (r: R): WantedRow => ({
  id: r.id, threadId: r.thread_id, messageId: r.message_id, kind: r.kind, text: r.text, quote: r.quote, senderKey: r.sender_key, dueDay: r.due_day, dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1, actAt: r.act_at,
  deferredUntil: r.deferred_until ?? null, arrivedAt: r.arrived_at, state: r.state, closedReason: r.closed_reason ?? null, closedAt: r.closed_at ?? null, rules: JSON.parse(r.rules) as string[], orphanedAt: r.orphaned_at ?? null, fromLook: r.from_look === 1,
  revision: r.revision, model: r.model ?? null, provider: r.provider ?? null, promptVersion: r.prompt_version ?? null, createdAt: r.created_at,
});

const byAct = (a: R, b: R) => a.act_at - b.act_at || a.id - b.id;

export const activeWanted = (c: Ctx): WantedRow[] => T(c, "wanted_items").by("open", "open").sort(byAct).map(toWanted);
export const getWanted = (c: Ctx, id: number): WantedRow | null => {
  const r = T(c, "wanted_items").get(id);
  return r ? toWanted(r) : null;
};
export const threadWanted = (c: Ctx, threadId: number): WantedRow[] => T(c, "wanted_items").by("fk_thread_id", threadId).filter((r) => r.state === "open").sort(byAct).map(toWanted);

const sameQuote = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();

export function finishWanted(c: Ctx, w: WantedFinish): "written" | "stale" | "gone" {
  const marks = T(c, "wanted_marks");
  const mark = marks.get(w.messageId);
  if (!mark) return "gone";
  if (revisionOf(c) !== w.revision) return "stale";
  const rows = T(c, "wanted_items");
  let open = rows.count("open", "open");
  for (const row of w.rows) {
    const quote = sameQuote(row.quote);
    const there = rows.by("message", w.messageId).find((r) => r.kind === row.kind && r.due_day === row.dueDay && sameQuote(r.quote) === quote);
    if (there) {
      // the same item, another rule that wants it: it shows while any of them is current (the Codex review's revision 12)
      rows.update(there, { rules: JSON.stringify([...new Set([...(JSON.parse(there.rules) as string[]), ...row.rules])]), orphaned_at: null });
      continue;
    }
    if (open >= WANTED_OPEN_MAX) continue;
    rows.put({
      // the mark's thread: a merge since the read moved it (the caller's may be gone)
      thread_id: mark.thread_id, message_id: w.messageId, kind: row.kind, text: row.text, quote: row.quote, sender_key: w.senderKey, due_day: row.dueDay, due_at: row.dueAt, timed: row.timed ? 1 : 0, dated: row.dated ? 1 : 0, act_at: row.actAt,
      deferred_until: null, arrived_at: w.arrivedAt, state: "open", closed_reason: null, closed_at: null, rules: JSON.stringify([...new Set(row.rules)]), orphaned_at: null, from_look: w.fromLook ? 1 : 0, revision: 0,
      model: w.model, provider: w.provider, prompt_version: w.promptVersion, created_at: w.now,
    });
    open++;
  }
  marks.deleteRow(mark);
  return "written";
}

const snapshotOf = (r: R): WantedSnapshot => ({ id: r.id, revision: r.revision, state: r.state, deferredUntil: r.deferred_until ?? null, closedReason: r.closed_reason ?? null, closedAt: r.closed_at ?? null });

/** As SQL's, all or none: every change is checked before any is written (one id named twice is refused, as its second would be there). */
export function actWanted(c: Ctx, changes: readonly { id: number; revision: number; patch: WantedPatch }[]): WantedSnapshot[] | null {
  const rows = T(c, "wanted_items");
  if (new Set(changes.map((x) => x.id)).size !== changes.length || !changes.every((x) => rows.get(x.id)?.revision === x.revision)) return null;
  return changes.map(({ id, patch: p }) => {
    const r = rows.get(id)!;
    const before = snapshotOf(r);
    rows.update(r, {
      state: p.state ?? r.state, deferred_until: p.deferredUntil !== undefined ? p.deferredUntil : before.deferredUntil, closed_reason: p.closedReason !== undefined ? p.closedReason : before.closedReason, closed_at: p.closedAt !== undefined ? p.closedAt : before.closedAt, revision: r.revision + 1,
    });
    return before;
  });
}

export function restoreWanted(c: Ctx, before: readonly WantedSnapshot[]): boolean {
  const rows = T(c, "wanted_items");
  if (new Set(before.map((s) => s.id)).size !== before.length || !before.every((s) => rows.get(s.id)?.revision === s.revision + 1)) return false;
  for (const s of before) {
    const r = rows.get(s.id)!;
    rows.update(r, { state: s.state, deferred_until: s.deferredUntil, closed_reason: s.closedReason, closed_at: s.closedAt, revision: r.revision + 1 });
  }
  return true;
}

export function reconcileWanted(c: Ctx, current: ReadonlySet<string>, now: number): number {
  const rows = T(c, "wanted_items");
  let n = 0;
  for (const r of rows.all()) {
    const live = (JSON.parse(r.rules) as string[]).some((k) => current.has(k));
    const orphanedAt: number | null = live ? null : (r.orphaned_at ?? now);
    if ((orphanedAt !== null && orphanedAt < now - WANTED_ORPHAN_KEEP_MS) || (r.state !== "open" && (r.closed_at ?? r.created_at) < now - WANTED_CLOSED_KEEP_MS)) {
      rows.deleteRow(r);
      n++;
    } else if (orphanedAt !== (r.orphaned_at ?? null)) rows.update(r, { orphaned_at: orphanedAt });
  }
  return n;
}

// ─── marks ─────────────────────────────────────────────────────────────────

/** A merge: the wanted items and their marks follow their thread. */
export function mergeWanted(c: Ctx, into: number, from: number): void {
  const marks = T(c, "wanted_marks");
  for (const m of marks.by("thread", from)) marks.update(m, { thread_id: into });
  const rows = T(c, "wanted_items");
  for (const r of rows.by("fk_thread_id", from)) rows.update(r, { thread_id: into, revision: r.revision + 1 });
}

/** As SQL's: received mail only, never Spam or Trash; the thread is the message's own. */
export function addWantedMark(c: Ctx, m: Omit<WantedMark, "queuedAt">, now: number): boolean {
  const message = T(c, "messages").get(m.messageId);
  if (!message || !received(message, receivedOwn(c))) return false;
  return T(c, "wanted_marks").insert({ message_id: m.messageId, thread_id: message.thread_id, arrived_at: m.arrivedAt, queued_at: now, source: m.source });
}

const toMark = (r: R): WantedMark => ({ messageId: r.message_id, threadId: r.thread_id, arrivedAt: r.arrived_at, queuedAt: r.queued_at, source: r.source });

/** As SQL's: live before the look back, newest first (sorted here: a bounded set, and the table has no order). */
export const wantedMarkPage = (c: Ctx, limit: number): WantedMark[] =>
  [...T(c, "wanted_marks").all()]
    .sort((a, b) => Number(a.source === "look") - Number(b.source === "look") || b.arrived_at - a.arrived_at || b.message_id - a.message_id)
    .slice(0, Math.max(0, limit))
    .map(toMark);

export function pruneWantedMarks(c: Ctx, now: number): number {
  const marks = T(c, "wanted_marks");
  const old = [...marks.all()].filter((r) => r.queued_at < now - (r.source === "look" ? WANTED_LOOK_MARK_MS : WANTED_MARK_MS));
  for (const r of old) marks.deleteRow(r);
  return old.length;
}

export function clearLookMarks(c: Ctx): void {
  const marks = T(c, "wanted_marks");
  for (const r of marks.by("source", "look")) marks.deleteRow(r);
}

export const countWantedMarks = (c: Ctx, source?: WantedMark["source"]): number => (source ? T(c, "wanted_marks").count("source", source) : T(c, "wanted_marks").size);

/**
 * As SQL's, without its date index: the conversations active since then (the threads' own order, newest first, left at the
 * first one older) and only their messages since then, only those sorted.
 */
export function wantedLookCandidates(c: Ctx, from: number, walk: number): WantedLookCandidate[] {
  const own = receivedOwn(c);
  const threads = T(c, "threads");
  const messages = T(c, "messages");
  const out: R[] = [];
  for (const id of c.order.current(threads)) {
    if (threads.get(id)!.last_date < from) break;
    for (const m of messages.by("fk_thread_id", id)) if (m.date >= from && received(m, own)) out.push(m);
  }
  return out
    .sort((a, b) => b.date - a.date || b.id - a.id)
    .slice(0, Math.max(0, walk))
    .map((m) => ({ id: m.id, threadId: m.thread_id, accountId: m.account_id, subject: m.subject, fromName: m.from_name, fromEmail: m.from_email, date: m.date }));
}

export function clearWanted(c: Ctx): void {
  const rows = T(c, "wanted_items");
  for (const r of rows.all()) rows.deleteRow(r);
  const marks = T(c, "wanted_marks");
  for (const r of marks.all()) marks.deleteRow(r);
}
