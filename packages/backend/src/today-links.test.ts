/** Plan 210 (iteration 2, B7): which items are one thing, conservatively, and which is a detail of another. */
import type { DatedKind, DatedRow, FollowupRow } from "@terno/core";
import { describe, expect, it } from "vitest";
import { attendsEvent, findLinks, isDetailOf, sameErrand, sameEvent, samePromise, sameRequest, TodayLinks } from "./today-links";
import type { MailStore } from "@terno/store";

const T = Date.UTC(2026, 10, 20, 0, 30);
/** every item not looked at yet; or only dated items past an id */
const all = () => true;
const after = (id: number) => (key: string) => !key.startsWith("dated:") || Number(key.slice(6)) > id;
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
    expect(sameErrand(dated("pay", "Pay $12 for the bus"), promise("send the signed slip and $12", { quote: "I'll send the signed slip and $12 for the bus" }))).toBe(true);
    // Codex code review: an amount alone isn't one errand
    expect(sameErrand(dated("pay", "Pay $12 for the bus"), promise("send $12 for the museum"))).toBe(false);
    // round 2: nor through Spanish small words ("para", "el")
    expect(sameErrand(dated("pay", "Pagar $12 para el autobús"), promise("enviar $12 para el museo"))).toBe(false);
    expect(sameErrand(dated("pay", "Pagar $12 para el autobús"), promise("mandar el permiso y $12 para el autobús"))).toBe(true);
    // nor one request for November and one for December
    expect(sameErrand(dated("respond", "Send the November payroll report"), promise("send the December payroll report"))).toBe(false);
    // what they asked for and what you promised name the same object (`sameObject`: one's naming words all the other's)
    expect(sameErrand(dated("respond", "Send the revised budget"), promise("send the budget"))).toBe(true);
    expect(sameErrand(dated("respond", "Sign the vendor contract"), promise("sign the employment contract"))).toBe(false);
    // a bill and a promise share no object by words alone: only by amount
    expect(sameErrand(dated("pay", "Pay the bus fee"), promise("pay the bus fee"))).toBe(false);
    expect(sameErrand(dated("pay", "Pay $12 for the bus"), promise("send the signed slip and $12 for the bus", { threadId: 2 }))).toBe(false);
    expect(sameErrand(dated("pay", "Pay $54.20 for electricity"), promise("send the slip and $12"))).toBe(false);
    // plan 210 (iteration 3): a promise its reply linked to a request is that request's by the link, never merged by words
    expect(sameErrand(dated("respond", "Send the revised budget"), promise("send the budget", { answers: 77 }))).toBe(false);
    expect(sameErrand(dated("pay", "Pay $12 for the bus"), promise("send the signed slip and $12", { quote: "I'll send the signed slip and $12 for the bus", answers: 77 }))).toBe(true);
  });

  it("a request asked again in the conversation is one; two different requests of one person are two", () => {
    const draft = dated("respond", "Send Jess your draft", { quote: "send me your draft by Friday", threadId: 4 });
    expect(sameRequest(draft, dated("respond", "Send Jess your draft", { quote: "your draft by Saturday", threadId: 4 }))).toBe(true);
    expect(sameRequest(draft, dated("ask", "Answer Jess about the budget", { quote: "can you tell me the budget", threadId: 4 }))).toBe(false);
    expect(sameRequest(draft, dated("respond", "Send Jess your draft", { quote: "your draft by Saturday", threadId: 5 }))).toBe(false);
    expect(sameRequest(draft, dated("respond", "Send Jess your draft", { quote: "your draft by Saturday", threadId: 4, senderKey: "else@x.test" }))).toBe(false);
    // Codex code review: a recurring request for another period is another request
    const nov = dated("respond", "Send the November payroll report", { quote: "send the November payroll report", threadId: 6 });
    expect(sameRequest(nov, dated("respond", "Send the December payroll report", { quote: "send the December payroll report", threadId: 6 }))).toBe(false);
    // round 2: dates and numeric months whole, never their first three characters
    const iso = dated("respond", "Send the 2026-11 payroll report", { quote: "send the 2026-11 payroll report", threadId: 6 });
    expect(sameRequest(iso, dated("respond", "Send the 2026-12 payroll report", { quote: "send the 2026-12 payroll report", threadId: 6 }))).toBe(false);
    expect(sameRequest(iso, dated("respond", "Send the 2026-11 payroll report", { quote: "the 2026-11 payroll report, please", threadId: 6 }))).toBe(true);
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
    const links = findLinks([a, b], [], all);
    expect(links.same).toEqual([{ item: { source: "dated", id: b.id }, sameAs: `dated:${a.id}` }]);
    // a third read of it joins the canonical, not its member
    const c = dated("event", "Nopa dinner, party of 4 at Nopa", { threadId: 3 });
    expect(findLinks([a, { ...b, sameAs: `dated:${a.id}` }, c], [], after(b.id)).same).toEqual([{ item: { source: "dated", id: c.id }, sameAs: `dated:${a.id}` }]);
    // nothing new: nothing looked at
    expect(findLinks([a, b], [], after(b.id)).same).toEqual([]);
  });

  it("plan 210 (iteration 4, revision 11): an ask that confirms an event is never one item with another request or a promise", () => {
    const cleaning = dated("event", "Sofia's cleaning", { threadId: 8, senderKey: "dental@x.test" });
    const confirm = dated("ask", "Reply C to confirm Sofia's cleaning", { threadId: 8, senderKey: "dental@x.test", quote: "Reply C to confirm", dated: false, confirms: cleaning.id });
    const again = dated("ask", "Reply C to confirm Sofia's cleaning", { threadId: 8, senderKey: "dental@x.test", quote: "Reply C to confirm", dated: false });
    const mine = promise("confirm Sofia's cleaning", { threadId: 8 });
    expect(findLinks([cleaning, confirm, again], [mine], all).same.filter((l) => l.item.id === confirm.id || l.sameAs === `dated:${confirm.id}`)).toEqual([]);
    // without the link, the two asks are one (as before)
    expect(findLinks([cleaning, { ...confirm, confirms: null }, again], [], all).same).toEqual([{ item: { source: "dated", id: again.id }, sameAs: `dated:${confirm.id}` }]);
  });

  it("a bill and a later promise: the promise joins the bill; a promise before the bill: the bill joins the promise", () => {
    const bill = dated("pay", "Pay $12 for the bus");
    const mine = promise("send the slip and $12 for the bus");
    expect(findLinks([bill], [mine], all).same).toEqual([{ item: { source: "promise", id: mine.id }, sameAs: `dated:${bill.id}` }]);
    const early = promise("send the slip and $15 for the museum");
    const later = dated("pay", "Pay $15 for the museum");
    expect(findLinks([later], [early], all).same).toEqual([{ item: { source: "dated", id: later.id }, sameAs: `promise:${early.id}` }]);
  });

  it("plan 210 (iteration 3): your promise to attend is the event it names, its day and conversation; the event leads, whichever came first", () => {
    const local = (h: number, m = 0) => new Date(2026, 10, 16, h, m).getTime();
    const check = dated("event", "Shipfast Summit tech check", { threadId: 15, messageId: 17, dueDay: "2026-11-16", dueAt: local(16) });
    const keynote = dated("event", "Shipfast Summit keynote", { threadId: 15, messageId: 17, dueDay: "2026-11-16", dueAt: local(19) });
    const attend = promise("attend the tech check", { threadId: 15, dueAt: local(9), quote: "I'll be there for the tech check" });
    expect(attendsEvent(attend, [check, keynote])).toBe(check);
    expect(findLinks([check, keynote], [attend], all).same).toEqual([{ item: { source: "promise", id: attend.id }, sameAs: `dated:${check.id}` }]);
    // the promise first, the event read later: the event still leads
    const later = dated("event", "Shipfast Summit tech check", { threadId: 15, messageId: 99, dueDay: "2026-11-16", dueAt: local(16), createdAt: attend.createdAt + 10 });
    expect(findLinks([later], [attend], all).same).toEqual([{ item: { source: "promise", id: attend.id }, sameAs: `dated:${later.id}` }]);
    // never that evening's keynote by the day alone, nor an event of another day or conversation
    expect(attendsEvent(promise("I'll be there for the tech check", { threadId: 15, dueAt: local(9) }), [keynote])).toBeNull();
    expect(attendsEvent({ ...attend, dueAt: new Date(2026, 10, 17, 9).getTime() }, [check])).toBeNull();
    expect(attendsEvent({ ...attend, threadId: 16 }, [check])).toBeNull();
    // a promise that isn't to attend is no part of the event
    expect(attendsEvent(promise("send the tech check notes", { threadId: 15, dueAt: local(9) }), [check])).toBeNull();
    // (Codex code review) a deliverable quoted from a sentence that also says you'll attend is its own, and so is one the
    // promise's words carry beside attending: Done on the event, or its day passing, never finishes them
    const slides = promise("send the slides for the tech check", { threadId: 15, dueAt: local(9), quote: "I'll attend the tech check and send its slides tonight" });
    expect(attendsEvent(slides, [check])).toBeNull();
    expect(findLinks([check], [slides], all).same).toEqual([]);
    expect(attendsEvent(promise("attend the tech check and send its slides", { threadId: 15, dueAt: local(9) }), [check])).toBeNull();
    // both events named: the promise's own time picks one; none, neither
    const both = promise("attend the Shipfast Summit", { threadId: 15, dueAt: local(19), timed: true });
    expect(attendsEvent(both, [check, keynote])).toBe(keynote);
    expect(attendsEvent({ ...both, timed: false }, [check, keynote])).toBeNull();
    // in Spanish
    const partido = dated("event", "Partido de fútbol de Sofía", { threadId: 20, dueDay: "2026-11-16", dueAt: local(10) });
    expect(attendsEvent(promise("ir al partido de Sofía", { threadId: 20, dueAt: local(9) }), [partido])).toBe(partido);
    expect(attendsEvent(promise("enviar las fotos del partido de Sofía", { threadId: 20, dueAt: local(9) }), [partido])).toBeNull();
    expect(attendsEvent(promise("asistir al partido de Sofía", { threadId: 20, dueAt: local(9) }), [partido])).toBe(partido);
    expect(attendsEvent(promise("ir al partido de Sofía y mandar las fotos", { threadId: 20, dueAt: local(9) }), [partido])).toBeNull();
  });

  it("plan 210 (iteration 4): who comes with you to an event, or what you'll bring to it, is the event's, with a day or none; never what you'll send besides", () => {
    const local = (h: number, d = 17) => new Date(2026, 10, d, h).getTime();
    // Jordan: "confirmed, thank you. I'll bring our CSM, Nina, and our solutions engineer for the Memphis conversation"
    const qbr = dated("event", "Q4 business review with Halvorsen Logistics", { threadId: 16, messageId: 21, dueDay: "2026-11-17", dueAt: local(14) });
    const bring = promise("bring your CSM Nina and your solutions engineer for the Memphis conversation", { threadId: 16, messageId: 22, dated: false, dueAt: local(9, 9) });
    // the words after "for" name no event: the conversation's only one
    expect(attendsEvent(bring, [qbr])).toBe(qbr);
    expect(findLinks([qbr], [bring], all).same).toEqual([{ item: { source: "promise", id: bring.id }, sameAs: `dated:${qbr.id}` }]);
    // the reply's other promise is its own: the agenda isn't brought, it's sent
    const agenda = promise("send Grace the agenda", { threadId: 16, messageId: 22, item: 1, dueAt: local(9, 13) });
    expect(attendsEvent(agenda, [qbr])).toBeNull();
    expect(findLinks([qbr], [bring, agenda], all).same.map((l) => l.item.id)).toEqual([bring.id]);
    // two events in the conversation: only the one its words name, else neither
    const dinner = dated("event", "Team dinner after the review", { threadId: 16, messageId: 21, item: 1, dueDay: "2026-11-17", dueAt: local(19) });
    expect(attendsEvent(bring, [qbr, dinner])).toBeNull();
    expect(attendsEvent(promise("bring the printed deck to the Halvorsen meeting", { threadId: 16, dated: false }), [qbr, dinner])).toBe(qbr);
    // with a day: that day's event; what it hands over besides is its own
    expect(attendsEvent(promise("bring snacks for the game", { threadId: 16, dueAt: local(9) }), [qbr])).toBe(qbr);
    expect(attendsEvent(promise("bring snacks for the game", { threadId: 16, dueAt: local(9, 18) }), [qbr])).toBeNull();
    expect(attendsEvent(promise("bring the deck to the review and send the notes after", { threadId: 16, dated: false }), [qbr])).toBeNull();
    // another conversation's event, never; nor a bring with no event it's for
    expect(attendsEvent({ ...bring, threadId: 17 }, [qbr])).toBeNull();
    expect(attendsEvent(promise("bring the signed lease", { threadId: 16, dated: false }), [qbr])).toBeNull();
    // in Spanish
    const partido = dated("event", "Partido de fútbol de Sofía", { threadId: 20, dueDay: "2026-11-16", dueAt: local(10, 16) });
    expect(attendsEvent(promise("llevar los bocadillos para el partido", { threadId: 20, dated: false }), [partido])).toBe(partido);
    // an undated promise to attend, by the event's words, among the conversation's events
    expect(attendsEvent(promise("attend the Halvorsen meeting", { threadId: 16, dated: false }), [qbr, dinner])).toBe(qbr);
    expect(attendsEvent(promise("be there", { threadId: 16, dated: false }), [qbr])).toBeNull();
  });

  it("plan 210 (iteration 3, the code review's second round): your reply read as two promises of one thing, one answering a request; neither brings the request back into their item", () => {
    const sentence = "I'll scan both papers and email them to you Monday";
    const request = dated("respond", "Scan and email both papers", { threadId: 30, quote: "scan and email both papers", createdAt: 200 });
    const scan = promise("scan both papers", { threadId: 30, messageId: 500, quote: "I'll scan both papers", createdAt: 100 });
    const email = promise("email both papers", { threadId: 30, messageId: 500, quote: sentence, createdAt: 100, answers: request.id });
    // by their words, the request and the reading that doesn't carry the link are one errand
    expect([samePromise(scan, email), sameErrand(request, scan)]).toEqual([true, true]);
    // as a start reads them: the twins one item, the request its own
    expect(findLinks([request], [scan, email], all).same).toEqual([{ item: { source: "promise", id: email.id }, sameAs: `promise:${scan.id}` }]);
    // the request still in the twin's item (stored before its verdict): the answering reading never joins it
    expect(findLinks([{ ...request, sameAs: `promise:${scan.id}` }], [scan, email], all).same).toEqual([]);
    // nor does the request join the answering reading's item
    expect(findLinks([request], [scan, { ...email, sameAs: `promise:${scan.id}` }], all).same).toEqual([]);
    // a promise of that reply that's something else is matched as before
    const budget = promise("send the budget", { threadId: 30, messageId: 500, quote: "I'll send the budget", createdAt: 100 });
    expect(findLinks([dated("respond", "Send the revised budget", { threadId: 30, createdAt: 200 })], [budget, email], all).same).toHaveLength(1);
  });

  it("a trip's return leg is linked as a detail", () => {
    const out = dated("event", "Flight to Austin", { messageId: 900, dueDay: "2026-11-20" });
    const back = dated("event", "Return flight", { messageId: 900, dueDay: "2026-11-24", dueAt: T + 4 * 86_400_000 });
    expect(findLinks([out, back], [], all).details).toEqual([{ id: back.id, detailOf: out.id }]);
  });
});

describe("plan 210 (iteration 2, Codex code review): what the matcher looks at, and when", () => {
  it("a link found in the same pass is counted at once: what joins an item that just joined another joins its canonical, never a chain", () => {
    // the request asked twice (the newer one first in the open set, as the store orders them) and your promise of it
    const first = dated("respond", "Send the budget", { quote: "send the budget by Friday", threadId: 9, createdAt: 1 });
    const again = dated("respond", "Send the budget", { quote: "the budget, by Saturday then", threadId: 9, createdAt: 2 });
    const mine = promise("send the budget", { threadId: 9, createdAt: 3 });
    const links = findLinks([again, first], [mine], all).same;
    expect(links).toEqual([
      { item: { source: "dated", id: again.id }, sameAs: `dated:${first.id}` },
      { item: { source: "promise", id: mine.id }, sameAs: `dated:${first.id}` },
    ]);
  });

  it("an item moved to another conversation (a merge of two) is looked at again; one looked at in its conversation isn't", async () => {
    const written: unknown[] = [];
    const store = { today: { link: async (l: unknown) => (written.push(l), 1) } } as unknown as MailStore;
    const links = new TodayLinks();
    const ask = dated("respond", "Send the budget", { threadId: 1, createdAt: 1 });
    const mine = promise("send the budget", { threadId: 2, createdAt: 2 });
    expect(await links.reconcile(store, [ask], [mine])).toBe(false);
    expect(await links.reconcile(store, [ask], [mine])).toBe(false);
    expect(written).toEqual([]);
    // the two conversations merged: both now on conversation 1
    expect(await links.reconcile(store, [ask], [{ ...mine, threadId: 1 }])).toBe(true);
    expect(written).toEqual([{ same: [{ item: { source: "promise", id: mine.id }, sameAs: `dated:${ask.id}` }], details: [] }]);
  });

  it("round 2: a read beside one that linked is told by the version, even though its own look finds nothing new", async () => {
    let n = 0;
    const store = { today: { link: async () => (n++, 1) } } as unknown as MailStore;
    const links = new TodayLinks();
    const a = dated("event", "Dinner at Nopa", { threadId: 1, createdAt: 1 });
    const b = dated("event", "Dinner with Jess at Nopa", { threadId: 2, createdAt: 2 });
    const version = links.version;
    const [first, second] = await Promise.all([links.reconcile(store, [a, b], []), links.reconcile(store, [a, b], [])]);
    expect([first, second, n]).toEqual([true, false, 1]);
    expect(links.version).not.toBe(version);
  });

  it("an act resolving a row's members runs alone: a reconcile waits for it", async () => {
    const order: string[] = [];
    const store = { today: { link: async () => (order.push("link"), 1) } } as unknown as MailStore;
    const links = new TodayLinks();
    let release!: () => void;
    const acting = links.exclusive(async () => {
      order.push("act starts");
      await new Promise<void>((r) => (release = r));
      order.push("act writes");
    });
    const a = dated("event", "Dinner at Nopa", { threadId: 1, createdAt: 1 });
    const b = dated("event", "Dinner with Jess at Nopa", { threadId: 2, createdAt: 2 });
    const reconciling = links.reconcile(store, [a, b], []);
    await Promise.resolve();
    release();
    await Promise.all([acting, reconciling]);
    expect(order).toEqual(["act starts", "act writes", "link"]);
  });
});
