import { describe, expect, it } from "vitest";
import { isFullEmail, parseDate, parseSearch } from "./parse";

const NOW = new Date(2026, 9, 22, 12).getTime();

describe("parseSearch", () => {
  it("splits free text into message terms and marks only the trailing token as prefix", () => {
    const q = parseSearch("factura marz", NOW);
    expect(q.terms).toEqual([
      { field: "text", value: "factura", phrase: false, negate: false, prefix: false },
      { field: "text", value: "marz", phrase: false, negate: false, prefix: true },
    ]);
  });

  it("does not prefix-match once the user typed a trailing space", () => {
    const q = parseSearch("factura ", NOW);
    expect(q.terms[0]!.prefix).toBe(false);
  });

  it("parses operators with quoted values and negation", () => {
    const q = parseSearch('from:ana subject:"reunión de equipo" -to:boss@x.com', NOW);
    expect(q.terms).toEqual([
      { field: "from", value: "ana", phrase: false, negate: false, prefix: false },
      { field: "subject", value: "reunión de equipo", phrase: true, negate: false, prefix: false },
      { field: "to", value: "boss@x.com", phrase: false, negate: true, prefix: true },
    ]);
  });

  it("understands Spanish aliases for keys and values", () => {
    const q = parseSearch("de:lucia tiene:adjunto es:noleido en:papelera categoría:viajes cuenta:trabajo", NOW);
    expect(q.terms).toEqual([{ field: "from", value: "lucia", phrase: false, negate: false, prefix: false }]);
    expect(q).toMatchObject({ hasAttachment: true, unread: true, view: "trash", categories: ["viajes"], accounts: ["trabajo"], excludeAccounts: [], excludeCategories: [] });
  });

  it("maps is:read and negated flags onto booleans", () => {
    expect(parseSearch("is:read", NOW).unread).toBe(false);
    expect(parseSearch("-is:unread", NOW).unread).toBe(false);
    expect(parseSearch("-has:attachment", NOW).hasAttachment).toBe(false);
    expect(parseSearch("-is:starred", NOW).starred).toBe(false);
  });

  it("keeps unknown keys and invalid values as literal text instead of dropping them", () => {
    const q = parseSearch("foo:bar is:weird before:someday", NOW);
    expect(q.terms.map((t) => t.value)).toEqual(["foo:bar", "is:weird", "before:someday"]);
    expect(q.before).toBeUndefined();
  });

  it("negation of scope and date operators is honoured, not dropped", () => {
    const q = parseSearch("-account:trabajo -category:facturas -before:2026-01-01 -after:7d", NOW);
    expect(q).toMatchObject({ accounts: [], categories: [], excludeAccounts: ["trabajo"], excludeCategories: ["facturas"] });
    expect(q.after).toBe(new Date(2026, 0, 1).getTime()); // -before:X → on/after X
    expect(q.before).toBe(NOW - 7 * 86_400_000); // -after:X → before X
  });

  it("parses absolute and relative dates", () => {
    const q = parseSearch("after:2026-01-15 before:7d", NOW);
    expect(q.after).toBe(new Date(2026, 0, 15).getTime());
    expect(q.before).toBe(NOW - 7 * 86_400_000);
    expect(parseDate("2026/02/30", NOW)).toBe(new Date(2026, 1, 30).getTime()); // JS rolls over, still a date
    expect(parseDate("tomorrow", NOW)).toBeUndefined();
  });

  it("treats an unterminated quote as a phrase to the end of input", () => {
    const q = parseSearch('"hola mundo', NOW);
    expect(q.terms).toEqual([{ field: "text", value: "hola mundo", phrase: true, negate: false, prefix: false }]);
  });

  it("treats a lone dash as text, not a negation", () => {
    expect(parseSearch("a - b", NOW).terms.map((t) => [t.value, t.negate])).toEqual([
      ["a", false],
      ["-", false],
      ["b", false],
    ]);
  });

  it("detects complete email addresses", () => {
    expect(isFullEmail("ana@example.com")).toBe(true);
    expect(isFullEmail("ana@example")).toBe(false);
    expect(isFullEmail("ana")).toBe(false);
  });
});
