import { describe, expect, it } from "vitest";
import { evaluateRule } from "./rules/evaluate";
import { sameRule, similarLearnedKey, similarRule, similarScopes } from "./similar";

const root = (o: Partial<{ sender: string; subject: string; domain: string | null; list: string | null }> = {}) => ({ sender: "receipts@uber.com", subject: "Your receipt", domain: "uber.com", list: null, ...o });

describe("similar scopes (plan 63)", () => {
  it("offers only what every target shares, in sender, subject, domain, list order", () => {
    expect(similarScopes([root({ list: "r.uber.com" })])).toEqual([
      { kind: "sender", email: "receipts@uber.com" },
      { kind: "subject", email: "receipts@uber.com", subject: "Your receipt" },
      { kind: "domain", domain: "uber.com" },
      { kind: "list", listId: "r.uber.com" },
    ]);
    // another subject: no subject scope; another sender: nor sender or subject, the domain still
    expect(similarScopes([root(), root({ subject: "Your trip" })]).map((s) => s.kind)).toEqual(["sender", "domain"]);
    expect(similarScopes([root(), root({ sender: "eats@uber.com" })]).map((s) => s.kind)).toEqual(["domain"]);
    expect(similarScopes([])).toEqual([]);
  });

  it("a subject means the same in the rule: non-empty, unpadded, at most 500 characters; consumer domains are no scope", () => {
    for (const subject of ["", " Hi", "Hi ", "x".repeat(501)]) expect(similarScopes([root({ subject })]).map((s) => s.kind), JSON.stringify(subject)).toEqual(["sender", "domain"]);
    expect(similarScopes([root({ subject: "x".repeat(500) })]).map((s) => s.kind)).toContain("subject");
    expect(similarScopes([root({ sender: "ana@gmail.com", domain: "gmail.com" })]).map((s) => s.kind)).toEqual(["sender", "subject"]);
    // case differs, the scope is the same
    expect(similarScopes([root(), root({ subject: "YOUR RECEIPT" })]).map((s) => s.kind)).toContain("subject");
  });

  it("each scope's rule catches the same mail in the future", () => {
    const message = { accountId: 1, fromName: "Uber", fromEmail: "receipts@uber.com", recipients: "", subject: "Your receipt", bodyText: "", listId: "r.uber.com", hasAttachments: false, date: 0 };
    for (const scope of similarScopes([root({ list: "r.uber.com" })])) {
      const rule = similarRule(scope, "spam");
      expect(evaluateRule(rule, message, 0), scope.kind).toBe(true);
      expect(evaluateRule(rule, { ...message, fromEmail: "x@other.com", listId: null, subject: "Your receipt!" }, 0), scope.kind).toBe(false);
    }
  });

  it("learned keys for sender, domain and list only; rules compare by canonical form", () => {
    expect(similarLearnedKey({ kind: "sender", email: "Receipts@Uber.com" }, "spam")).toBe("sender:receipts@uber.com:spam");
    expect(similarLearnedKey({ kind: "subject", email: "a@b.c", subject: "x" }, "spam")).toBeNull();
    const a = similarRule({ kind: "subject", email: "a@b.c", subject: "Hello" }, "archive");
    const b = { ...a, conditions: [...a.conditions].reverse().map((c) => ({ ...c, value: typeof c.value === "string" ? c.value.toUpperCase() : c.value })) };
    expect(sameRule(a, b)).toBe(true);
    expect(sameRule(a, similarRule({ kind: "subject", email: "a@b.c", subject: "Hello" }, "trash"))).toBe(false);
  });
});
