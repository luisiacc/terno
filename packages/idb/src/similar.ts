import { COUNT_CAP, normalizeText, similarScopes, type SimilarAction, type SimilarOffers, type SimilarPage, type SimilarScope } from "@terno/core";
import { ownAddresses, rootRefs, type OwnAddresses } from "./categorize";
import { T, type Ctx, type R } from "./mail";

/** Where a thread must still be for the action to move it. */
function inPlace(t: R | undefined, action: SimilarAction): t is R {
  if (!t || t.in_trash || t.in_spam) return false;
  return action !== "archive" || t.in_inbox === 1;
}
/** Mail the user values: never swept along (an explicit target still is acted on). */
const kept = (t: R) => t.is_starred === 1 || t.has_sent === 1;
/** An offer reads at most this many of the scope's newest messages (as SQLite's). */
export const OFFER_SCAN = 2000;

/** The scope's index bucket: message ids, newest first, below `before`, at most `limit` (one pass and a numeric sort; no row is read). */
function newest(c: Ctx, scope: SimilarScope, before: number | null, limit: number): Float64Array {
  const [index, value] =
    scope.kind === "domain" ? ["domain", normalizeText(scope.domain.trim().replace(/^@/, ""))]
    : scope.kind === "list" ? ["list", normalizeText(scope.listId.trim())]
    : ["from", normalizeText(scope.email.trim())];
  const bucket = T(c, "messages").bucket(index, value);
  if (!bucket) return new Float64Array(0);
  const ids = new Float64Array(bucket.size);
  let n = 0;
  for (const k of bucket) if (before === null || (k as number) < before) ids[n++] = k as number;
  return ids.subarray(0, n).sort().reverse().subarray(0, limit);
}

/** One page, folded into threads: those to act on and the valued ones left out (every row past the index is checked, never skipped by the walk). */
function page(c: Ctx, scope: SimilarScope, action: SimilarAction, own: OwnAddresses, targets: ReadonlySet<number>, before: number | null, limit: number): SimilarPage {
  const messages = T(c, "messages");
  const threads = T(c, "threads");
  const subject = scope.kind === "subject" ? normalizeText(scope.subject) : null;
  const keys = newest(c, scope, before, limit);
  const ids = new Set<number>();
  const left = new Set<number>();
  for (const key of keys) {
    const m = messages.get(key);
    if (!m || m.is_sent || own.emails.has(m.from_email) || (subject !== null && m.subject_norm !== subject)) continue;
    const t = threads.get(m.thread_id);
    if (!inPlace(t, action)) continue;
    if (kept(t) && !targets.has(t.id)) left.add(t.id);
    else ids.add(t.id);
  }
  return { ids: [...ids], kept: [...left], next: keys.length === limit ? keys[keys.length - 1]! : null };
}

const placedOf = (c: Ctx, ids: readonly number[], action: SimilarAction) => {
  const threads = T(c, "threads");
  return [...new Set(ids)].filter((id) => inPlace(threads.get(id), action));
};

/** One page of what a sweep acts on (the first also holds the targets still in place). */
export function resolveSimilarPage(c: Ctx, scope: SimilarScope, action: SimilarAction, targets: readonly number[], before: number | null, limit: number): SimilarPage {
  const p = page(c, scope, action, ownAddresses(c), new Set(targets), before, limit);
  return before === null ? { ...p, ids: [...new Set([...placedOf(c, targets, action), ...p.ids])] } : p;
}

export function keptThreads(c: Ctx, threadIds: readonly number[]): number[] {
  const threads = T(c, "threads");
  return [...new Set(threadIds)].filter((id) => {
    const t = threads.get(id);
    return !!t && kept(t);
  });
}

/** More targets than this and nothing is offered (each one is checked, never a sample). */
export const OFFER_TARGETS_MAX = 200;

/** Plan 63's offers: what every target shares, each with how many threads it would move now (at least that many when capped). */
export function similarOffers(c: Ctx, threadIds: readonly number[], action: SimilarAction): SimilarOffers {
  const own = ownAddresses(c);
  const targets = [...new Set(threadIds)];
  const refs = targets.length <= OFFER_TARGETS_MAX ? rootRefs(c, targets, own) : [];
  if (refs.length === 0 || refs.length < targets.length) return { senderName: null, offers: [] };
  const messages = T(c, "messages");
  const roots = refs.map((r) => messages.get(r.messageId)!);
  const scopes = similarScopes(
    roots.map((m) => ({
      sender: normalizeText(String(m.from_email).trim()),
      subject: m.subject,
      domain: m.from_domain && !own.domains.has(m.from_domain) ? m.from_domain : null,
      list: m.list_id ? normalizeText(String(m.list_id).trim()) : null,
    })),
  );
  const explicit = new Set(targets);
  const placed = placedOf(c, targets, action);
  return {
    senderName: scopes[0]?.kind === "sender" ? roots[0]!.from_name || roots[0]!.from_email : null,
    offers: scopes.map((scope) => {
      const p = page(c, scope, action, own, explicit, null, OFFER_SCAN);
      const n = new Set([...placed, ...p.ids]).size;
      return { scope, count: Math.min(n, COUNT_CAP), capped: p.next !== null || n > COUNT_CAP, skipped: Math.min(p.kept.length, COUNT_CAP) };
    }),
  };
}
