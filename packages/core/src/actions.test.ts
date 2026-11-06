import { describe, expect, it } from "vitest";
import { ruleOutcome, savesRuleOnly, type ActionPlan } from "./actions";

const plan = (futureOnly: boolean) => ({ summary: "s", action: { type: "archive" }, conditions: [], lookIn: "inbox", future: true, futureOnly, meaning: false }) as ActionPlan;

describe("a rule only for mail to come (plan 143)", () => {
  it("Apply's job is the rule whatever the box last said, once the rule can be saved", () => {
    expect(savesRuleOnly({ plan: plan(true), count: 0, keep: { kind: "ok" } })).toBe(true);
    expect(savesRuleOnly({ plan: plan(true), count: 0, keep: { kind: "disabled", reason: "exceptions" } })).toBe(false);
    // a row ticked by hand is an ordinary Apply
    expect(savesRuleOnly({ plan: plan(true), count: 1, keep: { kind: "ok" } })).toBe(false);
    expect(savesRuleOnly({ plan: plan(false), count: 0, keep: { kind: "ok" } })).toBe(false);
  });

  it("says the rule was saved only if it was, and keeps Undo for what happened first", () => {
    expect(ruleOutcome(plan(true), { done: 0, filterSaved: true, undoToken: null })).toBe("saved");
    expect(ruleOutcome(plan(true), { done: 0, filterSaved: false, undoToken: null })).toBe("failed");
    // a category it made before the save failed
    expect(ruleOutcome(plan(true), { done: 0, filterSaved: false, undoToken: "u" })).toBe("acted");
    expect(ruleOutcome(plan(true), { done: 2, filterSaved: false, undoToken: "u" })).toBe("acted");
    expect(ruleOutcome(plan(false), { done: 0, filterSaved: false, undoToken: null })).toBe("acted");
  });
});
