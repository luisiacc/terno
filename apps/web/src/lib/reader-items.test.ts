// @vitest-environment jsdom
import type { DatedRow, FollowupRow, ItemRef } from "@terno/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: () => () => {}, connectionVersion: 1 } }));
vi.mock("~/lib/open-dwell", () => ({ onExplicitOpen: () => {}, noteExplicitOpen: () => {} }));

const { readerItems, readerLine, repeatsItem } = await import("./reader-items");
const { setLocale } = await import("@terno/i18n");
const en = (await import("@terno/i18n/locales/en")).default;

afterEach(() => setLocale("en", en as never));

/** Thursday 22 October 2026, 4:00 PM local. */
const NOW = new Date(2026, 9, 22, 16, 0).getTime();
const at = (d: number, h = 9) => new Date(2026, 9, d, h, 0).getTime();

/** Jess's conversation: her draft by Saturday and the board meeting on the 24th, read from one mail. */
const dated = (o: Partial<DatedRow> & Pick<DatedRow, "id" | "text">): DatedRow =>
  ({ threadId: 7, messageId: 3, item: 0, kind: "respond", quote: "", senderKey: "jess@board.test", dueDay: "2026-10-24", dueAt: at(24), timed: false, dated: true, actAt: NOW - 1, deferredUntil: null, arrivedAt: NOW - 1, state: "open", closedReason: null, closedAt: null, fromScan: false, revision: 1, model: null, provider: null, createdAt: NOW - 1, ...o }) as DatedRow;
const promise = (o: Partial<FollowupRow> & Pick<FollowupRow, "id" | "text">): FollowupRow =>
  ({ threadId: 7, messageId: 4, rfcMessageId: null, item: 0, kind: "promise", quote: null, personName: "Jess Okafor", personEmail: "jess@board.test", sentAt: NOW - 1, dueAt: at(22), dated: true, deferredUntil: null, state: "open", inboxState: "seen", closedReason: null, closedAt: null, notifiedAt: null, fromScan: false, revision: 1, model: null, provider: null, createdAt: NOW - 1, ...o }) as FollowupRow;

const draft = dated({ id: 1, text: "Send Jess your draft" });
const board = dated({ id: 2, kind: "event", text: "Board meeting", dueAt: at(24, 8), timed: true });
const script = promise({ id: 9, text: "send Jess the script" });
const nudge = promise({ id: 10, kind: "awaiting", text: "" });
const read = (o: { target?: ItemRef[]; chosen?: string | null; dated?: DatedRow[]; followups?: FollowupRow[] } = {}) =>
  readerItems({ dated: o.dated ?? [draft, board], followups: o.followups ?? [], target: o.target ?? [], chosen: o.chosen ?? null, now: NOW });
const keys = (r: ReturnType<typeof read>) => [r.top?.key, ...r.others.map((o) => o.key)];

describe("the reader's one line (plan 210, iteration 3, Codex revision 10)", () => {
  it("the open row's item leads, whichever row opened the conversation; the other is the line under it", () => {
    expect(keys(read({ target: [{ source: "dated", id: 1 }] }))).toEqual(["dated:1", "dated:2"]);
    expect(keys(read({ target: [{ source: "dated", id: 2 }] }))).toEqual(["dated:2", "dated:1"]);
    expect(read({ target: [{ source: "dated", id: 2 }] }).targeted).toBe(true);
  });

  it("with no row of the feed open (another mailbox), the soonest leads, Missed first", () => {
    // the meeting at 8:00 before the draft's day (9:00)
    expect(keys(read())).toEqual(["dated:2", "dated:1"]);
    expect(read().targeted).toBe(false);
    const late = dated({ id: 3, kind: "pay", text: "Pay the deposit", dueDay: "2026-10-20", dueAt: at(20) });
    expect(keys(read({ dated: [draft, board, late] }))).toEqual(["dated:3", "dated:2", "dated:1"]);
    expect(read({ dated: [draft, board, late] }).top?.missed).toBe(true);
  });

  it("a dated item and a promise of yours in one design and one order; a nudge is never an item", () => {
    const r = read({ followups: [script, nudge], target: [{ source: "promise", id: 9 }] });
    expect(keys(r)).toEqual(["promise:9", "dated:2", "dated:1"]);
    expect(r.top?.source).toBe("promise");
    expect(readerLine(r.top!, NOW)).toBe("Due today · You told Jess you’d send the script");
    expect(readerLine(r.others[0]!, NOW)).toBe("Saturday 8:00 AM · Board meeting");
  });

  it("an item chosen from the line under it leads, while the feed's open row is the same; one gone, the row's leads again", () => {
    const target = [{ source: "dated" as const, id: 1 }];
    expect(keys(read({ target, chosen: "dated:2" }))).toEqual(["dated:2", "dated:1"]);
    expect(read({ target, chosen: "dated:2" }).targeted).toBe(false);
    // done meanwhile (a read without it): the open row's item, not nothing
    expect(keys(read({ target, chosen: "dated:2", dated: [draft] }))).toEqual(["dated:1"]);
  });

  it("a merged row's members are one line, its lead's words; a true duplicate outside the row is one line too", () => {
    const owed = promise({ id: 9, text: "send the slip and $12", sameAs: "dated:1" });
    const merged = read({ followups: [owed], target: [{ source: "dated", id: 1 }, { source: "promise", id: 9 }] });
    expect(keys(merged)).toEqual(["dated:1", "dated:2"]);
    expect(keys(read({ followups: [owed] }))).toEqual(["dated:2", "dated:1"]);
  });

  it("a history line's closed item leads, saying it's closed; the open ones are under it; closed ones never otherwise", () => {
    const done = dated({ id: 5, text: "Pay the electricity bill", state: "done", closedAt: at(21) });
    const r = read({ dated: [draft, board, done], target: [{ source: "dated", id: 5 }] });
    expect(keys(r)).toEqual(["dated:5", "dated:2", "dated:1"]);
    expect(r.top?.open).toBe(false);
    expect(readerLine(r.top!, NOW)).toBe("Pay the electricity bill");
    expect(keys(read({ dated: [draft, board, done] }))).toEqual(["dated:2", "dated:1"]);
    const kept = promise({ id: 9, text: "send the script", state: "done", closedAt: at(21) });
    expect(keys(read({ followups: [kept] }))).toEqual(["dated:2", "dated:1"]);
    expect(read({ followups: [kept], target: [{ source: "promise", id: 9 }] }).top?.key).toBe("promise:9");
  });

  it("plan 210 (iteration 4): a request an open promise answers is never a line of its own, the feed's rule; closed, or the matcher's one item, it is", () => {
    // Theo: "You told Jess you'd send the script" answers Jess's "send the Railyard script for review"
    const answering = promise({ id: 9, text: "send Jess the script", answers: 1 });
    const r = read({ followups: [answering], target: [{ source: "promise", id: 9 }] });
    expect(keys(r)).toEqual(["promise:9", "dated:2"]);
    // its reading asked again (one item with it) goes too
    const again = dated({ id: 3, text: "Send Jess your draft, please", sameAs: "dated:1" });
    expect(keys(read({ dated: [draft, board, again], followups: [answering], target: [{ source: "promise", id: 9 }] }))).toEqual(["promise:9", "dated:2"]);
    // the promise kept or removed: the request is its own line again
    expect(keys(read({ followups: [{ ...answering, state: "done", closedAt: at(21) }] }))).toEqual(["dated:2", "dated:1"]);
    // the matcher made them one item: that item's line, once
    const merged = promise({ id: 9, text: "send Jess the script", answers: 1, sameAs: "dated:1" });
    expect(keys(read({ followups: [merged], target: [{ source: "dated", id: 1 }, { source: "promise", id: 9 }] }))).toEqual(["dated:1", "dated:2"]);
    // a history line of the request itself still leads when it's what the feed opened
    expect(read({ followups: [answering], target: [{ source: "dated", id: 1 }] }).top?.key).toBe("dated:1");
  });

  it("iteration 4, merge: a promise's line says the days its feed row says: broken with a live day ahead (never Missed), or the day the request it answers is needed", () => {
    // Jess moved it to Sunday after Tuesday the 20th went by: "You said Tue 20 (missed) · needed Sun", as the row's column
    const broken = promise({ id: 9, text: "send Jess the script", dueAt: at(25), brokenDueAt: at(20) });
    const r = read({ dated: [], followups: [broken] });
    expect(r.top).toMatchObject({ key: "promise:9", missed: false, dueAt: at(25) });
    expect(readerLine(r.top!, NOW)).toBe("You said Tue 20 (missed) ·\u00a0needed Sun · You told Jess you’d send the script");
    // it said Wednesday (over), the request it answers needs it Saturday: under Saturday, not Missed
    const late = promise({ id: 9, text: "send Jess the script", dueAt: at(21), answers: 1 });
    const answered = read({ dated: [draft], followups: [late] });
    expect(answered.top).toMatchObject({ key: "promise:9", missed: false, dueAt: at(24) });
    expect(readerLine(answered.top!, NOW)).toBe("You said yesterday (missed) ·\u00a0needed Sat · You told Jess you’d send the script");
    // its own day ahead, the request's later: its own day, and the request's beside it
    expect(readerLine(read({ dated: [draft], followups: [{ ...late, dueAt: at(23) }] }).top!, NOW)).toBe("Due tomorrow ·\u00a0needed Sat · You told Jess you’d send the script");
  });

  it("plan 210 (iteration 5): a promise for this morning is missed in the reader once noon has passed, its line saying the part", () => {
    // NOW is 4:00 PM on the 22nd: its morning is over
    const cupcakes = promise({ id: 9, text: "bring Jess the cupcakes", dueAt: at(22), partOfDay: "morning" });
    const r = read({ dated: [], followups: [cupcakes] });
    expect(r.top).toMatchObject({ key: "promise:9", missed: true });
    expect(readerLine(r.top!, NOW)).toBe("Was due this morning · You told Jess you’d bring the cupcakes");
    // the whole day: still today's
    expect(read({ dated: [], followups: [{ ...cupcakes, partOfDay: null }] }).top).toMatchObject({ missed: false });
    // its morning tomorrow, the request it answers Saturday morning
    const ahead = promise({ id: 9, text: "send Jess the script", dueAt: at(23), partOfDay: "morning", answers: 1 });
    expect(readerLine(read({ dated: [{ ...draft, partOfDay: "morning" }], followups: [ahead] }).top!, NOW)).toBe("Due tomorrow morning · needed Sat morning · You told Jess you’d send the script");
  });

  it("the open row's item not read yet (its answer on its way) leaves the soonest on top, never nothing", () => {
    expect(keys(read({ target: [{ source: "dated", id: 99 }] }))).toEqual(["dated:2", "dated:1"]);
    expect(read({ dated: [], followups: [] }).top).toBeNull();
  });

  it("plan 210 (iteration 4): a reply's row targets its lead's item only, so its other promises stay lines of their own, each acted on alone", () => {
    // one reply to Jess: the script Thursday, and an undated promise the row says as its Also
    const deck = promise({ id: 11, item: 1, text: "send Jess the deck notes", dated: false, dueAt: at(27) });
    const r = read({ dated: [], followups: [script, deck], target: [{ source: "promise", id: 9 }] });
    expect(keys(r)).toEqual(["promise:9", "promise:11"]);
    expect(r.targeted).toBe(true);
    // a promise that only holds a request is the request's: never a line of its own
    const hold = promise({ id: 12, item: 2, text: "check your calendar and get back to Jess", dated: false, holds: 1 });
    expect(keys(read({ followups: [hold] }))).toEqual(["dated:2", "dated:1"]);
  });
});

describe("the summary's To do, less what the line says (Codex revision 10)", () => {
  it("an item it repeats goes; one it doesn't stays", () => {
    expect(repeatsItem("Send the script; a rough draft is acceptable, by Friday 13 November", ["send the script"])).toBe(true);
    expect(repeatsItem("Send Ingrid the full draft of Chapter 2 by Monday", ["Send Ingrid the full draft of Chapter 2"])).toBe(true);
    expect(repeatsItem("Sending the scripts by Friday", ["send the script"])).toBe(true);
    expect(repeatsItem("Book the venue for the offsite", ["send the script", "Board meeting"])).toBe(false);
    // one word in common isn't the same thing
    expect(repeatsItem("Send the invoice", ["send the script"])).toBe(false);
    expect(repeatsItem("Enviar el guion antes del viernes", ["enviar el guion"])).toBe(true);
    // who is often left out of a summary: a name needn't be there
    expect(repeatsItem("Send the script; a rough draft is acceptable, by Friday 13 November", ["send Jess the script"])).toBe(true);
    expect(repeatsItem("Send the full draft by Monday", ["Send Ingrid the full draft of Chapter 2"])).toBe(true);
    // but a name is all that tells two errands apart, it counts
    expect(repeatsItem("Pay Pingwire", ["Pay Stratus"])).toBe(false);
  });
});
