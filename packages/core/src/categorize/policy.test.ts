import { describe, expect, it } from "vitest";
import type { CategoryScore } from "./model";
import { betaCdf, betaQuantile, candidateCategories, decide, POLICY, valvePaused, type CategoryPolicy, type PolicyInput, type Vetoes } from "./policy";

const score = (over: Partial<CategoryScore> = {}): CategoryScore => ({
  categoryId: 1,
  p: 0.99,
  prior: 0,
  I: 4,
  C: 1,
  Nint: 1,
  identity: "sender",
  identitySupport: 12,
  domainSenders: 1,
  positives: 40,
  positiveSenders: 6,
  ...over,
});
const cats = (over: Partial<CategoryPolicy> = {}) => new Map([[1, { autoApply: true, kept: 0, reverted: 0, ...over }], [2, { autoApply: true, kept: 0, reverted: 0 }], [3, { autoApply: true, kept: 0, reverted: 0 }]]);
const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  mode: "auto",
  autoEligible: true,
  scores: [score()],
  categories: cats(),
  vetoes: new Map(),
  lookAlike: false,
  senderSupport: 12,
  ...over,
});
const one = (over: Partial<PolicyInput> = {}) => decide(input(over))[0]!;
const veto = (v: Partial<Vetoes>) => new Map([[1, { hard: false, senderRemovals: 0, senderPositives: 0, ...v }]]);

describe("categorization policy", () => {
  it("auto-applies on strong identity evidence", () => {
    expect(one()).toMatchObject({ decision: "auto", gate: "auto:identity" });
  });

  it("needs p ≥ 0.97 to auto-apply, p ≥ 0.80 to suggest", () => {
    expect(one({ scores: [score({ p: 0.969 })] })).toMatchObject({ decision: "suggest" });
    expect(one({ scores: [score({ p: POLICY.suggestP })] })).toMatchObject({ decision: "suggest" });
    expect(one({ scores: [score({ p: 0.79 })] })).toMatchObject({ decision: "none", gate: "low" });
  });

  it("needs 5 examples to auto-apply and 3 to suggest", () => {
    expect(one({ scores: [score({ positives: 4 })] })).toMatchObject({ decision: "suggest", gate: "suggest" });
    expect(one({ scores: [score({ positives: 2 })] })).toMatchObject({ decision: "none", gate: "few-examples" });
  });

  it("identity path: I ≥ 2 with support ≥ 3; a domain only once several of its senders are in the category", () => {
    expect(one({ scores: [score({ I: 1.9 })] })).toMatchObject({ decision: "suggest" });
    expect(one({ scores: [score({ identitySupport: 2 })] })).toMatchObject({ decision: "suggest" });
    expect(one({ scores: [score({ identity: "domain", domainSenders: 2 })] })).toMatchObject({ decision: "suggest" });
    expect(one({ scores: [score({ identity: "domain", domainSenders: 3 })] })).toMatchObject({ decision: "auto" });
    expect(one({ scores: [score({ identity: "list" })] })).toMatchObject({ decision: "auto" });
  });

  it("content path: only for unknown senders, with strong content and a broad category", () => {
    const content = score({ I: 0, identity: null, identitySupport: 0, C: 3, Nint: 1.5 });
    expect(one({ scores: [content], senderSupport: 0 })).toMatchObject({ decision: "auto", gate: "auto:content" });
    expect(one({ scores: [content], senderSupport: 3 })).toMatchObject({ decision: "suggest" });
    expect(one({ scores: [{ ...content, C: 2 }], senderSupport: 0 })).toMatchObject({ decision: "suggest" });
    expect(one({ scores: [{ ...content, positives: 29 }], senderSupport: 0 })).toMatchObject({ decision: "suggest" });
    expect(one({ scores: [{ ...content, positiveSenders: 4 }], senderSupport: 0 })).toMatchObject({ decision: "suggest" });
  });

  it("never auto-applies against the sender (I ≤ −1)", () => {
    expect(one({ scores: [score({ I: -1, C: 4, Nint: 3, identity: "sender" })], senderSupport: 0 })).toMatchObject({ decision: "suggest", gate: "suggest" });
  });

  it("vetoes block suggestions too: hard, sender back-off, look-alike", () => {
    expect(one({ vetoes: veto({ hard: true }) })).toMatchObject({ decision: "none", gate: "veto:hard" });
    expect(one({ vetoes: veto({ senderRemovals: 2, senderPositives: 2 }) })).toMatchObject({ decision: "none", gate: "veto:sender" });
    expect(one({ vetoes: veto({ senderRemovals: 2, senderPositives: 3 }) })).toMatchObject({ decision: "auto" });
    expect(one({ vetoes: veto({ senderRemovals: 1, senderPositives: 0 }) })).toMatchObject({ decision: "auto" });
    expect(one({ lookAlike: true })).toMatchObject({ decision: "none", gate: "veto:look-alike" });
  });

  it("respects the global mode, the per-category switch and the auto window", () => {
    expect(one({ mode: "off" })).toMatchObject({ decision: "none" });
    expect(one({ mode: "suggest" })).toMatchObject({ decision: "suggest" });
    expect(one({ autoEligible: false })).toMatchObject({ decision: "suggest" });
    expect(one({ categories: cats({ autoApply: false }) })).toMatchObject({ decision: "suggest" });
    expect(one({ categories: new Map() })).toMatchObject({ decision: "none" });
  });

  it("is multi-label for auto, at most two suggestions per thread", () => {
    const ds = decide(input({ scores: [score({ categoryId: 1 }), score({ categoryId: 2 }), score({ categoryId: 3 })] }));
    expect(ds.map((d) => d.decision)).toEqual(["auto", "auto", "auto"]);
    const ss = decide(input({ mode: "suggest", scores: [score({ categoryId: 1, p: 0.85 }), score({ categoryId: 2, p: 0.95 }), score({ categoryId: 3, p: 0.9 })] }));
    expect(ss.map((d) => d.decision)).toEqual(["none", "suggest", "suggest"]);
    expect(ss[0]!.gate).toBe("suggestion-limit");
  });

  it("candidates are what vetoes need to be looked up for", () => {
    expect(candidateCategories([score({ categoryId: 1 }), score({ categoryId: 2, p: 0.5 }), score({ categoryId: 3, positives: 1 })])).toEqual([1]);
  });

  describe("safety valve", () => {
    it("waits for a minimum of matured outcomes", () => {
      expect(valvePaused(0, 1)).toBe(false);
      expect(valvePaused(3, 3)).toBe(false);
      expect(valvePaused(4, 6)).toBe(true);
    });

    it("can't be tripped by a clean record, however short", () => {
      for (const kept of [0, 10, 27, 28, 500]) expect(valvePaused(kept, 0)).toBe(false);
    });

    it("pauses when the 5th percentile of Beta(1+kept, 1+reverted) is below 0.90", () => {
      expect(valvePaused(30, 3)).toBe(true);
      expect(valvePaused(200, 3)).toBe(false);
      expect(one({ categories: cats({ kept: 30, reverted: 3 }) })).toMatchObject({ decision: "suggest" });
      expect(decide(input({ categories: cats({ kept: 30, reverted: 3 }) }))[0]!.gate).toBe("suggest");
      expect(one({ categories: cats({ kept: 200, reverted: 3 }) })).toMatchObject({ decision: "auto" });
    });

    it("computes Beta quantiles correctly", () => {
      expect(betaQuantile(1, 1, 0.5)).toBeCloseTo(0.5, 8);
      // Beta(a, 1) has CDF x^a
      expect(betaQuantile(21, 1, 0.05)).toBeCloseTo(0.05 ** (1 / 21), 8);
      expect(betaCdf(0.3, 2, 5)).toBeCloseTo(0.579825, 5);
      expect(betaQuantile(31, 4, 0.05)).toBeGreaterThan(0.75);
    });
  });
});
