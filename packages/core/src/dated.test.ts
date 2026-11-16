import { describe, expect, it } from "vitest";
import { isAcknowledgment, looksLikeAcknowledgment, saysNoReplyNeeded } from "./today";
import { alertUntil, ANSWERED_KINDS, askEnd, datedGroup, datedGroupAt, datedOver, datedPlace, datedTiming, hasTimeCue, laterBefore, nextTodayChange, planEnd, promiseDay, promiseGroupAt, promiseOver, promisePlace, todayCounted, TODAY_GROUP_ORDER, type DatedKind, type DatedRow } from "./dated";
import { WAITING_WINDOW_MS } from "./people";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const clock = (ms: number) => { const d = new Date(ms); return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };

const arrived = at(2026, 11, 10, 14);
const timing = (kind: DatedKind, due: string | null, time: string | null = null, arrivedAt = arrived) => datedTiming({ kind, due, time, arrivedAt });

type Placed = Pick<DatedRow, "kind" | "state" | "dueDay" | "dueAt" | "timed" | "dated" | "actAt" | "deferredUntil" | "arrivedAt">;
const item = (kind: DatedKind, due: string | null, time: string | null = null, more: Partial<Placed> = {}): Placed => ({ kind, state: "open", deferredUntil: null, arrivedAt: arrived, ...timing(kind, due, time)!, ...more });

describe("when a dated item shows (plan 204 §2)", () => {
  it("each kind shows its lead before its day, at 9:00", () => {
    // the fourth panel round (change 5): a bill's week, as a request's
    expect(clock(timing("pay", "2026-11-20")!.actAt)).toEqual([11, 13, 9, 0]);
    expect(clock(timing("renew", "2026-11-20")!.actAt)).toEqual([11, 13, 9, 0]);
    // after the panel: 30 days for an expiring document (begun already: at once), a week for a request
    expect(timing("expire", "2026-11-20")!.actAt).toBe(arrived);
    expect(clock(timing("expire", "2026-12-20")!.actAt)).toEqual([11, 20, 9, 0]);
    expect(clock(timing("respond", "2026-11-20")!.actAt)).toEqual([11, 13, 9, 0]);
    // the sixth panel round (change 3): a Plan three days ahead
    expect(clock(timing("event", "2026-11-20")!.actAt)).toEqual([11, 17, 9, 0]);
    expect(clock(timing("delivery", "2026-11-20")!.actAt)).toEqual([11, 20, 0, 0]);
  });
  it("an alert shows at once; one with no day is ordered as if due its third day", () => {
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
  it("plan 210 (iteration 3): Coming up has no horizon: a bill five weeks out is Coming up's", () => {
    expect(datedPlace(item("pay", "2026-12-20"), at(2026, 11, 10, 15))).toBe("comingUp");
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
  it("Codex review of the fixes: a Missed item snoozed past its week comes back for a visible week, not straight to over", () => {
    const later = { ...bill, deferredUntil: at(2026, 12, 1, 9) };
    expect(datedPlace(later, at(2026, 11, 28, 9))).toBe("comingUp");
    expect(datedOver(later, at(2026, 11, 28, 9))).toBe(false);
    expect(datedPlace(later, at(2026, 12, 1, 9))).toBe("missed");
    expect(datedOver(later, at(2026, 12, 1, 9))).toBe(false);
    expect(datedPlace(later, at(2026, 12, 8, 23))).toBe("missed");
    expect(datedPlace(later, at(2026, 12, 9, 0))).toBe("hidden");
    expect(datedOver(later, at(2026, 12, 9, 0))).toBe(true);
    expect(nextTodayChange([later], [], at(2026, 12, 8, 23, 30))).toBe(at(2026, 12, 9));
  });
  it("plan 210 (iteration 3): a dated promise is Coming up's at any distance, and shows as its seven days begin (midnight)", () => {
    const promise = { kind: "promise", state: "open", dated: true, dueAt: at(2026, 11, 30, 9) };
    expect(promisePlace(promise, at(2026, 10, 2, 9))).toBe("comingUp");
    expect(promisePlace(promise, at(2026, 11, 22, 23, 59))).toBe("comingUp");
    expect(promisePlace(promise, at(2026, 11, 23, 0))).toBe("deadlines");
    expect(promisePlace({ ...promise, dated: false }, at(2026, 11, 20))).toBe("hidden");
    // no horizon to wake for: Coming up shows, so its midnight is the change (its words), and the eighth day's is the window's
    expect(nextTodayChange([], [promise], at(2026, 11, 8, 10))).toBe(at(2026, 11, 9));
    expect(nextTodayChange([], [promise], at(2026, 11, 22, 23, 30))).toBe(at(2026, 11, 23));
    expect(nextTodayChange([], [promise], at(2026, 11, 23, 0, 30))).toBe(at(2026, 11, 24));
  });
  it("closed is hidden", () => {
    expect(datedPlace({ ...bill, state: "done" }, at(2026, 11, 18))).toBe("hidden");
  });
});

describe("an alert that names no day (the sixth panel round, change 1 and revision 2)", () => {
  const alert = item("alert", null);
  it("is Deadlines' for a week from its arrival, never Missed, then over", () => {
    expect(datedPlace(alert, arrived)).toBe("deadlines");
    // its stored day (the order's) passing makes it no Missed item
    expect(datedPlace(alert, at(2026, 11, 13, 0))).toBe("deadlines");
    expect(datedPlace(alert, at(2026, 11, 17, 13, 59))).toBe("deadlines");
    expect(datedOver(alert, at(2026, 11, 17, 13, 59))).toBe(false);
    expect(datedPlace(alert, at(2026, 11, 17, 14))).toBe("hidden");
    expect(datedOver(alert, at(2026, 11, 17, 14))).toBe(true);
  });
  it("the clock wakes at each midnight while it shows (plan 210: its \"since\" moves on), and at its week's end", () => {
    expect(nextTodayChange([alert], [], at(2026, 11, 12, 10))).toBe(at(2026, 11, 13));
    expect(nextTodayChange([alert], [], at(2026, 11, 17, 10))).toBe(at(2026, 11, 17, 14));
    expect(nextTodayChange([alert], [], at(2026, 11, 17, 14))).toBeNull();
  });
  it("Later past its week keeps it: never over while put off, then a week from its return", () => {
    const later = { ...alert, deferredUntil: at(2026, 11, 20, 9) };
    expect(datedPlace(later, at(2026, 11, 17, 15))).toBe("comingUp");
    expect(datedOver(later, at(2026, 11, 17, 15))).toBe(false);
    expect(datedPlace(later, at(2026, 11, 20, 9))).toBe("deadlines");
    expect(alertUntil(later)).toBe(at(2026, 11, 27, 9));
    expect(datedPlace(later, at(2026, 11, 27, 8, 59))).toBe("deadlines");
    expect(datedOver(later, at(2026, 11, 27, 9))).toBe(true);
    expect(nextTodayChange([later], [], at(2026, 11, 19, 15))).toBe(at(2026, 11, 20));
    expect(nextTodayChange([later], [], at(2026, 11, 20, 1))).toBe(at(2026, 11, 20, 9));
    expect(nextTodayChange([later], [], at(2026, 11, 26, 9))).toBe(at(2026, 11, 27));
    expect(nextTodayChange([later], [], at(2026, 11, 27, 1))).toBe(at(2026, 11, 27, 9));
  });
  it("a week by the wall clock across a DST change", () => {
    // US clocks fall back on Nov 1: still 14:00 a week on, wherever the tests run
    expect(new Date(alertUntil({ arrivedAt: at(2026, 10, 30, 14), deferredUntil: null })).getHours()).toBe(14);
    expect(new Date(alertUntil({ arrivedAt: at(2026, 3, 5, 14), deferredUntil: null })).getHours()).toBe(14);
  });
  it("one with a day is a deadline as before: Missed after it", () => {
    const dated = item("alert", "2026-11-12");
    expect(datedPlace(dated, arrived)).toBe("deadlines");
    expect(datedPlace(dated, at(2026, 11, 13, 0))).toBe("missed");
  });
});

describe("a Plan's lead, read when placed (the sixth panel round, change 3 and revision 6)", () => {
  // stored under the old lead: a day before, at 9:00
  const stored = item("event", "2026-11-20", "10:00", { actAt: at(2026, 11, 19, 9) });
  it("plan 210 (iteration 3): an event stored a day ahead shows as its seven days begin, with no rescheduling", () => {
    expect(datedPlace(stored, at(2026, 11, 12, 23, 59))).toBe("comingUp");
    expect(datedPlace(stored, at(2026, 11, 13, 0))).toBe("plans");
    expect(nextTodayChange([stored], [], at(2026, 11, 12, 22))).toBe(at(2026, 11, 13));
  });
  it("the seven days whole, whatever the kind's lead: day seven shows, day eight is Coming up's; a longer lead brings it forward", () => {
    // Tue Nov 10: Tue Nov 17 is the seventh day after today, Wed Nov 18 the eighth
    const now = at(2026, 11, 10, 15);
    expect(datedPlace(item("event", "2026-11-17", null), now)).toBe("plans");
    expect(datedPlace(item("event", "2026-11-18", null), now)).toBe("comingUp");
    expect(datedPlace(item("delivery", "2026-11-17"), now)).toBe("plans");
    expect(datedPlace(item("delivery", "2026-11-18"), now)).toBe("comingUp");
    expect(datedPlace(item("pay", "2026-11-17"), now)).toBe("deadlines");
    expect(datedPlace(item("pay", "2026-11-18"), now)).toBe("comingUp");
    // an expiry's 30 days still bring it out early
    expect(datedPlace(item("expire", "2026-12-08"), now)).toBe("deadlines");
    // midnight brings the eighth day in
    expect(nextTodayChange([item("pay", "2026-11-18")], [], at(2026, 11, 10, 23))).toBe(at(2026, 11, 11));
    expect(datedPlace(item("pay", "2026-11-18"), at(2026, 11, 11))).toBe("deadlines");
  });
  it("on a Friday: tomorrow's delivery and Tuesday's keynote show under their days, the Wednesday after next's doesn't", () => {
    const friday = at(2026, 11, 13, 17);
    const came = at(2026, 11, 9, 10);
    const from = (kind: DatedKind, due: string, time: string | null = null): Placed => ({ kind, state: "open", deferredUntil: null, arrivedAt: came, ...timing(kind, due, time, came)! });
    expect(datedGroupAt(from("delivery", "2026-11-14"), friday)).toEqual({ group: "day", day: "2026-11-14" });
    expect(datedGroupAt(from("event", "2026-11-17", "10:00"), friday)).toEqual({ group: "day", day: "2026-11-17" });
    expect(datedGroupAt(from("event", "2026-11-25", "10:00"), friday)).toEqual({ group: "comingUp", day: "2026-11-25" });
  });
  it("the earlier of the two: a stored moment before the window keeps it; a delivery and a bill from their seven days", () => {
    expect(datedPlace(item("event", "2026-11-20", null, { actAt: arrived }), at(2026, 11, 10, 15))).toBe("plans");
    const parcel = item("delivery", "2026-11-20");
    expect(datedPlace(parcel, at(2026, 11, 12, 23, 59))).toBe("comingUp");
    expect(datedPlace(parcel, at(2026, 11, 13, 0))).toBe("plans");
    const bill = item("pay", "2026-11-20");
    expect(datedPlace(bill, at(2026, 11, 12, 23, 59))).toBe("comingUp");
    expect(datedPlace(bill, at(2026, 11, 13, 0))).toBe("deadlines");
  });
  it("across a DST change its seven days begin at midnight", () => {
    // US clocks change on Nov 1 and Mar 8: seven days before Nov 3 and Mar 10 cross them
    const storedFrom = (due: string, actAt: number, arrivedAt: number): Placed => ({ kind: "event", state: "open", deferredUntil: null, arrivedAt, ...timing("event", due, null, arrivedAt)!, actAt });
    const fall = storedFrom("2026-11-03", at(2026, 11, 2, 9), at(2026, 10, 20, 12));
    expect(datedPlace(fall, at(2026, 10, 26, 23, 59))).toBe("comingUp");
    expect(datedPlace(fall, at(2026, 10, 27, 0))).toBe("plans");
    const spring = storedFrom("2026-03-10", at(2026, 3, 9, 9), at(2026, 2, 20, 12));
    expect(datedPlace(spring, at(2026, 3, 2, 23, 59))).toBe("comingUp");
    expect(nextTodayChange([spring], [], at(2026, 3, 2, 22, 30))).toBe(at(2026, 3, 3));
    expect(datedPlace(spring, at(2026, 3, 3))).toBe("plans");
    expect(clock(timing("event", "2026-03-10", null, at(2026, 2, 20, 12))!.actAt)).toEqual([3, 7, 9, 0]);
  });
  it("Later before the item's day hides it until then; Later past its day keeps it Coming up's, never Missed", () => {
    const bill = item("pay", "2026-11-20");
    const before = { ...bill, deferredUntil: at(2026, 11, 18, 9) };
    expect(datedPlace(before, at(2026, 11, 16))).toBe("comingUp");
    expect(datedPlace(before, at(2026, 11, 18, 9))).toBe("deadlines");
    const after = { ...bill, deferredUntil: at(2026, 12, 30, 9) };
    expect(datedPlace(after, at(2026, 11, 25))).toBe("comingUp");
    expect(datedPlace(after, at(2026, 12, 30, 9))).toBe("missed");
  });
});

describe("a promise's day (plan 210, iteration 3: one resolver)", () => {
  const tue = at(2026, 11, 10, 9);
  const fri = at(2026, 11, 13, 9);
  it("its own; its person's new one, the day they moved it from said; the request's still ahead once its own is over", () => {
    const own = { kind: "promise", state: "open", dated: true, dueAt: tue };
    expect(promiseDay(own, at(2026, 11, 9))).toEqual({ dueAt: tue, dated: true, said: null, needed: null });
    expect(promiseDay({ ...own, dueAt: fri, brokenDueAt: tue }, at(2026, 11, 11))).toEqual({ dueAt: fri, dated: true, said: tue, needed: fri });
    const answering = { ...own, needed: fri };
    expect(promiseDay(answering, at(2026, 11, 10, 23))).toEqual({ dueAt: tue, dated: true, said: null, needed: fri });
    expect(promiseDay(answering, at(2026, 11, 11))).toEqual({ dueAt: fri, dated: true, said: tue, needed: fri });
    expect(promiseGroupAt(answering, at(2026, 11, 11))).toEqual({ group: "day", day: "2026-11-13" });
    expect(promiseGroupAt(answering, at(2026, 11, 13, 12))).toEqual({ group: "today", day: null });
    // both over: Missed, from the later
    expect(promiseDay(answering, at(2026, 11, 14))).toMatchObject({ dueAt: fri, said: null });
    expect(promisePlace(answering, at(2026, 11, 14))).toBe("missed");
    // the clock wakes as its own day ends (the request's day takes over)
    expect(nextTodayChange([], [{ ...answering, dueAt: at(2026, 11, 10, 9), deferredUntil: null }], at(2026, 11, 10, 12))).toBe(at(2026, 11, 11));
    // named no day: the request's
    expect(promiseDay({ ...answering, dated: false, dueAt: at(2026, 11, 12, 9) }, at(2026, 11, 9))).toEqual({ dueAt: fri, dated: true, said: null, needed: null });
  });
});

describe("where a promise of yours sits (plan 204 §1, the third panel round)", () => {
  const promise = { kind: "promise", state: "due", dated: true, dueAt: at(2026, 11, 12, 9) };
  it("Missed once its day ends, for 7 days, only when dated", () => {
    expect(promisePlace(promise, at(2026, 11, 12, 23))).toBe("deadlines");
    expect(promisePlace(promise, at(2026, 11, 13, 0))).toBe("missed");
    expect(promisePlace(promise, at(2026, 11, 19, 23))).toBe("missed");
    expect(promisePlace(promise, at(2026, 11, 20, 0))).toBe("hidden");
    // read before the worker marked it due: due all the same
    expect(promisePlace({ ...promise, state: "open" }, at(2026, 11, 13, 1))).toBe("missed");
    expect(promisePlace({ ...promise, kind: "awaiting" }, at(2026, 11, 13, 1))).toBe("hidden");
    expect(promisePlace({ ...promise, state: "done" }, at(2026, 11, 13, 1))).toBe("hidden");
  });
  it("Deadlines' from the midnight its seven days begin (plan 210, iteration 3), whatever its hour", () => {
    const open = { ...promise, state: "open" };
    expect(promisePlace(open, at(2026, 11, 12, 8))).toBe("deadlines");
    expect(promisePlace(open, at(2026, 11, 11, 23, 59))).toBe("deadlines");
    expect(promisePlace(open, at(2026, 11, 5, 0))).toBe("deadlines");
    expect(promisePlace(open, at(2026, 11, 4, 23, 59))).toBe("comingUp");
  });
  it("across a DST change its seven days begin at midnight, and its Missed week ends at midnight", () => {
    // US clocks change in the week before each (Nov 1, Mar 8): wall time holds wherever the tests run
    const fall = { kind: "promise", state: "open", dated: true, dueAt: at(2026, 11, 3, 9) };
    expect(promisePlace(fall, at(2026, 10, 26, 23, 59))).toBe("comingUp");
    expect(promisePlace(fall, at(2026, 10, 27, 0))).toBe("deadlines");
    const spring = { kind: "promise", state: "open", dated: true, dueAt: at(2026, 3, 10, 9) };
    expect(nextTodayChange([], [spring], at(2026, 3, 2, 22, 30))).toBe(at(2026, 3, 3));
    expect(promisePlace(spring, at(2026, 3, 17, 23, 59))).toBe("missed");
    expect(promisePlace(spring, at(2026, 3, 18))).toBe("hidden");
  });
  it("put off with Later: hidden or Coming up until then, never Missed meanwhile, and Missed for a week from a late return", () => {
    // the fifth panel round: its day (dueAt) stays; Later is its own
    const open = { ...promise, state: "open" };
    const soon = { ...open, deferredUntil: at(2026, 11, 8, 9) };
    expect(promisePlace(soon, at(2026, 11, 6))).toBe("comingUp");
    expect(promisePlace(soon, at(2026, 11, 8, 9))).toBe("deadlines");
    expect(nextTodayChange([], [soon], at(2026, 11, 7, 23, 30))).toBe(at(2026, 11, 8));
    expect(nextTodayChange([], [soon], at(2026, 11, 8, 0, 30))).toBe(at(2026, 11, 8, 9));
    // past its day: Coming up's, never Missed, never over
    const late = { ...open, deferredUntil: at(2026, 11, 20, 9) };
    expect(promisePlace(late, at(2026, 11, 12, 10))).toBe("comingUp");
    expect(promisePlace(late, at(2026, 11, 13, 1))).toBe("comingUp");
    expect(promiseOver(late, at(2026, 11, 20, 8))).toBe(false);
    expect(promisePlace(late, at(2026, 11, 20, 8))).toBe("comingUp");
    // back after its day: Missed for a week from then
    expect(promisePlace(late, at(2026, 11, 20, 9))).toBe("missed");
    expect(promisePlace(late, at(2026, 11, 27, 23, 59))).toBe("missed");
    expect(promiseOver(late, at(2026, 11, 27, 23, 59))).toBe(false);
    expect(promisePlace(late, at(2026, 11, 28))).toBe("hidden");
    expect(promiseOver(late, at(2026, 11, 28))).toBe(true);
    expect(nextTodayChange([], [late], at(2026, 11, 20, 8))).toBe(at(2026, 11, 20, 9));
    expect(nextTodayChange([], [late], at(2026, 11, 27, 23, 30))).toBe(at(2026, 11, 28));
    // further: Coming up's all the while (no horizon), back as its Later ends
    const far = { ...open, deferredUntil: at(2026, 12, 20, 9) };
    expect(promisePlace(far, at(2026, 11, 13, 1))).toBe("comingUp");
    expect(nextTodayChange([], [far], at(2026, 12, 20, 0, 30))).toBe(at(2026, 12, 20, 9));
    expect(promisePlace(far, at(2026, 12, 20, 9))).toBe("missed");
    // undated: Needs you's once back, not before
    const undated = { kind: "promise", state: "open", dated: false, dueAt: at(2026, 11, 12, 9), deferredUntil: at(2026, 11, 14, 9) };
    expect(promisePlace(undated, at(2026, 11, 13))).toBe("hidden");
    expect(promisePlace({ ...undated, state: "due" }, at(2026, 11, 13))).toBe("hidden");
    expect(promisePlace(undated, at(2026, 11, 14, 9))).toBe("needsYou");
    expect(nextTodayChange([], [undated], at(2026, 11, 13))).toBe(at(2026, 11, 14, 9));
    // Codex code review: put off until before its moment, the clock still wakes as the Later ends (its conversation waits again)
    const early = { kind: "promise", state: "open", dated: false, dueAt: at(2026, 11, 15, 9), deferredUntil: at(2026, 11, 14, 11) };
    expect(nextTodayChange([], [early], at(2026, 11, 14, 10))).toBe(at(2026, 11, 14, 11));
  });
  it("undated: Needs you's once due (it has no day to sit under), and never Missed (the fourth panel round)", () => {
    const undated = { kind: "promise", state: "open", dated: false, dueAt: at(2026, 11, 12, 9) };
    expect(promisePlace(undated, at(2026, 11, 12, 8))).toBe("hidden");
    expect(promisePlace(undated, at(2026, 11, 12, 9))).toBe("needsYou");
    expect(promisePlace({ ...undated, state: "due" }, at(2026, 12, 30))).toBe("needsYou");
    expect(todayCounted("today", { kind: "promise" })).toBe(true);
  });
  it("the clock wakes as its day starts and ends, and as an undated one comes due", () => {
    expect(nextTodayChange([], [{ ...promise, state: "open" }], at(2026, 11, 11, 15))).toBe(at(2026, 11, 12));
    expect(nextTodayChange([], [{ ...promise, dated: false, state: "open" }], at(2026, 11, 12, 8))).toBe(at(2026, 11, 12, 9));
  });
});

describe("Later's bounds (the third panel round)", () => {
  it("a timed item still ahead: before its moment; a Plan: before its end; a Missed one or a passed moment: anywhere", () => {
    const payroll = item("pay", "2026-11-13", "13:00");
    expect(laterBefore(payroll, at(2026, 11, 13, 10))).toBe(at(2026, 11, 13, 13));
    expect(laterBefore(payroll, at(2026, 11, 13, 14))).toBeNull();
    expect(laterBefore(payroll, at(2026, 11, 14, 10))).toBeNull();
    expect(laterBefore(item("pay", "2026-11-13"), at(2026, 11, 13, 10))).toBeNull();
    const flight = item("event", "2026-11-19", "07:40");
    expect(laterBefore(flight, at(2026, 11, 18, 10))).toBe(at(2026, 11, 19, 7, 40));
    expect(laterBefore(flight, at(2026, 11, 19, 8))).toBe(at(2026, 11, 19, 9, 40));
    expect(laterBefore(item("delivery", "2026-11-19"), at(2026, 11, 19, 8))).toBe(at(2026, 11, 20));
  });
});

describe("what's over for good (Codex code review)", () => {
  it("a plan once it's ended, a deadline past Missed's days unless Later moved it", () => {
    expect(datedOver(item("event", "2026-11-20", "07:40"), at(2026, 11, 20, 9, 40))).toBe(true);
    expect(datedOver(item("event", "2026-11-20", "07:40"), at(2026, 11, 20, 9, 39))).toBe(false);
    const bill = item("pay", "2026-11-20");
    expect(datedOver(bill, at(2026, 11, 27, 23))).toBe(false);
    expect(datedOver(bill, at(2026, 11, 28))).toBe(true);
    expect(datedOver({ ...bill, deferredUntil: at(2026, 12, 1) }, at(2026, 11, 28))).toBe(false);
    expect(datedOver({ ...bill, state: "done" }, at(2026, 12, 28))).toBe(false);
  });
  it("a dated promise past Missed's days is over, not Needs you's again", () => {
    const promise = { kind: "promise", state: "due", dated: true, dueAt: at(2026, 11, 12, 9) };
    expect(promiseOver(promise, at(2026, 11, 19, 23))).toBe(false);
    expect(promiseOver(promise, at(2026, 11, 20))).toBe(true);
    expect(promiseOver({ ...promise, dated: false }, at(2026, 12, 20))).toBe(false);
  });
});

describe("the next change by the clock (revision 11)", () => {
  it("is the soonest moment strictly after now, across items and promises", () => {
    const bill = item("pay", "2026-11-20");
    // in Coming up, Deadlines and Missed it's shown, so each midnight is a change too (its words); the last day's is Missed's end
    expect(nextTodayChange([bill], [], at(2026, 11, 10, 15))).toBe(at(2026, 11, 11));
    expect(nextTodayChange([bill], [], at(2026, 11, 16, 15))).toBe(at(2026, 11, 17));
    expect(nextTodayChange([bill], [], at(2026, 11, 12, 23, 30))).toBe(at(2026, 11, 13));
    expect(nextTodayChange([bill], [], at(2026, 11, 20, 9))).toBe(at(2026, 11, 21));
    expect(nextTodayChange([bill], [], at(2026, 11, 27, 9))).toBe(at(2026, 11, 28));
    expect(nextTodayChange([bill], [], at(2026, 11, 28))).toBeNull();
    expect(nextTodayChange([], [{ kind: "promise", state: "due", dated: true, dueAt: at(2026, 11, 12, 9) }], at(2026, 11, 12, 10))).toBe(at(2026, 11, 13));
  });
  it("plan 210 (iteration 3): no horizon to wake for: a far item is Coming up's now, and its seven days begin at a midnight", () => {
    expect(nextTodayChange([item("pay", "2026-12-20")], [], at(2026, 11, 10, 15))).toBe(at(2026, 11, 11));
    expect(nextTodayChange([item("pay", "2026-12-20")], [], at(2026, 12, 12, 23))).toBe(at(2026, 12, 13));
  });
  it("Codex code review: while a row shows, midnight changes its words (Tomorrow becomes Today)", () => {
    const flight = item("event", "2026-11-20", "07:40");
    expect(nextTodayChange([flight], [], at(2026, 11, 19, 23))).toBe(at(2026, 11, 20));
  });
  it("nothing open: no timer", () => {
    expect(nextTodayChange([{ ...item("pay", "2026-11-20"), state: "done" }], [], arrived)).toBeNull();
  });
});

describe("an ask (after the third panel round, revision 2)", () => {
  const ask = item("ask", null);
  it("has no day of its own: it shows from its arrival, undated; with a day it isn't an ask", () => {
    expect(timing("ask", null)).toEqual({ dueDay: "2026-11-10", dueAt: arrived, timed: false, dated: false, actAt: arrived });
    expect(timing("ask", "2026-11-20")).toBeNull();
    expect(datedGroup("ask")).toBe("needsYou");
  });
  it("is Needs you's for Needs you's window after it arrived, never Missed, then over", () => {
    expect(datedPlace(ask, arrived)).toBe("needsYou");
    expect(datedPlace(ask, at(2026, 11, 20))).toBe("needsYou");
    expect(askEnd(ask)).toBe(arrived + WAITING_WINDOW_MS);
    expect(datedPlace(ask, askEnd(ask) - 1)).toBe("needsYou");
    expect(datedOver(ask, askEnd(ask) - 1)).toBe(false);
    expect(datedPlace(ask, askEnd(ask))).toBe("hidden");
    expect(datedOver(ask, askEnd(ask))).toBe(true);
  });
  it("Later hides it until then (Coming up's); a Later past its window is over at the window's end", () => {
    const later = { ...ask, deferredUntil: at(2026, 11, 13, 9) };
    expect(datedPlace(later, at(2026, 11, 11))).toBe("comingUp");
    expect(datedPlace(later, at(2026, 11, 13, 9))).toBe("needsYou");
    const past = { ...ask, deferredUntil: askEnd(ask) + 86_400_000 };
    expect(datedOver(past, askEnd(ask) - 1)).toBe(false);
    expect(datedOver(past, askEnd(ask))).toBe(true);
    expect(datedPlace(past, askEnd(ask))).toBe("hidden");
  });
  it("the clock wakes at each midnight while it shows (plan 210: its \"since\" moves on), and at its window's end", () => {
    expect(nextTodayChange([ask], [], at(2026, 11, 10, 15))).toBe(at(2026, 11, 11));
    expect(nextTodayChange([ask], [], askEnd(ask) - 60_000)).toBe(askEnd(ask));
    expect(nextTodayChange([ask], [], askEnd(ask))).toBeNull();
  });
  it("a send of yours answers it, as it answers a request with a day", () => {
    expect(ANSWERED_KINDS).toEqual(["respond", "ask"]);
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

describe("an acknowledgment (plan 204, the second panel round: plan 145's rule, tighter)", () => {
  it.each([
    "Thanks.",
    "Thanks.\n\nMargaret",
    "Got it, thanks!",
    "Sounds good 👍",
    "Gracias",
    "Perfecto, gracias.\n\nEnviado desde mi iPhone",
    "Ok\n\nOn Tue, Nov 10, Ana wrote:\n> Can you send the deck by Friday?",
    "Got it, thanks for the update! Talk soon.",
    "Muchas gracias por la información, saludos",
    "Thanks so much, Ana Ruiz",
  ])("only acknowledges: %j", (text) => expect(isAcknowledgment(text)).toBe(true));
  it.each([
    "Thanks, can you send it Friday?",
    "Thanks! Please send the signed copy.",
    "Gracias, ¿me mandas el archivo?",
    "Thanks for the update. When do you think the second draft will be ready for review by the team",
    "",
    "Here's the contract.",
    // Codex code review: a request without a question mark, en and es, and an answer written below a quote
    "Thanks, review the contract today.",
    "Perfecto, firma el contrato hoy.",
    "Ok, sign it and send it back",
    "Gracias. Mañana te llamo para revisar el presupuesto",
    "Thanks.\n\nOn Tue, Nov 10, Me wrote:\n> Here's the draft.\n\nPlease sign the contract today.",
    // the second review: a request word capitalized like a name, or one that was filler on its own
    "Thanks. Please reply.",
    "Thanks. Please update the team.",
    "Perfecto. Avísame.",
    "Thanks. Friday works",
  ])("asks or says more: %j", (text) => expect(isAcknowledgment(text)).toBe(false));
  it("a body too long to read cheaply is kept: the rule only takes conversations out (the second review)", () => {
    expect(isAcknowledgment(`Thanks!\n\nOn Tue, Nov 10, Me wrote:\n${"> an old line of the thread\n".repeat(400)}`)).toBe(true);
    expect(isAcknowledgment(`Thanks!\n\nOn Tue, Nov 10, Me wrote:\n${"> an old line of the thread\n".repeat(800)}`)).toBe(false);
  });
  it("a snippet that starts like one is worth reading; one that doesn't isn't", () => {
    expect(looksLikeAcknowledgment("Thanks! Talk soon")).toBe(true);
    expect(looksLikeAcknowledgment("Hi Margaret, could you send the form")).toBe(false);
  });
});

describe("saysNoReplyNeeded (the fourth panel read)", () => {
  it.each(["Quick FYI: the code is live. No action needed! Jess", "No need to reply now, I know you're slammed.", "Nothing needed from you.", "You don't need to reply.", "Te aviso nada más, no hace falta que contestes.", "No es necesario responder."])("says no answer is needed: %j", (text) => {
    expect(saysNoReplyNeeded(text)).toBe(true);
  });
  it.each(["Can you reply by Friday?", "Need you to answer this", "No, I need a reply today.", "", null])("doesn't: %j", (text) => {
    expect(saysNoReplyNeeded(text)).toBe(false);
  });
});

describe("the groups go by day (plan 210, the owner, replacing plan 204's seventh-round groups)", () => {
  const today = { group: "today", day: null };
  const missed = { group: "missed", day: null };
  const day = (d: string) => ({ group: "day", day: d });
  const comingUp = (d: string) => ({ group: "comingUp", day: d });
  it("Missed, Today, a day of its own, Coming up", () => {
    expect(TODAY_GROUP_ORDER).toEqual(["missed", "today", "day", "comingUp"]);
  });
  it("a deadline and a Plan: their own day within their lead, Today on it, then Missed or over; Coming up by its day before", () => {
    const bill = item("pay", "2026-11-20");
    expect(datedGroupAt(bill, at(2026, 11, 10, 15))).toEqual(comingUp("2026-11-20"));
    expect(datedGroupAt(bill, at(2026, 11, 13, 9))).toEqual(day("2026-11-20"));
    expect(datedGroupAt(bill, at(2026, 11, 19, 23, 59))).toEqual(day("2026-11-20"));
    expect(datedGroupAt(bill, at(2026, 11, 20, 0))).toEqual(today);
    expect(datedGroupAt(bill, at(2026, 11, 21, 0))).toEqual(missed);
    expect(datedGroupAt(bill, at(2026, 11, 28, 0))).toBeNull();
    const flight = item("event", "2026-11-20", "23:00");
    expect(datedGroupAt(flight, at(2026, 11, 17, 9))).toEqual(day("2026-11-20"));
    expect(datedGroupAt(flight, at(2026, 11, 20, 8))).toEqual(today);
    // still on after midnight: Today's until it ends, never Missed
    expect(datedGroupAt(flight, at(2026, 11, 21, 0, 30))).toEqual(today);
    expect(datedGroupAt(flight, at(2026, 11, 21, 1))).toBeNull();
    // Later past its day keeps it out of every group until then: Coming up's under the day its Later ends, never Missed
    expect(datedGroupAt({ ...bill, deferredUntil: at(2026, 11, 22, 9) }, at(2026, 11, 21, 9))).toEqual(comingUp("2026-11-22"));
    // Codex code review: put off past its day before it's come, under the day its Later ends, never its own
    expect(datedGroupAt({ ...bill, deferredUntil: at(2026, 11, 22, 9) }, at(2026, 11, 15, 9))).toEqual(comingUp("2026-11-22"));
    // put off to a moment before its day: Coming up's under its own day still
    expect(datedGroupAt({ ...bill, deferredUntil: at(2026, 11, 15, 9) }, at(2026, 11, 14, 9))).toEqual(comingUp("2026-11-20"));
  });
  it("what has no date is Today's while it shows (an ask, an alert that named none); a dated alert is its day's", () => {
    const undated = item("alert", null);
    // its stored day (for order only) is the 12th: neither before nor on it does that decide anything
    expect(undated.dueDay).toBe("2026-11-12");
    expect(datedGroupAt(undated, arrived)).toEqual(today);
    expect(datedGroupAt(undated, at(2026, 11, 14, 9))).toEqual(today);
    expect(datedGroupAt(undated, at(2026, 11, 17, 14))).toBeNull();
    // put off: Coming up's under the day its Later ends
    expect(datedGroupAt({ ...undated, deferredUntil: at(2026, 11, 16, 9) }, at(2026, 11, 14, 9))).toEqual(comingUp("2026-11-16"));
    const dated = item("alert", "2026-11-14");
    expect(datedGroupAt(dated, arrived)).toEqual(day("2026-11-14"));
    expect(datedGroupAt(dated, at(2026, 11, 14, 0))).toEqual(today);
    expect(datedGroupAt(dated, at(2026, 11, 15, 0))).toEqual(missed);
    // an ask's stored day is its arrival: Today's from then on, whatever that day says
    const ask = item("ask", null);
    expect(ask.dueDay).toBe("2026-11-10");
    expect(datedGroupAt(ask, arrived)).toEqual(today);
    expect(datedGroupAt(ask, at(2026, 11, 12, 9))).toEqual(today);
  });
  it("a promise of yours: its day from its lead, Today on it, Missed after; one with no day Today's once due", () => {
    const promise = { kind: "promise", state: "open", dated: true, dueAt: at(2026, 11, 20, 17) };
    expect(promiseGroupAt(promise, at(2026, 11, 12, 9))).toEqual(comingUp("2026-11-20"));
    expect(promiseGroupAt(promise, at(2026, 11, 13, 9))).toEqual(day("2026-11-20"));
    expect(promiseGroupAt(promise, at(2026, 11, 20, 0))).toEqual(today);
    expect(promiseGroupAt(promise, at(2026, 11, 21, 0))).toEqual(missed);
    // put off past its day (the fifth panel round's own Later): under the day it's back
    expect(promiseGroupAt({ ...promise, deferredUntil: at(2026, 11, 24, 9) }, at(2026, 11, 14, 9))).toEqual(comingUp("2026-11-24"));
    const undated = { ...promise, dated: false, dueAt: at(2026, 11, 14, 9) };
    expect(promiseGroupAt(undated, at(2026, 11, 14, 8))).toBeNull();
    expect(promiseGroupAt(undated, at(2026, 11, 14, 9))).toEqual(today);
  });
  it("its day by the wall clock across a DST change: Today from its midnight, not an hour off", () => {
    // US clocks fall back on Nov 1 and spring forward on Mar 8
    const from = (kind: DatedKind, due: string, time: string | null, arrivedAt: number): Placed => ({ kind, state: "open", deferredUntil: null, arrivedAt, ...timing(kind, due, time, arrivedAt)! });
    const fall = from("pay", "2026-11-01", null, at(2026, 10, 20, 12));
    expect(datedGroupAt(fall, at(2026, 10, 31, 23, 59))).toEqual(day("2026-11-01"));
    expect(datedGroupAt(fall, at(2026, 11, 1, 0))).toEqual(today);
    expect(datedGroupAt(fall, at(2026, 11, 1, 23, 59))).toEqual(today);
    const spring = from("event", "2026-03-08", "10:00", at(2026, 2, 20, 12));
    expect(datedGroupAt(spring, at(2026, 3, 7, 23, 59))).toEqual(day("2026-03-08"));
    expect(datedGroupAt(spring, at(2026, 3, 8, 0))).toEqual(today);
    // the clock wakes at that midnight, when its day's item becomes Today's
    expect(nextTodayChange([spring], [], at(2026, 3, 7, 22))).toBe(at(2026, 3, 8, 0));
  });
  it("the clock wakes at midnight while only an ask shows: its \"since\" and the day names move on", () => {
    expect(nextTodayChange([item("ask", null)], [], at(2026, 11, 12, 15))).toBe(at(2026, 11, 13));
  });
  it("what's counted: a row in Missed or Today, unless it's your reminder or its own item is a Plan's kind; a day ahead no longer (plan 210, iteration 3)", () => {
    for (const group of ["missed", "today"] as const) {
      expect(todayCounted(group, { kind: "waiting" })).toBe(true);
      expect(todayCounted(group, { kind: "promise" })).toBe(true);
      expect(todayCounted(group, { kind: "dated", item: { kind: "pay" } })).toBe(true);
      expect(todayCounted(group, { kind: "dated", item: { kind: "alert" } })).toBe(true);
      expect(todayCounted(group, { kind: "dated", item: { kind: "ask" } })).toBe(true);
      expect(todayCounted(group, { kind: "dated", item: { kind: "event" } })).toBe(false);
      expect(todayCounted(group, { kind: "dated", item: { kind: "delivery" } })).toBe(false);
      expect(todayCounted(group, { kind: "reminder" })).toBe(false);
    }
    expect(todayCounted("comingUp", { kind: "dated", item: { kind: "pay" } })).toBe(false);
    expect(todayCounted("day", { kind: "dated", item: { kind: "pay" } })).toBe(false);
  });
});
