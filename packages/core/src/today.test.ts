import { describe, expect, it } from "vitest";
import { aiFeaturesAvailable, dayTier, inDayOrder, nextPrepareAt, prepareTimeToday, sortInDay, todayKey, type TodayWhy } from "./today";

const settings = (provider: string, over = {}) => ({ ai: { provider, model: "m", needsKey: false, hasKey: false, keyConfirmed: false, keyUnreadable: false, keys: {}, ...over } }) as never;

describe("who sees Today (plan 145)", () => {
  it("a provider set up, or the entitlement Pro will bring; nothing without either", () => {
    expect(aiFeaturesAvailable(settings("none"))).toBe(false);
    expect(aiFeaturesAvailable(settings("ollama"))).toBe(true);
    expect(aiFeaturesAvailable(settings("none"), { active: true })).toBe(true);
    expect(aiFeaturesAvailable(settings("none"), { active: false })).toBe(false);
    expect(aiFeaturesAvailable(null)).toBe(false);
  });

  it("a provider that needs a key, without one, is none", () => {
    expect(aiFeaturesAvailable(settings("compatible", { preset: "groq", needsKey: true }))).toBe(false);
    expect(aiFeaturesAvailable(settings("compatible", { preset: "groq", needsKey: true, hasKey: true, keyConfirmed: true }))).toBe(true);
    expect(aiFeaturesAvailable(settings("compatible", { preset: "groq", needsKey: true, hasKey: true, keyConfirmed: true, keyUnreadable: true }))).toBe(false);
  });

  it("plan 168: the one rule, so Today never shows where the digest can't run (Codex code review)", () => {
    expect(aiFeaturesAvailable(settings("ollama", { model: "" }))).toBe(false);
    expect(aiFeaturesAvailable(settings("compatible", { preset: "custom", baseURL: null }))).toBe(false);
    expect(aiFeaturesAvailable(settings("compatible", { preset: "custom", baseURL: "http://127.0.0.1:8080/v1" }))).toBe(true);
  });

  it("plan 168: on Claude or OpenAI, a usable key for either, whichever of the two is stored", () => {
    const key = (over = {}) => ({ hasKey: true, keyHint: null, ...over });
    expect(aiFeaturesAvailable(settings("anthropic", { needsKey: true, keys: {} }))).toBe(false);
    expect(aiFeaturesAvailable(settings("anthropic", { needsKey: true, keys: { openai: key() } }))).toBe(true);
    expect(aiFeaturesAvailable(settings("openai", { needsKey: true, keyUnreadable: true, keys: { openai: key({ keyUnreadable: true }), anthropic: key() } }))).toBe(true);
    expect(aiFeaturesAvailable(settings("anthropic", { needsKey: true, keys: { anthropic: key({ keyConfirmed: false }) } }))).toBe(false);
  });
});

describe("when it's prepared", () => {
  it("the next time round, today if it's still to come, tomorrow if it's gone", () => {
    const morning = new Date(2026, 10, 5, 7, 0).getTime();
    expect(nextPrepareAt("08:00", morning)).toBe(new Date(2026, 10, 5, 8, 0).getTime());
    const after = new Date(2026, 10, 5, 8, 0).getTime();
    expect(nextPrepareAt("08:00", after)).toBe(new Date(2026, 10, 6, 8, 0).getTime());
    expect(prepareTimeToday("08:30", morning)).toBe(new Date(2026, 10, 5, 8, 30).getTime());
    expect(todayKey(morning)).toBe("2026-11-05");
  });

  it("across a clock change, it's the same time on the wall", () => {
    // a year's worth of days: whichever the zone's changes are, each next is 8:00 local
    let at = new Date(2026, 0, 1, 9, 0).getTime();
    for (let i = 0; i < 366; i++) {
      at = nextPrepareAt("08:00", at);
      const d = new Date(at);
      expect([d.getHours(), d.getMinutes()]).toEqual([8, 0]);
    }
  });
});

describe("one order inside a day (plan 210, iteration 1)", () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const dated = (kind: NonNullable<TodayWhy["item"]>["kind"], dueAt: number, timed = false): TodayWhy => ({ kind: "dated", dueAt, item: { id: dueAt, revision: 0, kind, dueDay: "2026-11-18", timed, dated: true } });
  const named = new Map<TodayWhy, string>();
  const as = (name: string, why: TodayWhy) => (named.set(why, name), why);
  const sorted = (rows: TodayWhy[], clock = false) => [...rows].sort((a, b) => inDayOrder(a, b, clock)).map((w) => named.get(w));

  it("tasks, your promises, people, your reminders, then plans and deliveries", () => {
    expect([dated("pay", 0), dated("respond", 0), dated("alert", 0)].map(dayTier)).toEqual([0, 0, 0]);
    expect(dayTier({ kind: "promise" })).toBe(1);
    expect([dayTier(dated("ask", 0)), dayTier({ kind: "waiting" })]).toEqual([2, 2]);
    expect(dayTier({ kind: "reminder" })).toBe(3);
    expect([dayTier(dated("event", 0)), dayTier(dated("delivery", 0))]).toEqual([4, 4]);
  });

  it("the timed first by their time inside a tier; people as they came; a day ahead's timed by their time of day", () => {
    const rows = [
      as("lunch 12:30", dated("event", at(18, 12, 30), true)),
      as("parcel", dated("delivery", at(18, 0))),
      as("ask", dated("ask", at(17, 9))),
      as("waiting", { kind: "waiting" }),
      as("promise", { kind: "promise", dueAt: at(18, 0) }),
      as("rent", dated("pay", at(18, 0))),
      as("payroll 13:00", dated("respond", at(18, 13), true)),
      as("reminder", { kind: "reminder", dueAt: at(18, 9) }),
      as("breakfast 9:00", dated("event", at(18, 9), true)),
    ];
    expect(sorted(rows)).toEqual(["payroll 13:00", "rent", "promise", "ask", "waiting", "reminder", "breakfast 9:00", "lunch 12:30", "parcel"]);
    // Today: a plan still on from last night first; a day ahead: by the time of day (two put off to it from other days)
    const lastNight = as("last night 23:00", dated("event", at(17, 23), true));
    const morning = as("morning 8:00", dated("event", at(18, 8), true));
    expect(sorted([morning, lastNight])).toEqual(["last night 23:00", "morning 8:00"]);
    expect(sorted([lastNight, morning], true)).toEqual(["morning 8:00", "last night 23:00"]);
  });

  it("a whole list in the same order, each key read once: by its day first when given, ties as they came", () => {
    const rows = [
      { day: "2026-11-20", why: as("concert", dated("event", at(20, 19), true)) },
      { day: "2026-11-19", why: as("parcel", dated("delivery", at(19, 0))) },
      { day: "2026-11-20", why: as("rent", dated("pay", at(20, 0))) },
      { day: "2026-11-19", why: as("ned", { kind: "waiting" }) },
      { day: "2026-11-19", why: as("ana", { kind: "waiting" }) },
      { day: "2026-11-19", why: as("tax", dated("pay", at(19, 0))) },
    ];
    expect(sortInDay(rows, (r) => r.why, true, (r) => r.day).map((r) => named.get(r.why))).toEqual(["tax", "ned", "ana", "parcel", "rent", "concert"]);
    // without days, the comparator's order
    const whys = rows.map((r) => r.why);
    expect(sortInDay(whys, (w) => w, false).map((w) => named.get(w))).toEqual(sorted(whys));
  });
});
