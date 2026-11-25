import { describe, expect, it } from "vitest";
import { followupDaysSince, followupDue, hasCommitmentCue, isFollowupKind, mostUrgent, onTopEligible, theirDue, validFollowupDate } from "./followups";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const clock = (ms: number) => { const d = new Date(ms); return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };

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

it("the most urgent is what's due, then the soonest; days since count whole days (plan 161)", () => {
  expect(mostUrgent([{ id: 1, state: "open", dueAt: 1 }, { id: 2, state: "due", dueAt: 9 }, { id: 3, state: "due", dueAt: 5 }])!.id).toBe(3);
  // plan 204 (Codex code review of the fifth round): a promise put off wakes at its Later, so the one due sooner is the row's
  expect(mostUrgent([{ id: 1, state: "open", dueAt: 1, deferredUntil: 100 }, { id: 2, state: "open", dueAt: 50, deferredUntil: null }])!.id).toBe(2);
  expect(followupDaysSince(0, 3600)).toBe(0);
  expect(followupDaysSince(0, 86_400_000 - 1)).toBe(0);
  expect(followupDaysSince(0, 86_400_000)).toBe(1);
  expect(followupDaysSince(0, 5.9 * 86_400_000)).toBe(5);
  expect(followupDaysSince(0, 5 * 86_400_000)).toBe(5);
});

describe("when a promise of theirs is late (plan 280 §5)", () => {
  // 2026-03-05 is a Thursday, 2026-03-06 a Friday
  const theirs = (madeAt: number, due: string | null, nudgeAfterDays = 5) => theirDue({ madeAt, due, nudgeAfterDays });

  it("one working day after its day, at 9:00", () => {
    expect(theirs(at(2026, 3, 2, 14), "2026-03-05")).toEqual({ dueAt: at(2026, 3, 6, 9), dated: true, dueDay: "2026-03-05" });
  });
  it("weekends don't count: due Friday, late Monday; due Saturday or Sunday, late Monday too", () => {
    expect(clock(theirs(at(2026, 3, 2, 14), "2026-03-06").dueAt)).toEqual([3, 9, 9, 0]);
    expect(clock(theirs(at(2026, 3, 2, 14), "2026-03-07").dueAt)).toEqual([3, 9, 9, 0]);
    expect(clock(theirs(at(2026, 3, 2, 14), "2026-03-08").dueAt)).toEqual([3, 9, 9, 0]);
  });
  it("keeps the day promised apart from the moment it's late", () => {
    expect(theirs(at(2026, 3, 2, 14), "2026-03-06").dueDay).toBe("2026-03-06");
  });
  it("undated: its working days after it was made, at 9:00", () => {
    // made Thursday the 5th: Fri 6, Mon 9, Tue 10, Wed 11, Thu 12
    expect(clock(theirs(at(2026, 3, 5, 14), null).dueAt)).toEqual([3, 12, 9, 0]);
    expect(theirs(at(2026, 3, 5, 14), null)).toMatchObject({ dated: false, dueDay: null });
    // made on a Saturday, three working days: Mon, Tue, Wed
    expect(clock(theirs(at(2026, 3, 7, 10), null, 3).dueAt)).toEqual([3, 11, 9, 0]);
  });
  it("across a month's end and a DST change it keeps its hour", () => {
    expect(clock(theirs(at(2026, 1, 27, 14), "2026-01-30").dueAt)).toEqual([2, 2, 9, 0]);
    expect(new Date(theirs(at(2026, 3, 2, 14), "2026-03-06").dueAt).getHours()).toBe(9);
    expect(new Date(theirs(at(2026, 10, 28, 14), "2026-10-30").dueAt).getHours()).toBe(9);
  });
  it("a date that isn't one is undated", () => {
    expect(theirs(at(2026, 3, 2, 14), "2026-02-30").dated).toBe(false);
  });
});

describe("their promises' kind and the Inbox's top (plan 280)", () => {
  it("knows the three kinds and nothing else", () => {
    expect(["promise", "awaiting", "theirs"].every(isFollowupKind)).toBe(true);
    expect(isFollowupKind("owed")).toBe(false);
  });
  it("a tentative promise of theirs, or one from a check, never goes on top", () => {
    expect(onTopEligible({ kind: "theirs", fromScan: false, firm: true })).toBe(true);
    expect(onTopEligible({ kind: "theirs", fromScan: false })).toBe(true);
    expect(onTopEligible({ kind: "theirs", fromScan: false, firm: false })).toBe(false);
    expect(onTopEligible({ kind: "theirs", fromScan: true, firm: true })).toBe(false);
    expect(onTopEligible({ kind: "awaiting", fromScan: false })).toBe(true);
  });
});

describe("a commitment cue (plan 280 §2)", () => {
  it.each([
    "I'll send you the contract by Thursday.",
    "We will have the quote to you next week",
    "Let me check and get back to you.",
    "Will do, Friday at the latest.",
    "Te mando la factura mañana.",
    "Le envío el contrato el viernes.",
    "Quedo de mandarte el presupuesto.",
    "Lo reviso y te aviso.",
    "Vamos a enviarte la propuesta.",
  ])("reads %s", (text) => expect(hasCommitmentCue(text)).toBe(true));
  it.each(["Thanks, got it.", "Can you send me the signed copy?", "Gracias por todo.", "Here is the report you asked for."])("passes over %s", (text) => expect(hasCommitmentCue(text)).toBe(false));
});
