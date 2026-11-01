// @vitest-environment jsdom
/**
 * Plan 107 (Codex code review round 7 #3): a page on its way when the folder you're in is renamed (an IMAP one gets
 * a new key) is retired, and paging goes on under the new key; the rows loaded stay.
 */
import type { ThreadSummary } from "@terno/core";
import { expect, it, vi } from "vitest";

const calls: { method: string; params: { folder?: string; cursor?: unknown }; resolve: (v: unknown) => void }[] = [];
vi.mock("~/rpc/connection", () => ({
  client: {
    connectionVersion: 1,
    call: (method: string, params: { folder?: string }) => new Promise((resolve) => calls.push({ method, params, resolve })),
    on: () => () => {},
  },
}));

window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const { applyFolderRenames } = await import("~/lib/folders");
const { setApp } = await import("./app");
const { listKey, loadMore, useList } = await import("./list");

const row = (id: number) => ({ id, unread: false, starred: false, categoryIds: [], lastDate: 1000 - id }) as unknown as ThreadSummary;

it("a page asked before the rename doesn't freeze paging; the next one goes under the new key", async () => {
  setApp({ accountId: 3, folder: "Work", view: "all", query: "", categoryId: null, reviewCategoryId: null, gmailTab: null, reminders: false, folders: [], settings: { favoriteFolders: [] } as never });
  const items = [row(1), row(2)];
  const key = listKey();
  useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])), key, itemsKey: key, nextCursor: { lastDate: 998, id: 2 }, loading: false, loadingMore: false });
  calls.length = 0;
  void loadMore();
  expect(useList.getState().loadingMore).toBe(true);
  const stale = calls.find((c) => c.method === "threads.list")!;
  expect(stale.params.folder).toBe("Work");

  applyFolderRenames([{ accountId: 3, from: "Work", to: "Job" }]);
  expect(useList.getState().loadingMore).toBe(false);
  expect(useList.getState().items.map((t) => t.id)).toEqual([1, 2]);
  // the old page answers late: nothing of it lands
  stale.resolve({ items: [row(3)], nextCursor: null });
  await new Promise((r) => setTimeout(r, 0));
  expect(useList.getState().items.map((t) => t.id)).toEqual([1, 2]);

  // scrolling asks again, under the new key
  void loadMore();
  const next = calls.filter((c) => c.method === "threads.list").at(-1)!;
  expect(next).not.toBe(stale);
  expect(next.params.folder).toBe("Job");
});
