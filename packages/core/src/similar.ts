/**
 * Plan 63: archive, delete or spam mail similar to what the user just acted
 * on. A scope is matched exactly against received mail (store indexes) and,
 * for the future, as the filter rule that says the same thing.
 */
import { CONSUMER_DOMAINS } from "./categorize/features";
import { proposalKey, type DestructiveAction } from "./learning/propose";
import { foldPattern, subjectEnds, subjectGeneralizes, subjectGlob, subjectKey, subjectPattern } from "./rules/pattern";
import type { FilterRule, TextCondition } from "./rules/schema";
import { normalizeText } from "./text";

export const SIMILAR_ACTIONS = ["archive", "trash", "spam"] as const;
export type SimilarAction = DestructiveAction;

/**
 * Plan 127: what a sweep moves mail to: a place action, or one of an account's folders (its threads not in it yet, not
 * in Trash or Spam; nothing is left out for being starred or replied: filing isn't disposal).
 */
export interface SimilarFolder {
  accountId: number;
  folder: string;
}
export type SimilarTarget = SimilarAction | SimilarFolder;

export type SimilarScope =
  | { kind: "sender"; email: string }
  /** the same sender and this subject, any numbers in it standing for any number (plan 89) */
  | { kind: "subject"; email: string; subject: string }
  | { kind: "domain"; domain: string }
  | { kind: "list"; listId: string };

export interface SimilarOffer {
  scope: SimilarScope;
  /** eligible threads (not yet in the place, not starred, not replied), explicit targets included; capped: at least this many (a big scope is read only in part) */
  count: number;
  capped: boolean;
  /** starred or replied threads the scope leaves out */
  skipped: number;
}

/** One page of a sweep's scope: threads to act on, valued ones left out, and the store's cursor for the next page (null: done). */
export interface SimilarPage {
  ids: number[];
  /** starred or replied threads (not targets) the sweep leaves */
  kept: number[];
  next: number | null;
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
  // compared by key: "Tu pedido 43790" and "Tu pedido 3052" are one subject (plan 89)
  const subject = email ? shared((r) => (r.subject && r.subject === r.subject.trim() && r.subject.length <= RULE_VALUE_MAX ? subjectIdentity(normalizeText(r.subject)) : null)) : null;
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

/** A subject scope's condition: exactly the subject, or (with numbers in it) the pattern of its key. */
export function subjectCondition(subject: string): TextCondition {
  const normalized = normalizeText(subject);
  return subjectGeneralizes(normalized) ? { field: "subject", op: "matches", value: subjectPattern(normalized) } : { field: "subject", op: "equals", value: subject };
}

/** What a scope's subject is compared by: its key when its numbers generalize, else itself (exact). */
export function subjectIdentity(normalized: string): string {
  return subjectGeneralizes(normalized) ? `#${subjectKey(normalized)}` : `=${normalized}`;
}

/**
 * How the stores test a scope's subject against a message's normalized one:
 * the key (computed for each message) or exact equality.
 */
export function subjectTest(scopeSubject: string): { kind: "key"; key: string; glob: string } | { kind: "exact"; normalized: string } {
  const normalized = normalizeText(scopeSubject);
  return subjectGeneralizes(normalized) ? { kind: "key", key: subjectKey(normalized), glob: subjectGlob(normalized) } : { kind: "exact", normalized };
}

/** The scope's subject test, prepared once for a walk: does this normalized subject belong to it? */
export function subjectMatcher(scopeSubject: string): (normalized: string) => boolean {
  const test = subjectTest(scopeSubject);
  if (test.kind === "exact") return (normalized) => normalized === test.normalized;
  // the text around its numbers first (a string compare): most of a sender's other subjects stop there
  const { head, tail } = subjectEnds(normalizeText(scopeSubject));
  return (normalized) => normalized.startsWith(head) && normalized.endsWith(tail) && subjectKey(normalized) === test.key;
}

/** Does this normalized subject belong to the scope's subject? */
export const sameSubject = (scopeSubject: string, normalized: string): boolean => subjectMatcher(scopeSubject)(normalized);

/** The filter rule that does the same to future mail. */
export function similarRule(scope: SimilarScope, action: SimilarAction): FilterRule {
  const conditions: FilterRule["conditions"] = (() => {
    switch (scope.kind) {
      case "sender":
        return [{ field: "from" as const, op: "equals" as const, value: scope.email }];
      case "subject":
        return [
          { field: "from" as const, op: "equals" as const, value: scope.email },
          subjectCondition(scope.subject),
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
      // a pattern compares by its accent fold only: case and escapes are its meaning (\D isn't \d)
      conditions: r.conditions.map((c) => ({ ...c, value: typeof c.value === "string" ? (c.op === "matches" ? foldPattern(c.value.trim()) : normalizeText(c.value.trim())) : c.value, negate: Boolean(c.negate) })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
      actions: r.actions.map((x) => JSON.stringify(x)).sort(),
    });
  return canon(a) === canon(b);
}
