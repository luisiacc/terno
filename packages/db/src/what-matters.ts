import { NO_PREFERENCES, type DatedKind, type PreferenceVerdict, type PreferencesDraft, type WhatMattersPreferences } from "@terno/core";
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
  type WantedState,
} from "@terno/store";
import { RECEIVED_SQL } from "./ai-summaries";
import { getSetting, setSetting } from "./repos";
import type { Db } from "./sqlite";

/** Plan 249 on SQLite (v77): the words' record, verdicts, wanted items and their marks. See packages/store/src/what-matters.ts. */

const revisionOf = (db: Db): number => getSetting<WhatMattersPreferences>(db, PREFERENCES_KEY, NO_PREFERENCES).revision;

export const getPreferences = (db: Db): WhatMattersPreferences => ({ ...NO_PREFERENCES, ...getSetting<WhatMattersPreferences>(db, PREFERENCES_KEY, NO_PREFERENCES) });

export function savePreferences(db: Db, next: Omit<WhatMattersPreferences, "revision">, expect: number): WhatMattersPreferences | null {
  return db.tx(() => {
    if (revisionOf(db) !== expect) return null;
    const saved: WhatMattersPreferences = { ...next, revision: expect + 1 };
    setSetting(db, PREFERENCES_KEY, saved);
    return saved;
  });
}

export const getDraft = (db: Db): PreferencesDraft | null => getSetting<PreferencesDraft | null>(db, PREFERENCES_DRAFT_KEY, null);

export function putDraft(db: Db, draft: PreferencesDraft): boolean {
  return db.tx(() => {
    const was = getDraft(db);
    if (was && was.seq > draft.seq) return false;
    setSetting(db, PREFERENCES_DRAFT_KEY, draft);
    return true;
  });
}

// ─── verdicts ──────────────────────────────────────────────────────────────

type VerdictRaw = { target: string; basis: string; rules: string; failed: number; at: number };
const toVerdict = (r: VerdictRaw): PreferenceVerdict & { failed: boolean } => ({ target: r.target, basis: r.basis, rules: JSON.parse(r.rules) as string[], at: r.at, failed: r.failed === 1 });

export function getVerdicts(db: Db, targets: readonly string[]): Map<string, PreferenceVerdict & { failed: boolean }> {
  const out = new Map<string, PreferenceVerdict & { failed: boolean }>();
  if (!targets.length) return out;
  for (const r of db.all<VerdictRaw>("SELECT * FROM preference_verdicts WHERE target IN (SELECT value FROM json_each(?))", JSON.stringify([...new Set(targets)]))) out.set(r.target, toVerdict(r));
  return out;
}

export function putVerdicts(db: Db, rows: readonly (PreferenceVerdict & { failed?: boolean })[], expect: number): boolean {
  return db.tx(() => {
    if (revisionOf(db) !== expect) return false;
    for (const v of rows) db.run("INSERT OR REPLACE INTO preference_verdicts (target, basis, rules, failed, at) VALUES (?, ?, ?, ?, ?)", v.target, v.basis, JSON.stringify(v.rules), v.failed ? 1 : 0, v.at);
    return true;
  });
}

export function pruneVerdicts(db: Db, basis: string, keep: ReadonlySet<string>, max = PREFERENCE_VERDICTS_MAX): number {
  return db.tx(() => {
    const total = db.get<{ n: number }>("SELECT count(*) AS n FROM preference_verdicts")!.n;
    let over = total - max;
    if (over <= 0) return 0;
    let n = 0;
    // other bases first (an Undo of Clear would bring one back, but the working set comes first), oldest first
    for (const r of db.all<{ target: string }>("SELECT target FROM preference_verdicts WHERE basis <> ? ORDER BY at LIMIT ?", basis, over)) {
      n += Number(db.run("DELETE FROM preference_verdicts WHERE target = ?", r.target).changes);
    }
    over -= n;
    if (over <= 0) return n;
    for (const r of db.all<{ target: string }>("SELECT target FROM preference_verdicts INDEXED BY preference_verdicts_at ORDER BY at")) {
      if (over <= 0) break;
      if (keep.has(r.target)) continue;
      n += Number(db.run("DELETE FROM preference_verdicts WHERE target = ?", r.target).changes);
      over--;
    }
    return n;
  });
}

// ─── wanted items ──────────────────────────────────────────────────────────

type WantedRaw = {
  id: number; thread_id: number; message_id: number; kind: DatedKind; text: string; quote: string; sender_key: string; due_day: string; due_at: number; timed: number; dated: number; act_at: number; deferred_until: number | null;
  arrived_at: number; state: WantedState; closed_reason: string | null; closed_at: number | null; rules: string; orphaned_at: number | null; from_look: number; revision: number; model: string | null; provider: string | null; prompt_version: number | null; created_at: number;
};
const toWanted = (r: WantedRaw): WantedRow => ({
  id: r.id, threadId: r.thread_id, messageId: r.message_id, kind: r.kind, text: r.text, quote: r.quote, senderKey: r.sender_key, dueDay: r.due_day, dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1, actAt: r.act_at,
  deferredUntil: r.deferred_until, arrivedAt: r.arrived_at, state: r.state, closedReason: r.closed_reason, closedAt: r.closed_at, rules: JSON.parse(r.rules) as string[], orphanedAt: r.orphaned_at, fromLook: r.from_look === 1,
  revision: r.revision, model: r.model, provider: r.provider, promptVersion: r.prompt_version, createdAt: r.created_at,
});

export const activeWanted = (db: Db): WantedRow[] => db.all<WantedRaw>("SELECT * FROM wanted_items INDEXED BY wanted_open WHERE state = 'open' ORDER BY act_at, id").map(toWanted);
export const getWanted = (db: Db, id: number): WantedRow | null => {
  const r = db.get<WantedRaw>("SELECT * FROM wanted_items WHERE id = ?", id);
  return r ? toWanted(r) : null;
};
export const threadWanted = (db: Db, threadId: number): WantedRow[] => db.all<WantedRaw>("SELECT * FROM wanted_items INDEXED BY wanted_thread WHERE thread_id = ? AND state = 'open' ORDER BY act_at, id", threadId).map(toWanted);

const sameQuote = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();

export function finishWanted(db: Db, w: WantedFinish): "written" | "stale" | "gone" {
  return db.tx(() => {
    const mark = db.get<{ thread_id: number }>("SELECT thread_id FROM wanted_marks WHERE message_id = ?", w.messageId);
    if (!mark) return "gone";
    if (revisionOf(db) !== w.revision) return "stale";
    let open = db.get<{ n: number }>("SELECT count(*) AS n FROM wanted_items INDEXED BY wanted_open WHERE state = 'open'")!.n;
    for (const row of w.rows) {
      const quote = sameQuote(row.quote);
      const there = db.all<{ id: number; rules: string; quote: string }>("SELECT id, rules, quote FROM wanted_items WHERE message_id = ? AND kind = ? AND due_day = ?", w.messageId, row.kind, row.dueDay).find((r) => sameQuote(r.quote) === quote);
      if (there) {
        // the same item, another rule that wants it: it shows while any of them is current (the Codex review's revision 12)
        const rules = [...new Set([...(JSON.parse(there.rules) as string[]), ...row.rules])];
        db.run("UPDATE wanted_items SET rules = ?, orphaned_at = NULL WHERE id = ?", JSON.stringify(rules), there.id);
        continue;
      }
      if (open >= WANTED_OPEN_MAX) continue;
      db.run(
        `INSERT INTO wanted_items (thread_id, message_id, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, arrived_at, state, rules, from_look, model, provider, prompt_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        // the mark's thread: a merge since the read moved it (the caller's may be gone, and the insert would fail its key)
        mark.thread_id, w.messageId, row.kind, row.text, row.quote, w.senderKey, row.dueDay, row.dueAt, row.timed ? 1 : 0, row.dated ? 1 : 0, row.actAt, w.arrivedAt, JSON.stringify([...new Set(row.rules)]), w.fromLook ? 1 : 0, w.model, w.provider, w.promptVersion, w.now,
      );
      open++;
    }
    db.run("DELETE FROM wanted_marks WHERE message_id = ?", w.messageId);
    return "written";
  });
}

const snapshotOf = (r: WantedRaw): WantedSnapshot => ({ id: r.id, revision: r.revision, state: r.state, deferredUntil: r.deferred_until, closedReason: r.closed_reason, closedAt: r.closed_at });

export function actWanted(db: Db, changes: readonly { id: number; revision: number; patch: WantedPatch }[]): WantedSnapshot[] | null {
  return rolledBack(() => db.tx(() => {
    const before: WantedSnapshot[] = [];
    for (const c of changes) {
      const r = db.get<WantedRaw>("SELECT * FROM wanted_items WHERE id = ? AND revision = ?", c.id, c.revision);
      if (!r) throw new StaleWanted();
      before.push(snapshotOf(r));
      const p = c.patch;
      db.run(
        "UPDATE wanted_items SET state = ?, deferred_until = ?, closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE id = ?",
        p.state ?? r.state, p.deferredUntil !== undefined ? p.deferredUntil : r.deferred_until, p.closedReason !== undefined ? p.closedReason : r.closed_reason, p.closedAt !== undefined ? p.closedAt : r.closed_at, c.id,
      );
    }
    return before;
  }), null);
}

/** thrown inside an act's transaction so it rolls back whole; the act returns its fallback for it */
class StaleWanted extends Error {}
function rolledBack<T, F>(fn: () => T, fallback: F): T | F {
  try {
    return fn();
  } catch (error) {
    if (error instanceof StaleWanted) return fallback;
    throw error;
  }
}

export function restoreWanted(db: Db, before: readonly WantedSnapshot[]): boolean {
  return rolledBack(() => db.tx(() => {
    for (const s of before) {
      const changed = Number(db.run("UPDATE wanted_items SET state = ?, deferred_until = ?, closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?", s.state, s.deferredUntil, s.closedReason, s.closedAt, s.id, s.revision + 1).changes);
      if (!changed) throw new StaleWanted();
    }
    return true;
  }), false);
}

export function reconcileWanted(db: Db, current: ReadonlySet<string>, now: number): number {
  return db.tx(() => {
    for (const r of db.all<{ id: number; rules: string; orphaned_at: number | null }>("SELECT id, rules, orphaned_at FROM wanted_items")) {
      const live = (JSON.parse(r.rules) as string[]).some((k) => current.has(k));
      if (live && r.orphaned_at !== null) db.run("UPDATE wanted_items SET orphaned_at = NULL WHERE id = ?", r.id);
      else if (!live && r.orphaned_at === null) db.run("UPDATE wanted_items SET orphaned_at = ? WHERE id = ?", now, r.id);
    }
    return (
      Number(db.run("DELETE FROM wanted_items WHERE orphaned_at IS NOT NULL AND orphaned_at < ?", now - WANTED_ORPHAN_KEEP_MS).changes) +
      Number(db.run("DELETE FROM wanted_items WHERE state <> 'open' AND coalesce(closed_at, created_at) < ?", now - WANTED_CLOSED_KEEP_MS).changes)
    );
  });
}

// ─── marks ─────────────────────────────────────────────────────────────────

/** A merge: the wanted items and their marks follow their thread. */
export function mergeWanted(db: Db, into: number, from: number): void {
  db.run("UPDATE wanted_marks SET thread_id = ? WHERE thread_id = ?", into, from);
  db.run("UPDATE wanted_items SET thread_id = ?, revision = revision + 1 WHERE thread_id = ?", into, from);
}

export function addWantedMark(db: Db, m: Omit<WantedMark, "queuedAt">, now: number): boolean {
  // received mail only, never Spam or Trash (the worker checks again before anything leaves)
  return Number(db.run(`INSERT OR IGNORE INTO wanted_marks (message_id, thread_id, arrived_at, queued_at, source) SELECT m.id, m.thread_id, ?, ?, ? FROM messages m WHERE m.id = ? AND ${RECEIVED_SQL}`, m.arrivedAt, now, m.source, m.messageId).changes) === 1;
}

type MarkRaw = { message_id: number; thread_id: number; arrived_at: number; queued_at: number; source: WantedMark["source"] };
export const wantedMarkPage = (db: Db, limit: number): WantedMark[] =>
  db
    .all<MarkRaw>("SELECT * FROM wanted_marks INDEXED BY wanted_marks_order ORDER BY source = 'look', arrived_at DESC, message_id DESC LIMIT ?", limit)
    .map((r) => ({ messageId: r.message_id, threadId: r.thread_id, arrivedAt: r.arrived_at, queuedAt: r.queued_at, source: r.source }));

export const pruneWantedMarks = (db: Db, now: number): number =>
  Number(db.run("DELETE FROM wanted_marks WHERE (source = 'live' AND queued_at < ?) OR (source = 'look' AND queued_at < ?)", now - WANTED_MARK_MS, now - WANTED_LOOK_MARK_MS).changes);

export const countWantedMarks = (db: Db, source?: WantedMark["source"]): number =>
  source ? db.get<{ n: number }>("SELECT count(*) AS n FROM wanted_marks WHERE source = ?", source)!.n : db.get<{ n: number }>("SELECT count(*) AS n FROM wanted_marks")!.n;

export function wantedLookCandidates(db: Db, from: number, walk: number): WantedLookCandidate[] {
  return db
    .all<{ id: number; thread_id: number; account_id: number; subject: string; from_name: string; from_email: string; date: number }>(
      `SELECT m.id, m.thread_id, m.account_id, m.subject, m.from_name, m.from_email, m.date FROM messages m INDEXED BY messages_date
       WHERE m.date >= ? AND ${RECEIVED_SQL} ORDER BY m.date DESC, m.id DESC LIMIT ?`,
      from,
      walk,
    )
    .map((r) => ({ id: r.id, threadId: r.thread_id, accountId: r.account_id, subject: r.subject, fromName: r.from_name, fromEmail: r.from_email, date: r.date }));
}

export function clearWanted(db: Db): void {
  db.tx(() => {
    db.run("DELETE FROM wanted_items");
    db.run("DELETE FROM wanted_marks");
  });
}
