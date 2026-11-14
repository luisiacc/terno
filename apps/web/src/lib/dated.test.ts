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

const { actOnTask, answerScan, laterChoices } = await import("./dated");

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
    await actOnTask({ kind: "dated", item, when: null, end: null }, "dismiss");
    await actOnTask({ kind: "promise", id: 7, revision: 3, when: null }, "dismiss");
    expect(calls).toEqual(["dated.act", "followups.act"]);
    expect(params).toEqual([{ id: 30, revision: 2, action: "dismiss" }, { id: 7, revision: 3, action: "dismiss" }]);
    expect(said).toEqual([{ text: "Removed from Today", undo: true }, { text: "Removed from Today", undo: true }]);
  });

  it("Done and Later say so; a promise's Later moves its due moment", async () => {
    await actOnTask({ kind: "promise", id: 7, revision: 3, when: null }, "later", 1234);
    await actOnTask({ kind: "dated", item, when: null, end: null }, "done");
    expect(params).toEqual([{ id: 7, revision: 3, action: "later", dueAt: 1234 }, { id: 30, revision: 2, action: "done" }]);
    expect(said.map((s) => s.text)).toEqual(["Moved to later", "Marked done"]);
  });

  it("Later's choices: every preset that applies now; on a Plan, only those before it ends", () => {
    // Thursday 12 November 2026, 10:00: later today, tomorrow, this weekend, next week
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    expect(laterChoices({ kind: "promise", id: 7, revision: 3, when: null }, now).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend", "nextWeek"]);
    const plan = { kind: "dated" as const, item, when: null, end: new Date(2026, 10, 14, 12, 0).getTime() };
    expect(laterChoices(plan, now).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend"]);
    expect(laterChoices({ ...plan, end: new Date(2026, 10, 12, 12, 0).getTime() }, now)).toEqual([]);
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
