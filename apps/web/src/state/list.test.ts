import type { ThreadSummary } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { expect, it, vi } from "vitest";

type Params = { cursor?: unknown; limit?: number; unreadOnly?: boolean; keepIds?: number[]; query?: string; scope?: unknown };
const calls: { method: string; params: Params }[] = [];
let answer: (params: Params, method: string) => Promise<unknown> = async () => ({});
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: Params) => {
      calls.push({ method, params });
      return answer(params, method);
    },
  },
}));

const { setApp } = await import("~/state/app");
const { useList, loadMore, PAGE, patchRows, reloadList } = await import("~/state/list");

const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, lastDate: 1e9 - from - i }) as unknown as ThreadSummary);
const cursor = (id: number) => ({ lastDate: 1e9 - id, id, revision: { epoch: "e", seq: 1 }, queryKey: "k" });

it("a STALE search page refetches from the top with the loaded window plus a page, keeping the selection", async () => {
  answer = async (p) => ({ items: rows(0, p.limit ?? PAGE), nextCursor: cursor((p.limit ?? PAGE) - 1), strategy: "fts", tookMs: 1, complete: true });
  setApp({ query: "factura" });
  await vi.waitFor(() => expect(useList.getState().items).toHaveLength(PAGE));
  setApp({ selectedId: 42 });
  calls.length = 0;
  answer = async (p) => {
    if (p.cursor) throw new RpcError("STALE", "The mailbox changed since this page", { reason: "revision" });
    return { items: rows(0, p.limit!), nextCursor: cursor(p.limit! - 1), strategy: "fts", tookMs: 1, complete: true };
  };
  await loadMore();
  await vi.waitFor(() => expect(useList.getState().items).toHaveLength(2 * PAGE));
  expect(calls.map((c) => [c.method, c.params.cursor ? "cursor" : "top", c.params.limit])).toEqual([
    ["threads.search", "cursor", PAGE],
    ["threads.search", "top", 2 * PAGE],
  ]);
  expect(useList.getState().nextCursor).toEqual(cursor(2 * PAGE - 1));
  const { getApp } = await import("~/state/app");
  expect(getApp().selectedId).toBe(42);
  expect(useList.getState().loadingMore).toBe(false);
});

const row = (id: number, unread: boolean, starred = false) => ({ id, lastDate: 1e9 - id, unread, starred, hasAttachments: false }) as unknown as ThreadSummary;

it("the unread filter: a filtered mailbox asks for unread threads, keeping the open and checked ones, and counts its unread", async () => {
  answer = async (p, method) => (method === "threads.scopeCount" ? { count: 1234, capped: false } : { items: [row(1, true), row(2, false), row(3, true)], nextCursor: null });
  setApp({ query: "", view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, selectedId: null, checked: new Set() });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain('"inbox"'));
  calls.length = 0;
  // the filter toggles on with thread 2 open and nothing checked: the same mailbox, the open thread kept
  setApp({ selectedId: 2, listFilters: new Map([["inbox||", "unread"]]) });
  await vi.waitFor(() => expect(useList.getState().unreadTotal?.n).toBe(1234));
  const list = calls.find((c) => c.method === "threads.list")!;
  expect(list.params).toMatchObject({ filter: "unread", keepIds: [2] });
  expect(calls.find((c) => c.method === "threads.scopeCount")!.params.scope).toEqual({ kind: "view", view: "inbox", filter: "unread" });
  const { getApp } = await import("~/state/app");
  expect(getApp().selectedId).toBe(2);

  // a filtered search: the filter goes with the query; the kept row it showed stays at its place
  answer = async () => ({ items: [row(1, true), row(3, true)], nextCursor: null, strategy: "fts", tookMs: 1, complete: true });
  setApp({ query: "factura" });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain("factura"));
  // plan 64: a search looks everywhere, the Inbox's filter still goes with it
  expect(calls.at(-1)!.params).toMatchObject({ query: "factura", filter: "unread" });
  expect(calls.at(-1)!.params).toMatchObject({ accountId: undefined, categoryId: undefined });
  setApp({ selectedId: 3 });
  patchRows([3], (t) => ({ ...t, unread: false }));
  await reloadList({ keepSelection: true });
  expect(useList.getState().items.map((t) => [t.id, t.unread])).toEqual([[1, true], [3, true]]);
  answer = async () => ({ items: [row(1, true)], nextCursor: null, strategy: "fts", tookMs: 1, complete: true });
  await reloadList({ keepSelection: true });
  expect(useList.getState().items.map((t) => t.id)).toEqual([1, 3]);
  setApp({ listFilters: new Map(), query: "" });
});

it("the starred filter (plan 15): asked for as a filter, a thread unstarred elsewhere is dropped unless it's the open one", async () => {
  answer = async () => ({ items: [row(30, false, true), row(31, false, false), row(32, false, true)], nextCursor: null });
  setApp({ view: "inbox", query: "", listFilters: new Map([["inbox||", "starred"]]), selectedId: 31, checked: new Set() });
  await vi.waitFor(() => expect(calls.at(-1)!.params).toMatchObject({ filter: "starred", keepIds: [31] }));
  await vi.waitFor(() => expect(useList.getState().items.map((t) => t.id)).toEqual([30, 31, 32]));
  setApp({ selectedId: 30 });
  await reloadList({ keepSelection: true });
  expect(useList.getState().items.map((t) => t.id)).toEqual([30, 32]);
  setApp({ listFilters: new Map() });
});

it("a filtered answer asked for while a thread was open doesn't keep it once the selection moved off it", async () => {
  answer = async () => ({ items: [row(20, true), row(21, true), row(22, true)], nextCursor: null });
  setApp({ view: "starred", query: "", listFilters: new Map([["starred||", "unread"]]), selectedId: null, checked: new Set() });
  await vi.waitFor(() => expect(useList.getState().items.map((t) => t.id)).toEqual([20, 21, 22]));
  setApp({ selectedId: 20 });
  // 20 was read elsewhere; the refresh asks to keep it (open), and answers after the user moved to 21
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  answer = async (p) => {
    expect(p.keepIds).toEqual([20]);
    await held;
    return { items: [row(20, false), row(21, true), row(22, true)], nextCursor: null };
  };
  const refresh = reloadList({ keepSelection: true });
  setApp({ selectedId: 21 });
  release();
  await refresh;
  expect(useList.getState().items.map((t) => t.id)).toEqual([21, 22]);
  setApp({ listFilters: new Map() });
});

it("an optimistic edit wins over a reload that was already on its way: the answer is dropped and asked again", async () => {
  answer = async () => ({ items: [row(10, true), row(11, true)], nextCursor: null });
  setApp({ view: "archive", query: "" });
  await vi.waitFor(() => expect(useList.getState().items.map((t) => t.id)).toEqual([10, 11]));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let n = 0;
  // the first refresh answers late with 11 still there; the one after the edit knows it's gone
  answer = async () => (n++ === 0 ? (await held, { items: [row(10, true), row(11, true)], nextCursor: null }) : { items: [row(10, true)], nextCursor: null });
  const refresh = reloadList({ keepSelection: true });
  patchRows([11], () => null);
  release();
  await refresh;
  await vi.waitFor(() => expect(n).toBe(2));
  await vi.waitFor(() => expect(useList.getState().items.map((t) => t.id)).toEqual([10]));
});

it("a filtered search page with nothing kept but more after it: the list asks for the next one by itself (plan 15)", async () => {
  // first page empty with a cursor, the next one has the results
  answer = async (p) => (p.cursor ? { items: rows(500, 3).map((t) => ({ ...t, hasAttachments: true })), nextCursor: null, strategy: "fts", tookMs: 1, complete: true } : { items: [], nextCursor: cursor(99), strategy: "fts", tookMs: 1, complete: true });
  setApp({ view: "inbox", query: "zanahoria", listFilters: new Map([["inbox||", "attachments"]]) });
  await vi.waitFor(() => expect(useList.getState().items.map((t) => t.id)).toEqual([500, 501, 502]));
  expect(useList.getState().nextCursor).toBeNull();
  setApp({ query: "", listFilters: new Map() });
});

it("a page still on its way for the last search doesn't hold the next one (Codex review round 2)", async () => {
  // search A: an empty page with more after it, and the next page held
  let releaseA!: () => void;
  const heldA = new Promise<void>((r) => (releaseA = r));
  answer = async (p) => {
    if (p.query?.includes("alfa")) {
      if (!p.cursor) return { items: [], nextCursor: cursor(10), strategy: "fts", tookMs: 1, complete: true };
      await heldA;
      return { items: rows(900, 2).map((t) => ({ ...t, hasAttachments: true })), nextCursor: null, strategy: "fts", tookMs: 1, complete: true };
    }
    // search B: the same shape, answered at once
    return p.cursor ? { items: rows(700, 3).map((t) => ({ ...t, hasAttachments: true })), nextCursor: null, strategy: "fts", tookMs: 1, complete: true } : { items: [], nextCursor: cursor(20), strategy: "fts", tookMs: 1, complete: true };
  };
  setApp({ view: "inbox", query: "alfa", listFilters: new Map([["inbox||", "attachments"]]) });
  await vi.waitFor(() => expect(useList.getState().loadingMore).toBe(true));
  setApp({ query: "beta" });
  await vi.waitFor(() => expect(useList.getState().items.map((t) => t.id)).toEqual([700, 701, 702]));
  releaseA();
  await new Promise((r) => setTimeout(r, 10));
  expect(useList.getState().items.map((t) => t.id)).toEqual([700, 701, 702]);
  expect(useList.getState().loadingMore).toBe(false);
  setApp({ query: "", listFilters: new Map() });
});

it("scrolling while the next list's first page is on its way doesn't continue the last list's cursor (Codex review round 3)", async () => {
  answer = async (p) => ({ items: rows(100, 3), nextCursor: cursor(102), strategy: "fts", tookMs: 1, complete: true, ...(p.query ? {} : {}) });
  setApp({ view: "inbox", query: "gamma", listFilters: new Map() });
  await vi.waitFor(() => expect(useList.getState().items.map((t) => t.id)).toEqual([100, 101, 102]));
  // the next search's first page is held
  let releaseB!: () => void;
  const heldB = new Promise<void>((r) => (releaseB = r));
  answer = async (p) => {
    if (p.cursor) return { items: rows(50, 2), nextCursor: null, strategy: "fts", tookMs: 1, complete: true };
    await heldB;
    return { items: rows(300, 3), nextCursor: cursor(302), strategy: "fts", tookMs: 1, complete: true };
  };
  calls.length = 0;
  setApp({ query: "delta" });
  await vi.waitFor(() => expect(useList.getState().loading).toBe(true));
  await loadMore();
  expect(calls.filter((c) => c.params.cursor)).toEqual([]);
  releaseB();
  await vi.waitFor(() => expect(useList.getState().items.map((t) => t.id)).toEqual([300, 301, 302]));
  expect(useList.getState().nextCursor).toEqual(cursor(302));
  setApp({ query: "" });
});

it("plan 158: a mailbox comes back with its open thread, or the row now nearest it, and what the app opens isn't the user's choice", async () => {
  const { getApp, openedByApp } = await import("~/state/app");
  answer = async (_p, method) => (method === "threads.search" ? { items: rows(900, 2), nextCursor: null, strategy: "fts", tookMs: 1, complete: true } : { items: rows(0, 8), nextCursor: null });
  setApp({ query: "", view: "archive", accountId: null, categoryId: null, reviewCategoryId: null, selectedId: null, checked: new Set() });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain('"archive"'));
  expect(openedByApp(0)).toBe(true);
  setApp({ selectedId: 5 });
  expect(openedByApp(5)).toBe(false);

  setApp({ query: "pago" });
  await vi.waitFor(() => expect(getApp().selectedId).toBe(900));
  expect(openedByApp(900)).toBe(true);
  setApp({ query: "" });
  await vi.waitFor(() => expect(getApp().selectedId).toBe(5));
  expect(openedByApp(5)).toBe(true);

  // archived elsewhere while the search was on: the row that took its place
  setApp({ query: "pago" });
  await vi.waitFor(() => expect(getApp().selectedId).toBe(900));
  answer = async () => ({ items: rows(0, 8).filter((t) => t.id !== 5), nextCursor: null });
  setApp({ query: "" });
  await vi.waitFor(() => expect(getApp().selectedId).toBe(6));
});

it("plan 158: a mailbox left past its first window asks on until the thread and the row it was on are back", async () => {
  const { getApp } = await import("~/state/app");
  const window = (p: Params) => {
    const from = (p.cursor as { id: number } | undefined)?.id ?? -1;
    return { items: rows(from + 1, p.limit!), nextCursor: cursor(from + p.limit!) };
  };
  answer = async (p, method) => (method === "threads.search" ? { items: rows(9000, 1), nextCursor: null, strategy: "fts", tookMs: 1, complete: true } : window(p));
  setApp({ query: "", view: "sent", selectedId: null, checked: new Set() });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain('"sent"'));
  for (let i = 0; i < 7; i++) await loadMore();
  expect(useList.getState().items).toHaveLength(8 * PAGE);
  setApp({ selectedId: 750 });
  setApp({ query: "pago" });
  await vi.waitFor(() => expect(getApp().selectedId).toBe(9000));
  calls.length = 0;
  setApp({ query: "" });
  await vi.waitFor(() => expect(getApp().selectedId).toBe(750));
  expect(calls.filter((c) => c.method === "threads.list").map((c) => c.params.limit)).toEqual([500, 500]);
  // the whole list isn't read for it: a row that's gone stops at what was loaded and a little past
  setApp({ query: "pago" });
  await vi.waitFor(() => expect(getApp().selectedId).toBe(9000));
  calls.length = 0;
  answer = async (p) => { const page = window(p); return { ...page, items: page.items.filter((t) => t.id !== 750) }; };
  setApp({ query: "" });
  await vi.waitFor(() => expect(getApp().selectedId).toBe(751));
  expect(calls.filter((c) => c.method === "threads.list").length).toBeLessThanOrEqual(5);
});

it("plan 195: what arrived is the rows above every row that was there, 1 to 3, none the user just removed", async () => {
  const { arrivedOnTop } = await import("~/state/list");
  const before = new Map([[10, 0], [11, 1], [12, 2]]);
  expect(arrivedOnTop(before, rows(8, 5))).toEqual([8, 9]);
  // a row that moved up isn't new
  expect(arrivedOnTop(before, [...rows(11, 1), ...rows(10, 1), ...rows(12, 1)])).toEqual([]);
  // the Inbox's top (Pinned, Reminders) stands above where mail arrives
  expect(arrivedOnTop(before, [...rows(20, 1), ...rows(8, 5)], new Set([20]))).toEqual([8, 9]);
  // only rows live mail came to: anything else above them (a restore elsewhere) and nothing arrives
  expect(arrivedOnTop(before, rows(8, 5), new Set(), new Set([8, 9]))).toEqual([8, 9]);
  expect(arrivedOnTop(before, rows(8, 5), new Set(), new Set([9]))).toEqual([]);
  // a sync's batch just appears
  expect(arrivedOnTop(before, rows(6, 7))).toEqual([]);
  // an undo bringing back a row the user archived (an optimistic removal) isn't new mail
  useList.setState({ items: rows(9, 4), index: new Map(rows(9, 4).map((t, i) => [t.id, i])) });
  patchRows([9], () => null);
  expect(arrivedOnTop(before, rows(8, 5))).toEqual([]);
});

it("plan 198: the list on screen going from rows to none is said once, by its key; another list never", async () => {
  const { takeEmptied } = await import("~/state/list");
  useList.setState({ key: "k1", itemsKey: "k1", items: rows(1, 2), index: new Map([[1, 0], [2, 1]]) });
  patchRows([1, 2], () => null);
  expect(takeEmptied("k2")).toBe(false);
  expect(takeEmptied("k1")).toBe(true);
  expect(takeEmptied("k1")).toBe(false);
  // emptied, then another list before its empty state showed: spent
  useList.setState({ items: rows(1, 1), index: new Map([[1, 0]]) });
  patchRows([1], () => null);
  useList.setState({ key: "k2", itemsKey: "k2", items: [], index: new Map() });
  expect(takeEmptied("k2")).toBe(false);
  useList.setState({ key: "k1", itemsKey: "k1" });
  expect(takeEmptied("k1")).toBe(false);
});

it("plan 195 (Codex code review #2): a refresh while another mailbox is still on its way plays no arrival against the last one's rows", async () => {
  const { listArrival, listKey } = await import("~/state/list");
  const played: number[][] = [];
  Object.assign(listArrival, { on: () => true, arm: () => {}, play: (ids: readonly number[]) => played.push([...ids]) });
  try {
    // Archive on screen
    answer = async () => ({ items: rows(10, 3), nextCursor: null });
    setApp({ query: "", view: "archive", listFilters: new Map() });
    await vi.waitFor(() => expect(useList.getState().itemsKey).toBe(listKey()));
    // Starred asked for, its page held back: Archive's rows still shown
    let release!: () => void;
    answer = () => new Promise((r) => (release = () => r({ items: rows(1, 2), nextCursor: null })));
    setApp({ view: "starred" });
    await vi.waitFor(() => expect(useList.getState().key).toBe(listKey()));
    expect(useList.getState().itemsKey).not.toBe(listKey());
    // live mail meanwhile: the refresh answers first with Starred's rows, two "new" above nothing Archive had
    answer = async () => ({ items: rows(1, 2), nextCursor: null });
    await reloadList({ keepSelection: true, arrived: [1, 2] });
    release();
    expect(played).toEqual([]);
  } finally {
    listArrival.on = listArrival.arm = listArrival.play = undefined;
  }
});
