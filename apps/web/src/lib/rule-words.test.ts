import type { Condition, FilterRule } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { describeRule, hasDetails, matchesAnything, patternTerms, ruleDetails, ruleMisses, ruleRow, sensedOp, withSensedOp } from "./rule-words";

const names = { accountEmail: (id: number) => `a${id}@x.test`, category: () => "Invoices", folder: (_: number, f: string) => f };
const uber: FilterRule = { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com" }], actions: [{ type: "archive" }] };
const nicer: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "nicer" }], actions: [{ type: "archive" }] };
const bank: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "read" }], actions: [{ type: "archive" }] };

afterEach(() => setLocale("en", en));

describe("a rule in words (plan 161)", () => {
  it("says what the rule does from its fields, not what was asked", () => {
    expect(describeRule(uber, names)).toBe("Domain is “uber.com” → archive.");
    const two: FilterRule = { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com" }, { field: "ageDays", op: "gt", value: 7 }], actions: [{ type: "archive" }, { type: "markRead" }, { type: "addCategory", categoryId: 3 }] };
    expect(describeRule(two, names)).toBe("Domain is “uber.com” and older than 7 days → archive, mark as read, and file in Invoices.");
    expect(describeRule({ ...two, match: "any" }, names)).toBe("Domain is “uber.com” or older than 7 days → archive, mark as read, and file in Invoices.");
    expect(describeRule({ ...uber, conditions: [{ field: "subject", op: "contains", value: "x", negate: true }] }, names)).toBe("Subject doesn’t contain “x” → archive.");
  });

  it("in Spanish too", () => {
    setLocale("es", es);
    expect(describeRule(uber, names)).toBe("Dominio es «uber.com» → archivar.");
  });
});

describe("a rule that plainly misses its request (plan 161, no model asked)", () => {
  it("passes a rule that covers what was asked", () => {
    expect(ruleMisses("archive receipts from uber.com", uber)).toBe(false);
    expect(ruleMisses("archiva los recibos de uber.com", uber)).toBe(false);
  });
  it("flags a request with nothing to do, and one whose sender, age or action the rule lacks", () => {
    expect(ruleMisses("make my inbox nicer", nicer)).toBe(true);
    expect(ruleMisses("archive anything from my bank older than a week and mark it read", bank)).toBe(true);
    expect(ruleMisses("archive everything older than 30 days", uber)).toBe(true);
    expect(ruleMisses("archive mail with invoice in the subject and mark it as read", { ...nicer, actions: [{ type: "archive" }] })).toBe(true);
    expect(ruleMisses("archiva los correos de hace más de 30 días", uber)).toBe(true);
    expect(ruleMisses("delete newsletters from uber.com", uber)).toBe(true);
  });
});

describe("the operator menu holds both senses (plan 161: no yes/not toggle)", () => {
  it("reads and writes negate through the operator", () => {
    expect(sensedOp({ field: "subject", op: "contains", value: "x" })).toBe("contains");
    expect(sensedOp({ field: "subject", op: "contains", value: "x", negate: true })).toBe("not:contains");
    expect(withSensedOp({ field: "subject", op: "contains", value: "x" }, "not:equals")).toEqual({ field: "subject", op: "equals", value: "x", negate: true });
    expect(withSensedOp({ field: "subject", op: "equals", value: "x", negate: true }, "startsWith")).toEqual({ field: "subject", op: "startsWith", value: "x", negate: undefined });
    expect(sensedOp({ field: "hasAttachment", op: "is", value: true, negate: true })).toBe("not:is");
    // Codex review: a false value is a "no" too, in all four combinations, and a choice writes one plain sense
    expect(sensedOp({ field: "hasAttachment", op: "is", value: true })).toBe("is");
    expect(sensedOp({ field: "hasAttachment", op: "is", value: false })).toBe("not:is");
    expect(sensedOp({ field: "hasAttachment", op: "is", value: false, negate: true })).toBe("is");
    expect(withSensedOp({ field: "hasAttachment", op: "is", value: false }, "not:is")).toEqual({ field: "hasAttachment", op: "is", value: true, negate: true });
    expect(withSensedOp({ field: "hasAttachment", op: "is", value: false, negate: true }, "is")).toEqual({ field: "hasAttachment", op: "is", value: true, negate: undefined });
    expect(withSensedOp({ field: "account", op: "is", value: 2 }, "not:is")).toEqual({ field: "account", op: "is", value: 2, negate: true });
  });
});

const email = () => "me@example.com";

describe("a sentence's rule in words (plan 161)", () => {
  it("a pattern that's only words is those words", () => {
    expect(patternTerms("shipped|delivery|tracking|pedido|paquete|en camino|entregado|enviado")).toEqual(["shipped", "delivery", "tracking", "pedido", "paquete", "en camino", "entregado", "enviado"]);
    expect(patternTerms("(?:invoice|receipt)")).toEqual(["invoice", "receipt"]);
    // an escaped dot is a dot, said as written
    expect(patternTerms("amazon\\.com|ups")).toEqual(["amazon.com", "ups"]);
    // anything more than words isn't a list of them
    for (const p of ["ship.*ped", "^order", "a|b+", "[0-9]+", "x|", "(a|b)c"]) expect(patternTerms(p)).toBeNull();
  });

  it("each condition a row: where it looks, and what it asks", () => {
    const opening: Condition = { field: "opening", op: "matches", value: "shipped|delivery", negate: false };
    expect(ruleRow(opening, email)).toEqual({ label: "Subject and first lines", text: "mentions any of", terms: ["shipped", "delivery"] });
    expect(ruleRow({ ...opening, negate: true }, email)).toMatchObject({ text: "mentions none of" });
    expect(ruleRow({ field: "ageDays", op: "gt", value: 30, negate: false } as Condition, email)).toEqual({ label: "Age", text: "Older than 30 days" });
    expect(ruleRow({ field: "fromDomain", op: "equals", value: "amazon.com", negate: true }, email)).toEqual({ label: "Domain", text: "Isn’t “amazon.com”" });
    expect(ruleRow({ field: "text", op: "contains", value: "recruiter", negate: false }, email)).toEqual({ label: "Anywhere", text: "mentions", terms: ["recruiter"] });
    // a generated template reads as its template; any other pattern doesn't print its syntax
    expect(ruleRow({ field: "subject", op: "matches", value: "^Tu pedido [0-9]+ está en camino$", negate: false }, email).text).toMatch(/is like “Tu pedido # está en camino”/);
    const other = ruleRow({ field: "subject", op: "matches", value: "ship.*ped", negate: false }, email);
    expect(other.text).toBe("matches a pattern (see Exact pattern)");
    expect(other.terms).toBeUndefined();
  });

  it("Exact pattern holds each pattern verbatim by its field, and only when a pattern needs it (pass 2)", () => {
    const conditions: Condition[] = [{ field: "opening", op: "matches", value: "shipped|delivery", negate: false }, { field: "ageDays", op: "gt", value: 30, negate: false } as Condition, { field: "subject", op: "matches", value: "^Re:", negate: true }];
    expect(hasDetails(conditions)).toBe(true);
    // the rows already say the age: only the patterns, by the field's plain name, a "not" kept
    expect(ruleDetails(conditions)).toEqual([
      { field: "Subject and first lines", negate: false, pattern: "shipped|delivery" },
      { field: "Subject", negate: true, pattern: "^Re:" },
    ]);
    expect(hasDetails([{ field: "fromDomain", op: "equals", value: "ups.com", negate: false }])).toBe(false);
  });

  it("a pattern for anything says what it means, and needs no Exact pattern (pass 3)", () => {
    // the macOS rater's "Delete all newsletters from Netflix": the rule the stand-in model wrote was "any list at all"
    const anyList: Condition = { field: "listId", op: "matches", value: ".", negate: false };
    expect(ruleRow(anyList, email)).toEqual({ label: "List", text: "Any mailing list" });
    expect(ruleRow({ ...anyList, negate: true }, email).text).toBe("Not from a mailing list");
    expect(ruleRow({ field: "subject", op: "matches", value: ".+", negate: false }, email).text).toBe("Anything");
    expect(ruleRow({ field: "subject", op: "matches", value: ".", negate: true }, email).text).toBe("Empty");
    // Codex review (pass 3) #8: one an empty value matches too says so; mail with no List-Id is such a value
    expect(ruleRow({ field: "subject", op: "matches", value: "^", negate: false }, email).text).toBe("Anything, even empty");
    expect(ruleRow({ ...anyList, value: ".*" }, email).text).toBe("Any mail, on a list or not");
    expect(ruleRow({ ...anyList, value: ".*", negate: true }, email).text).toBe("Nothing");
    expect(hasDetails([anyList])).toBe(false);
    expect(hasDetails([{ ...anyList, value: "^" }])).toBe(false);
    expect(ruleDetails([anyList])).toEqual([]);
    for (const p of [".", ".+", " ^.+ ", "(.+)", ".*", "^", "^.*$"]) expect(matchesAnything(p)).toBe(true);
    // more than one character, or a character of its own: still "a pattern"
    for (const p of ["", "..", ".{2}", "\\.", "^a"]) expect(matchesAnything(p)).toBe(false);
  });
});
