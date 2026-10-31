import type { ThreadSummary } from "@terno/core";
import type { RemindersSnapshot } from "@terno/core/rpc";
import { beforeEach, expect, it, vi } from "vitest";

/** Plan 87 in the renderer: the Inbox's top, the Reminders list, and what counts as opening a due one. */
type Params = { cursor?: unknown; limit?: number; dueOnly?: boolean; threadIds?: number[]; filter?: string };
const calls: { method: string; params: Params }[] = [];
let due: ThreadSummary[] = [];
let all: ThreadSummary[] = [];
let page: ThreadSummary[] = [];
vi.mock("~/rpc/connection", () => ({
  client: {
    call: async (method: string, params: Params) => {
      calls.push({ method, params });
      if (method === "reminders.threads") return { items: params.dueOnly ? due : all };
      if (method === "threads.list") return params.cursor ? { items: [row(2), row(9)], nextCursor: null } : { items: page, nextCursor: { lastDate: 1, id: 1 } };
      if (method === "reminders.clear") return { cleared: [] };
      return {};
    },
  },
}));
vi.mock("~/lib/page", () => ({ readerShown: () => true, listLayout: () => false, currentPage: () => "list" }));
vi.mock("~/lib/select", () => ({ currentTargets: () => ({ ids: [] }), prune: () => null }));
vi.mock("~/lib/snack", () => ({ registerUndo: () => ({}), snack: Object.assign(() => {}, { success: () => {}, error: () => {} }) }));

const { getApp, navigate, setApp } = await import("~/state/app");
const { inboxTop, loadMore, reloadList, useList } = await import("~/state/list");
const { applyReminders, noteOpen, OPEN_DWELL_MS } = await import("./reminders");
const { useReminders } = await import("~/state/reminders");

function row(id: number, unread = false): ThreadSummary {
  return { id, lastDate: 1e9 - id, unread, starred: false, hasAttachments: false, categoryIds: [] } as unknown as ThreadSummary;
}
const ids = () => useList.getState().items.map((t) => t.id);
const snapshot = (dueIds: number[], pending: number[] = []): RemindersSnapshot => ({
  reminders: [...dueIds.map((threadId) => ({ threadId, dueAt: 1, kind: "always" as const, setAt: 0, due: true })), ...pending.map((threadId) => ({ threadId, dueAt: 9e12, kind: "always" as const, setAt: 0, due: false }))],
});

beforeEach(async () => {
  calls.length = 0;
  useReminders.setState({ byThread: new Map(), due: 0, loaded: true });
  inboxTop.ids = [];
  setApp({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, reminders: false, folder: null, query: "", selectedId: null, checked: new Set(), listFilters: new Map() });
  await reloadList();
});

it("due ones lead the Inbox's first page, leave the pages after it, and stay under a quick filter", async () => {
  page = [row(1, true), row(2), row(3, true)];
  due = [row(2), row(7)];
  applyReminders(snapshot([2, 7]));
  await vi.waitFor(() => expect(ids()).toEqual([2, 7, 1, 3]));
  await loadMore();
  expect(ids()).toEqual([2, 7, 1, 3, 9]);
  // Unread on: the top's read rows stay
  setApp({ listFilters: new Map([["inbox||", "unread"]]) });
  await vi.waitFor(() => expect(calls.some((c) => c.method === "threads.list" && c.params.filter === "unread")).toBe(true));
  await vi.waitFor(() => expect(ids().slice(0, 2)).toEqual([2, 7]));
  // nothing due: no call for it at all
  calls.length = 0;
  applyReminders(snapshot([]));
  due = [];
  await vi.waitFor(() => expect(ids()).toEqual([1, 3]));
  expect(calls.some((c) => c.method === "reminders.threads")).toBe(false);
});

it("only the plain Inbox has a top; Reminders is its own unfiltered list, soonest first", async () => {
  page = [row(1)];
  due = [row(7)];
  applyReminders(snapshot([7]));
  await vi.waitFor(() => expect(ids()).toEqual([7, 1]));
  setApp({ categoryId: 3, view: "all" });
  await vi.waitFor(() => expect(ids()).toEqual([1]));
  all = [row(7), row(4)];
  setApp({ listFilters: new Map([["all||", "unread"]]) });
  navigate({ reminders: true });
  await vi.waitFor(() => expect(ids()).toEqual([7, 4]));
  expect(calls.at(-1)).toEqual({ method: "reminders.threads", params: { dueOnly: false } });
  // a search from it leaves it
  setApp({ query: "x" });
  expect(getApp().reminders).toBe(false);
});

it("an open due one stays on top until the selection moves on", async () => {
  page = [row(1), row(2)];
  due = [row(7)];
  applyReminders(snapshot([7]));
  await vi.waitFor(() => expect(ids()).toEqual([7, 1, 2]));
  setApp({ selectedId: 7 });
  // opened: its reminder ended (the backend's next snapshot)
  due = [];
  applyReminders(snapshot([]));
  await vi.waitFor(() => expect(calls.filter((c) => c.method === "threads.list").length).toBeGreaterThan(1));
  await new Promise((r) => setTimeout(r, 0));
  expect(ids()).toEqual([7, 1, 2]);
  setApp({ selectedId: 1 });
  await vi.waitFor(() => expect(ids()).toEqual([1, 2]));
});

it("an open ends a due reminder after the dwell, only if it's still the one on screen and still due", async () => {
  vi.useFakeTimers();
  try {
    useReminders.setState({ byThread: new Map(snapshot([7], [8]).reminders.map((r) => [r.threadId, r])), due: 1 });
    setApp({ selectedId: 7 });
    noteOpen(7);
    vi.advanceTimersByTime(OPEN_DWELL_MS - 1);
    expect(calls.some((c) => c.method === "reminders.clear")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(calls.filter((c) => c.method === "reminders.clear").map((c) => c.params)).toEqual([{ threadIds: [7], dueOnly: true }]);
    // moved away before the dwell: nothing; a pending one: nothing
    calls.length = 0;
    noteOpen(7);
    setApp({ selectedId: 8 });
    noteOpen(8);
    vi.advanceTimersByTime(OPEN_DWELL_MS);
    expect(calls.some((c) => c.method === "reminders.clear")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
