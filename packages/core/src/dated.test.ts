import { describe, expect, it } from "vitest";
import { datedPlace, datedTiming, hasTimeCue, nextTodayChange, planEnd, promiseMissed, type DatedKind, type DatedRow } from "./dated";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const clock = (ms: number) => { const d = new Date(ms); return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };

const arrived = at(2026, 11, 10, 14);
const timing = (kind: DatedKind, due: string | null, time: string | null = null, arrivedAt = arrived) => datedTiming({ kind, due, time, arrivedAt });

type Placed = Pick<DatedRow, "kind" | "state" | "dueDay" | "dueAt" | "timed" | "actAt" | "deferredUntil">;
const item = (kind: DatedKind, due: string | null, time: string | null = null, more: Partial<Placed> = {}): Placed => ({ kind, state: "open", deferredUntil: null, ...timing(kind, due, time)!, ...more });

describe("when a dated item shows (plan 204 §2)", () => {
  it("each kind shows its lead before its day, at 9:00", () => {
    expect(clock(timing("pay", "2026-11-20")!.actAt)).toEqual([11, 17, 9, 0]);
    expect(clock(timing("renew", "2026-11-20")!.actAt)).toEqual([11, 13, 9, 0]);
    expect(clock(timing("expire", "2026-11-20")!.actAt)).toEqual([11, 13, 9, 0]);
    expect(clock(timing("respond", "2026-11-20")!.actAt)).toEqual([11, 18, 9, 0]);
    expect(clock(timing("event", "2026-11-20")!.actAt)).toEqual([11, 19, 9, 0]);
    expect(clock(timing("delivery", "2026-11-20")!.actAt)).toEqual([11, 20, 0, 0]);
  });
  it("an alert shows at once; one with no day is due its third day", () => {
    expect(timing("alert", "2026-11-20")!.actAt).toBe(arrived);
    const undated = timing("alert", null)!;
    expect(undated).toMatchObject({ actAt: arrived, dated: false, dueDay: "2026-11-12" });
  });
  it("a lead that's already begun shows at once", () => {
    expect(timing("renew", "2026-11-12")!.actAt).toBe(arrived);
  });
  it("a time orders it; with none, 9:00", () => {
    expect(timing("event", "2026-11-20", "07:40")).toMatchObject({ timed: true, dueAt: at(2026, 11, 20, 7, 40) });
    expect(timing("event", "2026-11-20", "25:00")).toMatchObject({ timed: false, dueAt: at(2026, 11, 20, 9) });
  });
  it("isn't kept: a day already over, a year out, a non-date, a dated kind with no day", () => {
    expect(timing("pay", "2026-11-09")).toBeNull();
    expect(timing("pay", "2026-11-10")).not.toBeNull();
    expect(timing("pay", "2027-12-01")).toBeNull();
    expect(timing("pay", "2026-02-30")).toBeNull();
    expect(timing("pay", null)).toBeNull();
  });
  it("across a DST change it keeps its hour", () => {
    expect(new Date(timing("pay", "2026-11-03", null, at(2026, 10, 25, 12))!.actAt).getHours()).toBe(9);
    expect(new Date(timing("pay", "2026-03-10", null, at(2026, 3, 1, 12))!.actAt).getHours()).toBe(9);
  });
});

describe("where an item sits (revision 8)", () => {
  const bill = item("pay", "2026-11-20");
  it("a deadline: Coming up, then Deadlines, then Missed for 7 days, then nothing", () => {
    expect(datedPlace(bill, at(2026, 11, 10, 15))).toBe("comingUp");
    expect(datedPlace(bill, at(2026, 11, 17, 9))).toBe("deadlines");
    expect(datedPlace(bill, at(2026, 11, 20, 23, 59))).toBe("deadlines");
    expect(datedPlace(bill, at(2026, 11, 21, 0))).toBe("missed");
    expect(datedPlace(bill, at(2026, 11, 27, 23))).toBe("missed");
    expect(datedPlace(bill, at(2026, 11, 28, 0))).toBe("hidden");
  });
  it("past Coming up's two weeks it isn't shown yet", () => {
    expect(datedPlace(item("pay", "2026-12-20"), at(2026, 11, 10, 15))).toBe("hidden");
  });
  it("a plan is never Missed: it ends", () => {
    const flight = item("event", "2026-11-20", "07:40");
    expect(datedPlace(flight, at(2026, 11, 19, 9))).toBe("plans");
    expect(datedPlace(flight, at(2026, 11, 20, 9, 39))).toBe("plans");
    expect(datedPlace(flight, at(2026, 11, 20, 9, 40))).toBe("hidden");
    expect(planEnd(item("delivery", "2026-11-20"))).toBe(at(2026, 11, 21));
  });
  it("Later hides it, and it isn't Missed while deferred", () => {
    const later = { ...bill, deferredUntil: at(2026, 11, 22, 9) };
    expect(datedPlace(later, at(2026, 11, 18, 9))).toBe("comingUp");
    expect(datedPlace(later, at(2026, 11, 21, 9))).toBe("comingUp");
    expect(datedPlace(later, at(2026, 11, 22, 9))).toBe("missed");
  });
  it("closed is hidden", () => {
    expect(datedPlace({ ...bill, state: "done" }, at(2026, 11, 18))).toBe("hidden");
  });
  it("an undated alert is Missed its fourth day", () => {
    const alert = item("alert", null);
    expect(datedPlace(alert, arrived)).toBe("deadlines");
    expect(datedPlace(alert, at(2026, 11, 13, 0))).toBe("missed");
  });
});

describe("a promise of yours is Missed (plan 204 §1)", () => {
  const promise = { kind: "promise", state: "due", dated: true, dueAt: at(2026, 11, 12, 9) };
  it("once its day ends, for 7 days, only when dated and due", () => {
    expect(promiseMissed(promise, at(2026, 11, 12, 23))).toBe(false);
    expect(promiseMissed(promise, at(2026, 11, 13, 0))).toBe(true);
    expect(promiseMissed(promise, at(2026, 11, 20, 0))).toBe(false);
    expect(promiseMissed({ ...promise, dated: false }, at(2026, 11, 13, 1))).toBe(false);
    expect(promiseMissed({ ...promise, state: "open" }, at(2026, 11, 13, 1))).toBe(false);
    expect(promiseMissed({ ...promise, kind: "awaiting" }, at(2026, 11, 13, 1))).toBe(false);
  });
});

describe("the next change by the clock (revision 11)", () => {
  it("is the soonest moment strictly after now, across items and promises", () => {
    const bill = item("pay", "2026-11-20");
    expect(nextTodayChange([bill], [], at(2026, 11, 10, 15))).toBe(at(2026, 11, 17, 9));
    expect(nextTodayChange([bill], [], at(2026, 11, 17, 9))).toBe(at(2026, 11, 21));
    expect(nextTodayChange([bill], [], at(2026, 11, 21))).toBe(at(2026, 11, 28));
    expect(nextTodayChange([bill], [], at(2026, 11, 28))).toBeNull();
    expect(nextTodayChange([], [{ kind: "promise", state: "due", dated: true, dueAt: at(2026, 11, 12, 9) }], at(2026, 11, 12, 10))).toBe(at(2026, 11, 13));
  });
  it("an item further than two weeks enters Coming up", () => {
    expect(nextTodayChange([item("pay", "2026-12-20")], [], at(2026, 11, 10, 15))).toBe(at(2026, 12, 3, 9));
  });
  it("nothing open: no timer", () => {
    expect(nextTodayChange([{ ...item("pay", "2026-11-20"), state: "done" }], [], arrived)).toBeNull();
  });
});

describe("time cues (§3)", () => {
  it.each([
    ["Your bill of $54.20 is due on 11/20", ""],
    ["Tu factura vence el 20 de noviembre", ""],
    ["Your flight IB3170 departs tomorrow at 7:40", ""],
    ["", "Action required: update your payment method"],
    ["Tu cita es el lunes a las 10:30", ""],
    ["Your free trial ends Nov 20", ""],
    ["Can you send it by Thursday?", ""],
    ["Pago rechazado", ""],
  ])("reads %j %j", (text, subject) => expect(hasTimeCue(text, subject)).toBe(true));
  it.each([
    ["Thanks, that sounds great!", "Re: lunch"],
    ["Here are the photos from the team offsite", "Photos"],
    ["Great to hear from you, hope all is well", "Hola"],
  ])("skips %j", (text, subject) => expect(hasTimeCue(text, subject)).toBe(false));
});
