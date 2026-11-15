// @vitest-environment jsdom
/**
 * Plan 204 (after the second panel round): Done means gone. Done, Remove and Later on a Today row's task take the row
 * out of Today at once, the cursor on the next row as after Archive; Undo brings it back in its place, selected.
 */
import type { FollowupRow, ThreadSummary, TodayList } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.requestAnimationFrame = () => 0;
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>> };
});
vi.mock("~/rpc/connection", () => ({
  client: {
    connectionVersion: 0,
    call: (method: string, params: unknown) => fake.handlers[method]?.(params) ?? Promise.resolve({}),
    on: () => () => {},
  },
}));

const { actOnThreadItem, actOnThreadPromise, actOnTodayRow, doneOnSelected, laterOnSelected, removeOnSelected } = await import("./today-task");
const { getApp, setApp } = await import("~/state/app");
const { reloadList, useList } = await import("~/state/list");
const { useToday } = await import("~/state/today");
const { resetSnacks, runUndo, useSnack } = await import("~/lib/snack");

const thread = (id: number) => ({ id, accountId: 1, subject: `t${id}`, snippet: "", fromName: "A", fromEmail: "a@x.test", lastDate: 1e9 - id, messageCount: 1, unread: false, starred: false, hasAttachments: false, categoryIds: [], inInbox: true, inSpam: false, inTrash: false }) as unknown as ThreadSummary;
const item = (id: number) => ({ id: id * 10, revision: 1, kind: "pay" as const, dueDay: "2026-11-20", timed: false, dated: true });
/** what's open: the backend's Today, without what's been done (held rows aren't modelled: nothing here leaves on its own) */
const done = new Set<number>();
/** promises shown, by thread: Codex code review, the conversation's promise controls */
const promised = new Map<number, number>();
const today = (): TodayList =>
  ({
    now: 1e9,
    held: [],
    digest: null,
    sections: [
      { kind: "today", items: [1, 2, 3].filter((id) => !done.has(id * 10)).map((id) => ({ thread: thread(id), why: { kind: "dated", text: `Task ${id}`, dueAt: 2e12, item: item(id) } })) },
      // (a day ahead's: a heading of its own after Today's)
      { kind: "day", day: "2026-11-20", items: [...promised].filter(([, id]) => !done.has(id)).map(([threadId, id]) => ({ thread: thread(threadId), why: { kind: "promise", text: "send the agenda", dueAt: 2e12, personName: "Ana", sentAt: 1e9, promise: { id, revision: 1, dated: false } } })) },
    ],
  }) as unknown as TodayList;
const shown = () => useList.getState().items.map((t) => t.id);
const undo = () => runUndo(useSnack.getState().undo!);

beforeEach(async () => {
  done.clear();
  promised.clear();
  resetSnacks();
  fake.handlers = {
    "today.list": async () => today(),
    "dated.act": async (p) => (done.add((p as { id: number }).id), { undoId: 5 }),
    "dated.undo": async () => (done.clear(), {}),
    "followups.act": async (p) => (done.add((p as { id: number }).id), { undoId: 6 }),
    "followups.undo": async () => (done.clear(), {}),
  };
  setApp({ view: "all", today: true, query: "", selectedId: null, checked: new Set(), scope: null });
  await reloadList();
  setApp({ selectedId: 2 });
});

describe("Done means gone (plan 204, after the second panel round)", () => {
  it("D: the row leaves at once and the cursor is on the next; Undo brings it back in its place, selected", async () => {
    expect(doneOnSelected()).toBe(true);
    // the same frame: not held in place as a row that leaves on its own is
    expect(shown()).toEqual([1, 3]);
    expect(getApp().selectedId).toBe(3);
    // the fourth panel round: it names the task, as the row showed it
    await vi.waitFor(() => expect(useSnack.getState().current?.message).toBe("Done: Task 2"));
    await undo();
    expect(shown()).toEqual([1, 2, 3]);
    expect(getApp().selectedId).toBe(2);
  });

  it("the fourth panel round: Undo's words are the task's when acted on, not what the reload brought in its place", async () => {
    let slow: (() => void) | null = null;
    fake.handlers["dated.act"] = (p) => new Promise((resolve) => (slow = () => resolve((done.add((p as { id: number }).id), { undoId: 5 }))));
    const acting = actOnTodayRow(2, useToday.getState().tasks.get(2)!, "dismiss");
    // the conversation's next item is the row's now (a reload while the act was on its way)
    useToday.setState({ tasks: new Map([[2, { kind: "dated", item: { ...item(2), id: 21 }, when: null, due: null, dueAt: 0, text: "Pay the rent" }]]) });
    slow!();
    await acting;
    expect(useSnack.getState().current?.message).toBe("Removed from What matters: Task 2");
  });

  it("Remove and Later leave too; a row that isn't the open one leaves without moving the cursor", async () => {
    await actOnTodayRow(3, useToday.getState().tasks.get(3)!, "dismiss");
    expect(shown()).toEqual([1, 2]);
    expect(getApp().selectedId).toBe(2);
    await actOnTodayRow(2, useToday.getState().tasks.get(2)!, "later", 3e12);
    expect(shown()).toEqual([1]);
    expect(getApp().selectedId).toBe(1);
  });

  it("an act that failed brings the row back, selected", async () => {
    fake.handlers["dated.act"] = async () => {
      throw new Error("The backend is busy.");
    };
    await actOnTodayRow(2, useToday.getState().tasks.get(2)!, "done");
    await vi.waitFor(() => expect(shown()).toEqual([1, 2, 3]));
    expect(getApp().selectedId).toBe(2);
    expect(useSnack.getState().current?.message).toBe("The backend is busy.");
  });

  it("the conversation's line: its row leaves only for the item the row stands for", async () => {
    await actOnThreadItem(2, { id: 99, revision: 1 }, "done");
    expect(shown()).toEqual([1, 2, 3]);
    await actOnThreadItem(2, item(2), "dismiss");
    expect(shown()).toEqual([1, 3]);
    expect(getApp().selectedId).toBe(3);
  });

  it("the third panel round: Later from the conversation's line takes the row out at once, its moment sent; Undo brings it back selected; a failure brings it back", async () => {
    const sent: unknown[] = [];
    const act = fake.handlers["dated.act"]!;
    fake.handlers["dated.act"] = async (p) => (sent.push(p), act(p));
    await actOnThreadItem(2, { ...item(2), text: "Task 2" }, "later", 3e12);
    expect(sent).toEqual([{ id: 20, revision: 1, action: "later", until: 3e12 }]);
    expect(shown()).toEqual([1, 3]);
    expect(getApp().selectedId).toBe(3);
    await vi.waitFor(() => expect(useSnack.getState().current?.message).toBe("Later: Task 2"));
    await undo();
    expect(shown()).toEqual([1, 2, 3]);
    expect(getApp().selectedId).toBe(2);
    fake.handlers["dated.act"] = async () => {
      throw new Error("That’s too late for it. Choose an earlier time.");
    };
    await actOnThreadItem(2, item(2), "later", 3e12);
    await vi.waitFor(() => expect(shown()).toEqual([1, 2, 3]));
    expect(getApp().selectedId).toBe(2);
    expect(useSnack.getState().current?.message).toBe("That’s too late for it. Choose an earlier time.");
  });

  it("the conversation's promise controls: the row leaves for the promise it stands for, not for another (Codex code review)", async () => {
    promised.set(4, 400);
    await reloadList();
    setApp({ selectedId: 4 });
    const row = (id: number) => ({ id, threadId: 4, revision: 1, kind: "promise", text: "send the agenda", dueAt: 2e12 }) as unknown as FollowupRow;
    await actOnThreadPromise(row(401), "done");
    expect(shown()).toEqual([1, 2, 3, 4]);
    // follow-ups' own act names the promise too (the fourth panel round)
    expect(useSnack.getState().current?.message).toBe("Done: send the agenda");
    await actOnThreadPromise(row(400), "done");
    expect(shown()).toEqual([1, 2, 3]);
    expect(getApp().selectedId).toBe(3);
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    expect(useSnack.getState().current?.message).toBe("Done: send the agenda");
    await undo();
    expect(shown()).toEqual([1, 2, 3, 4]);
    expect(getApp().selectedId).toBe(4);
  });

  it("the headings follow the rows that are left, before the list reloads (Codex code review)", async () => {
    promised.set(4, 400);
    await reloadList();
    expect(useToday.getState().groups).toEqual([{ kind: "today", at: 0 }, { kind: "day:2026-11-20", at: 3 }]);
    fake.handlers["today.list"] = () => new Promise(() => {}); // the reload never answers: what's shown is the optimistic list
    await actOnTodayRow(1, useToday.getState().tasks.get(1)!, "done");
    expect(shown()).toEqual([2, 3, 4]);
    expect(useToday.getState().groups).toEqual([{ kind: "today", at: 0 }, { kind: "day:2026-11-20", at: 2 }]);
    await actOnTodayRow(2, useToday.getState().tasks.get(2)!, "done");
    await actOnTodayRow(3, useToday.getState().tasks.get(3)!, "done");
    expect(shown()).toEqual([4]);
    expect(useToday.getState().groups).toEqual([{ kind: "day:2026-11-20", at: 0 }]);
  });

  it("plan 210 (iteration 1): ⇧D removes the key's item as D finishes it, with the same Undo; b opens Later for the item as it was, and opening or leaving it moves nothing", async () => {
    const acts: unknown[] = [];
    const act = fake.handlers["dated.act"]!;
    fake.handlers["dated.act"] = async (p) => (acts.push(p), act(p));
    expect(removeOnSelected()).toBe(true);
    expect(shown()).toEqual([1, 3]);
    expect(getApp().selectedId).toBe(3);
    await vi.waitFor(() => expect(acts).toEqual([{ id: 20, revision: 1, action: "dismiss" }]));
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    await undo();
    expect(shown()).toEqual([1, 2, 3]);
    // b: with no feed drawn (the item is the reader's alone), Later's own picker, for the task b saw
    setApp({ selectedId: 2 });
    const seen = useToday.getState().tasks.get(2)!;
    expect(laterOnSelected()).toBe(true);
    expect(getApp().dialog).toBe("todayLater");
    expect(useToday.getState().laterPick).toEqual({ threadId: 2, task: seen });
    // a reload meanwhile brings another item to the row: the picker keeps the one it opened for
    useToday.setState({ tasks: new Map([[2, { kind: "dated", item: { ...item(2), id: 21 }, when: null, due: null, dueAt: 0 }]]) });
    expect(useToday.getState().laterPick?.task).toBe(seen);
    expect(shown()).toEqual([1, 2, 3]);
    expect(acts).toHaveLength(1);
    setApp({ dialog: null });
    useToday.setState({ laterPick: null });
  });

  it("plan 210 (iteration 1): b and ⇧D leave the key alone among several checked, in a scope, on a row with no task, or outside What matters", async () => {
    setApp({ checked: new Set([1, 2]) });
    expect(removeOnSelected()).toBe(false);
    expect(laterOnSelected()).toBe(false);
    setApp({ checked: new Set(), selectedId: 99 });
    expect(removeOnSelected()).toBe(false);
    expect(laterOnSelected()).toBe(false);
    setApp({ selectedId: 2, today: false });
    expect(removeOnSelected()).toBe(false);
    expect(laterOnSelected()).toBe(false);
    expect(shown()).toEqual([1, 2, 3]);
    expect(getApp().dialog).toBe(null);
  });

  it("outside Today nothing leaves the list", async () => {
    const task = useToday.getState().tasks.get(2)!;
    setApp({ today: false });
    useList.setState({ itemsKey: "other" });
    await actOnTodayRow(2, task, "done");
    expect(shown()).toEqual([1, 2, 3]);
    expect(done.has(20)).toBe(true);
  });
});
