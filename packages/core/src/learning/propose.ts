import type { TextKey } from "@terno/i18n";
import type { FilterRule } from "../rules/schema";
import type { UserActionKind } from "../types";

export interface LearningAction {
  action: UserActionKind;
  fromEmail: string;
  fromDomain: string;
  listId: string | null;
  at: number;
}

export type LearnedScope = "list" | "sender" | "domain";
export type DestructiveAction = "archive" | "trash" | "spam";

/** A learned filter's name, per action (the renderer names it in the user's language; the backend falls back to English). */
export const LEARNED_FILTER_NAME = { archive: "filters.learnedName.archive", trash: "filters.learnedName.trash", spam: "filters.learnedName.spam" } as const satisfies Record<DestructiveAction, TextKey>;

/** A filter name fits what filters.save and exports accept (120 characters); a long list id or domain is cut with "…" (the rule keeps it whole). */
export const FILTER_NAME_MAX = 120;
export function capFilterName(name: string): string {
  const chars = [...name.trim()];
  return chars.length <= FILTER_NAME_MAX ? chars.join("") : `${chars.slice(0, FILTER_NAME_MAX - 1).join("").trimEnd()}…`;
}

export interface LearnedProposal {
  key: string;
  scope: LearnedScope;
  value: string;
  action: DestructiveAction;
  support: number;
  confidence: number;
  rule: FilterRule;
}

export interface LearningOptions {
  now: number;
  windowDays?: number;
  minSupport?: number;
  minConfidence?: number;
  /** proposal keys the user dismissed or already turned into filters */
  excludedKeys?: ReadonlySet<string>;
}

const DESTRUCTIVE: ReadonlySet<UserActionKind> = new Set(["archive", "trash", "spam"]);
/** Any of these on a key means the user values that mail: never propose hiding it. */
const PROTECTIVE: ReadonlySet<UserActionKind> = new Set(["star", "reply", "markImportant"]);

/** Shared consumer domains are too broad for a domain-wide rule. */
const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
]);

interface Bucket {
  scope: LearnedScope;
  value: string;
  counts: Record<DestructiveAction, number>;
  protective: number;
  senders: Set<string>;
  actions: LearningAction[];
}

function ruleFor(scope: LearnedScope, value: string, action: DestructiveAction): FilterRule {
  const field = scope === "list" ? "listId" : scope === "sender" ? "from" : "fromDomain";
  return {
    match: "all",
    conditions: [{ field, op: "equals", value }],
    actions: [{ type: action }],
  };
}

export function proposalKey(scope: LearnedScope, value: string, action: DestructiveAction): string {
  return `${scope}:${value}:${action}`;
}

export function proposeLearnedFilters(
  actions: readonly LearningAction[],
  options: LearningOptions,
): LearnedProposal[] {
  const windowMs = (options.windowDays ?? 60) * 86_400_000;
  const minSupport = options.minSupport ?? 5;
  const minConfidence = options.minConfidence ?? 0.85;
  const excluded = options.excludedKeys ?? new Set<string>();
  const since = options.now - windowMs;

  const buckets = new Map<string, Bucket>();
  const touch = (scope: LearnedScope, value: string, a: LearningAction) => {
    if (!value) return;
    const id = `${scope}:${value}`;
    let b = buckets.get(id);
    if (!b) {
      b = { scope, value, counts: { archive: 0, trash: 0, spam: 0 }, protective: 0, senders: new Set(), actions: [] };
      buckets.set(id, b);
    }
    b.senders.add(a.fromEmail);
    b.actions.push(a);
    if (DESTRUCTIVE.has(a.action)) b.counts[a.action as DestructiveAction]++;
    else if (PROTECTIVE.has(a.action)) b.protective++;
  };

  for (const a of actions) {
    // Protective signals count regardless of age: one starred newsletter vetoes hiding it.
    if (a.at < since && !PROTECTIVE.has(a.action)) continue;
    const email = a.fromEmail.toLowerCase();
    const domain = a.fromDomain.toLowerCase();
    const normalized = { ...a, fromEmail: email, fromDomain: domain };
    touch("sender", email, normalized);
    if (a.listId) touch("list", a.listId.toLowerCase(), normalized);
    if (domain && !CONSUMER_DOMAINS.has(domain)) touch("domain", domain, normalized);
  }

  const proposals: LearnedProposal[] = [];
  const coveredSenders = new Set<string>();
  const order: LearnedScope[] = ["list", "sender", "domain"];

  for (const scope of order) {
    for (const b of buckets.values()) {
      if (b.scope !== scope || b.protective > 0) continue;
      if (scope === "domain" && b.senders.size < 2) continue;
      if (scope === "sender" && coveredSenders.has(b.value)) continue;
      const total = b.counts.archive + b.counts.trash + b.counts.spam;
      if (total === 0) continue;
      const action = (Object.keys(b.counts) as DestructiveAction[]).reduce((best, k) =>
        b.counts[k] > b.counts[best] ? k : best,
      );
      const support = b.counts[action];
      const confidence = support / total;
      if (support < minSupport || confidence < minConfidence) continue;
      const key = proposalKey(scope, b.value, action);
      // A domain proposal is redundant when every sender in it is already covered.
      if (scope === "domain" && [...b.senders].every((s) => coveredSenders.has(s))) continue;
      // Excluded keys (dismissed or already a filter) still cover their senders,
      // so accepting a list rule doesn't surface a redundant per-sender rule next.
      if (!excluded.has(key)) {
        proposals.push({ key, scope, value: b.value, action, support, confidence, rule: ruleFor(scope, b.value, action) });
      }
      if (scope === "list") {
        // senders whose every action came through this list are covered by it
        for (const s of b.senders) {
          const senderBucket = buckets.get(`sender:${s}`);
          if (senderBucket && senderBucket.actions.every((x) => x.listId?.toLowerCase() === b.value)) {
            coveredSenders.add(s);
          }
        }
      } else if (scope === "sender") coveredSenders.add(b.value);
    }
  }
  return proposals.sort((a, b) => b.support - a.support || a.key.localeCompare(b.key));
}
