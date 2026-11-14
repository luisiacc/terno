/** Plan 204 §6, the Codex code review: the 14-day check's yes is kept only once the check is queued. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const params: unknown[] = [];
let fail = false;
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, p: unknown) => {
      calls.push(method);
      params.push(p);
      return fail ? Promise.reject(new Error("The backend is busy.")) : Promise.resolve({ queued: 3, undoId: "u1" });
    },
  },
}));
const errors: string[] = [];
const said: { text: string; undo: boolean }[] = [];
vi.mock("~/lib/snack", () => ({ registerUndo: (f: () => void) => f, snack: { success: (text: string, o: { action?: unknown }) => said.push({ text, undo: !!o.action }), error: (m: string) => errors.push(m) } }));

const { actOnTask, answerScan, laterChoices, laterNote, laterStart, laterWindow } = await import("./dated");

beforeEach(() => {
  calls.length = 0;
  params.length = 0;
  errors.length = 0;
  said.length = 0;
  fail = false;
});

describe("a Today row's task (plan 204, after the panel)", () => {
  const item = { id: 30, revision: 2, kind: "event" as const, dueDay: "2026-11-12", timed: true, dated: true };
  it("Not a task: a date is dismissed by its own act, a promise by follow-ups' (the one the row shows), each with Undo", async () => {
    await actOnTask({ kind: "dated", item, when: null, due: null, dueAt: 0 }, "dismiss");
    await actOnTask({ kind: "promise", id: 7, revision: 3, when: null, due: null }, "dismiss");
    expect(calls).toEqual(["dated.act", "followups.act"]);
    expect(params).toEqual([{ id: 30, revision: 2, action: "dismiss" }, { id: 7, revision: 3, action: "dismiss" }]);
    expect(said).toEqual([{ text: "Removed from Today", undo: true }, { text: "Removed from Today", undo: true }]);
  });

  it("Done and Later say so; a promise's Later moves its due moment", async () => {
    await actOnTask({ kind: "promise", id: 7, revision: 3, when: null, due: null }, "later", 1234);
    await actOnTask({ kind: "dated", item, when: null, due: null, dueAt: 0 }, "done");
    expect(params).toEqual([{ id: 7, revision: 3, action: "later", dueAt: 1234 }, { id: 30, revision: 2, action: "done" }]);
    expect(said.map((s) => s.text)).toEqual(["Moved to later", "Marked done"]);
  });

  it("Later's choices: every preset that applies now; on a Plan, only those before it ends", () => {
    // Thursday 12 November 2026, 10:00: later today, tomorrow, this weekend, next week
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    expect(laterChoices({ kind: "promise", id: 7, revision: 3, when: null, due: null }, now).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend", "nextWeek"]);
    const plan = { kind: "dated" as const, item: { ...item, kind: "delivery" as const, dueDay: "2026-11-14", timed: false }, when: null, due: null, dueAt: new Date(2026, 10, 14, 9).getTime() };
    expect(laterChoices(plan, now).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend"]);
    expect(laterChoices({ ...plan, item: { ...plan.item, dueDay: "2026-11-12" }, dueAt: new Date(2026, 10, 12, 9).getTime() }, now).map((p) => p.id)).toEqual(["laterToday"]);
  });

  it("the third panel round: a timed item still ahead keeps only what's before its moment; Missed, every preset; a dated promise, another day", () => {
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    // a 1:00 PM payroll at 10:00: Later today is 1:00 PM, not before it
    const payroll = { kind: "dated" as const, item: { ...item, kind: "pay" as const, dueDay: "2026-11-12", timed: true }, when: null, due: null, dueAt: new Date(2026, 10, 12, 13).getTime() };
    expect(laterChoices(payroll, now)).toEqual([]);
    expect(laterWindow(payroll, now)).toEqual({ from: null, before: payroll.dueAt, limit: "due" });
    expect(laterNote(laterWindow(payroll, now)).late).toBe("Pick a time before it’s due.");
    // the same at 2:00 PM (its moment passed) and once Missed: every preset
    expect(laterChoices(payroll, new Date(2026, 10, 12, 14).getTime()).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend", "nextWeek"]);
    expect(laterChoices({ ...payroll, item: { ...payroll.item, dueDay: "2026-11-11" }, dueAt: new Date(2026, 10, 11, 13).getTime() }, now).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend", "nextWeek"]);
    // a dated promise of yours: not later today (it'd still be today's)
    expect(laterChoices({ kind: "promise", id: 7, revision: 3, when: "Today", due: "Due today", dated: true }, now).map((p) => p.id)).toEqual(["tomorrow", "weekend", "nextWeek"]);
    // the picker starts an hour before the moment when tomorrow at 9 is past it
    expect(laterStart(laterWindow(payroll, now), now)).toBe(new Date(2026, 10, 12, 12).getTime());
  });
});

describe("the 14-day check's answer", () => {
  it("yes: queued, then answered", async () => {
    const save = vi.fn(async () => {});
    expect(await answerScan(true, save)).toBe(true);
    expect(calls).toEqual(["dated.scan"]);
    expect(save).toHaveBeenCalledWith({ scanAnswered: true });
  });

  it("a yes that fails isn't saved: it says so, and the offer stays", async () => {
    fail = true;
    const save = vi.fn(async () => {});
    expect(await answerScan(true, save)).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(errors).toEqual(["The backend is busy."]);
  });

  it("not now: answered, nothing queued", async () => {
    const save = vi.fn(async () => {});
    await answerScan(false, save);
    expect(calls).toEqual([]);
    expect(save).toHaveBeenCalledWith({ scanAnswered: true });
  });
});

describe("the conversation's line keeps the whole wording (plan 204, after the second panel round)", () => {
  it("when, then the task; a promise's in your words; no day, the task alone", async () => {
    const { datedLine, promiseLine } = await import("./dated");
    // Thursday 12 November 2026, 10:00
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const facts = { kind: "pay" as const, dueDay: "2026-11-12", dueAt: new Date(2026, 10, 12, 13, 0).getTime(), timed: true, dated: true, text: "Wire payroll" };
    expect(datedLine(facts, false, now)).toBe("Due today 1:00 PM · Wire payroll");
    expect(datedLine({ ...facts, dueDay: "2026-11-11", timed: false }, true, now)).toBe("Was due yesterday · Wire payroll");
    expect(datedLine({ ...facts, dated: false }, false, now)).toBe("Wire payroll");
    expect(promiseLine({ text: "send the agenda", dueAt: facts.dueAt, dated: true }, false, now)).toBe("Due today · You said: send the agenda");
    expect(promiseLine({ text: "call back", dated: false }, false, now)).toBe("You said: call back");
  });
  it("the third panel round: an ask is its words alone, in the conversation and in Today, its row's date the day it came", async () => {
    const { datedLine, taskOf } = await import("./dated");
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const arrived = new Date(2026, 10, 10, 9, 0).getTime();
    const ask = { kind: "ask" as const, dueDay: "2026-11-10", dueAt: arrived, timed: false, dated: false, text: "Answer Mariana about a rebranding quote" };
    expect(datedLine(ask, false, now)).toBe("Answer Mariana about a rebranding quote");
    // an older backend's ask said dated: it still names no day
    expect(datedLine({ ...ask, dated: true }, false, now)).toBe("Answer Mariana about a rebranding quote");
    const task = taskOf({ kind: "dated", text: ask.text, dueAt: arrived, item: { id: 1, revision: 0, kind: "ask", dueDay: ask.dueDay, timed: false, dated: false } }, now);
    expect(task).toMatchObject({ kind: "dated", when: null, due: null, dueAt: arrived });
  });
});
