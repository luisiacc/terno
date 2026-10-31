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
/** An offer reads at most this many of the scope's messages (as SQLite's). */
export const OFFER_SCAN = 2000;

/**
 * A sweep's walks of the index, kept between its pages under a token (the
 * cursor): a page reads on from where the last stopped, never rereads the
 * bucket. The index's order isn't the ids' (an update re-adds a row at the
 * end), so the walk itself is the cursor. A token gone (a few sweeps at
 * once) starts the walk over: the backend's sets keep each thread once.
 */
const walks = new WeakMap<object, Map<number, Iterator<unknown>>>();
const WALKS_KEPT = 8;
let tokens = 0;

function walkOf(c: Ctx, scope: SimilarScope, cursor: number | null): Iterator<unknown> {
  const messages = T(c, "messages");
  const kept = walks.get(messages);
  const going = cursor === null ? undefined : kept?.get(cursor);
  if (going) {
    kept!.delete(cursor!);
    return going;
  }
  const [index, value] =
    scope.kind === "domain" ? ["domain", normalizeText(scope.domain.trim().replace(/^@/, ""))]
    : scope.kind === "list" ? ["list", normalizeText(scope.listId.trim())]
    : ["from", normalizeText(scope.email.trim())];
  return messages.keysBy(index, value);
}

function keepWalk(c: Ctx, walk: Iterator<unknown>): number {
  const messages = T(c, "messages");
  let kept = walks.get(messages);
  if (!kept) walks.set(messages, (kept = new Map()));
  const token = ++tokens;
  kept.set(token, walk);
  while (kept.size > WALKS_KEPT) kept.delete(kept.keys().next().value as number);
  return token;
}

/** One page, folded into threads: at most `limit` index entries, each checked (subject, own addresses, place, value), never skipped by the walk. */
function page(c: Ctx, scope: SimilarScope, action: SimilarAction, own: OwnAddresses, targets: ReadonlySet<number>, cursor: number | null, limit: number, keep = true): SimilarPage {
  const messages = T(c, "messages");
  const threads = T(c, "threads");
  const subject = scope.kind === "subject" ? normalizeText(scope.subject) : null;
  const walk = walkOf(c, scope, cursor);
  const ids = new Set<number>();
  const left = new Set<number>();
  let read = 0;
  for (; read < limit; read++) {
    const step = walk.next();
    if (step.done) return { ids: [...ids], kept: [...left], next: null };
    const m = messages.get(step.value as number);
    if (!m || m.is_sent || own.emails.has(m.from_email) || (subject !== null && m.subject_norm !== subject)) continue;
    const t = threads.get(m.thread_id);
    if (!inPlace(t, action)) continue;
    if (kept(t) && !targets.has(t.id)) left.add(t.id);
    else ids.add(t.id);
  }
  // an offer only needs to know there is more: it keeps no walk (a sweep's would be crowded out)
  return { ids: [...ids], kept: [...left], next: keep ? keepWalk(c, walk) : 0 };
}

const placedOf = (c: Ctx, ids: readonly number[], action: SimilarAction) => {
  const threads = T(c, "threads");
  return [...new Set(ids)].filter((id) => inPlace(threads.get(id), action));
};

/** One page of what a sweep acts on (the first also holds the targets still in place). */
export function resolveSimilarPage(c: Ctx, scope: SimilarScope, action: SimilarAction, targets: readonly number[], cursor: number | null, limit: number): SimilarPage {
  const p = page(c, scope, action, ownAddresses(c), new Set(targets), cursor, limit);
  return cursor === null ? { ...p, ids: [...new Set([...placedOf(c, targets, action), ...p.ids])] } : p;
}

export function keptThreads(c: Ctx, threadIds: readonly number[]): number[] {
  const threads = T(c, "threads");
  return [...new Set(threadIds)].filter((id) => {
    const t = threads.get(id);
    return !!t && kept(t);
  });
}

function sharedScopes(c: Ctx, targets: readonly number[], own: ReturnType<typeof ownAddresses>) {
  const refs = targets.length <= OFFER_TARGETS_MAX ? rootRefs(c, targets, own) : [];
  if (refs.length === 0 || refs.length < targets.length) return null;
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
  return { roots, scopes };
}

/** Plan 80: what the threads' root inbound messages share, without counting; the sender's display name. */
export function similarScopesOf(c: Ctx, threadIds: readonly number[]): { senderName: string | null; scopes: SimilarScope[] } {
  const shared = sharedScopes(c, [...new Set(threadIds)], ownAddresses(c));
  if (!shared) return { senderName: null, scopes: [] };
  const { roots, scopes } = shared;
  return { senderName: scopes[0]?.kind === "sender" ? roots[0]!.from_name || roots[0]!.from_email : null, scopes };
}

/** More targets than this and nothing is offered (each one is checked, never a sample). */
export const OFFER_TARGETS_MAX = 200;

/** Plan 63's offers: what every target shares, each with how many threads it would move now (at least that many when capped). */
export function similarOffers(c: Ctx, threadIds: readonly number[], action: SimilarAction): SimilarOffers {
  const own = ownAddresses(c);
  const targets = [...new Set(threadIds)];
  const shared = sharedScopes(c, targets, own);
  if (!shared) return { senderName: null, offers: [] };
  const { roots, scopes } = shared;
  const explicit = new Set(targets);
  const placed = placedOf(c, targets, action);
  return {
    senderName: scopes[0]?.kind === "sender" ? roots[0]!.from_name || roots[0]!.from_email : null,
    offers: scopes.map((scope) => {
      const p = page(c, scope, action, own, explicit, null, OFFER_SCAN, false);
      const n = new Set([...placed, ...p.ids]).size;
      return { scope, count: Math.min(n, COUNT_CAP), capped: p.next !== null || n > COUNT_CAP, skipped: Math.min(p.kept.length, COUNT_CAP) };
    }),
  };
}
