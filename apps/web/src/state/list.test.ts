import type { ThreadSummary } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { expect, it, vi } from "vitest";

const calls: { method: string; params: { cursor?: unknown; limit?: number } }[] = [];
let answer: (params: { cursor?: unknown; limit?: number }) => Promise<unknown> = async () => ({});
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: { cursor?: unknown; limit?: number }) => {
      calls.push({ method, params });
      return answer(params);
    },
  },
}));

const { setApp } = await import("~/state/app");
const { useList, loadMore, PAGE } = await import("~/state/list");

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
