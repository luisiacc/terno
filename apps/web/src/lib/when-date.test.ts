import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryDay, whenDate, whenDay } from "./when";

afterEach(() => setLocale("en", en));

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 22, 16, 0);

describe("whenDate (plan 162: a past moment in a sentence)", () => {
  it("weekday, day and time; the year only when it isn't this one", () => {
    expect(whenDate(at(2026, 10, 22, 16, 0), NOW)).toBe("Thu, Oct 22, 4:00 PM");
    expect(whenDate(at(2025, 7, 14, 9, 5), NOW)).toBe("Mon, Jul 14, 2025, 9:05 AM");
    expect(whenDay(at(2026, 10, 19), NOW)).toBe("Mon, Oct 19");
  });
  it("a boundary always carries its year (Ask's scope)", () => {
    expect(boundaryDay(at(2026, 4, 25))).toBe("Apr 25, 2026");
  });
  it("Spanish", () => {
    setLocale("es", es);
    expect(whenDay(at(2026, 10, 19), NOW)).toMatch(/lun.*19.*oct/);
  });
});
