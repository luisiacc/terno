/** Plan 210 (iteration 2, A7): a promise's moment is a time its words state, in the reader's zone; never a made-up one. */
import { describe, expect, it } from "vitest";
import { checkSentMail } from "./followups";
import { promiseMoment, readerZone } from "./promise-time";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const SENT = at(2026, 11, 16, 10);
const morning = { dueAt: at(2026, 11, 20, 9), dated: true };

describe("promiseMoment", () => {
  it("its words' clock on its day, in the reader's own zone", () => {
    expect(promiseMoment("call Marcus at 4:00 PM", "2026-11-20", morning, SENT)).toEqual({ dueAt: at(2026, 11, 20, 16), timed: true });
    expect(promiseMoment("llamar a Ana a las 16:30", "2026-11-20", morning, SENT)).toEqual({ dueAt: at(2026, 11, 20, 16, 30), timed: true });
  });

  it("a time in another zone, read in the reader's: the same instant", () => {
    // the reader's zone is the machine's (`readerZone`), as the dated reader's
    expect(readerZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const { dueAt, timed } = promiseMoment("call Marcus at 4:00 PM PT", "2026-11-20", morning, SENT);
    expect(timed).toBe(true);
    // 4:00 PM in Los Angeles that day, wherever the reader is
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(dueAt)).toBe("4:00 PM");
  });

  it("no clock, no day, or a moment before it was sent: the day's default, untimed", () => {
    expect(promiseMoment("send the deck", "2026-11-20", morning, SENT)).toEqual({ dueAt: morning.dueAt, timed: false });
    expect(promiseMoment("call at 4:00 PM", null, { dueAt: 5, dated: false }, SENT)).toEqual({ dueAt: 5, timed: false });
    expect(promiseMoment("call at 9:00 AM", "2026-11-16", { dueAt: at(2026, 11, 16, 17), dated: true }, SENT)).toEqual({ dueAt: at(2026, 11, 16, 17), timed: false });
  });

  it("follow-ups' checks keep a promise's stated time", () => {
    const out = checkSentMail({ promises: [{ text: "call Marcus at 4:00 PM", quote: "I'll call you at 4:00 PM Friday", to: "r1", due: "2026-11-20" }], expectsReply: false, awaiting: [], kept: [] }, { ownText: "I'll call you at 4:00 PM Friday", recipients: [{ label: "r1", name: "Marcus", email: "marcus@x.test" }], open: new Map(), sentAt: SENT, nudgeAfterDays: 5 });
    expect(out.rows[0]).toMatchObject({ dueAt: at(2026, 11, 20, 16), dated: true, timed: true });
  });
});
