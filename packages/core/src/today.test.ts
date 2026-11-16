import { describe, expect, it } from "vitest";
import { aiFeaturesAvailable, dayOrderKey, dayTier, nextPrepareAt, prepareTimeToday, sortInDay, sortToday, todayKey, todayOrderKey, type TodayWhy } from "./today";

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
  const first = new Set<TodayWhy>();
  const today = (rows: TodayWhy[]) => sortToday(rows, (w) => w, (w) => first.has(w)).map((w) => named.get(w));
  const ahead = (rows: TodayWhy[]) => sortInDay(rows, (w) => w, () => "2026-11-18").map((w) => named.get(w));

  it("tasks, your promises, people, your reminders, then plans and deliveries", () => {
    expect([dated("pay", 0), dated("respond", 0), dated("alert", 0)].map(dayTier)).toEqual([0, 0, 0]);
    expect(dayTier({ kind: "promise" })).toBe(1);
    expect([dayTier(dated("ask", 0)), dayTier({ kind: "waiting" })]).toEqual([2, 2]);
    expect(dayTier({ kind: "reminder" })).toBe(3);
    expect([dayTier(dated("event", 0)), dayTier(dated("delivery", 0))]).toEqual([4, 4]);
  });

  it("Today (iteration 5, revision 7): what you do before what happens to you, each by its time and then the untimed; people last as they came. A day ahead: tier first, timed by their time of day", () => {
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
    expect(today(rows)).toEqual(["reminder", "payroll 13:00", "rent", "promise", "breakfast 9:00", "lunch 12:30", "parcel", "ask", "waiting"]);
    // a day ahead: by tier, the timed first in each
    expect(ahead(rows)).toEqual(["payroll 13:00", "rent", "promise", "ask", "waiting", "reminder", "breakfast 9:00", "lunch 12:30", "parcel"]);
    // Today: a plan still on from last night first (by its instant); a day ahead: by the time of day (two put off to it)
    const lastNight = as("last night 23:00", dated("event", at(17, 23), true));
    const morning = as("morning 8:00", dated("event", at(18, 8), true));
    expect(today([morning, lastNight])).toEqual(["last night 23:00", "morning 8:00"]);
    expect(ahead([lastNight, morning])).toEqual(["morning 8:00", "last night 23:00"]);
  });

  it("Today (revision 7's case): a 4:00 PM promise and an untimed payment before a 9:00 AM delivery; a broken promise needed today before all", () => {
    const delivery = as("delivery 9:00", dated("delivery", at(18, 9), true));
    const promise = as("promise 16:00", { kind: "promise", dueAt: at(18, 16), promise: { id: 1, revision: 0, timed: true } });
    const payment = as("payment", dated("pay", at(18, 9)));
    expect(today([delivery, promise, payment])).toEqual(["promise 16:00", "payment", "delivery 9:00"]);
    const broken = as("broken", { kind: "promise", dueAt: at(18, 9), promise: { id: 2, revision: 0 } });
    first.add(broken);
    expect(today([delivery, promise, payment, broken])).toEqual(["broken", "promise 16:00", "payment", "delivery 9:00"]);
    // one key, so the order is one order: every pair agrees with the whole list's
    const keys = [delivery, promise, payment, broken].map((w) => todayOrderKey(w, first.has(w)));
    expect(keys.map((k) => k.length)).toEqual([5, 5, 5, 5]);
  });

  it("a whole list ahead in the same order, each key read once: by its day first, ties as they came", () => {
    const rows = [
      { day: "2026-11-20", why: as("concert", dated("event", at(20, 19), true)) },
      { day: "2026-11-19", why: as("parcel", dated("delivery", at(19, 0))) },
      { day: "2026-11-20", why: as("rent", dated("pay", at(20, 0))) },
      { day: "2026-11-19", why: as("ned", { kind: "waiting" }) },
      { day: "2026-11-19", why: as("ana", { kind: "waiting" }) },
      { day: "2026-11-19", why: as("tax", dated("pay", at(19, 0))) },
    ];
    expect(sortInDay(rows, (r) => r.why, (r) => r.day).map((r) => named.get(r.why))).toEqual(["tax", "ned", "ana", "parcel", "rent", "concert"]);
    expect(dayOrderKey(rows[0]!.why)).toEqual([4, 0, 19 * 60, at(20, 19)]);
  });
});
