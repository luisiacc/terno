/**
 * Plan 24: which page List shows, the ways in and out of it, and what Split
 * keeps exactly as it was. Node, the RPC client mocked.
 */
import type { ThreadSummary } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const html = { classList: { contains: () => false, toggle() {} }, dataset: {}, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}), activeElement: null, body: {} };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = { setItem() {}, getItem: () => null, removeItem() {} };
  g.requestAnimationFrame = () => 0;
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>>, calls: [] as string[] };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => {
      fake.calls.push(method);
      return fake.handlers[method]?.(params) ?? Promise.resolve({ items: [], nextCursor: null, undoId: null });
    },
    on: () => () => {},
  },
}));

const { useAppearance } = await import("~/lib/appearance");
const { closePage, currentPage, openThread, pageOf } = await import("./page");
const { act, scheduleMarkRead, toggleStar } = await import("./actions");
const { extendSelection, pressRow, releaseRow, selectAll, selectWhere, toggleCurrent } = await import("./select");
const { useThreads } = await import("~/state/threads");
const { getApp, navigate, setApp } = await import("~/state/app");
const { editCount, flushDeferredRefresh, listAnchor, listKey, patchRows, refreshList, syncRow, useList } = await import("~/state/list");

const row = (id: number): ThreadSummary => ({ id, unread: true, starred: false, categoryIds: [], lastDate: 1000 - id }) as unknown as ThreadSummary;
const layout = (l: "split" | "list") => useAppearance.setState({ layout: l });

beforeEach(async () => {
  fake.handlers = {};
  layout("list");
  const items = [row(1), row(2), row(3), row(4)];
  setApp({ view: "inbox", query: "", categoryId: null, reviewCategoryId: null, accountId: null, checked: new Set(), scope: null, readerOpen: false, compose: null, listFilters: new Map() });
  // a list load the mailbox change above started lands now, before the rows below are set
  await new Promise((r) => setTimeout(r, 0));
  fake.calls = [];
  setApp({ selectedId: 1 });
  useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])), key: listKey(), itemsKey: listKey() });
  fake.handlers["threads.act"] = async () => ({ undoId: null });
});

describe("the page (plan 24)", () => {
  it("List: the list until a conversation is opened, a new message wins; Split never has pages", () => {
    expect(currentPage()).toBe("list");
    setApp({ readerOpen: true });
    expect(currentPage()).toBe("thread");
    expect(pageOf({ compose: { key: "d", seq: 1 }, readerOpen: true, selectedId: 1 })).toBe("compose");
    expect(pageOf({ compose: null, readerOpen: true, selectedId: null })).toBe("list");
    layout("split");
    expect(currentPage()).toBe("list");
  });

  it("opening in List ends a multi-selection (its actions must mean the open thread only, R2); Split keeps it", () => {
    setApp({ checked: new Set([2, 3]) });
    openThread(2);
    expect(getApp()).toMatchObject({ selectedId: 2, readerOpen: true });
    expect(getApp().checked.size).toBe(0);
    layout("split");
    setApp({ checked: new Set([3, 4]) });
    openThread(3);
    expect(getApp().checked.size).toBe(2);
  });

  it("a press only moves List's cursor (it may be a drag starting); the click opens. Split opens on the press, as before", () => {
    pressRow(3, { meta: false, ctrl: false, shift: false });
    expect(getApp()).toMatchObject({ selectedId: 3, readerOpen: false });
    releaseRow(3);
    expect(currentPage()).toBe("thread");
    layout("split");
    setApp({ readerOpen: false });
    pressRow(2, { meta: false, ctrl: false, shift: false });
    expect(getApp()).toMatchObject({ selectedId: 2, readerOpen: true });
  });

  it("navigating to another list closes the page", async () => {
    setApp({ readerOpen: true });
    navigate({ view: "sent" });
    expect(currentPage()).toBe("list");
    // the new list's load lands here, not in the next test
    await new Promise((r) => setTimeout(r, 0));
  });

  it("an action that takes the open thread away returns to the list, the cursor on the next thread", async () => {
    setApp({ selectedId: 2, readerOpen: true });
    await act("archive");
    expect(currentPage()).toBe("list");
    expect(getApp().selectedId).toBe(3);
  });

  it("mark unread is done reading it: back to the list; a star stays on the page", async () => {
    setApp({ selectedId: 2, readerOpen: true });
    await act("star");
    expect(currentPage()).toBe("thread");
    await act("markUnread");
    expect(currentPage()).toBe("list");
    expect(getApp().selectedId).toBe(2);
  });

  it("an action on the list page, or in Split, changes no page", async () => {
    setApp({ selectedId: 2 });
    await act("archive");
    expect(getApp()).toMatchObject({ readerOpen: false, selectedId: 3 });
    layout("split");
    setApp({ readerOpen: true });
    await act("archive");
    expect(getApp().readerOpen).toBe(true);
  });

  it("closePage leaves a new message the way Esc does (kept if written), and lands on the list (R1)", () => {
    setApp({ selectedId: 2, readerOpen: false, compose: { key: "nope", seq: 1 } });
    expect(currentPage()).toBe("compose");
    closePage();
    expect(getApp().compose).toBeNull();
    expect(currentPage()).toBe("list");
  });
});

describe("what the Codex code review found", () => {
  it("no selection can be made under a page (the reader's actions would act on it, unseen): ⌘A, x, ⇧J, * r", () => {
    setApp({ selectedId: 2, readerOpen: true });
    selectAll();
    toggleCurrent();
    extendSelection(1);
    selectWhere(() => true);
    expect(getApp().checked.size).toBe(0);
    // on the list they work as ever
    closePage();
    selectAll();
    expect(getApp().checked.size).toBe(4);
  });

  it("a conversation the list doesn't hold (a reload on one): its star toggles from what the reader shows, and the dwell reads it", async () => {
    const acts: string[] = [];
    fake.handlers["threads.act"] = async (p) => (acts.push((p as { action: string }).action), { undoId: null });
    useThreads.setState({ details: new Map([[99, { thread: { ...row(99), starred: true, unread: true }, messages: [] } as never]]) });
    setApp({ selectedId: 99, readerOpen: true });
    toggleStar();
    await vi.waitFor(() => expect(acts).toEqual(["unstar"]));
    vi.useFakeTimers();
    scheduleMarkRead(99);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    await vi.waitFor(() => expect(acts).toEqual(["unstar", "markRead"]));
  });

  it("Split → List lands on the list, the cursor kept (Split's open thread isn't a page)", () => {
    layout("split");
    setApp({ selectedId: 3, readerOpen: true });
    layout("list");
    expect(currentPage()).toBe("list");
    expect(getApp().selectedId).toBe(3);
  });

  it("a search under a page (the palette's, a sender's): the list shows with its results", () => {
    setApp({ selectedId: 2, readerOpen: true });
    setApp({ query: "factura" });
    expect(currentPage()).toBe("list");
  });

  it("List keeps a deep window through an ordinary refresh too (an archive 600 rows down returns to the same list)", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => row(i + 1));
    useList.setState({ items: many, index: new Map(many.map((t, i) => [t.id, i])) });
    const limits: number[] = [];
    fake.handlers["threads.list"] = async (p) => {
      const { limit, cursor } = p as { limit: number; cursor?: { id: number } };
      limits.push(limit);
      const start = cursor ? cursor.id : 0;
      return { items: many.slice(start, start + limit), nextCursor: { lastDate: 0, id: start + limit } };
    };
    refreshList(false, true);
    await vi.waitFor(() => expect(limits).toEqual([500, 500, 200]));
    // Split: today's single capped page
    limits.length = 0;
    await vi.waitFor(() => expect(useList.getState().items).toHaveLength(1200));
    refreshList(false, false);
    await vi.waitFor(() => expect(limits).toEqual([500]));
  });
});

describe("what the second Codex review found", () => {
  it("the open thread's row follows its refreshed detail while the list waits, so the star toggles the right way", async () => {
    const acts: string[] = [];
    fake.handlers["threads.act"] = async (p) => (acts.push((p as { action: string }).action), { undoId: null });
    setApp({ selectedId: 2, readerOpen: true });
    // another client starred it: the reader's detail says so; the covered list's row doesn't yet
    syncRow({ id: 2, starred: true, unread: true, categoryIds: [] }, editCount());
    toggleStar();
    await vi.waitFor(() => expect(acts).toEqual(["unstar"]));
  });

  it("a refetch older than an optimistic edit doesn't overwrite it", () => {
    const since = editCount();
    patchRows([3], (t) => ({ ...t, starred: true }));
    syncRow({ id: 3, starred: false, unread: true, categoryIds: [] }, since);
    expect(useList.getState().items[2]!.starred).toBe(true);
  });

  it("a search or another list while writing a new message shows the list (the draft left as Esc leaves it)", () => {
    setApp({ compose: { key: "k1", seq: 1 } });
    expect(currentPage()).toBe("compose");
    setApp({ query: "factura" });
    expect(currentPage()).toBe("list");
    expect(getApp().compose).toBeNull();
    setApp({ query: "", compose: { key: "k2", seq: 2 } });
    navigate({ view: "sent" });
    expect(currentPage()).toBe("list");
    expect(getApp().compose).toBeNull();
  });

  it("archiving the list's only thread from its page closes the page for good (nothing left to open with j)", async () => {
    useList.setState({ items: [row(7)], index: new Map([[7, 0]]) });
    setApp({ selectedId: 7, readerOpen: true });
    await act("archive");
    expect(getApp()).toMatchObject({ selectedId: null, readerOpen: false });
  });

  it("the window refresh reaches the rows that were on screen when new mail pushed them past the old count", async () => {
    // 100 loaded, the first row on screen is #95; 30 new threads arrive above everything
    const old = Array.from({ length: 100 }, (_, i) => row(i + 1));
    const fresh = Array.from({ length: 30 }, (_, i) => row(1000 + i));
    const now = [...fresh, ...old];
    useList.setState({ items: old, index: new Map(old.map((t, i) => [t.id, i])) });
    setApp({ selectedId: 96 });
    listAnchor.firstVisible = () => 95;
    fake.handlers["threads.list"] = async (p) => {
      const { limit, cursor } = p as { limit: number; cursor?: { id: number } };
      const start = cursor ? cursor.id : 0;
      return { items: now.slice(start, start + limit), nextCursor: start + limit < now.length ? { lastDate: 0, id: start + limit } : null };
    };
    refreshList(true);
    flushDeferredRefresh();
    // the refresh landed (the new mail is in), and it reaches the rows that were on screen
    await vi.waitFor(() => expect(useList.getState().index.has(1000)).toBe(true));
    expect(useList.getState().index.has(95)).toBe(true);
    expect(useList.getState().index.has(96)).toBe(true);
    listAnchor.firstVisible = undefined;
  });
});

describe("the covered list's refresh (R4)", () => {
  it("waits while a page covers the list, then reloads its whole loaded window once, in pieces of at most 500", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => row(i + 1));
    useList.setState({ items: many, index: new Map(many.map((t, i) => [t.id, i])) });
    const limits: number[] = [];
    fake.handlers["threads.list"] = async (p) => {
      const { limit, cursor } = p as { limit: number; cursor?: { id: number } };
      limits.push(limit);
      const start = cursor ? cursor.id : 0;
      const items = many.slice(start, start + limit);
      return { items, nextCursor: start + limit < 2000 ? { lastDate: 0, id: start + limit } : null };
    };
    refreshList(true);
    await Promise.resolve();
    expect(fake.calls.filter((c) => c === "threads.list")).toHaveLength(0);
    flushDeferredRefresh();
    await vi.waitFor(() => expect(limits).toEqual([500, 500, 200]));
    await vi.waitFor(() => expect(useList.getState().items).toHaveLength(1200));
    // once
    flushDeferredRefresh();
    await Promise.resolve();
    expect(limits).toHaveLength(3);
  });

  it("not covered: today's refresh", async () => {
    refreshList(false);
    await vi.waitFor(() => expect(fake.calls).toContain("threads.list"));
  });
});
