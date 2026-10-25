import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { formatBytes, fullDate, listDate, viewLabel } from "./format";

afterEach(() => setLocale("en", en));

// local times, so the tests hold in any time zone
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2025, 10, 22, 9, 34);

describe("listDate", () => {
  it("English: time today, Yesterday, Oct 22 this year, Oct 22, 2024 before", () => {
    expect(listDate(at(2025, 10, 22, 0, 0), NOW)).toBe("12:00 AM");
    expect(listDate(at(2025, 10, 22, 9, 34), NOW)).toBe("9:34 AM");
    expect(listDate(at(2025, 10, 21, 23, 59), NOW)).toBe("Yesterday");
    expect(listDate(at(2025, 10, 21, 0, 0), NOW)).toBe("Yesterday");
    expect(listDate(at(2025, 10, 20, 23, 59), NOW)).toBe("Oct 20");
    expect(listDate(at(2025, 1, 1), NOW)).toBe("Jan 1");
    expect(listDate(at(2024, 12, 31, 23, 59), NOW)).toBe("Dec 31, 2024");
  });

  it("English: Yesterday across midnight of January 1st and across a DST change", () => {
    expect(listDate(at(2024, 12, 31, 22), at(2025, 1, 1, 1))).toBe("Yesterday");
    // the US and EU DST changes (whichever applies here, the day before is a calendar day)
    expect(listDate(at(2025, 3, 8, 12), at(2025, 3, 9, 12))).toBe("Yesterday");
    expect(listDate(at(2025, 3, 29, 23), at(2025, 3, 30, 4))).toBe("Yesterday");
    expect(listDate(at(2025, 11, 1, 1), at(2025, 11, 2, 23))).toBe("Yesterday");
  });

  it("Spanish keeps its formats: 09:34, 22 oct, 22 oct 2024, no Ayer", () => {
    setLocale("es", es);
    expect(listDate(at(2025, 10, 22, 9, 34), NOW)).toBe("09:34");
    expect(listDate(at(2025, 10, 21, 23, 59), NOW)).toBe("21 oct");
    expect(listDate(at(2025, 9, 3), NOW)).toBe("3 sept");
    expect(listDate(at(2024, 12, 31), NOW)).toBe("31 dic 2024");
  });

  it("full dates per locale", () => {
    expect(fullDate(NOW)).toBe("Wed, Oct 22, 2025, 9:34 AM");
    setLocale("es", es);
    expect(fullDate(NOW)).toBe("mié, 22 oct 2025, 09:34");
  });
});

describe("labels and sizes", () => {
  it("mailbox names in the active language", () => {
    expect(viewLabel("inbox")).toBe("Inbox");
    expect(viewLabel("other")).toBe("other");
    setLocale("es", es);
    expect(viewLabel("inbox")).toBe("Entrada");
  });

  it("sizes with the locale's digits", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
    setLocale("es", es);
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  });
});
