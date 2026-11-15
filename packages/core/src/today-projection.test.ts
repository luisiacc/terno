/** Plan 210 (iteration 2): a row per item, one projection for the feed, the counts and the notice. */
import { describe, expect, it } from "vitest";
import { datedGroupAt, datedTiming, needsPresence, nextTodayChange, type DatedKind, type DatedRow } from "./dated";
import type { FollowupRow } from "./followups";
import { projectToday, type ProjectionFacts } from "./today-projection";
import { splitZoneNote, statedClock, weekEndDay } from "./today-items";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// a Wednesday
const NOW = at(2026, 11, 18, 10);

let ids = 0;
function dated(kind: DatedKind, due: string | null, more: Partial<DatedRow> = {}, time: string | null = null): DatedRow {
  const arrivedAt = more.arrivedAt ?? at(2026, 11, 17, 9);
  const timing = datedTiming({ kind, due, time, arrivedAt })!;
  const id = more.id ?? ++ids;
  return { id, threadId: 1, messageId: id, item: 0, kind, text: `${kind} ${id}`, quote: "q", senderKey: "a@b.c", ...timing, deferredUntil: null, arrivedAt, state: "open", closedReason: null, closedAt: null, fromScan: false, revision: 0, model: null, provider: null, createdAt: arrivedAt, ...more };
}

function promise(dueAt: number, more: Partial<FollowupRow> = {}): FollowupRow {
  const id = more.id ?? ++ids;
  return { id, threadId: 1, messageId: id, rfcMessageId: null, item: 0, kind: "promise", text: `send ${id}`, quote: null, personName: "Jess", personEmail: "jess@x.test", sentAt: at(2026, 11, 16, 9), dueAt, dated: true, deferredUntil: null, state: "open", inboxState: "none", closedReason: null, closedAt: null, notifiedAt: null, fromScan: false, revision: 0, model: null, provider: null, createdAt: 0, ...more };
}

const facts = (more: Partial<ProjectionFacts>): ProjectionFacts => ({ now: NOW, dated: [], promises: [], waiting: [], reminders: [], live: () => true, zone: "America/New_York", ...more });

describe("a row per item", () => {
  it("two items of one conversation are two rows, each with its own id", () => {
    const bill = dated("pay", "2026-11-18", { threadId: 7 });
    const keynote = dated("event", "2026-11-19", { threadId: 7 }, "09:30");
    const { rows } = projectToday(facts({ dated: [bill, keynote] }));
    expect(rows.map((r) => [r.id, r.threadId, r.group, r.day])).toEqual([
      [`dated:${bill.id}`, 7, "today", null],
      [`dated:${keynote.id}`, 7, "day", "2026-11-19"],
    ]);
    // neither says the other: Also is a related detail only
    expect(rows.every((r) => r.also === undefined)).toBe(true);
  });

  it("an ask and your promise in one conversation are both rows (a promise never stands in for an ask)", () => {
    const ask = dated("ask", null, { threadId: 3 });
    const mine = promise(at(2026, 11, 20, 9), { threadId: 3 });
    const { rows } = projectToday(facts({ dated: [ask], promises: [mine] }));
    expect(rows.map((r) => r.id).sort()).toEqual([`dated:${ask.id}`, `promise:${mine.id}`].sort());
  });

  it("a waiting conversation is its own row unless an item of it says what's asked (a Plan doesn't)", () => {
    const plan = dated("event", "2026-11-19", { threadId: 4 }, "15:00");
    const ask = dated("ask", null, { threadId: 5 });
    const waiting = [4, 5, 6].map((id) => ({ id, lastDate: NOW - id, hasSent: true }));
    const { rows, counts } = projectToday(facts({ dated: [plan, ask], waiting }));
    expect(rows.filter((r) => r.waiting).map((r) => r.threadId)).toEqual([4, 6]);
    // the plan isn't counted; the ask and the two waiting conversations are Today's
    expect(counts).toEqual({ missed: 0, today: 3, thisWeek: 0 });
  });

  it("an item in Spam or Trash has no row, and isn't counted", () => {
    const bill = dated("pay", "2026-11-18", { threadId: 9 });
    const { rows, counts } = projectToday(facts({ dated: [bill], live: (id) => id !== 9 }));
    expect(rows).toEqual([]);
    expect(counts.today).toBe(0);
  });

  it("your reminder is a row only on a conversation with none of its own", () => {
    const bill = dated("pay", "2026-11-18", { threadId: 2 });
    const { rows } = projectToday(facts({ dated: [bill], reminders: [{ threadId: 2, dueAt: NOW }, { threadId: 8, dueAt: NOW + 1 }] }));
    expect(rows.map((r) => r.id)).toEqual([`dated:${bill.id}`, "reminder:8"]);
  });
});

describe("duplicates and related details", () => {
  it("true duplicates are one row, the canonical's id, every member named", () => {
    const restaurant = dated("event", "2026-11-18", { threadId: 1 }, "19:30");
    const friend = dated("event", "2026-11-18", { threadId: 2, sameAs: `dated:${restaurant.id}` }, "19:30");
    const { rows } = projectToday(facts({ dated: [restaurant, friend] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `dated:${restaurant.id}`, threadId: 1 });
    expect(rows[0]!.why.members).toEqual([{ source: "dated", id: restaurant.id }, { source: "dated", id: friend.id }]);
  });

  it("an errand read as a bill and as your promise is one row; its id stays the canonical's when only the member is open", () => {
    const bus = dated("pay", "2026-11-20", { threadId: 1 });
    const mine = promise(at(2026, 11, 20, 9), { threadId: 1, sameAs: `dated:${bus.id}` });
    expect(projectToday(facts({ dated: [bus], promises: [mine] })).rows.map((r) => r.id)).toEqual([`dated:${bus.id}`]);
    // the bill settled by mail: the promise is still the same row
    const [row] = projectToday(facts({ promises: [mine] })).rows;
    expect(row).toMatchObject({ id: `dated:${bus.id}`, why: { kind: "promise", promise: { id: mine.id } } });
  });

  it("a return leg is its outbound flight's Also, and a row of its own once that flight is over", () => {
    const out = dated("event", "2026-11-18", { threadId: 1, text: "Flight to Austin" }, "12:00");
    const back = dated("event", "2026-11-22", { threadId: 1, text: "Return flight to Madrid", detailOf: out.id }, "18:10");
    const before = projectToday(facts({ dated: [out, back] })).rows;
    expect(before.map((r) => r.id)).toEqual([`dated:${out.id}`]);
    expect(before[0]!.also).toMatchObject({ text: "Return flight to Madrid", dueDay: "2026-11-22", timed: true });
    // the day after the outbound flight, the trip's row is the return leg's, under its own day (a Plan's lead is three days)
    const after = projectToday(facts({ now: at(2026, 11, 19, 10), dated: [out, back] })).rows;
    expect(after.map((r) => [r.id, r.group])).toEqual([[`dated:${back.id}`, "day"]]);
  });
});

describe("early, broken, one time", () => {
  it("a person's request with a far day shows from its arrival in Today's people, and counts there", () => {
    const far = dated("respond", "2026-11-30", { threadId: 1, early: true, arrivedAt: at(2026, 11, 17, 9) });
    const late = dated("respond", "2026-11-30", { threadId: 2, arrivedAt: at(2026, 11, 17, 9) });
    const { rows, counts } = projectToday(facts({ dated: [far, late] }));
    expect(rows.filter((r) => r.group === "today").map((r) => r.id)).toEqual([`dated:${far.id}`]);
    expect(rows.find((r) => r.id === `dated:${far.id}`)!.why.item).toMatchObject({ early: true });
    // without it, a week before (Coming up meanwhile)
    expect(rows.find((r) => r.id === `dated:${late.id}`)!.group).toBe("comingUp");
    expect(counts.today).toBe(1);
    // on its day it's due today, as any request
    const due = projectToday(facts({ now: at(2026, 11, 30, 9), dated: [far] })).rows[0]!;
    expect(due.why.item?.early).toBeUndefined();
  });

  it("a delivery that needs someone there shows from the day before; the clock agrees", () => {
    const parcel = dated("delivery", "2026-11-21", { early: true });
    expect(datedGroupAt(parcel, at(2026, 11, 19, 23))).toMatchObject({ group: "comingUp" });
    expect(datedGroupAt(parcel, at(2026, 11, 20, 0))).toEqual({ group: "day", day: "2026-11-21" });
    expect(nextTodayChange([parcel], [], at(2026, 11, 19, 23))).toBe(at(2026, 11, 20, 0));
    expect(needsPresence("Laptops arrive Saturday", "Adult signature required")).toBe(true);
    expect(needsPresence("Your order arrives Saturday")).toBe(false);
  });

  it("a broken promise given a new day keeps its first one, under the new day, not Missed", () => {
    const moved = promise(at(2026, 11, 23, 9), { brokenDueAt: at(2026, 11, 17, 9) });
    const [row] = projectToday(facts({ promises: [moved] })).rows;
    expect(row).toMatchObject({ group: "day", day: "2026-11-23", why: { promise: { promisedAt: at(2026, 11, 17, 9) } } });
    expect(row!.why.missed).toBeUndefined();
  });

  it("the mail's own time leaves the words for the when column; a promise's stated time too", () => {
    const rfp = dated("respond", "2026-11-18", { text: "Submit the RFP response (5:00 PM ET)" }, "16:00");
    const call = promise(at(2026, 11, 18, 16), { text: "call Marcus at 4:00 PM PT", timed: true });
    const rows = projectToday(facts({ dated: [rfp], promises: [call] })).rows;
    expect(rows.find((r) => r.why.kind === "dated")!.why).toMatchObject({ text: "Submit the RFP response", item: { note: "5:00 PM ET" } });
    expect(rows.find((r) => r.why.kind === "promise")!.why).toMatchObject({ text: "call Marcus", promise: { timed: true, note: "4:00 PM PT" } });
    // in the reader's own zone, no brackets
    const local = projectToday(facts({ promises: [call], zone: "America/Los_Angeles" })).rows[0]!;
    expect(local.why.promise?.note).toBeUndefined();
  });
});

describe("the header's numbers", () => {
  it("Today, this week through Sunday, Missed; never a Plan, a reminder nor Coming up", () => {
    const rows = [
      dated("pay", "2026-11-17"), // Missed
      dated("pay", "2026-11-18"), // Today
      dated("ask", null), // Today
      dated("event", "2026-11-18", {}, "19:00"), // Today, a Plan
      dated("pay", "2026-11-21"), // Saturday: this week
      dated("renew", "2026-11-22"), // Sunday: this week
      dated("pay", "2026-11-24"), // next Tuesday: a day ahead, not this week
      dated("respond", "2026-12-10"), // Coming up
    ];
    const { counts } = projectToday(facts({ dated: rows, reminders: [{ threadId: 99, dueAt: NOW }] }));
    expect(counts).toEqual({ missed: 1, today: 2, thisWeek: 2 });
    // the count's projection agrees with the list's
    expect(projectToday(facts({ dated: rows }), { count: true }).counts).toEqual(counts);
  });

  it("the week ends on Sunday", () => {
    expect(weekEndDay(at(2026, 11, 18, 10))).toBe("2026-11-22");
    expect(weekEndDay(at(2026, 11, 22, 23))).toBe("2026-11-22");
    expect(weekEndDay(at(2026, 11, 23, 0))).toBe("2026-11-29");
  });
});

describe("words and clocks", () => {
  it("a zone note comes off the words, any other parentheses stay", () => {
    expect(splitZoneNote("Call with Marcus (4:00 PM PT)")).toEqual({ text: "Call with Marcus", note: "4:00 PM PT" });
    expect(splitZoneNote("Keynote (18:00 hora de Ciudad de México)")).toEqual({ text: "Keynote", note: "18:00 hora de Ciudad de México" });
    expect(splitZoneNote("Submit the RFP (5:00 PM Eastern)")).toEqual({ text: "Submit the RFP", note: "5:00 PM Eastern" });
    expect(splitZoneNote("Pay the bill ($54.20)")).toEqual({ text: "Pay the bill ($54.20)", note: null });
  });

  it("a promise's stated clock, never a bare number", () => {
    expect(statedClock("call Marcus at 4:00 PM PT")).toMatchObject({ time: "16:00", zone: "America/Los_Angeles", note: "4:00 PM PT", rest: "call Marcus" });
    expect(statedClock("llamar a Ana a las 16:30")).toMatchObject({ time: "16:30", zone: null, rest: "llamar a Ana" });
    expect(statedClock("send it by 9am")).toMatchObject({ time: "09:00", rest: "send it" });
    expect(statedClock("meet at 4 people")).toBeNull();
    expect(statedClock("send the deck")).toBeNull();
  });
});
