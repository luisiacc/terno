import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import type { TodayList, TodayWhy } from "@terno/core";
import { afterEach, describe, expect, it } from "vitest";
import { countClearDay, momentsOfList, nextChange, nextUp, sunPlace } from "./clear";
import { freeUntil } from "./when";

afterEach(() => setLocale("en", en));

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 19, 10, 0);
const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const dated = (dueAt: number, timed: boolean, extra: Partial<NonNullable<TodayWhy["item"]>> = {}): TodayWhy => ({ kind: "dated", dueAt, item: { id: 1, revision: 1, kind: "event", dueDay: day(dueAt), timed, dated: true, ...extra } });
const list = (...whys: TodayWhy[][]): Pick<TodayList, "sections"> => ({ sections: whys.map((items, i) => ({ kind: i === whys.length - 1 ? "comingUp" : "ahead", items: items.map((why, k) => ({ id: `${i}-${k}`, thread: {}, why })) })) as unknown as TodayList["sections"] });

const next = (l: Pick<TodayList, "sections">, now: number) => nextUp(momentsOfList(l), now);

describe("nextUp (plan 222): the next moment ahead in a clear What matters", () => {
  it("a timed plan later today; one already over is skipped", () => {
    expect(next(list([dated(at(2026, 11, 19, 7), true), dated(at(2026, 11, 19, 15), true)]), NOW)).toEqual({ at: at(2026, 11, 19, 15), timed: true });
  });
  it("the soonest of an untimed day ahead and Coming up's items, drawn or not", () => {
    expect(next(list([dated(at(2026, 11, 26, 9), false)], [dated(at(2026, 11, 21, 9), true)]), NOW)).toEqual({ at: at(2026, 11, 21, 9), timed: true });
    expect(next(list([], [dated(at(2026, 12, 3, 9), false)]), NOW)).toEqual({ at: at(2026, 12, 3), timed: false });
  });
  it("an ask's due is its arrival, a promise with no day has none: neither counts; a dated promise and a reminder do", () => {
    const ask: TodayWhy = { kind: "dated", dueAt: at(2026, 11, 25), item: { id: 2, revision: 1, kind: "ask", dueDay: "2026-11-25", timed: false, dated: false } };
    const undated: TodayWhy = { kind: "promise", dueAt: at(2026, 11, 20), promise: { id: 3, revision: 1, dated: false } };
    expect(next(list([ask, undated]), NOW)).toBeNull();
    expect(next(list([{ kind: "promise", dueAt: at(2026, 11, 23, 12), promise: { id: 3, revision: 1, dated: true, timed: true } }, { kind: "reminder", dueAt: at(2026, 11, 22, 9) }]), NOW)).toEqual({ at: at(2026, 11, 22, 9), timed: true });
  });
  it("an untimed item today leaves the day as it was", () => {
    expect(next(list([dated(at(2026, 11, 19, 12), false), dated(at(2026, 11, 19, 15), true)]), NOW)).toBe("today");
  });
  it("Codex's plan critique: put off with Later, an item is next when it's back, waiting rows too", () => {
    expect(next(list([{ ...dated(at(2026, 11, 18, 9), true, { kind: "pay" }), back: at(2026, 11, 20, 9) }]), NOW)).toEqual({ at: at(2026, 11, 20, 9), timed: true });
    expect(next(list([{ kind: "waiting", back: at(2026, 11, 21, 8) }]), NOW)).toEqual({ at: at(2026, 11, 21, 8), timed: true });
  });
  it("Codex's plan critique: a reply's other promise (`also`) sooner than the one its row leads with", () => {
    const lead: TodayWhy = { kind: "promise", dueAt: at(2026, 11, 27, 12), promise: { id: 4, revision: 1, dated: true, timed: true } };
    const l = { sections: [{ kind: "ahead", items: [{ id: "p", thread: {}, why: lead, also: [{ kind: "promise", text: "Send the deck", dueDay: "2026-11-24", dueAt: at(2026, 11, 24, 9), timed: false, dated: true }] }] }] } as unknown as TodayList;
    expect(next(l, NOW)).toEqual({ at: at(2026, 11, 24), timed: false });
  });
  it("Codex's plan critique: a plan underway is today's, not free time; once it's over, what's next", () => {
    const meeting = list([dated(at(2026, 11, 19, 9, 30), true), dated(at(2026, 11, 20, 9), true)]);
    expect(next(meeting, NOW)).toBe("today");
    expect(next(meeting, at(2026, 11, 19, 11, 31))).toEqual({ at: at(2026, 11, 20, 9), timed: true });
  });
  it("nothing ahead at all", () => {
    expect(next(list([{ kind: "waiting" }]), NOW)).toBeNull();
  });
});

describe("freeUntil (plan 222): its words", () => {
  it("English", () => {
    expect(freeUntil({ at: at(2026, 11, 19, 15), timed: true }, NOW)).toBe("You're free until 3:00 PM.");
    expect(freeUntil({ at: at(2026, 11, 20, 9), timed: true }, NOW)).toBe("Nothing needs you until tomorrow.");
    expect(freeUntil({ at: at(2026, 11, 24), timed: false }, NOW)).toBe("Nothing needs you until Tuesday.");
    expect(freeUntil({ at: at(2026, 11, 26), timed: false }, NOW)).toBe("Nothing needs you until Nov 26.");
    expect(freeUntil({ at: at(2026, 12, 3), timed: false }, NOW)).toBe("Nothing needs you until Dec 3.");
    expect(freeUntil("today", NOW)).toBe("Nothing needs you today.");
    expect(freeUntil(null, NOW)).toBe("Nothing on the horizon.");
  });
  it("Spanish", () => {
    setLocale("es", es);
    expect(freeUntil({ at: at(2026, 11, 19, 15), timed: true }, NOW)).toBe("Estás libre hasta las 15:00.");
    expect(freeUntil({ at: at(2026, 11, 20, 9), timed: true }, NOW)).toBe("Nada te necesita hasta mañana.");
    expect(freeUntil({ at: at(2026, 11, 24), timed: false }, NOW)).toBe("Nada te necesita hasta el martes.");
    expect(freeUntil({ at: at(2026, 12, 3), timed: false }, NOW)).toBe("Nada te necesita hasta el 3 dic.");
    expect(freeUntil(null, NOW)).toBe("Nada en el horizonte.");
  });
});

describe("nextChange (plan 222): the one moment the words change by the clock", () => {
  it("the next timed moment or plan's end today, else midnight", () => {
    const moments = momentsOfList(list([dated(at(2026, 11, 19, 9, 30), true), dated(at(2026, 11, 19, 15), true)]));
    expect(nextChange(moments, NOW)).toBe(at(2026, 11, 19, 11, 30));
    expect(nextChange(moments, at(2026, 11, 19, 12))).toBe(at(2026, 11, 19, 15));
    expect(nextChange(moments, at(2026, 11, 19, 18))).toBe(at(2026, 11, 20));
  });
});

describe("sunPlace (plan 222): the sun by the clock, never at night", () => {
  it("rests on the line at its feet before 6:00 and after 18:00; highest at noon", () => {
    expect(sunPlace(3)).toEqual({ x: 30, y: 92, up: false });
    expect(sunPlace(21)).toEqual({ x: 410, y: 92, up: false });
    const noon = sunPlace(12);
    expect(noon.x).toBeCloseTo(220);
    expect(noon.y).toBeLessThan(sunPlace(9).y);
    expect(noon.up).toBe(true);
  });
});

describe("countClearDay (plan 222): a count of days, never a streak", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("the first clear day is 1; the same day again is still 1; a later day, even after a gap, is the next", () => {
    const s = memory();
    expect(countClearDay(NOW, s)).toBe(1);
    expect(countClearDay(NOW + 3_600_000, s)).toBe(1);
    expect(countClearDay(at(2026, 11, 23, 9), s)).toBe(2);
  });
  it("refused or broken storage says no number", () => {
    expect(countClearDay(NOW, null)).toBeNull();
    expect(countClearDay(NOW, { getItem: () => { throw new Error("denied"); }, setItem: () => {} })).toBeNull();
    const s = memory();
    s.setItem("terno.whatMatters.clearDays", "{broken");
    expect(countClearDay(NOW, s)).toBeNull();
  });
});
