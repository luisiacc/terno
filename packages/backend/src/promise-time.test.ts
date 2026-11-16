/** Plan 210 (iteration 2, A7): a promise's moment is a time its words state, in the reader's zone; never a made-up one. */
import { describe, expect, it } from "vitest";
import { checkSentMail } from "./followups";
import { promiseMoment, readerZone } from "./promise-time";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const SENT = at(2026, 11, 16, 10);
const morning = { dueAt: at(2026, 11, 20, 9), dated: true };
const moment = (text: string, quote: string, day: string | null, fallback = morning, part: "morning" | "afternoon" | "evening" | null = null) => promiseMoment({ text, quote, day, part }, fallback, SENT);

describe("promiseMoment", () => {
  it("its words' clock on its day, in the reader's own zone, when the quote states one", () => {
    expect(moment("call Marcus at 4:00 PM", "I'll call you at 4 on Friday", "2026-11-20")).toEqual({ dueAt: at(2026, 11, 20, 16), timed: true, text: "call Marcus at 4:00 PM", partOfDay: null });
    expect(moment("llamar a Ana a las 16:30", "te llamo el viernes a las 16:30", "2026-11-20")).toMatchObject({ dueAt: at(2026, 11, 20, 16, 30), timed: true });
  });

  it("a time in another zone, read in the reader's: the same instant", () => {
    // the reader's zone is the machine's (`readerZone`), as the dated reader's
    expect(readerZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const { dueAt, timed } = moment("call Marcus at 4:00 PM PT", "I'll call you Friday at 4pm PT", "2026-11-20");
    expect(timed).toBe(true);
    // 4:00 PM in Los Angeles that day, wherever the reader is
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(dueAt)).toBe("4:00 PM");
  });

  it("no clock, no day, or a moment before it was sent: the day's default, untimed", () => {
    expect(moment("send the deck", "I'll send the deck Friday", "2026-11-20")).toEqual({ dueAt: morning.dueAt, timed: false, text: "send the deck", partOfDay: null });
    expect(moment("call at 4:00 PM", "I'll call at 4", null, { dueAt: 5, dated: false })).toMatchObject({ dueAt: 5, timed: false });
    expect(moment("call at 9:00 AM", "I'll call at 9", "2026-11-16", { dueAt: at(2026, 11, 16, 17), dated: true })).toMatchObject({ dueAt: at(2026, 11, 16, 17), timed: false });
  });

  it("plan 210 (iteration 5): a clock the quote never stated isn't the promise's: out of its words, and the quote's part is what was meant", () => {
    // María's cupcakes, as v12 wrote them
    const v12 = moment("bring the bake sale two dozen nut-free, labeled cupcakes by 12:00 PM", "I'll bring two dozen cupcakes (nut-free, labeled) Friday morning at drop-off.", "2026-11-20");
    expect(v12).toEqual({ dueAt: at(2026, 11, 20, 9), timed: false, text: "bring the bake sale two dozen nut-free, labeled cupcakes", partOfDay: "morning" });
    // a made-up clock and no part in the quote: the whole day, untimed
    expect(moment("send the deck by 12:00 PM", "I'll send the deck Friday", "2026-11-20")).toEqual({ dueAt: morning.dueAt, timed: false, text: "send the deck", partOfDay: null });
  });

  it("plan 210 (iteration 5): the reader's part, only when the quote names it and states no clock; at the part's moment, untimed", () => {
    expect(moment("drop Phil the spare key", "I'll drop the spare key off at your place Friday morning", "2026-11-20", morning, "morning")).toMatchObject({ dueAt: at(2026, 11, 20, 9), timed: false, partOfDay: "morning" });
    expect(moment("send it", "I'll send it Friday afternoon", "2026-11-20", morning, "afternoon")).toMatchObject({ dueAt: at(2026, 11, 20, 13), partOfDay: "afternoon" });
    // "tonight", written at 10:00 the same day: 18:00 that day
    expect(moment("send Jess the scan", "I'll send it tonight", "2026-11-16", { dueAt: at(2026, 11, 16, 17), dated: true }, "evening")).toMatchObject({ dueAt: at(2026, 11, 16, 18), partOfDay: "evening" });
    // a part the quote doesn't name, a clock beside it, or no day: none
    expect(moment("send it", "I'll send it Friday", "2026-11-20", morning, "morning")).toMatchObject({ partOfDay: null, dueAt: morning.dueAt });
    expect(moment("call Ana at 10:00 AM", "I'll call you Friday morning at 10", "2026-11-20", morning, "morning")).toMatchObject({ timed: true, partOfDay: null, dueAt: at(2026, 11, 20, 10) });
    expect(moment("send it", "I'll send it tomorrow morning", null, { dueAt: 5, dated: false }, "morning")).toMatchObject({ partOfDay: null, dueAt: 5 });
    // this morning, written after noon: the part is over, nothing said
    expect(promiseMoment({ text: "send it", quote: "I'll send it this morning", day: "2026-11-16", part: "morning" }, { dueAt: at(2026, 11, 16, 17), dated: true }, at(2026, 11, 16, 13))).toMatchObject({ partOfDay: null, dueAt: at(2026, 11, 16, 17) });
  });

  it("follow-ups' checks keep a promise's stated time, and store a part of the day with words that never gain a clock", () => {
    const recipients = [{ label: "r1", name: "Marcus", email: "marcus@x.test" }];
    const out = checkSentMail({ promises: [{ text: "call Marcus at 4:00 PM", quote: "I'll call you at 4:00 PM Friday", to: "r1", due: "2026-11-20" }], expectsReply: false, awaiting: [], kept: [] }, { ownText: "I'll call you at 4:00 PM Friday", recipients, open: new Map(), sentAt: SENT, nudgeAfterDays: 5 });
    expect(out.rows[0]).toMatchObject({ dueAt: at(2026, 11, 20, 16), dated: true, timed: true });
    const own = "I'll bring two dozen cupcakes (nut-free, labeled) Friday morning at drop-off.";
    const part = checkSentMail({ promises: [{ text: "bring Jessica the cupcakes", quote: own, to: "r1", due: "2026-11-20", partOfDay: "morning" }], expectsReply: false, awaiting: [], kept: [] }, { ownText: own, recipients, open: new Map(), sentAt: SENT, nudgeAfterDays: 5 });
    expect(part.rows[0]).toMatchObject({ text: "bring Jessica the cupcakes", dueAt: at(2026, 11, 20, 9), dated: true, partOfDay: "morning" });
    expect(part.rows[0]!.timed).toBeUndefined();
    const v12 = checkSentMail({ promises: [{ text: "bring Jessica the cupcakes by 12:00 PM", quote: own, to: "r1", due: "2026-11-20" }], expectsReply: false, awaiting: [], kept: [] }, { ownText: own, recipients, open: new Map(), sentAt: SENT, nudgeAfterDays: 5 });
    expect(v12.rows[0]).toMatchObject({ text: "bring Jessica the cupcakes", partOfDay: "morning" });
    expect(v12.rows[0]!.timed).toBeUndefined();
  });
});
