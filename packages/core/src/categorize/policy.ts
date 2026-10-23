import { DOMAIN_MIN_SENDERS, type CategoryScore } from "./model";

export type AutoCategorize = "off" | "suggest" | "auto";
export type DecisionKind = "auto" | "suggest" | "none";

export const POLICY = {
  autoP: 0.97,
  suggestP: 0.8,
  /** with 5–10 examples the eval makes no false positives and auto recall stays low: conservative by design */
  autoMinPositives: 5,
  suggestMinPositives: 3,
  /** identity path: calibrated share of the key's mail the user files there (upper bound) */
  identityMinFit: 0.9,
  identityMinSupport: 3,
  /** a domain speaks for a category only once several of its senders are in it (clients: yes; uber.com receipts vs promos: no) */
  domainMinSenders: DOMAIN_MIN_SENDERS,
  /** below this calibrated share the identity is counter-evidence */
  counterIdentityShare: 0.3,
  contentMinEvidence: 4,
  /** to suggest against the sender's own history, content and intents must both nearly max out */
  counterContentEvidence: 5,
  contentMinPositives: 30,
  contentMinSenders: 5,
  /** below this many examples/background threads a sender is unknown */
  knownSenderSupport: 3,
  maxSuggestionsPerThread: 2,
  /** only new inbox mail this recent may be auto-applied (older mail is backfill) */
  autoWindowDays: 14,
  senderVetoDays: 90,
  senderVetoRemovals: 2,
  /** an auto decision removed within this window is a revert; afterwards it matured as kept */
  revertWindowDays: 30,
  /** the valve says nothing until this many auto decisions have an outcome */
  valveMinMatured: 10,
  valveFloor: 0.9,
  valveQuantile: 0.05,
} as const;

export interface Vetoes {
  /** the user once removed this thread from the category */
  hard: boolean;
  /** removals of this sender's threads from the category in the last POLICY.senderVetoDays */
  senderRemovals: number;
  /** this sender's threads the user put in the category in the same window */
  senderPositives: number;
}

export const NO_VETOES: Vetoes = { hard: false, senderRemovals: 0, senderPositives: 0 };

export interface CategoryPolicy {
  autoApply: boolean;
  /** outcomes of this category's past auto decisions */
  kept: number;
  reverted: number;
}

export interface PolicyInput {
  mode: AutoCategorize;
  /** new inbound inbox mail within the auto window */
  autoEligible: boolean;
  scores: readonly CategoryScore[];
  categories: ReadonlyMap<number, CategoryPolicy>;
  vetoes: ReadonlyMap<number, Vetoes>;
  lookAlike: boolean;
  /** examples + background threads from this sender */
  senderSupport: number;
}

export type Gate =
  | "auto:identity"
  | "auto:content"
  | "suggest"
  | "off"
  | "low"
  | "few-examples"
  | "veto:hard"
  | "veto:sender"
  | "veto:look-alike"
  | "paused"
  | "category-auto-off"
  | "not-eligible"
  | "mode-suggest"
  | "weak-identity"
  | "counter-identity"
  | "suggestion-limit";

export interface Decision {
  categoryId: number;
  decision: DecisionKind;
  p: number;
  gate: Gate;
}

/** Thresholded p alone, before vetoes: the categories worth looking up vetoes for. */
export function candidateCategories(scores: readonly CategoryScore[]): number[] {
  return scores.filter((s) => s.p >= POLICY.suggestP && s.positives >= POLICY.suggestMinPositives).map((s) => s.categoryId);
}

export function senderVetoed(v: Vetoes): boolean {
  return v.senderRemovals >= POLICY.senderVetoRemovals && v.senderRemovals >= v.senderPositives;
}

/**
 * Safety valve: auto pauses for a category when the 5th percentile of
 * Beta(1 + kept, 1 + reverted) is below 0.90. Without a minimum number of
 * matured outcomes the very first revert would pause it; without a revert the
 * quantile only measures sample size (28 clean keeps are needed to clear 0.90),
 * so a category can't be paused by its own success.
 */
export function valvePaused(kept: number, reverted: number): boolean {
  if (reverted === 0 || kept + reverted < POLICY.valveMinMatured) return false;
  return betaQuantile(1 + kept, 1 + reverted, POLICY.valveQuantile) < POLICY.valveFloor;
}

function autoGate(s: CategoryScore, input: PolicyInput, policy: CategoryPolicy): Gate {
  if (input.mode !== "auto") return "mode-suggest";
  if (!input.autoEligible) return "not-eligible";
  if (!policy.autoApply) return "category-auto-off";
  if (valvePaused(policy.kept, policy.reverted)) return "paused";
  if (s.positives < POLICY.autoMinPositives) return "few-examples";
  if (s.p < POLICY.autoP) return "low";
  if (s.identity && s.identityShare <= POLICY.counterIdentityShare) return "counter-identity";
  const identity =
    s.identityFit >= POLICY.identityMinFit &&
    s.identitySupport >= POLICY.identityMinSupport &&
    (s.identity !== "domain" || s.domainSenders >= POLICY.domainMinSenders);
  if (identity) return "auto:identity";
  const content =
    input.senderSupport < POLICY.knownSenderSupport &&
    s.C + s.Nint >= POLICY.contentMinEvidence &&
    s.positives >= POLICY.contentMinPositives &&
    s.positiveSenders >= POLICY.contentMinSenders;
  return content ? "auto:content" : "weak-identity";
}

/** AUTO / SUGGEST / NOTHING per category, precision first. Pure: the caller fetched the vetoes. */
export function decide(input: PolicyInput): Decision[] {
  const out: Decision[] = [];
  for (const s of input.scores) {
    const d = (decision: DecisionKind, gate: Gate): Decision => ({ categoryId: s.categoryId, decision, p: s.p, gate });
    const policy = input.categories.get(s.categoryId);
    if (input.mode === "off" || !policy) {
      out.push(d("none", "off"));
      continue;
    }
    if (s.p < POLICY.suggestP) {
      out.push(d("none", "low"));
      continue;
    }
    if (s.positives < POLICY.suggestMinPositives) {
      out.push(d("none", "few-examples"));
      continue;
    }
    const v = input.vetoes.get(s.categoryId) ?? NO_VETOES;
    if (v.hard) {
      out.push(d("none", "veto:hard"));
      continue;
    }
    if (senderVetoed(v)) {
      out.push(d("none", "veto:sender"));
      continue;
    }
    if (input.lookAlike) {
      out.push(d("none", "veto:look-alike"));
      continue;
    }
    // against the sender's own history only content this strong is worth a question (Amazon's invoices among its shipping notices)
    if (s.identity && s.identityShare <= POLICY.counterIdentityShare && s.C + s.Nint < POLICY.counterContentEvidence) {
      out.push(d("none", "counter-identity"));
      continue;
    }
    const gate = autoGate(s, input, policy);
    out.push(gate === "auto:identity" || gate === "auto:content" ? d("auto", gate) : d("suggest", "suggest"));
  }
  // at most two suggestions per thread, the most likely ones
  const suggestions = out.filter((x) => x.decision === "suggest").sort((a, b) => b.p - a.p || a.categoryId - b.categoryId);
  for (const extra of suggestions.slice(POLICY.maxSuggestionsPerThread)) {
    extra.decision = "none";
    extra.gate = "suggestion-limit";
  }
  return out;
}

// ───────────────────────────── Beta quantile ─────────────────────────────

function lnGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the regularized incomplete beta (Numerical Recipes betacf). */
function betaCf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b): the Beta(a, b) CDF. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaCf(a, b, x)) / a : 1 - (front * betaCf(b, a, 1 - x)) / b;
}

export function betaQuantile(a: number, b: number, q: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
