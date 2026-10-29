import { COUNT_CAP, normalizeText, similarScopes, type SimilarAction, type SimilarOffers, type SimilarScope } from "@terno/core";
import { ownAddresses, rootRefs, type OwnAddresses } from "./categorize";
import type { Db, Param } from "./sqlite";

/** Where a thread must still be for the action to move it. */
const PLACE: Record<SimilarAction, string> = {
  archive: "t.in_inbox = 1 AND t.in_trash = 0 AND t.in_spam = 0",
  trash: "t.in_trash = 0 AND t.in_spam = 0",
  spam: "t.in_trash = 0 AND t.in_spam = 0",
};
/** Mail the user values: never swept along (an explicit target still is acted on). */
const KEPT = "(t.is_starred = 1 OR t.has_sent = 1)";

/**
 * The scope's (message, thread) pairs: received mail, not from the user's own
 * addresses, whose thread is still in place. One indexed probe per scope.
 */
function matchSql(scope: SimilarScope, action: SimilarAction, own: OwnAddresses): { sql: string; params: Param[] } {
  const by = (index: string, predicate: string, values: Param[]) => ({
    sql: `FROM messages m INDEXED BY ${index} JOIN threads t ON t.id = m.thread_id
          WHERE ${predicate} AND m.is_sent = 0 AND m.from_email NOT IN (SELECT value FROM json_each(?)) AND ${PLACE[action]}`,
    params: [...values, JSON.stringify([...own.emails])],
  });
  switch (scope.kind) {
    case "sender":
      return by("messages_from", "m.from_email = ?", [normalizeText(scope.email.trim())]);
    case "subject":
      // exactly what the rule's evaluators compare: the normalized subject, untrimmed (an offer never has padding)
      return by("messages_from", "m.from_email = ? AND m.subject_norm = ?", [normalizeText(scope.email.trim()), normalizeText(scope.subject)]);
    case "domain":
      return by("messages_domain", "m.from_domain = ?", [normalizeText(scope.domain.trim().replace(/^@/, ""))]);
    case "list":
      return by("messages_list", "m.list_id = ?", [normalizeText(scope.listId.trim())]);
  }
}

/** Distinct threads matching, stopping at `cap` (no ordering: a count). */
function countWhere(db: Db, m: { sql: string; params: Param[] }, extra: string, extraParams: Param[], cap: number): number {
  return db.get<{ c: number }>(`SELECT count(*) AS c FROM (SELECT DISTINCT m.thread_id ${m.sql} AND ${extra} LIMIT ?)`, ...m.params, ...extraParams, cap)!.c;
}

/**
 * Every thread to act on, newest first: the eligible ones (in place, not
 * starred or replied) plus the targets still in place; the starred or
 * replied ones that aren't targets are left out and counted.
 */
export function resolveSimilar(db: Db, scope: SimilarScope, action: SimilarAction, targets: readonly number[], own = ownAddresses(db)): { ids: number[]; skipped: number } {
  const m = matchSql(scope, action, own);
  const t = JSON.stringify([...new Set(targets)]);
  const ids = db
    .all<{ id: number }>(
      `SELECT t.id FROM threads t
       WHERE t.id IN (SELECT m.thread_id ${m.sql} AND (NOT ${KEPT} OR t.id IN (SELECT value FROM json_each(?))))
          OR (t.id IN (SELECT value FROM json_each(?)) AND ${PLACE[action]})
       ORDER BY t.last_date DESC, t.id DESC`,
      ...m.params,
      t,
      t,
    )
    .map((r) => r.id);
  return { ids, skipped: countWhere(db, m, `${KEPT} AND t.id NOT IN (SELECT value FROM json_each(?))`, [t], COUNT_CAP + 1) };
}

/** Which of these threads the user values now. */
export function keptThreads(db: Db, threadIds: readonly number[]): number[] {
  return db.all<{ id: number }>(`SELECT t.id FROM json_each(?) j JOIN threads t ON t.id = j.value WHERE ${KEPT}`, JSON.stringify([...new Set(threadIds)])).map((r) => r.id);
}

/** The roots' sender, subject, domain and list, in one read; null when a target has no received mail (nothing is shared). */
function rootFacts(db: Db, threadIds: readonly number[], own: OwnAddresses) {
  const refs = rootRefs(db, threadIds, own);
  if (refs.length === 0 || refs.length < new Set(threadIds).size) return null;
  return db.all<{ from_email: string; from_name: string; from_domain: string; subject: string; list_id: string | null }>(
    "SELECT m.from_email, m.from_name, m.from_domain, m.subject, m.list_id FROM json_each(?) j JOIN messages m ON m.id = j.value ORDER BY j.key",
    JSON.stringify(refs.map((r) => r.messageId)),
  );
}

/** More targets than this and nothing is offered (each one is checked, never a sample). */
export const OFFER_TARGETS_MAX = 200;

/** Plan 63's offers: what every target shares, each with how many threads it would move now (capped counts). */
export function similarOffers(db: Db, threadIds: readonly number[], action: SimilarAction): SimilarOffers {
  const own = ownAddresses(db);
  const targets = [...new Set(threadIds)];
  const roots = targets.length <= OFFER_TARGETS_MAX ? rootFacts(db, targets, own) : null;
  if (!roots) return { senderName: null, offers: [] };
  const scopes = similarScopes(
    roots.map((r) => ({
      sender: normalizeText(r.from_email.trim()),
      subject: r.subject,
      domain: r.from_domain && !own.domains.has(r.from_domain) ? r.from_domain : null,
      list: r.list_id ? normalizeText(r.list_id.trim()) : null,
    })),
  );
  const t = JSON.stringify(targets);
  const inPlace = db.get<{ c: number }>(`SELECT count(*) AS c FROM json_each(?) j JOIN threads t ON t.id = j.value WHERE ${PLACE[action]}`, t)!.c;
  return {
    senderName: scopes[0]?.kind === "sender" ? roots[0]!.from_name || roots[0]!.from_email : null,
    offers: scopes.map((scope) => {
      const m = matchSql(scope, action, own);
      // every target matches every shared scope: those in place count once, plus the eligible others
      const others = countWhere(db, m, `NOT ${KEPT} AND t.id NOT IN (SELECT value FROM json_each(?))`, [t], COUNT_CAP + 1);
      const n = inPlace + others;
      const skipped = countWhere(db, m, `${KEPT} AND t.id NOT IN (SELECT value FROM json_each(?))`, [t], COUNT_CAP + 1);
      return { scope, count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP, skipped: Math.min(skipped, COUNT_CAP) };
    }),
  };
}
