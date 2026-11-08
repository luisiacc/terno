import type { FilterRule } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { describeRule, ruleMisses, sensedOp, withSensedOp } from "./rule-words";

const names = { accountEmail: (id: number) => `a${id}@x.test`, category: () => "Invoices", folder: (_: number, f: string) => f };
const uber: FilterRule = { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com" }], actions: [{ type: "archive" }] };
const nicer: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "nicer" }], actions: [{ type: "archive" }] };
const bank: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "read" }], actions: [{ type: "archive" }] };

afterEach(() => setLocale("en", en));

describe("a rule in words (plan 161)", () => {
  it("says what the rule does from its fields, not what was asked", () => {
    expect(describeRule(uber, names)).toBe("Archives mail that matches: domain is “uber.com”.");
    const two: FilterRule = { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com" }, { field: "ageDays", op: "gt", value: 7 }], actions: [{ type: "archive" }, { type: "markRead" }, { type: "addCategory", categoryId: 3 }] };
    expect(describeRule(two, names)).toBe("Archives, marks as read, and files in Invoices mail that matches: domain is “uber.com” and older than 7 days.");
    expect(describeRule({ ...two, match: "any" }, names)).toContain("matches any of: domain is “uber.com” or older than 7 days.");
    expect(describeRule({ ...uber, conditions: [{ field: "subject", op: "contains", value: "x", negate: true }] }, names)).toContain("subject doesn’t contain “x”");
  });

  it("in Spanish too", () => {
    setLocale("es", es);
    expect(describeRule(uber, names)).toBe("Archiva el correo que cumple: dominio es «uber.com».");
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
    expect(withSensedOp({ field: "account", op: "is", value: 2 }, "not:is")).toEqual({ field: "account", op: "is", value: 2, negate: true });
  });
});
