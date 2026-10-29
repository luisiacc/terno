/**
 * Plan 63: archive, delete or spam mail similar to what the user just acted
 * on. A scope is matched exactly against received mail (store indexes) and,
 * for the future, as the filter rule that says the same thing.
 */
import { CONSUMER_DOMAINS } from "./categorize/features";
import { proposalKey, type DestructiveAction } from "./learning/propose";
import type { FilterRule } from "./rules/schema";
import { normalizeText } from "./text";

export const SIMILAR_ACTIONS = ["archive", "trash", "spam"] as const;
export type SimilarAction = DestructiveAction;

export type SimilarScope =
  | { kind: "sender"; email: string }
  /** the same sender and exactly this subject */
  | { kind: "subject"; email: string; subject: string }
  | { kind: "domain"; domain: string }
  | { kind: "list"; listId: string };

export interface SimilarOffer {
  scope: SimilarScope;
  /** eligible threads (not yet in the place, not starred, not replied), explicit targets included; capped at COUNT_CAP */
  count: number;
  capped: boolean;
  /** starred or replied threads the scope leaves out */
  skipped: number;
}

export interface SimilarOffers {
  /** the shared sender's display name (for labels) */
  senderName: string | null;
  offers: SimilarOffer[];
}

/** A rule condition value holds at most this; a longer subject gets no offer. */
export const RULE_VALUE_MAX = 500;

/** What the targets' root inbound messages share, as scopes (sender, subject, domain, list order). */
export function similarScopes(roots: readonly { sender: string; subject: string; domain: string | null; list: string | null }[]): SimilarScope[] {
  const first = roots[0];
  if (!first) return [];
  const shared = <T>(pick: (r: (typeof roots)[number]) => T | null): T | null => {
    const v = pick(first);
    return v !== null && roots.every((r) => pick(r) === v) ? v : null;
  };
  const email = shared((r) => r.sender || null);
  // a filter value is trimmed and non-empty: only a subject that is already so means the same in the rule
  const subject = email ? shared((r) => (r.subject && r.subject === r.subject.trim() && r.subject.length <= RULE_VALUE_MAX ? normalizeText(r.subject) : null)) : null;
  const domain = shared((r) => (r.domain && !CONSUMER_DOMAINS.has(r.domain) ? r.domain : null));
  const list = shared((r) => r.list);
  const out: SimilarScope[] = [];
  if (email) out.push({ kind: "sender", email });
  // the verbatim subject of the first root (all share it, normalized): what the rule shows
  if (email && subject) out.push({ kind: "subject", email, subject: first.subject });
  if (domain) out.push({ kind: "domain", domain });
  if (list && list.length <= RULE_VALUE_MAX) out.push({ kind: "list", listId: list });
  return out;
}

/** The filter rule that does the same to future mail. */
export function similarRule(scope: SimilarScope, action: SimilarAction): FilterRule {
  const conditions: FilterRule["conditions"] = (() => {
    switch (scope.kind) {
      case "sender":
        return [{ field: "from" as const, op: "equals" as const, value: scope.email }];
      case "subject":
        return [
          { field: "from" as const, op: "equals" as const, value: scope.email },
          { field: "subject" as const, op: "equals" as const, value: scope.subject },
        ];
      case "domain":
        return [{ field: "fromDomain" as const, op: "equals" as const, value: scope.domain }];
      case "list":
        return [{ field: "listId" as const, op: "equals" as const, value: scope.listId }];
    }
  })();
  return { match: "all", conditions, actions: [{ type: action }] };
}

/** The learned-filter key the same rule would have (null for subject scopes, which learning never proposes). */
export function similarLearnedKey(scope: SimilarScope, action: SimilarAction): string | null {
  switch (scope.kind) {
    case "sender":
      return proposalKey("sender", normalizeText(scope.email), action);
    case "domain":
      return proposalKey("domain", normalizeText(scope.domain), action);
    case "list":
      return proposalKey("list", normalizeText(scope.listId), action);
    case "subject":
      return null;
  }
}

/** What a scope shows in a filter's name: the address, @domain, the list, or "address · subject". */
export function similarValue(scope: SimilarScope): string {
  switch (scope.kind) {
    case "sender":
      return scope.email;
    case "subject":
      return `${scope.email} · ${scope.subject}`;
    case "domain":
      return `@${scope.domain}`;
    case "list":
      return scope.listId;
  }
}

/** Two rules say the same thing (filters are compared by their canonical form). */
export function sameRule(a: FilterRule, b: FilterRule): boolean {
  const canon = (r: FilterRule) =>
    JSON.stringify({
      match: r.match,
      conditions: r.conditions.map((c) => ({ ...c, value: typeof c.value === "string" ? normalizeText(c.value.trim()) : c.value, negate: Boolean(c.negate) })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
      actions: r.actions.map((x) => JSON.stringify(x)).sort(),
    });
  return canon(a) === canon(b);
}
