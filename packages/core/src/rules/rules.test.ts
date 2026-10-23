import { describe, expect, it } from "vitest";
import { bodyMatches, evaluateRule, type RuleMessage } from "./evaluate";
import { filterRuleSchema, type FilterRule } from "./schema";

const NOW = Date.UTC(2026, 9, 22);
const msg = (over: Partial<RuleMessage> = {}): RuleMessage => ({
  accountId: 1,
  fromName: "Señora Peña",
  fromEmail: "Ofertas@Tienda.ES",
  recipients: "luis@example.com Luis Cordero",
  subject: "¡Última OFERTA en Canción!",
  bodyText: "Hola Luis, descubre la nueva colección. Darse de baja aquí.",
  listId: "promo.tienda.es",
  hasAttachments: false,
  date: NOW - 3 * 86_400_000,
  ...over,
});
const rule = (conditions: FilterRule["conditions"], match: FilterRule["match"] = "all"): FilterRule => ({
  match,
  conditions,
  actions: [{ type: "archive" }],
});

describe("evaluateRule", () => {
  it("matches text case- and accent-insensitively on both sides", () => {
    expect(evaluateRule(rule([{ field: "subject", op: "contains", value: "ultima oferta" }]), msg(), NOW)).toBe(true);
    expect(evaluateRule(rule([{ field: "from", op: "contains", value: "PENA" }]), msg(), NOW)).toBe(true);
  });

  it("from: equals matches the address or the display name, never a substring", () => {
    expect(evaluateRule(rule([{ field: "from", op: "equals", value: "ofertas@tienda.es" }]), msg(), NOW)).toBe(true);
    expect(evaluateRule(rule([{ field: "from", op: "equals", value: "señora peña" }]), msg(), NOW)).toBe(true);
    expect(evaluateRule(rule([{ field: "from", op: "equals", value: "tienda.es" }]), msg(), NOW)).toBe(false);
  });

  it("fromDomain compares the domain part only", () => {
    expect(evaluateRule(rule([{ field: "fromDomain", op: "equals", value: "tienda.es" }]), msg(), NOW)).toBe(true);
    expect(evaluateRule(rule([{ field: "fromDomain", op: "endsWith", value: ".es" }]), msg(), NOW)).toBe(true);
    expect(evaluateRule(rule([{ field: "fromDomain", op: "equals", value: "ofertas" }]), msg(), NOW)).toBe(false);
  });

  it("negation of a condition on a missing value is true (null never matches)", () => {
    const noList = msg({ listId: null, bodyText: null });
    expect(evaluateRule(rule([{ field: "listId", op: "contains", value: "promo" }]), noList, NOW)).toBe(false);
    expect(evaluateRule(rule([{ field: "listId", op: "contains", value: "promo", negate: true }]), noList, NOW)).toBe(true);
    expect(evaluateRule(rule([{ field: "body", op: "contains", value: "hola", negate: true }]), noList, NOW)).toBe(true);
  });

  it("ageDays compares against the supplied clock", () => {
    expect(evaluateRule(rule([{ field: "ageDays", op: "gt", value: 2 }]), msg(), NOW)).toBe(true);
    expect(evaluateRule(rule([{ field: "ageDays", op: "gt", value: 5 }]), msg(), NOW)).toBe(false);
    expect(evaluateRule(rule([{ field: "ageDays", op: "lt", value: 5 }]), msg(), NOW)).toBe(true);
  });

  it("supports any/all combination", () => {
    const conditions: FilterRule["conditions"] = [
      { field: "hasAttachment", op: "is", value: true },
      { field: "account", op: "is", value: 1 },
    ];
    expect(evaluateRule(rule(conditions, "all"), msg(), NOW)).toBe(false);
    expect(evaluateRule(rule(conditions, "any"), msg(), NOW)).toBe(true);
  });
});

describe("bodyMatches (word/phrase semantics, mirrors FTS)", () => {
  const body = "Hola Luis, descubre la nueva colección. Darse de baja aquí.";
  it("matches whole-word phrases ignoring punctuation and accents", () => {
    expect(bodyMatches("contains", body, "darse de baja")).toBe(true);
    expect(bodyMatches("contains", body, "COLECCION")).toBe(true);
    expect(bodyMatches("contains", body, "luis descubre")).toBe(true); // comma is a separator
  });
  it("does not match partial words or out-of-order phrases", () => {
    expect(bodyMatches("contains", body, "colec")).toBe(false);
    expect(bodyMatches("contains", body, "baja de darse")).toBe(false);
  });
  it("anchors startsWith/endsWith/equals on token boundaries", () => {
    expect(bodyMatches("startsWith", body, "hola luis")).toBe(true);
    expect(bodyMatches("endsWith", body, "baja aqui")).toBe(true);
    expect(bodyMatches("equals", "  Hola, LUIS! ", "hola luis")).toBe(true);
    expect(bodyMatches("equals", body, "hola luis")).toBe(false);
  });
  it("never matches a needle with no word characters", () => {
    expect(bodyMatches("contains", body, "!!!")).toBe(false);
  });
});

describe("filterRuleSchema", () => {
  it("rejects conflicting location actions and duplicates", () => {
    const bad = filterRuleSchema.safeParse({
      match: "all",
      conditions: [{ field: "subject", op: "contains", value: "x" }],
      actions: [{ type: "archive" }, { type: "trash" }],
    });
    expect(bad.success).toBe(false);
    const dup = filterRuleSchema.safeParse({
      match: "all",
      conditions: [{ field: "subject", op: "contains", value: "x" }],
      actions: [{ type: "addCategory", categoryId: 2 }, { type: "addCategory", categoryId: 2 }],
    });
    expect(dup.success).toBe(false);
  });

  it("rejects operators that don't fit the field type and blank values", () => {
    const parse = (c: unknown) =>
      filterRuleSchema.safeParse({ match: "all", conditions: [c], actions: [{ type: "star" }] }).success;
    expect(parse({ field: "hasAttachment", op: "contains", value: true })).toBe(false);
    expect(parse({ field: "ageDays", op: "contains", value: 3 })).toBe(false);
    expect(parse({ field: "subject", op: "contains", value: "   " })).toBe(false);
    expect(parse({ field: "subject", op: "matches", value: ".*" })).toBe(false);
    expect(parse({ field: "ageDays", op: "gt", value: 30 })).toBe(true);
  });
});
