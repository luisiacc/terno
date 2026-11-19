// @vitest-environment jsdom
/**
 * Plan 204 (after the second panel round): Done means gone. Done, Remove and Later on a What matters row's task take the
 * row out at once, the open one moving on to the next as after Archive; Undo brings it back in its place, open. Plan 210
 * (iteration 2): rows by their own ids, so a conversation's other row stays; the conversation's line and its promise card
 * take out the rows standing for their item.
 */
import type { FollowupRow, ThreadSummary, TodayList } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderItem } from "./reader-items";

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

const { actOnThreadItem, actOnThreadPromise, actOnTodayRow, changeOnSelected, doneOnSelected, handOnSelected, laterFromPicker, laterOnSelected, remindLimit, removeOnSelected } = await import("./today-task");
const { useChangePick } = await import("~/lib/change");
const { getApp, openedByApp, setApp } = await import("~/state/app");
const { reloadList } = await import("~/state/list");
const { feedRow, installToday, openFeedRow, useFeedRow, useReaderChoice, useToday } = await import("~/state/today");
const { resetSnacks, runUndo, useSnack } = await import("~/lib/snack");
installToday();

const thread = (id: number) => ({ id, accountId: 1, subject: `t${id}`, snippet: "", fromName: "A", fromEmail: "a@x.test", lastDate: 1e9 - id, messageCount: 1, unread: false, starred: false, hasAttachments: false, categoryIds: [], inInbox: true, inSpam: false, inTrash: false }) as unknown as ThreadSummary;
const item = (id: number) => ({ id: id * 10, revision: 1, kind: "pay" as const, dueDay: "2026-11-20", timed: false, dated: true });
/** what's open: the backend's What matters, without what's been done (held rows aren't modelled: nothing here leaves on its own) */
const done = new Set<number>();
/** promises shown, by thread */
const promised = new Map<number, number>();
/** items 1, 2 and 3 on conversations 1, 2, 3; item 5 a second one of conversation 2 */
const today = (): TodayList =>
  ({
    now: 1e9,
    counts: { missed: 0, today: 3, thisWeek: 0 },
    digest: null,
    sections: [
      { kind: "today", items: [[1, 1], [2, 2], [5, 2], [3, 3]].filter(([id]) => !done.has(id! * 10)).map(([id, t]) => ({ id: `dated:${id! * 10}`, thread: thread(t!), why: { kind: "dated", text: `Task ${id}`, dueAt: 2e12, item: item(id!) } })) },
      // (a day ahead's: a heading of its own after Today's)
      { kind: "day", day: "2026-11-20", items: [...promised].filter(([, id]) => !done.has(id)).map(([threadId, id]) => ({ id: `promise:${id}`, thread: thread(threadId), why: { kind: "promise", text: "send the agenda", dueAt: 2e12, personName: "Ana", sentAt: 1e9, promise: { id, revision: 1, dated: false } } })) },
    ],
  }) as unknown as TodayList;
const shown = () => useToday.getState().rows.map((r) => r.id);
const task = (row: string) => feedRow(row)!.task!;
const open = (row: string) => {
  openFeedRow(row);
  setApp({ selectedId: feedRow(row)!.threadId });
};
const undo = () => runUndo(useSnack.getState().undo!);

beforeEach(async () => {
  done.clear();
  promised.clear();
  resetSnacks();
  fake.handlers = {
    "today.list": async () => today(),
    "dated.act": async (p) => (done.add((p as { id: number }).id), { undoId: "t5" }),
    "dated.undo": async () => (done.clear(), {}),
    "followups.act": async (p) => (done.add((p as { id: number }).id), { undoId: "t6" }),
    "followups.undo": async () => (done.clear(), {}),
  };
  setApp({ view: "all", today: true, query: "", selectedId: null, checked: new Set(), scope: null });
  useFeedRow.setState({ opened: null, cursor: null });
  await reloadList();
  open("dated:20");
});

describe("Done means gone (plan 204, after the second panel round; plan 210, iteration 2: a row per item)", () => {
  it("D: the row leaves at once, its conversation's other row stays and opens next; Undo brings it back in its place, open", async () => {
    expect(doneOnSelected()).toBe(true);
    // the same frame: not held in place as a row that leaves on its own is
    expect(shown()).toEqual(["dated:10", "dated:50", "dated:30"]);
    expect([useFeedRow.getState().opened, getApp().selectedId]).toEqual(["dated:50", 2]);
    // Codex code review: opened by the app, as Archive's next is, so it isn't read until chosen
    expect(openedByApp(2)).toBe(true);
    await vi.waitFor(() => expect(useSnack.getState().current?.message).toBe("Done: Task 2"));
    await undo();
    expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]);
    expect([useFeedRow.getState().opened, getApp().selectedId]).toEqual(["dated:20", 2]);
  });

  it("plan 210 (iteration 4): after Done the next row's mail opens only when the reader was open by the user's own choice (or a Done went on from one); else the reader goes and the feed is on the next row", async () => {
    // the user's click (open): D goes on to the next, its mail opened, and again from there
    expect(doneOnSelected()).toBe(true);
    expect([useFeedRow.getState().opened, getApp().selectedId]).toEqual(["dated:50", 2]);
    expect(doneOnSelected()).toBe(true);
    expect([useFeedRow.getState().opened, getApp().selectedId]).toEqual(["dated:30", 3]);
    // a mail the app opened (no choice of the user's): D puts the reader away, the feed on the next row, nothing opened
    const { setAppOpened } = await import("~/state/app");
    useFeedRow.setState({ opened: "dated:10", carried: null });
    setAppOpened(1);
    expect(doneOnSelected()).toBe(true);
    expect(getApp().selectedId).toBeNull();
    expect(useFeedRow.getState()).toMatchObject({ opened: null, cursor: "dated:30" });
    // the row the feed was put away on leaves: the feed is on the one after it
    await vi.waitFor(() => expect(shown()).not.toContain("dated:10"));
    void actOnTodayRow("dated:30", task("dated:30"), "done");
    expect(useFeedRow.getState().cursor).not.toBe("dated:30");
  });

  it("Codex's code review of iteration 4: Undo brings the row back open as the user had it: click A, Done, Undo, Done goes on to B with its mail", async () => {
    open("dated:10");
    expect(openedByApp(1)).toBe(false);
    expect(doneOnSelected()).toBe(true);
    expect([useFeedRow.getState().opened, getApp().selectedId]).toEqual(["dated:20", 2]);
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    await undo();
    expect([useFeedRow.getState().opened, getApp().selectedId]).toEqual(["dated:10", 1]);
    expect(openedByApp(1)).toBe(false);
    expect(useFeedRow.getState().carried).toBeNull();
    expect(doneOnSelected()).toBe(true);
    expect([useFeedRow.getState().opened, getApp().selectedId]).toEqual(["dated:20", 2]);
    // one the app opened comes back as the app's: its Done puts the reader away
    await vi.waitFor(() => expect(useSnack.getState().current?.message).toBe("Done: Task 1"));
    await undo();
    const { setAppOpened } = await import("~/state/app");
    useFeedRow.setState({ opened: "dated:10", carried: null });
    setAppOpened(1);
    expect(doneOnSelected()).toBe(true);
    await vi.waitFor(() => expect(useSnack.getState().current?.message).toBe("Done: Task 1"));
    await undo();
    expect([useFeedRow.getState().opened, getApp().selectedId, openedByApp(1)]).toEqual(["dated:10", 1, true]);
  });

  it("Codex code review, round 2: Undo after leaving What matters opens nothing in the mailbox shown now", async () => {
    expect(doneOnSelected()).toBe(true);
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    setApp({ today: false, view: "inbox", selectedId: null });
    await undo();
    expect(getApp().selectedId).toBeNull();
    expect(done.has(20)).toBe(false);
  });

  it("Undo restores the open row only when nothing was opened since, a sibling of its conversation included", async () => {
    expect(doneOnSelected()).toBe(true);
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    open("dated:10");
    await undo();
    expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]);
    expect(useFeedRow.getState().opened).toBe("dated:10");
  });

  it("the fourth panel round: Undo's words are the task's when acted on, not what the reload brought in its place", async () => {
    let slow: (() => void) | null = null;
    fake.handlers["dated.act"] = (p) => new Promise((resolve) => (slow = () => resolve((done.add((p as { id: number }).id), { undoId: "t5" }))));
    const acting = actOnTodayRow("dated:20", task("dated:20"), "dismiss");
    useToday.setState({ rows: [] });
    slow!();
    await acting;
    expect(useSnack.getState().current?.message).toBe("Removed from “What matters”: Task 2");
  });

  it("Remove and Later leave too; a row that isn't the open one leaves without moving the open one", async () => {
    await actOnTodayRow("dated:30", task("dated:30"), "dismiss");
    expect(shown()).toEqual(["dated:10", "dated:20", "dated:50"]);
    expect(useFeedRow.getState().opened).toBe("dated:20");
    await actOnTodayRow("dated:20", task("dated:20"), "later", 3e12);
    expect(shown()).toEqual(["dated:10", "dated:50"]);
    expect(useFeedRow.getState().opened).toBe("dated:50");
  });

  it("an act that failed brings the row back, open", async () => {
    fake.handlers["dated.act"] = async () => {
      throw new Error("The backend is busy.");
    };
    await actOnTodayRow("dated:20", task("dated:20"), "done");
    await vi.waitFor(() => expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]));
    expect(useFeedRow.getState().opened).toBe("dated:20");
    expect(useSnack.getState().current?.message).toBe("The backend is busy.");
  });

  it("the conversation's line: the row standing for its item leaves, never its sibling", async () => {
    await actOnThreadItem(2, { id: 99, revision: 1 }, "done");
    expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]);
    await actOnThreadItem(2, item(5), "dismiss");
    expect(shown()).toEqual(["dated:10", "dated:20", "dated:30"]);
    expect(useFeedRow.getState().opened).toBe("dated:20");
  });

  it("the third panel round: Later from the conversation's line takes the row out at once, its moment sent; Undo brings it back open; a failure brings it back", async () => {
    const sent: unknown[] = [];
    const act = fake.handlers["dated.act"]!;
    fake.handlers["dated.act"] = async (p) => (sent.push(p), act(p));
    await actOnThreadItem(2, { ...item(2), text: "Task 2" }, "later", 3e12);
    expect(sent).toEqual([{ id: 20, revision: 1, action: "later", until: 3e12 }]);
    expect(shown()).toEqual(["dated:10", "dated:50", "dated:30"]);
    await vi.waitFor(() => expect(useSnack.getState().current?.message).toBe("Later: Task 2"));
    await undo();
    expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]);
    expect(useFeedRow.getState().opened).toBe("dated:20");
    fake.handlers["dated.act"] = async () => {
      throw new Error("That’s too late for it. Choose an earlier time.");
    };
    await actOnThreadItem(2, item(2), "later", 3e12);
    await vi.waitFor(() => expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]));
    expect(useSnack.getState().current?.message).toBe("That’s too late for it. Choose an earlier time.");
  });

  it("the conversation's promise controls: the row leaves for the promise it stands for, not for another (Codex code review)", async () => {
    promised.set(4, 400);
    await reloadList();
    open("promise:400");
    const row = (id: number) => ({ id, threadId: 4, revision: 1, kind: "promise", text: "send the agenda", dueAt: 2e12 }) as unknown as FollowupRow;
    await actOnThreadPromise(row(401), "done");
    expect(shown()).toContain("promise:400");
    expect(useSnack.getState().current?.message).toBe("Done: send the agenda");
    await actOnThreadPromise(row(400), "done");
    expect(shown()).not.toContain("promise:400");
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    await undo();
    expect(shown()).toContain("promise:400");
    expect(useFeedRow.getState().opened).toBe("promise:400");
  });

  it("Codex code review of iteration 2: a promise merged into a row its card doesn't lead takes that row out too, with its Undo", async () => {
    // the row is a bill (dated:20) with your promise 600 as its member
    useToday.setState({ rows: useToday.getState().rows.map((r) => (r.id === "dated:20" ? { ...r, entry: { ...r.entry!, why: { ...r.entry!.why, members: [{ source: "dated", id: 20 }, { source: "promise", id: 600 }] } } } : r)) });
    const row = { id: 600, threadId: 2, revision: 1, kind: "promise", text: "send the slip", dueAt: 2e12 } as unknown as FollowupRow;
    await actOnThreadPromise(row, "done");
    expect(shown()).toEqual(["dated:10", "dated:50", "dated:30"]);
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    await undo();
    expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]);
  });

  it("the headings follow the rows that are left, before the list reloads (Codex code review)", async () => {
    promised.set(4, 400);
    await reloadList();
    fake.handlers["today.list"] = () => new Promise(() => {}); // the reload never answers: what's shown is the optimistic feed
    for (const row of ["dated:10", "dated:20", "dated:50", "dated:30"]) await actOnTodayRow(row, task(row), "done");
    expect(useToday.getState().rows.map((r) => [r.id, r.group])).toEqual([["promise:400", "day:2026-11-20"]]);
  });

  it("plan 210 (iteration 1): ⇧D removes the key's row as D finishes it, with the same Undo; b opens Later for the item as it was, and opening or leaving it moves nothing", async () => {
    const acts: unknown[] = [];
    const act = fake.handlers["dated.act"]!;
    fake.handlers["dated.act"] = async (p) => (acts.push(p), act(p));
    expect(removeOnSelected()).toBe(true);
    expect(shown()).toEqual(["dated:10", "dated:50", "dated:30"]);
    await vi.waitFor(() => expect(acts).toEqual([{ id: 20, revision: 1, action: "dismiss" }]));
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    await undo();
    expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]);
    // b: with no feed drawn, Later's own picker, for the task b saw: the open row's, never its sibling's
    open("dated:50");
    const seen = task("dated:50");
    expect(laterOnSelected()).toBe(true);
    expect(getApp().dialog).toBe("todayLater");
    expect(useToday.getState().laterPick).toEqual({ rowId: "dated:50", task: seen });
    useToday.setState({ rows: [] });
    expect(useToday.getState().laterPick?.task).toBe(seen);
    expect(acts).toHaveLength(1);
    setApp({ dialog: null });
    useToday.setState({ laterPick: null });
  });

  it("plan 210 (Codex code review): b on another row than the open one, then a moment of your own: the row goes and the keys go on to the next, as from a preset", async () => {
    const feed = document.createElement("section");
    feed.dataset.testid = "wm-feed";
    for (const id of shown()) feed.insertAdjacentHTML("beforeend", `<div data-row-id="${id}"><button data-testid="wm-item-open">${id}</button></div>`);
    document.body.append(feed);
    const button = (id: string) => feed.querySelector<HTMLElement>(`[data-row-id="${id}"] button`)!;
    button("dated:10").focus();
    const seen = task("dated:10");
    expect(laterOnSelected()).toBe(true);
    expect(useToday.getState().laterPick).toEqual({ rowId: "dated:10", task: seen, next: "dated:20" });
    const frame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => (cb(0), 0);
    try {
      laterFromPicker(useToday.getState().laterPick!, 3e12);
      expect(shown()).toEqual(["dated:20", "dated:50", "dated:30"]);
      expect(document.activeElement).toBe(button("dated:20"));
    } finally {
      globalThis.requestAnimationFrame = frame;
      feed.remove();
      setApp({ dialog: null });
      useToday.setState({ laterPick: null });
    }
  });

  it("plan 210 (iteration 1): b and ⇧D leave the key alone among several checked, in a scope, on a row with no task, or outside What matters", async () => {
    setApp({ checked: new Set([1, 2]) });
    expect(removeOnSelected()).toBe(false);
    expect(laterOnSelected()).toBe(false);
    setApp({ checked: new Set(), selectedId: 99 });
    useFeedRow.setState({ opened: null, cursor: null });
    expect(removeOnSelected()).toBe(false);
    expect(laterOnSelected()).toBe(false);
    open("dated:20");
    setApp({ today: false });
    expect(removeOnSelected()).toBe(false);
    expect(laterOnSelected()).toBe(false);
    expect(getApp().dialog).toBe(null);
  });

  it("plan 210 (iteration 5): ⇧B opens Change… for the key's item as it is, ⇧F asks to hand it on; both leave the key alone where b and ⇧D do", async () => {
    open("dated:20");
    expect(changeOnSelected()).toBe(true);
    expect(getApp().dialog).toBe("todayChange");
    expect(useChangePick.getState().target).toMatchObject({ source: "dated", id: 20, revision: 1 });
    setApp({ dialog: null });
    useChangePick.setState({ target: null });
    const asked: unknown[] = [];
    fake.handlers["today.handoff"] = async (p) => (asked.push(p), new Promise(() => {}));
    expect(handOnSelected()).toBe(true);
    await vi.waitFor(() => expect(asked).toEqual([{ source: "dated", id: 20, revision: 1 }]));
    delete fake.handlers["today.handoff"];
    setApp({ checked: new Set([1, 2]) });
    expect([changeOnSelected(), handOnSelected()]).toEqual([false, false]);
    setApp({ checked: new Set(), today: false });
    expect([changeOnSelected(), handOnSelected()]).toEqual([false, false]);
    expect(getApp().dialog).toBe(null);
  });

  it("plan 210 (iteration 3, code review): an item chosen in the reader with no feed row leads there: D, ⇧D and b are its, never the open row's", async () => {
    const acts: unknown[] = [];
    fake.handlers["dated.act"] = async (p) => (acts.push(p), { undoId: null });
    // the open row is item 2's (conversation 2); the reader's line chose its item 9, behind Coming up (no row)
    const chosen = { key: "dated:90", ref: { source: "dated", id: 90 }, open: true, missed: false, dueAt: 2e12, source: "dated", row: { id: 90, threadId: 2, revision: 3, text: "Task 9" } } as never;
    useReaderChoice.setState({ held: { threadId: 2, item: chosen } });
    try {
      expect(doneOnSelected()).toBe(true);
      expect(removeOnSelected()).toBe(true);
      await vi.waitFor(() => expect(acts).toEqual([{ id: 90, revision: 3, action: "done" }, { id: 90, revision: 3, action: "dismiss" }]));
      // the open row stays, open: it wasn't what the keys acted on
      expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]);
      expect(useFeedRow.getState().opened).toBe("dated:20");
      // b: the reader's own Later, not the row's picker
      expect(laterOnSelected()).toBe(true);
      expect([useReaderChoice.getState().later, getApp().menuOpen, getApp().dialog, useToday.getState().laterPick]).toEqual([true, true, null, null]);
      // another conversation open: the choice isn't its, the open row's item is what D acts on
      open("dated:10");
      expect(doneOnSelected()).toBe(true);
      await vi.waitFor(() => expect(acts.at(-1)).toEqual({ id: 10, revision: 1, action: "done" }));
    } finally {
      useReaderChoice.setState({ held: null, later: false });
      setApp({ menuOpen: false });
    }
  });

  it("outside What matters nothing leaves the feed", async () => {
    const seen = task("dated:20");
    setApp({ today: false });
    await actOnTodayRow("dated:20", seen, "done");
    expect(shown()).toEqual(["dated:10", "dated:20", "dated:50", "dated:30"]);
    expect(done.has(20)).toBe(true);
  });
});

describe("plan 215: a conversation waiting on you", () => {
  /** Waiting on you: Tomas's conversation (8), while it isn't done */
  let cleared = false;
  beforeEach(async () => {
    cleared = false;
    const base = fake.handlers["today.list"]!;
    fake.handlers["today.list"] = async (p) => {
      const list = (await base(p)) as TodayList;
      if (!cleared) list.sections.push({ kind: "today", part: "waiting", items: [{ id: "waiting:8", thread: { ...thread(8), fromName: "Tomas" }, why: { kind: "waiting", wrote: true, reply: { since: 700, rev: 0, message: 80 } } }] });
      return list;
    };
    fake.handlers["today.waitingAct"] = async (p) => ((cleared = (p as { action: string }).action === "done"), { undoId: "w1" });
    fake.handlers["today.waitingUndo"] = async () => ((cleared = false), { ok: true });
    await reloadList();
    open("waiting:8");
  });

  it("D finishes it (its act at what the row was drawn at), the row leaving at once; Undo brings it back; b opens its Later", async () => {
    const acts: unknown[] = [];
    const act = fake.handlers["today.waitingAct"]!;
    fake.handlers["today.waitingAct"] = async (p) => (acts.push(p), act(p));
    expect(task("waiting:8")).toMatchObject({ kind: "waiting", threadId: 8, since: 700, message: 80, rev: 0, name: "Tomas" });
    expect(doneOnSelected()).toBe(true);
    expect(shown()).not.toContain("waiting:8");
    await vi.waitFor(() => expect(acts).toEqual([{ threadId: 8, since: 700, message: 80, rev: 0, action: "done" }]));
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    await undo();
    expect(shown()).toContain("waiting:8");
    open("waiting:8");
    expect(laterOnSelected()).toBe(true);
    expect(useToday.getState().laterPick?.task).toMatchObject({ kind: "waiting", threadId: 8 });
    setApp({ dialog: null });
    useToday.setState({ laterPick: null });
  });

  it("⇧B and ⇧F leave the key alone: Change… and Hand to… are an item's", () => {
    expect(changeOnSelected()).toBe(false);
    expect(handOnSelected()).toBe(false);
    expect(shown()).toContain("waiting:8");
    expect(remindLimit({ task: task("waiting:8") })).toBeNull();
  });

  it("plan 216: ⇧D removes it from What matters (its act at what the row was drawn at), the row leaving at once; Undo brings it back", async () => {
    const acts: unknown[] = [];
    const act = fake.handlers["today.waitingAct"]!;
    fake.handlers["today.waitingAct"] = async (p) => (acts.push(p), act(p));
    expect(removeOnSelected()).toBe(true);
    expect(shown()).not.toContain("waiting:8");
    await vi.waitFor(() => expect(acts).toEqual([{ threadId: 8, since: 700, message: 80, rev: 0, action: "remove" }]));
    await vi.waitFor(() => expect(useSnack.getState().undo).toBeTruthy());
    await undo();
    expect(shown()).toContain("waiting:8");
  });
});

describe("plan 210 (iteration 5, R7): how far Remind me may go for the item in hand", () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const now = at(12, 10);
  it("a timed item's own time; an untimed one's day's end; none once passed, nor for what names no day", () => {
    const item = (o: { dueDay: string; dueAt: number; timed: boolean; dated?: boolean }) => ({ task: { kind: "dated" as const, item: { id: 1, revision: 0, kind: "event" as const, dated: true, ...o }, when: null, due: null, dueAt: o.dueAt } });
    // the 12:30 reservation: "Later today 1:00 PM" is past it
    expect(remindLimit(item({ dueDay: "2026-11-12", dueAt: at(12, 12, 30), timed: true }), now)).toBe(at(12, 12, 30));
    expect(remindLimit(item({ dueDay: "2026-11-14", dueAt: at(14, 9), timed: false }), now)).toBe(at(15, 0));
    expect(remindLimit(item({ dueDay: "2026-11-12", dueAt: at(12, 9), timed: true }), now)).toBeNull();
    expect(remindLimit(item({ dueDay: "2026-11-12", dueAt: at(12, 9), timed: false, dated: false }), now)).toBeNull();
    // a promise of yours by its day; one that named none, any time
    expect(remindLimit({ task: { kind: "promise", id: 2, revision: 0, when: null, due: null, dated: true, dueAt: at(13, 16), timed: true } }, now)).toBe(at(13, 16));
    expect(remindLimit({ task: { kind: "promise", id: 2, revision: 0, when: null, due: null, dated: false, noDay: true } }, now)).toBeNull();
  });

  it("iteration 5's code review: a part of the day ends where its part does, the row's, the promise's and the reader's alike", () => {
    // Kai's "by Saturday morning": over at noon, so "Saturday afternoon" is never offered
    const morning = { task: { kind: "dated" as const, item: { id: 1, revision: 0, kind: "respond" as const, dated: true, dueDay: "2026-11-14", timed: false, part: "morning" as const }, when: null, due: null, dueAt: at(14, 9) } };
    expect(remindLimit(morning, now)).toBe(at(14, 12));
    expect(remindLimit({ task: { kind: "promise", id: 2, revision: 0, when: null, due: null, dated: true, dueAt: at(13, 9), timed: false, part: "morning" } }, now)).toBe(at(13, 12));
    const reader = (row: object, source: "dated" | "promise") => ({ item: { source, row } as unknown as ReaderItem });
    expect(remindLimit(reader({ kind: "respond", dated: true, dueDay: "2026-11-14", dueAt: at(14, 13), timed: false, partOfDay: "afternoon" }, "dated"), now)).toBe(at(14, 18));
    expect(remindLimit(reader({ id: 3, kind: "promise", state: "open", dated: true, dueAt: at(13, 9), timed: false, partOfDay: "morning", sentAt: at(11, 9) }, "promise"), now)).toBe(at(13, 12));
  });
});
