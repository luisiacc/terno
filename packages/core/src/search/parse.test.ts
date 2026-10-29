import { describe, expect, it } from "vitest";
import { isFullEmail, parseDate, parseSearch, withUnreadOnly } from "./parse";
import { resolveSearch } from "./resolve";

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
    expect(parseDate("2026/02/30", NOW)).toBeUndefined();
    expect(parseDate("tomorrow", NOW)).toBeUndefined();
  });

  it("rejects impossible calendar dates instead of searching a rolled-over day", () => {
    for (const date of ["2026-00-10", "2026-13-01", "2026-01-00", "2026-01-32", "2026-04-31", "2026-02-29", "1900-02-29"]) {
      expect(parseDate(date, NOW), date).toBeUndefined();
    }
    expect(parseDate("2000-02-29", NOW)).toBe(new Date(2000, 1, 29).getTime());
    expect(parseDate("2024/2/29", NOW)).toBe(new Date(2024, 1, 29).getTime());
    expect(parseDate("2026-01/15", NOW)).toBe(new Date(2026, 0, 15).getTime());
  });

  it("uses literal four-digit years, including leap days before year 100", () => {
    expect(parseDate("0000-02-29", NOW)).toBe(Date.parse("0000-02-29T00:00:00"));
    expect(parseDate("0004-02-29", NOW)).toBe(Date.parse("0004-02-29T00:00:00"));
    expect(parseDate("0099-01-15", NOW)).toBe(Date.parse("0099-01-15T00:00:00"));
    expect(parseDate("0001-02-29", NOW)).toBeUndefined();
  });

  it("never places non-finite relative boundaries in a search query", () => {
    for (const clock of [NaN, Infinity, -Infinity]) expect(parseDate("0d", clock)).toBeUndefined();
    for (const value of [`${"9".repeat(400)}d`, `1${"0".repeat(308)}d`]) {
      expect(parseDate(value, NOW), value).toBeUndefined();
      const q = parseSearch(`after:${value}`, NOW);
      expect(q.after).toBeUndefined();
      expect(q.terms[0]?.value).toBe(`after:${value}`);
    }
    expect(parseDate(`1${"0".repeat(300)}d`, -Number.MAX_VALUE)).toBeUndefined();
    expect(parseDate("0d", NOW)).toBe(NOW);
    expect(parseDate("2w", NOW)).toBe(NOW - 14 * 86_400_000);
    expect(parseDate("3m", NOW)).toBe(NOW - 90 * 86_400_000);
    expect(parseDate("1y", NOW)).toBe(NOW - 365 * 86_400_000);
    expect(parseDate("2026-01-15", NaN)).toBe(new Date(2026, 0, 15).getTime());
  });

  it.each([
    ["before:2026-02-30", "before:2026-02-30", false, false, true],
    ["-before:2026-02-30", "before:2026-02-30", false, true, true],
    ['after:"2026-02-30"', "after:2026-02-30", true, false, false],
    ["before:2026-02-30 ", "before:2026-02-30", false, false, false],
    ["-antes:2026-02-30 ", "before:2026-02-30", false, true, false],
    ["después:2026-02-30", "after:2026-02-30", false, false, true],
  ])("keeps invalid date input %s as a complete literal term", (input, value, phrase, negate, prefix) => {
    const q = parseSearch(input, NOW);
    expect(q.before).toBeUndefined();
    expect(q.after).toBeUndefined();
    expect(q.terms).toEqual([{ field: "text", value, phrase, negate, prefix }]);
  });

  it("keeps the last valid effective bound when invalid input follows", () => {
    const q = parseSearch("before:2026-01-01 -after:2026-01-02 before:2026-02-30 after:2025-01-01 -before:2025-01-02", NOW);
    expect(q.before).toBe(new Date(2026, 0, 2).getTime());
    expect(q.after).toBe(new Date(2025, 0, 2).getTime());
    expect(q.terms).toEqual([{ field: "text", value: "before:2026-02-30", phrase: false, negate: false, prefix: false }]);
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

describe("withUnreadOnly", () => {
  it("narrows to unread in front, so the token being typed stays the prefix one", () => {
    const q = withUnreadOnly("in:inbox factura marz", NOW)!;
    expect(q).toBe("is:unread in:inbox factura marz");
    const parsed = parseSearch(q, NOW);
    expect(parsed.unread).toBe(true);
    expect(parsed.view).toBe("inbox");
    expect(parsed.terms.map((t) => [t.value, t.prefix])).toEqual([["factura", false], ["marz", true]]);
  });

  it("a query that asks for read threads matches nothing with the filter on", () => {
    for (const q of ["is:read factura", "-is:unread", "es:leido", "-es:noleido"]) expect(withUnreadOnly(q, NOW), q).toBeNull();
    expect(withUnreadOnly("is:unread", NOW)).toBe("is:unread is:unread");
  });
});

describe("plan 64: a search looks everywhere", () => {
  const lookup = { accounts: [], categories: [] };
  it("by default every place (Spam and Trash too); in:all is still everything but them", () => {
    expect(resolveSearch(parseSearch("factura", NOW), "factura", {}, lookup).view).toBe("anywhere");
    expect(resolveSearch(parseSearch("in:all factura", NOW), "in:all factura", {}, lookup).view).toBe("all");
    expect(resolveSearch(parseSearch("in:spam factura", NOW), "in:spam factura", {}, lookup).view).toBe("spam");
  });
  it("in:anywhere and its aliases say it", () => {
    for (const q of ["in:anywhere", "in:everywhere", "en:todas", "en:cualquiera"]) expect(parseSearch(`${q} x`, NOW).view, q).toBe("anywhere");
    // todo keeps meaning All Mail (es)
    expect(parseSearch("en:todo x", NOW).view).toBe("all");
  });
});
