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

const row = (id: number, unread: boolean) => ({ id, lastDate: 1e9 - id, unread }) as unknown as ThreadSummary;

it("the unread filter: a filtered mailbox asks for unread threads, keeping the open and checked ones, and counts its unread", async () => {
  answer = async (p, method) => (method === "threads.scopeCount" ? { count: 1234, capped: false } : { items: [row(1, true), row(2, false), row(3, true)], nextCursor: null });
  setApp({ query: "", view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, selectedId: null, checked: new Set() });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain('"inbox"'));
  calls.length = 0;
  // the filter toggles on with thread 2 open and nothing checked: the same mailbox, the open thread kept
  setApp({ selectedId: 2, unreadFilters: new Set(["inbox||"]) });
  await vi.waitFor(() => expect(useList.getState().unreadTotal?.n).toBe(1234));
  const list = calls.find((c) => c.method === "threads.list")!;
  expect(list.params).toMatchObject({ unreadOnly: true, keepIds: [2] });
  expect(calls.find((c) => c.method === "threads.scopeCount")!.params.scope).toEqual({ kind: "view", view: "inbox", unreadOnly: true });
  const { getApp } = await import("~/state/app");
  expect(getApp().selectedId).toBe(2);

  // a filtered search: the filter goes with the query; the kept row it showed stays at its place
  answer = async () => ({ items: [row(1, true), row(3, true)], nextCursor: null, strategy: "fts", tookMs: 1, complete: true });
  setApp({ query: "factura" });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain("factura"));
  expect(calls.at(-1)!.params).toMatchObject({ query: "in:inbox factura", unreadOnly: true });
  setApp({ selectedId: 3 });
  patchRows([3], (t) => ({ ...t, unread: false }));
  await reloadList({ keepSelection: true });
  expect(useList.getState().items.map((t) => [t.id, t.unread])).toEqual([[1, true], [3, true]]);
  answer = async () => ({ items: [row(1, true)], nextCursor: null, strategy: "fts", tookMs: 1, complete: true });
  await reloadList({ keepSelection: true });
  expect(useList.getState().items.map((t) => t.id)).toEqual([1, 3]);
  setApp({ unreadFilters: new Set(), query: "" });
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
