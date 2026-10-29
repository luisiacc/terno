import { COUNT_CAP, normalizeText, similarScopes, type SimilarAction, type SimilarOffers, type SimilarPage, type SimilarScope } from "@terno/core";
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
/** An offer reads at most this many of the scope's messages: a dominant sender costs the same as any other. */
export const OFFER_SCAN = 2000;

/**
 * One page of the scope's received mail (not from the user's own addresses),
 * in message order from after `cursor` (a message id), with each thread's
 * place and value. Every predicate past the index is computed, not filtered,
 * so a page examines exactly `limit` index entries: a rare subject or an
 * all-archived scope can't turn it into a walk of the whole sender. A later
 * page seeks its cursor in the index (`m.id > ?` is a range of it).
 */
export function pageSql(scope: SimilarScope, action: SimilarAction, own: OwnAddresses, cursor: number | null, limit: number): { sql: string; params: Param[] } {
  const [index, column, value] =
    scope.kind === "domain" ? ["messages_domain", "m.from_domain", normalizeText(scope.domain.trim().replace(/^@/, ""))]
    : scope.kind === "list" ? ["messages_list", "m.list_id", normalizeText(scope.listId.trim())]
    : ["messages_from", "m.from_email", normalizeText(scope.email.trim())];
  // exactly what the rule's evaluators compare: the normalized subject, untrimmed (an offer never has padding)
  const subject = scope.kind === "subject" ? normalizeText(scope.subject) : null;
  return {
    sql: `SELECT m.id, m.thread_id, (? IS NULL OR m.subject_norm = ?) AND m.is_sent = 0 AND m.from_email NOT IN (SELECT value FROM json_each(?)) AS match,
                 ${PLACE[action]} AS placed, ${KEPT} AS kept
          FROM messages m INDEXED BY ${index} JOIN threads t ON t.id = m.thread_id
          WHERE ${column} = ?${cursor === null ? "" : " AND m.id > ?"}
          ORDER BY m.id LIMIT ?`,
    params: [subject, subject, JSON.stringify([...own.emails]), value, ...(cursor === null ? [] : [cursor]), limit],
  };
}

function page(db: Db, scope: SimilarScope, action: SimilarAction, own: OwnAddresses, cursor: number | null, limit: number) {
  const q = pageSql(scope, action, own, cursor, limit);
  return db.all<{ id: number; thread_id: number; match: number; placed: number; kept: number }>(q.sql, ...q.params);
}

/** Folds a page into thread ids: those to act on (in place; not valued unless targeted) and the valued ones left out. */
function fold(rows: ReturnType<typeof page>, targets: ReadonlySet<number>, limit: number): SimilarPage {
  const ids = new Set<number>();
  const kept = new Set<number>();
  for (const r of rows) {
    if (!r.match || !r.placed) continue;
    if (r.kept && !targets.has(r.thread_id)) kept.add(r.thread_id);
    else ids.add(r.thread_id);
  }
  return { ids: [...ids], kept: [...kept], next: rows.length === limit ? rows[rows.length - 1]!.id : null };
}

const inPlace = (db: Db, ids: readonly number[], action: SimilarAction) =>
  db.all<{ id: number }>(`SELECT t.id FROM json_each(?) j JOIN threads t ON t.id = j.value WHERE ${PLACE[action]}`, JSON.stringify([...new Set(ids)])).map((r) => r.id);

/** One page of what a sweep acts on (the first also holds the targets still in place). */
export function resolveSimilarPage(db: Db, scope: SimilarScope, action: SimilarAction, targets: readonly number[], cursor: number | null, limit: number): SimilarPage {
  const p = fold(page(db, scope, action, ownAddresses(db), cursor, limit), new Set(targets), limit);
  return cursor === null ? { ...p, ids: [...new Set([...inPlace(db, targets, action), ...p.ids])] } : p;
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

/**
 * Plan 63's offers: what every target shares, each with how many threads it
 * would move now. A count is exact when the scope's first OFFER_SCAN
 * messages are all of it, else at least that many (capped).
 */
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
  // every target matches every shared scope: those in place count once
  const placed = inPlace(db, targets, action);
  const explicit = new Set(targets);
  return {
    senderName: scopes[0]?.kind === "sender" ? roots[0]!.from_name || roots[0]!.from_email : null,
    offers: scopes.map((scope) => {
      const p = fold(page(db, scope, action, own, null, OFFER_SCAN), explicit, OFFER_SCAN);
      const n = new Set([...placed, ...p.ids]).size;
      return { scope, count: Math.min(n, COUNT_CAP), capped: p.next !== null || n > COUNT_CAP, skipped: Math.min(p.kept.length, COUNT_CAP) };
    }),
  };
}
