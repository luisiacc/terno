import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { followupDaysSince, followupDue, mostUrgent, validFollowupDate } from "./followups";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const clock = (ms: number) => { const d = new Date(ms); return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };
const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/Mexico_City"; });
afterAll(() => { process.env.TZ = zone; });

describe("when a follow-up comes due (plan 142 §5)", () => {
  const promise = (sentAt: number, due: string | null) => followupDue({ kind: "promise", sentAt, due, nudgeAfterDays: 5 });

  it("a promise with a date: that day at 9:00", () => {
    expect(promise(at(2026, 3, 2, 14), "2026-03-06")).toEqual({ dueAt: at(2026, 3, 6, 9), dated: true });
  });
  it("for today: before 9, at 9; after 9, at 17:00; after 17:00, tomorrow at 9:00", () => {
    expect(clock(promise(at(2026, 3, 2, 8), "2026-03-02").dueAt)).toEqual([3, 2, 9, 0]);
    expect(clock(promise(at(2026, 3, 2, 11), "2026-03-02").dueAt)).toEqual([3, 2, 17, 0]);
    expect(clock(promise(at(2026, 3, 2, 18), "2026-03-02").dueAt)).toEqual([3, 3, 9, 0]);
  });
  it("with no date: 3 days after sending, at the next 9:00", () => {
    expect(clock(promise(at(2026, 3, 2, 8), null).dueAt)).toEqual([3, 5, 9, 0]);
    expect(clock(promise(at(2026, 3, 2, 14), null).dueAt)).toEqual([3, 6, 9, 0]);
    expect(promise(at(2026, 3, 2, 14), null).dated).toBe(false);
  });
  it("awaiting: its days after sending, at the next 9:00", () => {
    expect(clock(followupDue({ kind: "awaiting", sentAt: at(2026, 3, 2, 14), due: null, nudgeAfterDays: 7 }).dueAt)).toEqual([3, 10, 9, 0]);
  });
  it("across a month's edge and a DST change it keeps its hour", () => {
    expect(clock(promise(at(2026, 1, 30, 14), null).dueAt)).toEqual([2, 3, 9, 0]);
    // the US's spring change, by the local clock whatever the zone runs here
    expect(new Date(promise(at(2026, 3, 6, 14), null).dueAt).getHours()).toBe(9);
    expect(new Date(promise(at(2026, 10, 30, 14), null).dueAt).getHours()).toBe(9);
  });
});

describe("a date a model gave", () => {
  const sent = at(2026, 3, 2, 12);
  it("must parse, be on or after the day it was sent, and within a year", () => {
    expect(validFollowupDate("2026-03-02", sent)).toBe("2026-03-02");
    expect(validFollowupDate("2026-03-01", sent)).toBeNull();
    expect(validFollowupDate("2027-03-03", sent)).toBeNull();
    expect(validFollowupDate("someday", sent)).toBeNull();
    expect(validFollowupDate("2026-02-31", sent)).toBeNull();
    expect(validFollowupDate(null, sent)).toBeNull();
  });
});

it("the most urgent is what's due, then the soonest; days since never say zero", () => {
  expect(mostUrgent([{ id: 1, state: "open", dueAt: 1 }, { id: 2, state: "due", dueAt: 9 }, { id: 3, state: "due", dueAt: 5 }])!.id).toBe(3);
  expect(followupDaysSince(0, 3600)).toBe(1);
  expect(followupDaysSince(0, 5 * 86_400_000)).toBe(5);
});
