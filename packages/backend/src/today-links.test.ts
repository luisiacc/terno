/** Plan 210 (iteration 2, B7): which items are one thing, conservatively, and which is a detail of another. */
import type { DatedKind, DatedRow, FollowupRow } from "@terno/core";
import { describe, expect, it } from "vitest";
import { findLinks, isDetailOf, sameErrand, sameEvent, samePromise, sameRequest } from "./today-links";

const T = Date.UTC(2026, 10, 20, 0, 30);
let n = 0;
const dated = (kind: DatedKind, text: string, more: Partial<DatedRow> = {}): DatedRow =>
  ({ id: ++n, threadId: 1, messageId: n, item: 0, kind, text, quote: text, senderKey: "a@x.test", dueDay: "2026-11-20", dueAt: T, timed: true, dated: true, actAt: 0, deferredUntil: null, arrivedAt: 0, state: "open", closedReason: null, closedAt: null, fromScan: false, revision: 0, model: null, provider: null, createdAt: n, sameAs: null, detailOf: null, ...more }) as DatedRow;
const promise = (text: string, more: Partial<FollowupRow> = {}): FollowupRow =>
  ({ id: ++n, threadId: 1, messageId: n, rfcMessageId: null, item: 0, kind: "promise", text, quote: text, personName: null, personEmail: null, sentAt: 0, dueAt: T, dated: true, deferredUntil: null, state: "open", inboxState: "none", closedReason: null, closedAt: null, notifiedAt: null, fromScan: false, revision: 0, model: null, provider: null, createdAt: n, sameAs: null, ...more }) as FollowupRow;

describe("one thing, read twice", () => {
  it("an event: the same moment and place from two messages; never a person, a noun or a moment alone", () => {
    const restaurant = dated("event", "Dinner reservation at Nopa", { threadId: 1 });
    expect(sameEvent(restaurant, dated("event", "Dinner with Jess at Nopa", { threadId: 2 }))).toBe(true);
    expect(sameEvent(restaurant, dated("event", "Dinner reservation at Nopa", { threadId: 2 }))).toBe(true);
    // a shared person, a shared noun, the same moment elsewhere: two
    expect(sameEvent(dated("event", "Call with Jess"), dated("event", "Lunch with Jess"))).toBe(false);
    expect(sameEvent(restaurant, dated("event", "Dinner with the team at Zuni"))).toBe(false);
    expect(sameEvent(restaurant, dated("event", "Dinner at Nopa", { dueAt: T + 3_600_000 }))).toBe(false);
    // one message's own two items are what the reader found in it
    expect(sameEvent(restaurant, { ...dated("event", "Dinner at Nopa"), messageId: restaurant.messageId })).toBe(false);
  });

  it("an errand: a bill or request and your promise in one conversation, by amount or object", () => {
    expect(sameErrand(dated("pay", "Pay $12 for the bus"), promise("send the signed slip and $12"))).toBe(true);
    // what they asked for and what you promised name the same object (`sameObject`: one's naming words all the other's)
    expect(sameErrand(dated("respond", "Send the revised budget"), promise("send the budget"))).toBe(true);
    expect(sameErrand(dated("respond", "Sign the vendor contract"), promise("sign the employment contract"))).toBe(false);
    // a bill and a promise share no object by words alone: only by amount
    expect(sameErrand(dated("pay", "Pay the bus fee"), promise("pay the bus fee"))).toBe(false);
    expect(sameErrand(dated("pay", "Pay $12 for the bus"), promise("send the signed slip and $12", { threadId: 2 }))).toBe(false);
    expect(sameErrand(dated("pay", "Pay $54.20 for electricity"), promise("send the slip and $12"))).toBe(false);
  });

  it("a request asked again in the conversation is one; two different requests of one person are two", () => {
    const draft = dated("respond", "Send Jess your draft", { quote: "send me your draft by Friday", threadId: 4 });
    expect(sameRequest(draft, dated("respond", "Send Jess your draft", { quote: "your draft by Saturday", threadId: 4 }))).toBe(true);
    expect(sameRequest(draft, dated("ask", "Answer Jess about the budget", { quote: "can you tell me the budget", threadId: 4 }))).toBe(false);
    expect(sameRequest(draft, dated("respond", "Send Jess your draft", { quote: "your draft by Saturday", threadId: 5 }))).toBe(false);
    expect(sameRequest(draft, dated("respond", "Send Jess your draft", { quote: "your draft by Saturday", threadId: 4, senderKey: "else@x.test" }))).toBe(false);
  });

  it("a promise read as two from one sentence of yours, with an object in common; two things in one sentence stay two", () => {
    const quote = "I'll scan both papers and email them to you Monday";
    const a = promise("scan both papers", { quote });
    expect(samePromise(a, { ...promise("email both papers", { quote }), messageId: a.messageId })).toBe(true);
    const deck = promise("send the deck", { quote: "I'll send the deck and sign the vendor form Friday" });
    expect(samePromise(deck, { ...promise("sign the vendor form", { quote: deck.quote }), messageId: deck.messageId })).toBe(false);
  });

  it("a return leg is its outbound flight's detail; a keynote and a tech check from one mail aren't", () => {
    const out = dated("event", "Flight to Austin", { messageId: 500, dueDay: "2026-11-20" });
    const back = dated("event", "Return flight to Madrid", { messageId: 500, dueDay: "2026-11-24" });
    expect(isDetailOf(back, out)).toBe(true);
    expect(isDetailOf(out, back)).toBe(false);
    const check = dated("event", "Tech check", { messageId: 600, dueDay: "2026-11-20" });
    expect(isDetailOf(dated("event", "Keynote", { messageId: 600, dueDay: "2026-11-21" }), check)).toBe(false);
  });
});

describe("findLinks", () => {
  it("the newer joins the older's canonical, never forms a chain, and only what's new since the last look is matched", () => {
    const a = dated("event", "Dinner at Nopa", { threadId: 1 });
    const b = dated("event", "Dinner with Jess at Nopa", { threadId: 2 });
    const links = findLinks([a, b], [], { dated: 0, promise: 0 });
    expect(links.same).toEqual([{ item: { source: "dated", id: b.id }, sameAs: `dated:${a.id}` }]);
    // a third read of it joins the canonical, not its member
    const c = dated("event", "Nopa dinner, party of 4 at Nopa", { threadId: 3 });
    expect(findLinks([a, { ...b, sameAs: `dated:${a.id}` }, c], [], { dated: b.id, promise: 0 }).same).toEqual([{ item: { source: "dated", id: c.id }, sameAs: `dated:${a.id}` }]);
    // nothing new: nothing looked at
    expect(findLinks([a, b], [], { dated: b.id, promise: 0 }).same).toEqual([]);
  });

  it("a bill and a later promise: the promise joins the bill; a promise before the bill: the bill joins the promise", () => {
    const bill = dated("pay", "Pay $12 for the bus");
    const mine = promise("send the slip and $12");
    expect(findLinks([bill], [mine], { dated: 0, promise: 0 }).same).toEqual([{ item: { source: "promise", id: mine.id }, sameAs: `dated:${bill.id}` }]);
    const early = promise("send the slip and $15");
    const later = dated("pay", "Pay $15 for the museum");
    expect(findLinks([later], [early], { dated: 0, promise: 0 }).same).toEqual([{ item: { source: "dated", id: later.id }, sameAs: `promise:${early.id}` }]);
  });

  it("a trip's return leg is linked as a detail", () => {
    const out = dated("event", "Flight to Austin", { messageId: 900, dueDay: "2026-11-20" });
    const back = dated("event", "Return flight", { messageId: 900, dueDay: "2026-11-24", dueAt: T + 4 * 86_400_000 });
    expect(findLinks([out, back], [], { dated: 0, promise: 0 }).details).toEqual([{ id: back.id, detailOf: out.id }]);
  });
});
