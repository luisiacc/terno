/** Plan 210 (iteration 2): a row per item, one projection for the feed, the counts and the notice. */
import { describe, expect, it } from "vitest";
import { canLapse, datedGroupAt, datedTiming, dayKeyOf, displayBucket, lapsesUnlessRenewed, needsPresence, nextTodayChange, promiseOver, type DatedKind, type DatedRow } from "./dated";
import type { FollowupRow } from "./followups";
import { placedThreads, placeItems, projectToday, withMembersDetails, withNeeds, type ProjectionFacts } from "./today-projection";
import { splitZoneNote, statedClock } from "./today-items";

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
    // the plan isn't counted; the ask and the two waiting conversations are Today's "Waiting on you"
    expect(counts).toEqual({ missed: 0, today: 0, waiting: 3, overdue: 0 });
    // your promise to them behind Coming up says nothing yet: their conversation waiting on you is its own row meanwhile
    const later = promise(at(2026, 11, 30, 9), { threadId: 6 });
    expect(projectToday(facts({ promises: [later], waiting })).rows.filter((r) => r.waiting).map((r) => r.threadId)).toEqual([4, 5, 6]);
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
    // (iteration 5, revision 7: a to-do with a time, by its time, before the untimed)
    expect(rows.map((r) => r.id)).toEqual(["reminder:8", `dated:${bill.id}`]);
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

  it("plan 210 (iteration 3): a merged row keeps what its members add (Priya's car pickup from Jess's note), and says its own message", () => {
    const restaurant = dated("event", "2026-11-18", { threadId: 1, messageId: 49, text: "Juniper & Rye reservation, party of 4, Chef's counter" }, "19:30");
    const friend = dated("event", "2026-11-18", { threadId: 2, sameAs: `dated:${restaurant.id}`, text: "Dinner at Juniper & Rye (car pickup 7:05)" }, "19:30");
    const [row] = projectToday(facts({ dated: [restaurant, friend] })).rows;
    expect(row!.why.text).toBe("Juniper & Rye reservation, party of 4, Chef's counter (car pickup 7:05)");
    expect(row!.source).toEqual({ messageId: 49, senderKey: "a@b.c" });
    // a detail already said, or a zone note, isn't said twice; one bracket of its own takes the rest
    expect(withMembersDetails("Dinner (car pickup 7:05)", [friend])).toBe("Dinner (car pickup 7:05)");
    expect(withMembersDetails("Dinner (party of 4)", [friend])).toBe("Dinner (party of 4; car pickup 7:05)");
    expect(withMembersDetails("Dinner", [{ ...friend, text: "Dinner at 7:30 (7:30 PM ET)", timed: true }])).toBe("Dinner");
    // the count makes no words
    expect(projectToday(facts({ dated: [restaurant, friend] }), { count: true }).rows).toEqual([]);
  });

  it("Codex code review: the canonical's conversation in Trash, a live member shows the same row", () => {
    const restaurant = dated("event", "2026-11-18", { threadId: 1 }, "19:30");
    const friend = dated("event", "2026-11-18", { threadId: 2, sameAs: `dated:${restaurant.id}` }, "19:30");
    const rows = projectToday(facts({ dated: [restaurant, friend], live: (id) => id !== 1 })).rows;
    expect(rows.map((r) => [r.id, r.threadId])).toEqual([[`dated:${restaurant.id}`, 2]]);
    expect(projectToday(facts({ dated: [restaurant, friend], live: (id) => id !== 1 }), { count: true }).counts.today).toBe(0);
    // round 2: the caller is asked about every member's conversation, so it can know the friend's is live
    expect(placedThreads(placeItems([restaurant, friend], [], NOW)).sort()).toEqual([1, 2]);
  });

  it("an errand read as a bill and as your promise is one row; its id stays the canonical's when only the member is open", () => {
    const bus = dated("pay", "2026-11-20", { threadId: 1 });
    const mine = promise(at(2026, 11, 20, 9), { threadId: 1, sameAs: `dated:${bus.id}` });
    expect(projectToday(facts({ dated: [bus], promises: [mine] })).rows.map((r) => r.id)).toEqual([`dated:${bus.id}`]);
    // the bill settled by mail: the promise is still the same row
    const [row] = projectToday(facts({ promises: [mine] })).rows;
    expect(row).toMatchObject({ id: `dated:${bus.id}`, why: { kind: "promise", promise: { id: mine.id } } });
  });

  it("a return leg is a quiet row of its own on its day (iteration 4), never also its outbound flight's Also line (iteration 5, R1)", () => {
    const out = dated("event", "2026-11-18", { threadId: 1, text: "Flight to Austin" }, "12:00");
    const back = dated("event", "2026-11-22", { threadId: 1, text: "Return flight to Madrid", detailOf: out.id }, "18:10");
    const before = projectToday(facts({ dated: [out, back] }));
    expect(before.rows.map((r) => [r.id, r.group, r.day])).toEqual([[`dated:${out.id}`, "today", null], [`dated:${back.id}`, "day", "2026-11-22"]]);
    expect(before.rows.map((r) => r.also)).toEqual([undefined, undefined]);
    // a Plan: never counted, under its own day or Today
    expect(before.counts).toEqual({ missed: 0, today: 0, waiting: 0, overdue: 0 });
    // past the seven days, behind Coming up like any row of that day
    const far = { ...back, dueDay: "2026-12-02", dueAt: at(2026, 12, 2, 18, 10) };
    expect(projectToday(facts({ dated: [out, far] })).rows.map((r) => [r.id, r.group, r.day])).toEqual([[`dated:${out.id}`, "today", null], [`dated:${back.id}`, "comingUp", "2026-12-02"]]);
    // the day after the outbound flight, the trip's row is the return leg's, under its own day (a Plan's lead is three days)
    const after = projectToday(facts({ now: at(2026, 11, 19, 10), dated: [out, back] })).rows;
    expect(after.map((r) => [r.id, r.group])).toEqual([[`dated:${back.id}`, "day"]]);
  });
});

describe("one reply, one row (plan 210, iteration 4)", () => {
  // Diego: "el verde lo calibro con el perfil de la imprenta… el jueves te los mando": two promises of one reply to Valeria
  const reply = (more: Partial<FollowupRow>[]) => more.map((m, item) => promise(at(2026, 11, 19, 9), { messageId: 43, item, personEmail: "Valeria@CafeOrigen.mx", personName: "Valeria", ...m }));

  it("Diego: the dated one leads, under its day; the other is its Also line, named for its acts, never a member", () => {
    const [green, send] = reply([{ text: "calibrate the green with the printer's profile", dated: false, dueAt: NOW - 3_600_000 }, { text: "send Valeria the three changes" }]);
    // alone, the undated one would be Today's own, counted
    expect(projectToday(facts({ promises: [green!] }), { count: true }).counts.today).toBe(1);
    const { rows, counts } = projectToday(facts({ promises: [green!, send!] }));
    expect(rows.map((r) => [r.id, r.group, r.day])).toEqual([[`promise:${send!.id}`, "day", "2026-11-19"]]);
    expect(rows[0]!.why.with).toEqual([{ source: "promise", id: green!.id, revision: 0 }]);
    // its members are its own item's: the reader keeps the other a line of its own, an act on it alone leaves the row
    expect(rows[0]!.why.members).toBeUndefined();
    expect(rows[0]!.also).toEqual([{ kind: "promise", text: "calibrate the green with the printer's profile", dueDay: "2026-11-18", dueAt: NOW - 3_600_000, timed: false, dated: false }]);
    // one row, and the count says so (the day ahead isn't counted)
    expect(counts).toEqual({ missed: 0, today: 0, waiting: 0, overdue: 0 });
    expect(projectToday(facts({ promises: [green!, send!] }), { count: true }).counts).toEqual(counts);
  });

  it("Priya: both dated, the first said leads (the call at 4:00 PM), the other said with its day; with no dated one, the first", () => {
    const [call, equity] = reply([{ text: "call Marcus at 4:00 PM", timed: true, dueAt: at(2026, 11, 19, 16) }, { text: "bring flexibility on the equity side to Marcus", dueAt: at(2026, 11, 19, 9) }]);
    const [row] = projectToday(facts({ promises: [equity!, call!] })).rows;
    expect(row).toMatchObject({ id: `promise:${call!.id}`, why: { text: "call Marcus", with: [{ source: "promise", id: equity!.id }] } });
    expect(row!.also).toMatchObject([{ text: "bring flexibility on the equity side to Marcus", dueDay: "2026-11-19", dated: true, timed: false }]);
    const [a, b] = reply([{ dated: false, dueAt: NOW - 1 }, { dated: false, dueAt: NOW - 2 }]);
    expect(projectToday(facts({ promises: [b!, a!] })).rows.map((r) => r.id)).toEqual([`promise:${a!.id}`]);
  });

  it("a promise that only holds a request (Margaret's \"I'll get back to you\") is never a row, nor its reply's Also: the request is the row", () => {
    const ask = dated("respond", "2026-11-23", { threadId: 1, text: "Tell Valeria whether you can host in December" });
    const [hold, send] = reply([{ text: "check your calendar and get back to Valeria", dated: false, dueAt: NOW - 1, holds: ask.id }, { text: "email Valeria the questions" }]);
    const { rows, counts } = projectToday(facts({ dated: [ask], promises: [hold!, send!] }));
    expect(rows.map((r) => r.id).sort()).toEqual([`dated:${ask.id}`, `promise:${send!.id}`].sort());
    expect(rows.find((r) => r.id === `promise:${send!.id}`)!.also).toBeUndefined();
    expect(projectToday(facts({ dated: [ask], promises: [hold!, send!] }), { count: true }).counts).toEqual(counts);
    expect(projectToday(facts({ promises: [hold!] })).rows).toEqual([]);
  });

  it("another person, another message, or no one named: rows of their own", () => {
    const [mine, theirs] = reply([{}, { personEmail: "pablo@cafeorigen.mx", personName: "Pablo" }]);
    expect(projectToday(facts({ promises: [mine!, theirs!] })).rows).toHaveLength(2);
    const [x, y] = reply([{}, { messageId: 44 }]);
    expect(projectToday(facts({ promises: [x!, y!] })).rows).toHaveLength(2);
    const [p, q] = reply([{ personEmail: null, personName: null }, { personEmail: null, personName: null }]);
    expect(projectToday(facts({ promises: [p!, q!] })).rows).toHaveLength(2);
    // by the address as compared everywhere, else the name
    const [m, n] = reply([{ personEmail: null, personName: "Valeria " }, { personEmail: null, personName: "valeria" }]);
    expect(projectToday(facts({ promises: [m!, n!] })).rows).toHaveLength(1);
  });

  it("a promise an event leads (Jordan's who comes along) stays the event's row; attendance and the reply apart", () => {
    const qbr = dated("event", "2026-11-19", { threadId: 1, text: "Q4 business review" }, "14:00");
    const [bring, agenda] = reply([{ dated: false, dueAt: NOW - 1, sameAs: `dated:${qbr.id}` }, { text: "send Grace the agenda" }]);
    const { rows } = projectToday(facts({ dated: [qbr], promises: [bring!, agenda!] }));
    expect(rows.map((r) => r.id).sort()).toEqual([`dated:${qbr.id}`, `promise:${agenda!.id}`].sort());
    expect(rows.find((r) => r.id === `promise:${agenda!.id}`)!.why.with).toBeUndefined();
    // (iteration 5, R9) what you said you'd bring is the event's line, in your words, no day of its own
    expect(rows.find((r) => r.id === `dated:${qbr.id}`)!.also).toEqual([{ kind: "promise", text: bring!.text, dueDay: dayKeyOf(NOW - 1), dueAt: NOW - 1, timed: false, dated: false, attends: true }]);
    // an errand read as a bill and as your promise says nothing more: the same thing twice is one row, one line
    const bus = dated("pay", "2026-11-20", { threadId: 2 });
    const mine = promise(at(2026, 11, 20, 9), { threadId: 2, sameAs: `dated:${bus.id}` });
    expect(projectToday(facts({ dated: [bus], promises: [mine] })).rows[0]!.also).toBeUndefined();
  });

  it("grouped where they're placed: a lead behind Coming up takes the other with it in the list and in the count alike; one closed, the other is its own row", () => {
    const [green, send] = reply([{ dated: false, dueAt: NOW - 1 }, { dueAt: at(2026, 12, 18, 9) }]);
    expect(projectToday(facts({ promises: [green!, send!] })).rows.map((r) => [r.id, r.group])).toEqual([[`promise:${send!.id}`, "comingUp"]]);
    expect(projectToday(facts({ promises: [green!, send!] }), { count: true }).counts.today).toBe(0);
    // an undated one not showing yet is the row's too: Done on the row finishes it, so it never comes back alone
    const notYet = { ...green!, dueAt: at(2026, 11, 23, 9) };
    expect(projectToday(facts({ promises: [notYet] })).rows).toEqual([]);
    const [row0] = projectToday(facts({ promises: [notYet, send!] })).rows;
    expect(row0).toMatchObject({ id: `promise:${send!.id}`, why: { with: [{ id: green!.id }] }, also: [{ dated: false }] });
    // a reply none of whose promises shows has no row
    expect(projectToday(facts({ promises: [notYet, { ...notYet, id: 901, item: 1 }] })).rows).toEqual([]);
    // Done on the lead alone (the reader's line): the other is a row of its own again
    expect(projectToday(facts({ promises: [green!] })).rows.map((r) => r.id)).toEqual([`promise:${green!.id}`]);
    // a duplicate of either is still that item's member, under the reply's row
    const twin = { ...green!, id: 900, item: 5, sameAs: `promise:${green!.id}` };
    const [row] = projectToday(facts({ promises: [green!, send!, twin] })).rows;
    expect(row!.why.with).toEqual([{ source: "promise", id: green!.id, revision: 0 }]);
  });
});

describe("early, broken, one time", () => {
  it("a person's request shows from its arrival: past the seven days under Ahead by its day (iteration 5, revision 5), never counted; within them in Today's people, counted there", () => {
    const far = dated("respond", "2026-11-30", { threadId: 1, early: true, arrivedAt: at(2026, 11, 17, 9) });
    const late = dated("respond", "2026-11-30", { threadId: 2, arrivedAt: at(2026, 11, 17, 9) });
    const ahead = projectToday(facts({ dated: [far, late] }));
    expect(ahead.rows.map((r) => [r.id, r.group, r.day, r.part ?? null, r.bucket ?? null])).toEqual([
      [`dated:${far.id}`, "ahead", "2026-11-30", null, null],
      // without it, a week before (Coming up meanwhile)
      [`dated:${late.id}`, "comingUp", "2026-11-30", null, "2026-11-30"],
    ]);
    expect(ahead.rows[0]!.why.item?.early).toBeUndefined();
    expect(ahead.counts).toEqual({ missed: 0, today: 0, waiting: 0, overdue: 0 });
    // the 23rd brings its day within the seven: Today's people, counted as waiting
    const { rows, counts } = projectToday(facts({ now: at(2026, 11, 23, 10), dated: [far, late] }));
    expect(rows.filter((r) => r.group === "today").map((r) => r.id)).toEqual([`dated:${far.id}`]);
    expect(rows.find((r) => r.id === `dated:${far.id}`)!.why.item).toMatchObject({ early: true });
    expect(counts).toEqual({ missed: 0, today: 0, waiting: 1, overdue: 0 });
    expect(rows.find((r) => r.id === `dated:${far.id}`)!.part).toBe("waiting");
    // on its day it's due today, as any request
    const due = projectToday(facts({ now: at(2026, 11, 30, 9), dated: [far] }));
    expect(due.rows[0]!.why.item?.early).toBeUndefined();
    // a deadline, not Waiting (revision 8)
    expect([due.rows[0]!.part, due.counts]).toEqual([undefined, { missed: 0, today: 1, waiting: 0, overdue: 0 }]);
  });

  it("a delivery, needing someone there or not, shows as its seven days begin (plan 210, iteration 3); the clock agrees", () => {
    const parcel = dated("delivery", "2026-11-21", { early: true, arrivedAt: at(2026, 11, 2, 9) });
    expect(datedGroupAt(parcel, at(2026, 11, 13, 23))).toMatchObject({ group: "comingUp" });
    expect(datedGroupAt(parcel, at(2026, 11, 14, 0))).toEqual({ group: "day", day: "2026-11-21" });
    expect(nextTodayChange([parcel], [], at(2026, 11, 13, 23))).toBe(at(2026, 11, 14, 0));
    // revision 11: the mail's words (the quote's paragraph), never the item's
    expect(needsPresence("Your laptops arrive Saturday. Adult signature required.")).toBe(true);
    expect(needsPresence("Your order arrives Saturday")).toBe(false);
  });

  it("revision 11: what lapses unless renewed takes an expiry's 30 days whatever kind it was read as; what renews by itself doesn't", () => {
    const now = at(2026, 11, 10, 10);
    const domain = (lapses: boolean) => dated("renew", "2026-12-07", { lapses, arrivedAt: at(2026, 11, 2, 9) });
    // a week's lead: Coming up on the 10th; lapsing: 30 days, so under its day already
    expect(datedGroupAt(domain(false), now)).toEqual({ group: "comingUp", day: "2026-12-07" });
    // (iteration 5: shown past the seven days, under Ahead)
    expect(datedGroupAt(domain(true), now)).toEqual({ group: "ahead", day: "2026-12-07" });
    // read as expire it's the same either way
    expect(datedGroupAt({ ...domain(true), kind: "expire" }, now)).toEqual({ group: "ahead", day: "2026-12-07" });
    expect(lapsesUnlessRenewed("Para no perder tu dominio ni el correo asociado, renueva antes de la fecha de vencimiento:")).toBe(true);
    expect(lapsesUnlessRenewed("To keep your apps available, renew your membership ($99 USD/year) before it expires.")).toBe(true);
    expect(lapsesUnlessRenewed("Auto-renew is off for pingwire.dev.")).toBe(true);
    expect(lapsesUnlessRenewed("Your domain pingwire.dev expires on November 19.")).toBe(true);
    expect(lapsesUnlessRenewed("Your Loomcast Business plan will renew automatically on December 1, 2026.")).toBe(false);
    expect(lapsesUnlessRenewed("Tu suscripción anual se renovará automáticamente el 19 de noviembre.")).toBe(false);
    expect(lapsesUnlessRenewed("AutoPay is on. We'll charge your account on Nov 24.")).toBe(false);
    expect(lapsesUnlessRenewed("Your plan renews Dec 1, charged by the card on file automatically.")).toBe(false);
    expect(lapsesUnlessRenewed("La renovación automática está desactivada: tu dominio vence el 8 de diciembre.")).toBe(true);
    expect(canLapse("renew") && canLapse("expire") && canLapse("pay") && canLapse("respond")).toBe(true);
    expect(canLapse("event") || canLapse("delivery") || canLapse("alert") || canLapse("ask")).toBe(false);
  });

  it("a broken promise given a new day keeps its first one, under the new day, not Missed", () => {
    const moved = promise(at(2026, 11, 23, 9), { brokenDueAt: at(2026, 11, 17, 9) });
    const [row] = projectToday(facts({ promises: [moved] })).rows;
    // (iteration 4, revision 8) someone waits on it: Today's Waiting on you, its column as it was
    expect(row).toMatchObject({ group: "today", day: null, part: "waiting", why: { dueAt: at(2026, 11, 23, 9), promise: { said: at(2026, 11, 17, 9), needed: at(2026, 11, 23, 9) } } });
    expect(row!.why.missed).toBeUndefined();
  });

  describe("a promise that answers a request keeps its deadline (iteration 3)", () => {
    const linked = (request: DatedRow, mine: FollowupRow) => withNeeds([mine], new Map([[request.id, request]]));

    it("its own day missed, it sits under the request's day still ahead, the request no row of its own", () => {
      // María: the school needs the slip Friday; she said Tuesday
      const slip = dated("respond", "2026-11-20", { threadId: 9, arrivedAt: at(2026, 11, 13, 9) });
      const mine = promise(at(2026, 11, 17, 9), { threadId: 9, answers: slip.id });
      const { rows, counts } = projectToday(facts({ dated: [slip], promises: linked(slip, mine) }));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: `promise:${mine.id}`, group: "today", day: null, part: "waiting", why: { dueAt: slip.dueAt, promise: { said: mine.dueAt, needed: slip.dueAt, dated: true } } });
      expect(rows[0]!.why.missed).toBeUndefined();
      expect(counts).toEqual({ missed: 0, today: 0, waiting: 1, overdue: 1 });
      // past the request's day too: Missed, from the later day, its column "Was due Fri" (nothing said beside)
      const after = projectToday(facts({ now: at(2026, 11, 21, 10), dated: [slip], promises: linked(slip, mine) })).rows;
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ group: "missed", why: { missed: true, dueAt: slip.dueAt } });
      expect(after[0]!.why.promise?.said).toBeUndefined();
      expect(promiseOver(linked(slip, mine)[0]!, at(2026, 11, 27, 23))).toBe(false);
      expect(promiseOver(linked(slip, mine)[0]!, at(2026, 11, 28, 0))).toBe(true);
    });

    it("its own day ahead, it sits under it and says the request's other day; one that named none sits under the request's", () => {
      const deck = dated("respond", "2026-11-23", { threadId: 9 });
      const mine = promise(at(2026, 11, 19, 9), { threadId: 9, answers: deck.id });
      const [row] = projectToday(facts({ dated: [deck], promises: linked(deck, mine) })).rows;
      expect(row).toMatchObject({ group: "day", day: "2026-11-19", why: { promise: { needed: deck.dueAt } } });
      expect(row!.why.promise?.said).toBeUndefined();
      // the same day: nothing said beside it
      const same = promise(at(2026, 11, 23, 15), { threadId: 9, answers: deck.id, timed: true });
      expect(projectToday(facts({ dated: [deck], promises: linked(deck, same) })).rows[0]!.why.promise?.needed).toBeUndefined();
      // "I'll send it" with no day: the request's day is its own
      const undated = promise(at(2026, 11, 21, 9), { threadId: 9, answers: deck.id, dated: false });
      expect(projectToday(facts({ dated: [deck], promises: linked(deck, undated) })).rows.map((r) => [r.id, r.group, r.day])).toEqual([[`promise:${undated.id}`, "day", "2026-11-23"]]);
    });

    it("the person's new day comes first; a closed request or an undated ask carries nothing", () => {
      const deck = dated("respond", "2026-11-26", { threadId: 9 });
      const moved = promise(at(2026, 11, 23, 9), { threadId: 9, answers: deck.id, brokenDueAt: at(2026, 11, 17, 9) });
      expect(projectToday(facts({ dated: [deck], promises: linked(deck, moved) })).rows[0]).toMatchObject({ group: "today", part: "waiting", why: { dueAt: at(2026, 11, 23, 9), promise: { said: at(2026, 11, 17, 9), needed: at(2026, 11, 23, 9) } } });
      const closed = { ...deck, state: "settled" as const };
      expect(withNeeds([moved], new Map([[deck.id, closed]]))[0]!.needed).toBeUndefined();
      const ask = dated("ask", null, { threadId: 9 });
      expect(withNeeds([promise(at(2026, 11, 17, 9), { answers: ask.id })], new Map([[ask.id, ask]]))[0]!.needed).toBeUndefined();
    });

    it("plan 210 (iteration 4, revision 11): the day a request was asked before reaches its row and the promise that answers it", () => {
      const soc = dated("respond", "2026-11-22", { threadId: 9, before: "2026-11-23" });
      expect(projectToday(facts({ dated: [soc] })).rows[0]!.why.item).toMatchObject({ dueDay: "2026-11-22", before: "2026-11-23" });
      const mine = promise(at(2026, 11, 20, 9), { threadId: 9, answers: soc.id });
      expect(linked(soc, mine)[0]).toMatchObject({ needed: soc.dueAt, neededBefore: "2026-11-23" });
      expect(projectToday(facts({ dated: [soc], promises: linked(soc, mine) })).rows[0]!.why.promise).toMatchObject({ needed: soc.dueAt, neededBefore: "2026-11-23" });
      // the person's own move "before" a day, broken: said beside the day it sits under
      const moved = promise(at(2026, 11, 22, 9), { threadId: 9, brokenDueAt: at(2026, 11, 17, 9), before: "2026-11-23" });
      expect(projectToday(facts({ promises: [moved] })).rows[0]!.why.promise).toMatchObject({ said: at(2026, 11, 17, 9), needed: at(2026, 11, 22, 9), neededBefore: "2026-11-23" });
      // none stored (a row from before v67): nothing guessed
      expect(projectToday(facts({ dated: [dated("respond", "2026-11-22", { threadId: 9 })] })).rows[0]!.why.item!.before).toBeUndefined();
    });

    it("plan 210 (iteration 5, revision 4): a part of the day reaches the row, the promise that answers it, and Missed at noon", () => {
      // Wednesday at 10:00: Kai's notes by this morning, María's cupcakes this morning
      const kai = dated("respond", "2026-11-18", { threadId: 9, partOfDay: "morning" });
      const cupcakes = promise(at(2026, 11, 18, 9), { threadId: 8, partOfDay: "morning" });
      const { rows } = projectToday(facts({ dated: [kai], promises: [cupcakes] }));
      expect(rows.find((r) => r.id === `dated:${kai.id}`)!.why.item).toMatchObject({ part: "morning" });
      expect(rows.find((r) => r.id === `promise:${cupcakes.id}`)).toMatchObject({ group: "today", why: { promise: { part: "morning" } } });
      // at noon, with no mail: both Missed
      const noon = projectToday(facts({ now: at(2026, 11, 18, 12), dated: [kai], promises: [cupcakes] }));
      expect(noon.rows.map((r) => [r.id, r.group])).toEqual(expect.arrayContaining([[`dated:${kai.id}`, "missed"], [`promise:${cupcakes.id}`, "missed"]]));
      expect(noon.counts.missed).toBe(2);
      // a promise answering it carries the request's part beside its own day
      const sat = dated("respond", "2026-11-21", { threadId: 9, partOfDay: "morning" });
      const mine = promise(at(2026, 11, 20, 9), { threadId: 9, answers: sat.id });
      expect(linked(sat, mine)[0]).toMatchObject({ neededPart: "morning" });
      expect(projectToday(facts({ dated: [sat], promises: linked(sat, mine) })).rows[0]!.why.promise).toMatchObject({ needed: sat.dueAt, neededPart: "morning" });
    });

    it("plan 210 (iteration 4, revision 10): a timed event with a place keeps the mail's clock for its row; one with a zone alone doesn't travel", () => {
      const wall = { day: "2026-11-19", time: "16:00", zone: "America/Chicago", place: "Austin" };
      const check = dated("event", "2026-11-19", { threadId: 9, wall }, "14:00");
      expect(projectToday(facts({ dated: [check] })).rows[0]!.why.item!.travel).toEqual({ day: "2026-11-19", time: "16:00", place: "Austin" });
      expect(projectToday(facts({ dated: [{ ...check, wall: { ...wall, place: null } }] })).rows[0]!.why.item!.travel).toBeUndefined();
    });

    it("a request whose promise is closed is its own row again; one the matcher made the same item is that item's row", () => {
      const deck = dated("respond", "2026-11-23", { threadId: 9 });
      expect(projectToday(facts({ dated: [deck], promises: [] })).rows.map((r) => r.id)).toEqual([`dated:${deck.id}`]);
      const merged = promise(at(2026, 11, 19, 9), { threadId: 9, answers: deck.id, sameAs: `dated:${deck.id}` });
      const rows = projectToday(facts({ dated: [deck], promises: linked(deck, merged) })).rows;
      expect(rows.map((r) => r.id)).toEqual([`dated:${deck.id}`]);
    });
  });

  it("the mail's own time leaves the words for the when column; a promise's stated time too", () => {
    const rfp = dated("respond", "2026-11-18", { text: "Submit the RFP response (5:00 PM ET)" }, "16:00");
    // 4:00 PM in Los Angeles that day
    const call = promise(Date.UTC(2026, 10, 19, 0, 0), { text: "call Marcus at 4:00 PM PT", timed: true });
    const rows = projectToday(facts({ dated: [rfp], promises: [call] })).rows;
    expect(rows.find((r) => r.why.kind === "dated")!.why).toMatchObject({ text: "Submit the RFP response", item: { note: "5:00 PM ET" } });
    expect(rows.find((r) => r.why.kind === "promise")!.why).toMatchObject({ text: "call Marcus", promise: { timed: true, note: "4:00 PM PT" } });
    // in the reader's own zone, no brackets
    const local = projectToday(facts({ promises: [call], zone: "America/Los_Angeles" })).rows[0]!;
    expect(local.why.promise?.note).toBeUndefined();
    // moved to another time, its words' clock isn't the row's to say (Codex code review)
    const moved = projectToday(facts({ promises: [{ ...call, dueAt: call.dueAt + 3_600_000 }] })).rows[0]!;
    expect(moved.why.promise?.note).toBeUndefined();
  });
});

describe("the header's numbers (plan 210, iteration 3, revision 8)", () => {
  it("missed, today and waiting, disjoint; never a Plan, a day ahead nor Coming up; your reminder is Today's (iteration 4)", () => {
    const rows = [
      dated("pay", "2026-11-17"), // Missed
      dated("pay", "2026-11-18"), // Today
      dated("respond", "2026-11-18"), // a request due today: a deadline, Today
      dated("ask", null), // Waiting on you
      dated("respond", "2026-11-24", { early: true }), // shown early: Waiting on you
      dated("respond", "2026-11-27", { early: true }), // shown early past the seven days: Ahead (iteration 5), never counted
      dated("event", "2026-11-18", {}, "19:00"), // Today, a Plan
      dated("pay", "2026-11-21"), // a day ahead
      dated("respond", "2026-12-10"), // Coming up
    ];
    const waiting = [{ id: 50, lastDate: NOW - 5, hasSent: true }];
    const reminders = [{ threadId: 99, dueAt: NOW }];
    const { counts } = projectToday(facts({ dated: rows, waiting, reminders }));
    expect(counts).toEqual({ missed: 1, today: 3, waiting: 3, overdue: 0 });
    // the count's projection agrees with the list's
    expect(projectToday(facts({ dated: rows, waiting, reminders }), { count: true }).counts).toEqual(counts);
    // a reminder on a conversation with a row of its own is that row (counted once), and one in Trash none
    expect(projectToday(facts({ dated: rows, waiting, reminders: [{ threadId: 50, dueAt: NOW }, { threadId: 98, dueAt: NOW }], live: (id) => id !== 98 }), { count: true }).counts).toEqual({ missed: 1, today: 2, waiting: 3, overdue: 0 });
  });
});

describe("Ahead (plan 210, iteration 5, revision 5)", () => {
  it("what shows past the seven days is one group after them, by its own days, no bucket of its own; Coming up after it, apart", () => {
    const bill = dated("pay", "2026-11-21", { threadId: 1 });
    const visa = dated("expire", "2026-12-08", { threadId: 2 });
    const passport = dated("expire", "2026-11-30", { threadId: 3 });
    const domain = dated("renew", "2026-11-30", { threadId: 4, lapses: true }, "09:00");
    const rent = dated("pay", "2026-11-28", { threadId: 5 });
    const { rows, counts } = projectToday(facts({ dated: [visa, rent, passport, bill, domain] }));
    expect(rows.map((r) => [r.id, r.group, r.day, r.bucket ?? null])).toEqual([
      [`dated:${bill.id}`, "day", "2026-11-21", "2026-11-21"],
      [`dated:${domain.id}`, "ahead", "2026-11-30", null],
      [`dated:${passport.id}`, "ahead", "2026-11-30", null],
      [`dated:${visa.id}`, "ahead", "2026-12-08", null],
      [`dated:${rent.id}`, "comingUp", "2026-11-28", "2026-11-28"],
    ]);
    expect(counts).toEqual({ missed: 0, today: 0, waiting: 0, overdue: 0 });
  });
});

describe("Coming up's buckets (plan 210, iteration 3, revision 9)", () => {
  it("a day for the first two weeks (through the Sunday that ends them), then its week, with the year's own Monday", () => {
    // Sunday Nov 15: the 29th is a Sunday, its own day; the 30th starts a week
    expect(displayBucket("2026-11-29", "2026-11-15")).toBe("2026-11-29");
    expect(displayBucket("2026-11-30", "2026-11-15")).toBe("week:2026-11-30");
    expect(displayBucket("2026-12-09", "2026-11-15")).toBe("week:2026-12-07");
    // a Wednesday: the fourteenth day is a Wednesday, its week stays days to its Sunday (no week split)
    expect(displayBucket("2026-12-06", "2026-11-18")).toBe("2026-12-06");
    expect(displayBucket("2026-12-07", "2026-11-18")).toBe("week:2026-12-07");
    // across the year
    expect(displayBucket("2027-01-03", "2026-12-20")).toBe("2027-01-03");
    expect(displayBucket("2027-01-06", "2026-12-20")).toBe("week:2027-01-04");
  });

  it("each row ahead carries its bucket apart from its own day, in order; the count makes none", () => {
    const near = dated("pay", "2026-11-28", { threadId: 1 });
    const far = dated("pay", "2026-12-17", { threadId: 2 });
    const farther = dated("renew", "2027-01-20", { threadId: 3 });
    const { rows } = projectToday(facts({ dated: [farther, far, near] }));
    expect(rows.map((r) => [r.group, r.day, r.bucket])).toEqual([
      ["comingUp", "2026-11-28", "2026-11-28"],
      ["comingUp", "2026-12-17", "week:2026-12-14"],
      ["comingUp", "2027-01-20", "week:2027-01-18"],
    ]);
    expect(rows.map((r) => r.id)).toEqual([`dated:${near.id}`, `dated:${far.id}`, `dated:${farther.id}`]);
  });
});

describe("Waiting on you, a part of Today (plan 210, iteration 3, revision 8)", () => {
  it("after Today's own (its quiet rows too); requests within the seven days by their day, the undated as they came, newest first; a request due later is Ahead's (iteration 5)", () => {
    const bill = dated("pay", "2026-11-18", { threadId: 1 });
    const plan = dated("event", "2026-11-18", { threadId: 2 }, "19:00");
    const later = dated("respond", "2026-11-28", { threadId: 3, early: true, arrivedAt: at(2026, 11, 17, 8) });
    const sooner = dated("respond", "2026-11-20", { threadId: 4, early: true, arrivedAt: at(2026, 11, 16, 8) });
    const ask = dated("ask", null, { threadId: 5, arrivedAt: at(2026, 11, 17, 12) });
    const waiting = [{ id: 6, lastDate: at(2026, 11, 18, 8), hasSent: true }, { id: 7, lastDate: at(2026, 11, 16, 8), hasSent: false }];
    const { rows } = projectToday(facts({ dated: [later, ask, bill, sooner, plan], waiting, reminders: [{ threadId: 8, dueAt: NOW }] }));
    expect(rows.map((r) => [r.id, r.part ?? null])).toEqual([
      ["reminder:8", null],
      [`dated:${bill.id}`, null],
      [`dated:${plan.id}`, null],
      [`dated:${sooner.id}`, "waiting"],
      ["waiting:6", "waiting"],
      [`dated:${ask.id}`, "waiting"],
      ["waiting:7", "waiting"],
      [`dated:${later.id}`, null],
    ]);
    expect(rows.at(-1)!.group).toBe("ahead");
  });

  it("iteration 4 (revision 8): a promise broken with a live day ahead is first, by that day, counted once as waiting in the list and the count alike", () => {
    // Jordan: "You said Tue 17 (missed) · needed Mon"; a request of Tomás's due Friday; Gary's due in December
    const deck = dated("respond", "2026-11-23", { threadId: 9 });
    const mine = withNeeds([promise(at(2026, 11, 17, 9), { threadId: 9, answers: deck.id })], new Map([[deck.id, deck]]));
    const moved = promise(at(2026, 11, 21, 9), { threadId: 10, brokenDueAt: at(2026, 11, 16, 9) });
    const friday = dated("respond", "2026-11-20", { threadId: 11, early: true });
    const december = dated("respond", "2026-12-31", { threadId: 12, early: true });
    const bill = dated("pay", "2026-11-18", { threadId: 13 });
    const f = facts({ dated: [deck, friday, december, bill], promises: [...mine, moved] });
    const { rows, counts } = projectToday(f);
    expect(rows.map((r) => [r.id, r.group, r.part ?? null])).toEqual([
      [`dated:${bill.id}`, "today", null],
      [`promise:${moved.id}`, "today", "waiting"],
      [`promise:${mine[0]!.id}`, "today", "waiting"],
      [`dated:${friday.id}`, "today", "waiting"],
      // (iteration 5, revision 5: Gary's December request is Ahead's, by its day, never Waiting on you's)
      [`dated:${december.id}`, "ahead", null],
    ]);
    // its column as it was: the missed day said, the day it's needed by, never Missed's bucket
    expect(rows[1]!.why).toMatchObject({ dueAt: at(2026, 11, 21, 9), promise: { said: at(2026, 11, 16, 9) } });
    expect(rows[1]!.why.missed).toBeUndefined();
    // (iteration 5, revision 6) the two broken promises are overdue, a part of waiting
    expect(counts).toEqual({ missed: 0, today: 1, waiting: 3, overdue: 2 });
    expect(projectToday(f, { count: true }).counts).toEqual(counts);
    // put off with Later: behind Coming up, neither shown nor counted
    const off = { ...moved, deferredUntil: at(2026, 11, 20, 9) };
    expect(projectToday(facts({ promises: [off] })).rows.map((r) => r.group)).toEqual(["comingUp"]);
    expect(projectToday(facts({ promises: [off] }), { count: true }).counts).toEqual({ missed: 0, today: 0, waiting: 0, overdue: 0 });
    // its live day over too: Missed
    expect(projectToday(facts({ now: at(2026, 11, 22, 10), promises: [moved] })).rows.map((r) => r.group)).toEqual(["missed"]);
  });

  it("iteration 5 (revision 6): needed today, a broken promise is Today's own first row, counted to do today; needed ahead, Waiting on you's and overdue; midnight moves it", () => {
    // María: "You said Tue 10 (missed) · needed today"
    const slip = promise(at(2026, 11, 18, 9), { threadId: 20, text: "send Ms. Ruiz the signed slip", brokenDueAt: at(2026, 11, 10, 9) });
    const bill = dated("pay", "2026-11-18", { threadId: 21 });
    const plan = dated("event", "2026-11-18", { threadId: 22 }, "19:00");
    const f = facts({ dated: [bill, plan], promises: [slip] });
    const { rows, counts } = projectToday(f);
    expect(rows.map((r) => [r.id, r.group, r.part ?? null])).toEqual([
      [`promise:${slip.id}`, "today", null],
      [`dated:${bill.id}`, "today", null],
      [`dated:${plan.id}`, "today", null],
    ]);
    expect(rows[0]!.why.promise).toMatchObject({ said: at(2026, 11, 10, 9) });
    expect(counts).toEqual({ missed: 0, today: 2, waiting: 0, overdue: 0 });
    expect(projectToday(f, { count: true }).counts).toEqual(counts);
    // the day before its live day it was ahead: Waiting on you's, overdue; at midnight, Today's own
    const eve = facts({ now: at(2026, 11, 17, 23, 59), promises: [slip] });
    expect(projectToday(eve).rows.map((r) => [r.group, r.part ?? null])).toEqual([["today", "waiting"]]);
    expect(projectToday(eve, { count: true }).counts).toEqual({ missed: 0, today: 0, waiting: 1, overdue: 1 });
    const midnight = facts({ now: at(2026, 11, 18), promises: [slip] });
    expect(projectToday(midnight).rows.map((r) => [r.group, r.part ?? null])).toEqual([["today", null]]);
    expect(projectToday(midnight, { count: true }).counts).toEqual({ missed: 0, today: 1, waiting: 0, overdue: 0 });
    // put off with Later: neither
    expect(projectToday(facts({ promises: [{ ...slip, deferredUntil: at(2026, 11, 18, 15) }] }), { count: true }).counts).toEqual({ missed: 0, today: 0, waiting: 0, overdue: 0 });
  });

  it("iteration 5 (revision 6): a reply's row and a duplicate shown for a canonical in Trash read the lead it shows, in both paths", () => {
    // one reply to Jess: the broken dated one leads, needed today; the other its Also line; one row, counted once
    const lead = promise(at(2026, 11, 18, 9), { threadId: 30, messageId: 77, item: 0, brokenDueAt: at(2026, 11, 12, 9) });
    const other = promise(at(2026, 11, 18, 9), { threadId: 30, messageId: 77, item: 1, dated: false, dueAt: NOW - 1 });
    const grouped = facts({ promises: [lead, other] });
    expect(projectToday(grouped).rows.map((r) => [r.id, r.part ?? null, r.why.with?.length ?? 0])).toEqual([[`promise:${lead.id}`, null, 1]]);
    expect(projectToday(grouped, { count: true }).counts).toEqual({ missed: 0, today: 1, waiting: 0, overdue: 0 });
    // the canonical (needed ahead) in Trash; its live duplicate, needed today, is the row and decides it
    const canonical = promise(at(2026, 11, 21, 9), { threadId: 31, brokenDueAt: at(2026, 11, 12, 9) });
    const twin = promise(at(2026, 11, 18, 9), { threadId: 32, brokenDueAt: at(2026, 11, 12, 9), sameAs: `promise:${canonical.id}` });
    const trash = facts({ promises: [canonical, twin], live: (id) => id !== 31 });
    expect(projectToday(trash).rows.map((r) => [r.id, r.threadId, r.part ?? null])).toEqual([[`promise:${canonical.id}`, 32, null]]);
    expect(projectToday(trash, { count: true }).counts).toEqual({ missed: 0, today: 1, waiting: 0, overdue: 0 });
  });

  it("iteration 5 (revision 7): Today's to-dos first, by their time then the untimed (Priya's payroll 1:00 PM, Marcus at 4:00 PM, rent), then what happens (the 1:1 at 2:00 PM)", () => {
    const payroll = dated("pay", "2026-11-18", { threadId: 1 }, "13:00");
    const oneOnOne = dated("event", "2026-11-18", { threadId: 2 }, "14:00");
    const marcus = promise(at(2026, 11, 18, 16), { threadId: 3, timed: true, text: "call Marcus at 4:00 PM" });
    const rent = dated("pay", "2026-11-18", { threadId: 4 });
    const { rows } = projectToday(facts({ dated: [oneOnOne, payroll, rent], promises: [marcus], zone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    expect(rows.map((r) => r.id)).toEqual([`dated:${payroll.id}`, `promise:${marcus.id}`, `dated:${rent.id}`, `dated:${oneOnOne.id}`]);
  });

  it("a row's id stays as its tier changes: shown early, then due today", () => {
    const request = dated("respond", "2026-11-20", { threadId: 3, early: true });
    const before = projectToday(facts({ dated: [request] })).rows[0]!;
    const on = projectToday(facts({ now: at(2026, 11, 20, 9), dated: [request] })).rows[0]!;
    expect([before.id, before.part]).toEqual([`dated:${request.id}`, "waiting"]);
    expect([on.id, on.part]).toEqual([`dated:${request.id}`, undefined]);
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
    // Codex code review: a zone that reads one way only, in any case; one that doesn't (CST, IST) leaves it untimed
    expect(statedClock("call Marcus at 4:00 pm pt")).toMatchObject({ time: "16:00", zone: "America/Los_Angeles" });
    expect(statedClock("call Marcus at 4:00 PM CST")).toBeNull();
    expect(statedClock("call Priya at 9:00 AM IST")).toBeNull();
    // round 2: an offset after the zone isn't read as the zone alone
    expect(statedClock("call Marcus at 4:00 PM UTC+2")).toBeNull();
    expect(statedClock("send the deck")).toBeNull();
  });
});
