// @vitest-environment jsdom
/**
 * Plan 204 (after the second panel round): Done means gone. Done, Not a task and Later on a Today row's task take the row
 * out of Today at once, the cursor on the next row as after Archive; Undo brings it back in its place, selected.
 */
import type { ThreadSummary, TodayList } from "@terno/core";
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

const { actOnThreadItem, actOnTodayRow, doneOnSelected } = await import("./today-task");
const { getApp, setApp } = await import("~/state/app");
const { reloadList, useList } = await import("~/state/list");
const { useToday } = await import("~/state/today");
const { resetSnacks, runUndo, useSnack } = await import("~/lib/snack");

const thread = (id: number) => ({ id, accountId: 1, subject: `t${id}`, snippet: "", fromName: "A", fromEmail: "a@x.test", lastDate: 1e9 - id, messageCount: 1, unread: false, starred: false, hasAttachments: false, categoryIds: [], inInbox: true, inSpam: false, inTrash: false }) as unknown as ThreadSummary;
const item = (id: number) => ({ id: id * 10, revision: 1, kind: "pay" as const, dueDay: "2026-11-20", timed: false, dated: true });
/** what's open: the backend's Today, without what's been done (held rows aren't modelled: nothing here leaves on its own) */
const done = new Set<number>();
const today = (): TodayList => ({ now: 1e9, held: [], digest: null, sections: [{ kind: "deadlines", items: [1, 2, 3].filter((id) => !done.has(id * 10)).map((id) => ({ thread: thread(id), why: { kind: "dated", text: `Task ${id}`, dueAt: 2e12, item: item(id) } })) }] }) as unknown as TodayList;
const shown = () => useList.getState().items.map((t) => t.id);
const undo = () => runUndo(useSnack.getState().undo!);

beforeEach(async () => {
  done.clear();
  resetSnacks();
  fake.handlers = {
    "today.list": async () => today(),
    "dated.act": async (p) => (done.add((p as { id: number }).id), { undoId: 5 }),
    "dated.undo": async () => (done.clear(), {}),
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
    await vi.waitFor(() => expect(useSnack.getState().current?.message).toBe("Marked done"));
    await undo();
    expect(shown()).toEqual([1, 2, 3]);
    expect(getApp().selectedId).toBe(2);
  });

  it("Not a task and Later leave too; a row that isn't the open one leaves without moving the cursor", async () => {
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

  it("outside Today nothing leaves the list", async () => {
    const task = useToday.getState().tasks.get(2)!;
    setApp({ today: false });
    useList.setState({ itemsKey: "other" });
    await actOnTodayRow(2, task, "done");
    expect(shown()).toEqual([1, 2, 3]);
    expect(done.has(20)).toBe(true);
  });
});
