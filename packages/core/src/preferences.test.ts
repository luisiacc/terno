import { describe, expect, it } from "vitest";
import { activeRules, checkPreferences, cueIn, exactlyReaches, NO_PREFERENCES, preferenceDecision, ruleKey, rowPrint, senderMatches, senderSelector, verdictBasis, wantedBy, type CompiledPreferences, type PreferenceRule } from "./preferences";

const unclear = (said: string) => `unclear: ${said}`;
const rule = (r: Partial<CompiledPreferences["rules"][number]> & { said: string; effect: string }): CompiledPreferences["rules"][number] => ({ kinds: [], senders: [], about: null, unless: null, cues: [], understood: r.said, ...r });
const ok = (r: Partial<PreferenceRule> & Pick<PreferenceRule, "effect">): PreferenceRule => {
  const out = { id: "r1", key: "", said: "x", understood: "x", ...r } as PreferenceRule;
  out.key = ruleKey(out);
  return out;
};

describe("checkPreferences (plan 248 §2)", () => {
  const text = "Never show package deliveries unless I have to sign. Hide everything from @promo.shopmart.com. Show sales at REI.";
  it("keeps what holds against the words: their own words, a written domain, known kinds; numbers and keys them", () => {
    const { rules, notes } = checkPreferences(
      {
        rules: [
          rule({ said: "Never show package deliveries unless I have to sign", effect: "hide", kinds: ["delivery"], unless: "a signature is needed" }),
          rule({ said: "Hide everything from @promo.shopmart.com", effect: "HIDE", senders: ["promo.shopmart.com"] }),
          rule({ said: "Show sales at REI", effect: "show", about: "a sale at REI", cues: ["REI", "rei.com", " "] }),
        ],
        notes: [],
      },
      text,
      unclear,
    );
    expect(rules.map((r) => [r.id, r.effect, r.kinds, r.senders, r.cues])).toEqual([
      ["r1", "hide", ["delivery"], undefined, undefined],
      ["r2", "hide", undefined, ["@promo.shopmart.com"], undefined],
      ["r3", "show", undefined, undefined, ["REI", "rei.com"]],
    ]);
    expect(new Set(rules.map((r) => r.key)).size).toBe(3);
    expect(notes).toEqual([]);
  });
  it("refuses an invented address or words, an unknown kind or effect, a rule with no selector; each becomes an unclear note when its words are theirs", () => {
    const { rules, notes } = checkPreferences(
      {
        rules: [
          rule({ said: "Show sales at REI", effect: "show", senders: ["deals@rei.com"] }),
          rule({ said: "something they never wrote", effect: "hide", kinds: ["delivery"] }),
          rule({ said: "Hide everything from @promo.shopmart.com", effect: "mute", senders: ["@promo.shopmart.com"] }),
          rule({ said: "Never show package deliveries", effect: "hide", kinds: ["newsletter"] }),
          rule({ said: "Show sales at REI", effect: "first" }),
        ],
        notes: [{ said: "Show sales at REI", kind: "conflict", text: "both" }, { said: "x", kind: "rumour", text: "?" }],
      },
      text,
      unclear,
    );
    expect(rules).toEqual([]);
    expect(notes.map((n) => [n.kind, n.said])).toEqual([
      ["unclear", "Show sales at REI"],
      ["unclear", "Hide everything from @promo.shopmart.com"],
      ["unclear", "Never show package deliveries"],
      ["conflict", "Show sales at REI"],
    ]);
  });
  it("cues only on a show; one rule per meaning", () => {
    const { rules } = checkPreferences(
      { rules: [rule({ said: "Hide sales at REI", effect: "hide", about: "a sale at REI", cues: ["REI"] }), rule({ said: "Hide sales at REI", effect: "hide", about: "A sale  at REI" })], notes: [] },
      "Hide sales at REI",
      unclear,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]!.cues).toBeUndefined();
  });
});

describe("the empty box", () => {
  it("has no rules whatever the record holds", () => {
    expect(activeRules(null)).toEqual([]);
    expect(activeRules(NO_PREFERENCES)).toEqual([]);
    expect(activeRules({ ...NO_PREFERENCES, text: "  ", rules: [ok({ effect: "hide", kinds: ["pay"] })] })).toEqual([]);
    expect(preferenceDecision([], { kind: "pay", senderKey: "a@b.c" }, undefined, "")).toEqual({ hide: false, first: false, pending: false });
  });
});

describe("matching (plan 248 §4)", () => {
  it("senders by address or domain and its subdomains, never a lookalike", () => {
    expect(senderSelector("Orders+eu@Shop.test")).toBe("orders@shop.test");
    expect(senderSelector("@shop.test")).toBe("@shop.test");
    expect(senderSelector("shop.test")).toBe("@shop.test");
    expect(senderSelector("my landlord")).toBeNull();
    expect(senderMatches("@shop.test", "a@mail.shop.test")).toBe(true);
    expect(senderMatches("@shop.test", "a@shop.test")).toBe(true);
    expect(senderMatches("@shop.test", "a@myshop.test")).toBe(false);
  });
  it("exact rules decide alone; semantic ones by a verdict of the current basis; a hide wins; an unjudged semantic hide is pending", () => {
    const hidePay = ok({ effect: "hide", kinds: ["pay"] });
    const firstSchool = ok({ effect: "first", about: "school" });
    const hideNews = ok({ effect: "hide", about: "a newsletter" });
    const rules = [hidePay, firstSchool, hideNews];
    const basis = verdictBasis(rules);
    const t = { kind: "event" as const, senderKey: "office@school.test" };
    expect(preferenceDecision(rules, { kind: "pay", senderKey: "x@y.z" }, undefined, basis)).toEqual({ hide: true, first: false, pending: false });
    expect(preferenceDecision(rules, t, undefined, basis)).toEqual({ hide: false, first: false, pending: true });
    expect(preferenceDecision(rules, t, { basis, rules: [firstSchool.key] }, basis)).toEqual({ hide: false, first: true, pending: false });
    expect(preferenceDecision(rules, t, { basis, rules: [firstSchool.key, hideNews.key] }, basis)).toEqual({ hide: true, first: false, pending: false });
    // an old basis is no verdict
    expect(preferenceDecision(rules, t, { basis: "old", rules: [hideNews.key] }, basis).pending).toBe(true);
    // the exact parts gate the semantic: a hide of deliveries "unless signed" never reaches a bill
    expect(exactlyReaches(ok({ effect: "hide", kinds: ["delivery"], unless: "signed" }), { kind: "pay", senderKey: "" })).toBe(false);
  });
  it("a show's basis doesn't count: changing only shows keeps every verdict", () => {
    const hide = ok({ effect: "hide", about: "a newsletter" });
    expect(verdictBasis([hide, ok({ effect: "show", about: "REI", cues: ["REI"] })])).toBe(verdictBasis([hide]));
    expect(verdictBasis([ok({ effect: "hide", kinds: ["pay"] })])).toBe("");
  });
  it("a row's print changes with its words or day, not its revision", () => {
    expect(rowPrint("pay", "Pay", "due", "2026-11-20")).toBe(rowPrint("pay", "Pay", "due", "2026-11-20"));
    expect(rowPrint("pay", "Pay", "due", "2026-11-21")).not.toBe(rowPrint("pay", "Pay", "due", "2026-11-20"));
  });
});

describe("show admission (plan 248 §5)", () => {
  const rei = ok({ effect: "show", about: "a sale at REI", cues: ["REI", "field trip"] });
  const domain = ok({ effect: "show", senders: ["@school.test"] });
  it("a cue as whole words in the sender's name, subject or text; a sender by its selector", () => {
    expect(cueIn("art", " a party here ")).toBe(false);
    expect(wantedBy([rei], { senderKey: "a@b.test", subject: "Members sale at REI", text: "" })).toEqual([rei]);
    expect(wantedBy([rei], { senderKey: "a@b.test", subject: "Hi", text: "The Field-Trip is on Friday" })).toEqual([rei]);
    expect(wantedBy([rei], { senderKey: "a@b.test", subject: "Freight", text: "trips" })).toEqual([]);
    expect(wantedBy([domain, rei], { senderKey: "office@mail.school.test", subject: "Hello" })).toEqual([domain]);
    expect(wantedBy([ok({ effect: "hide", about: "REI", kinds: ["pay"] })], { senderKey: "x@y.z", subject: "REI" })).toEqual([]);
  });
});
