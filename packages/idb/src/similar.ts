import { COUNT_CAP, normalizeText, similarScopes, type SimilarAction, type SimilarOffers, type SimilarScope } from "@terno/core";
import { ownAddresses, rootRefs, sortByRecency, type OwnAddresses } from "./categorize";
import { T, type Ctx, type R } from "./mail";

/** Where a thread must still be for the action to move it. */
function inPlace(t: R | undefined, action: SimilarAction): t is R {
  if (!t || t.in_trash || t.in_spam) return false;
  return action !== "archive" || t.in_inbox === 1;
}
/** Mail the user values: never swept along (an explicit target still is acted on). */
const kept = (t: R) => t.is_starred === 1 || t.has_sent === 1;

/**
 * The scope's threads in place, one at a time, from the message index: received
 * mail, not from the user's own addresses (a walk a count can stop early).
 */
function* matching(c: Ctx, scope: SimilarScope, action: SimilarAction, own: OwnAddresses): Generator<R> {
  const messages = T(c, "messages");
  const threads = T(c, "threads");
  const [index, value] =
    scope.kind === "domain" ? ["domain", normalizeText(scope.domain.trim().replace(/^@/, ""))]
    : scope.kind === "list" ? ["list", normalizeText(scope.listId.trim())]
    : ["from", normalizeText(scope.email.trim())];
  const subject = scope.kind === "subject" ? normalizeText(scope.subject) : null;
  const seen = new Set<number>();
  for (const key of messages.keysBy(index, value)) {
    const m = messages.get(key);
    if (!m || m.is_sent || own.emails.has(m.from_email) || seen.has(m.thread_id)) continue;
    if (subject !== null && m.subject_norm !== subject) continue;
    seen.add(m.thread_id);
    const t = threads.get(m.thread_id);
    if (inPlace(t, action)) yield t;
  }
}

function countUntil(rows: Iterable<R>, keep: (t: R) => boolean, cap: number): number {
  let n = 0;
  for (const t of rows) if (keep(t) && ++n >= cap) break;
  return n;
}

/** Every thread to act on, newest first, and how many valued ones (not targets) it leaves out. */
export function resolveSimilar(c: Ctx, scope: SimilarScope, action: SimilarAction, targets: readonly number[], own = ownAddresses(c)): { ids: number[]; skipped: number } {
  const explicit = new Set(targets);
  const ids = new Set<number>();
  let skipped = 0;
  for (const t of matching(c, scope, action, own)) {
    if (explicit.has(t.id) || !kept(t)) ids.add(t.id);
    else skipped++;
  }
  const threads = T(c, "threads");
  for (const id of explicit) if (inPlace(threads.get(id), action)) ids.add(id);
  return { ids: sortByRecency(c, [...ids]), skipped: Math.min(skipped, COUNT_CAP + 1) };
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

/** Plan 63's offers: what every target shares, each with how many threads it would move now (capped counts). */
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
  const threads = T(c, "threads");
  const placed = targets.filter((id) => inPlace(threads.get(id), action)).length;
  return {
    senderName: scopes[0]?.kind === "sender" ? roots[0]!.from_name || roots[0]!.from_email : null,
    offers: scopes.map((scope) => {
      // every target matches every shared scope: those in place count once, plus the eligible others
      const n = placed + countUntil(matching(c, scope, action, own), (t) => !explicit.has(t.id) && !kept(t), COUNT_CAP + 1);
      const skipped = countUntil(matching(c, scope, action, own), (t) => !explicit.has(t.id) && kept(t), COUNT_CAP + 1);
      return { scope, count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP, skipped: Math.min(skipped, COUNT_CAP) };
    }),
  };
}
