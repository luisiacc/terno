import { describe, expect, it } from "vitest";
import { isAcknowledgment, looksLikeAcknowledgment } from "./today";
import { datedOver, datedPlace, datedTiming, hasTimeCue, nextTodayChange, planEnd, promiseComingUp, promiseMissed, promiseOver, type DatedKind, type DatedRow } from "./dated";

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
  it("a dated promise due within two weeks is Coming up's, and the clock wakes as it enters and comes due", () => {
    const promise = { kind: "promise", state: "open", dated: true, dueAt: at(2026, 11, 30, 9) };
    expect(promiseComingUp(promise, at(2026, 11, 16, 9))).toBe(true);
    expect(promiseComingUp(promise, at(2026, 11, 16, 8))).toBe(false);
    expect(promiseComingUp({ ...promise, dated: false }, at(2026, 11, 20))).toBe(false);
    expect(nextTodayChange([], [promise], at(2026, 11, 10))).toBe(at(2026, 11, 16, 9));
    expect(nextTodayChange([], [promise], at(2026, 11, 29, 23, 30))).toBe(at(2026, 11, 30));
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
    expect(nextTodayChange([bill], [], at(2026, 11, 17, 0, 30))).toBe(at(2026, 11, 17, 9));
    expect(nextTodayChange([bill], [], at(2026, 11, 20, 9))).toBe(at(2026, 11, 21));
    expect(nextTodayChange([bill], [], at(2026, 11, 27, 9))).toBe(at(2026, 11, 28));
    expect(nextTodayChange([bill], [], at(2026, 11, 28))).toBeNull();
    expect(nextTodayChange([], [{ kind: "promise", state: "due", dated: true, dueAt: at(2026, 11, 12, 9) }], at(2026, 11, 12, 10))).toBe(at(2026, 11, 13));
  });
  it("an item further than two weeks enters Coming up", () => {
    expect(nextTodayChange([item("pay", "2026-12-20")], [], at(2026, 11, 10, 15))).toBe(at(2026, 12, 3, 9));
  });
  it("Codex code review: while a row shows, midnight changes its words (Tomorrow becomes Today)", () => {
    const flight = item("event", "2026-11-20", "07:40");
    expect(nextTodayChange([flight], [], at(2026, 11, 19, 23))).toBe(at(2026, 11, 20));
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
  ])("asks or says more: %j", (text) => expect(isAcknowledgment(text)).toBe(false));
  it("a snippet that starts like one is worth reading; one that doesn't isn't", () => {
    expect(looksLikeAcknowledgment("Thanks! Talk soon")).toBe(true);
    expect(looksLikeAcknowledgment("Hi Margaret, could you send the form")).toBe(false);
  });
});
