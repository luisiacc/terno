import { describe, expect, it } from "vitest";
import { isAcknowledgment, looksLikeAcknowledgment, saysNoReplyNeeded } from "./today";
import { ANSWERED_KINDS, askEnd, datedGroup, datedOver, datedPlace, datedTiming, hasTimeCue, laterBefore, nextTodayChange, planEnd, promiseOver, promisePlace, TODAY_COUNTED, TODAY_GROUP_ORDER, type DatedKind, type DatedRow } from "./dated";
import { WAITING_WINDOW_MS } from "./people";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const clock = (ms: number) => { const d = new Date(ms); return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };

const arrived = at(2026, 11, 10, 14);
const timing = (kind: DatedKind, due: string | null, time: string | null = null, arrivedAt = arrived) => datedTiming({ kind, due, time, arrivedAt });

type Placed = Pick<DatedRow, "kind" | "state" | "dueDay" | "dueAt" | "timed" | "actAt" | "deferredUntil" | "arrivedAt">;
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
  it("a dated promise is Coming up's two weeks before its week's lead, and the clock wakes as it enters and shows", () => {
    // the fifth panel round: a request's lead, from 9:00 a week before its day
    const promise = { kind: "promise", state: "open", dated: true, dueAt: at(2026, 11, 30, 9) };
    expect(promisePlace(promise, at(2026, 11, 9, 9))).toBe("comingUp");
    expect(promisePlace(promise, at(2026, 11, 9, 8))).toBe("hidden");
    expect(promisePlace(promise, at(2026, 11, 23, 8, 59))).toBe("comingUp");
    expect(promisePlace(promise, at(2026, 11, 23, 9))).toBe("deadlines");
    expect(promisePlace({ ...promise, dated: false }, at(2026, 11, 20))).toBe("hidden");
    expect(nextTodayChange([], [promise], at(2026, 11, 8))).toBe(at(2026, 11, 9, 9));
    expect(nextTodayChange([], [promise], at(2026, 11, 22, 23, 30))).toBe(at(2026, 11, 23));
    expect(nextTodayChange([], [promise], at(2026, 11, 23, 0, 30))).toBe(at(2026, 11, 23, 9));
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
  it("Deadlines' from a week before its day at 9:00 (a request's lead, the fifth panel round), whatever its hour", () => {
    const open = { ...promise, state: "open" };
    expect(promisePlace(open, at(2026, 11, 12, 8))).toBe("deadlines");
    expect(promisePlace(open, at(2026, 11, 11, 23, 59))).toBe("deadlines");
    expect(promisePlace(open, at(2026, 11, 5, 9))).toBe("deadlines");
    expect(promisePlace(open, at(2026, 11, 5, 8, 59))).toBe("comingUp");
  });
  it("across a DST change its lead is still 9:00, and its Missed week ends at midnight", () => {
    // US clocks change in the week before each (Nov 1, Mar 8): wall time holds wherever the tests run
    const fall = { kind: "promise", state: "open", dated: true, dueAt: at(2026, 11, 3, 9) };
    expect(promisePlace(fall, at(2026, 10, 27, 8, 59))).toBe("comingUp");
    expect(promisePlace(fall, at(2026, 10, 27, 9))).toBe("deadlines");
    const spring = { kind: "promise", state: "open", dated: true, dueAt: at(2026, 3, 10, 9) };
    expect(nextTodayChange([], [spring], at(2026, 3, 3, 0, 30))).toBe(at(2026, 3, 3, 9));
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
    // past its day: Coming up while within its two weeks, never Missed, never over
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
    // further than two weeks: hidden until Coming up's horizon
    const far = { ...open, deferredUntil: at(2026, 12, 20, 9) };
    expect(promisePlace(far, at(2026, 11, 13, 1))).toBe("hidden");
    expect(promisePlace(far, at(2026, 12, 6, 9))).toBe("comingUp");
    expect(nextTodayChange([], [far], at(2026, 11, 13, 1))).toBe(at(2026, 12, 6, 9));
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
    expect(TODAY_COUNTED.has("needsYou")).toBe(true);
  });
  it("Needs you's heading is above Plans' (the fourth panel round, revision 4)", () => {
    expect(TODAY_GROUP_ORDER).toEqual(["missed", "deadlines", "needsYou", "plans", "reminders", "comingUp"]);
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
    expect(nextTodayChange([bill], [], at(2026, 11, 13, 0, 30))).toBe(at(2026, 11, 13, 9));
    expect(nextTodayChange([bill], [], at(2026, 11, 20, 9))).toBe(at(2026, 11, 21));
    expect(nextTodayChange([bill], [], at(2026, 11, 27, 9))).toBe(at(2026, 11, 28));
    expect(nextTodayChange([bill], [], at(2026, 11, 28))).toBeNull();
    expect(nextTodayChange([], [{ kind: "promise", state: "due", dated: true, dueAt: at(2026, 11, 12, 9) }], at(2026, 11, 12, 10))).toBe(at(2026, 11, 13));
  });
  it("an item further than two weeks enters Coming up", () => {
    expect(nextTodayChange([item("pay", "2026-12-20")], [], at(2026, 11, 10, 15))).toBe(at(2026, 11, 29, 9));
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
  it("Later hides it until then (Coming up's within two weeks); a Later past its window is over at the window's end", () => {
    const later = { ...ask, deferredUntil: at(2026, 11, 13, 9) };
    expect(datedPlace(later, at(2026, 11, 11))).toBe("comingUp");
    expect(datedPlace(later, at(2026, 11, 13, 9))).toBe("needsYou");
    const past = { ...ask, deferredUntil: askEnd(ask) + 86_400_000 };
    expect(datedOver(past, askEnd(ask) - 1)).toBe(false);
    expect(datedOver(past, askEnd(ask))).toBe(true);
    expect(datedPlace(past, askEnd(ask))).toBe("hidden");
  });
  it("the clock wakes at its window's end, not at each midnight (its words name no day)", () => {
    expect(nextTodayChange([ask], [], at(2026, 11, 10, 15))).toBe(askEnd(ask));
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
