/**
 * Plan 24: j at the end of the loaded rows on List's conversation page asks
 * for the next page, then moves. A page that answers after the user moved
 * again, or went back to the list, moves nothing for them (Codex review).
 * Node; the RPC client and the components keyboard.ts reaches are stubbed.
 */
import type { ThreadSummary } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const html = { classList: { contains: () => false, toggle() {} }, dataset: {}, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}), activeElement: null, body: {}, addEventListener() {} };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = { setItem() {}, getItem: () => null, removeItem() {} };
  g.requestAnimationFrame = () => 0;
  return { page: null as null | ((v: unknown) => void), calls: [] as string[] };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string) => {
      fake.calls.push(method);
      // the next page waits until the test answers it
      if (method === "threads.list") return new Promise((resolve) => (fake.page = resolve));
      return Promise.resolve({});
    },
    on: () => () => {},
  },
}));
vi.mock("~/components/thread-list", () => ({ listScroller: {}, focusSearch() {} }));
vi.mock("~/components/snack-dock", () => ({ focusDock() {} }));
vi.mock("~/components/thread-menu", () => ({ openMenuForSelection() {} }));
vi.mock("~/components/category-snackbar", () => ({ snackbarControls: { current: null } }));

const { move } = await import("./keyboard");
const { useAppearance } = await import("~/lib/appearance");
const { closePage } = await import("./page");
const { getApp, setApp } = await import("~/state/app");
const { listKey, useList } = await import("~/state/list");

const row = (id: number): ThreadSummary => ({ id, unread: false, starred: false, categoryIds: [], lastDate: 1000 - id }) as unknown as ThreadSummary;
const nextPage = { items: [row(4), row(5)], nextCursor: null };

beforeEach(() => {
  fake.page = null;
  useAppearance.setState({ layout: "list" });
  setApp({ view: "inbox", query: "", categoryId: null, accountId: null, reviewCategoryId: null, checked: new Set(), compose: null, selectedId: 3, readerOpen: true });
  const items = [row(1), row(2), row(3)];
  useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])), key: listKey(), itemsKey: listKey(), nextCursor: { lastDate: 0, id: 3 }, loading: false, loadingMore: false });
});

describe("j past the loaded rows on the page (plan 24)", () => {
  it("loads the next page, then moves to its first thread", async () => {
    move(1);
    await vi.waitFor(() => expect(fake.page).not.toBeNull());
    fake.page!(nextPage);
    await vi.waitFor(() => expect(getApp().selectedId).toBe(4));
  });

  it("a page that answers after k moved the cursor doesn't move it again", async () => {
    move(1);
    await vi.waitFor(() => expect(fake.page).not.toBeNull());
    move(-1);
    expect(getApp().selectedId).toBe(2);
    fake.page!(nextPage);
    await vi.waitFor(() => expect(useList.getState().items).toHaveLength(5));
    expect(getApp().selectedId).toBe(2);
  });

  it("a page that answers after Esc moves nothing on the list", async () => {
    move(1);
    await vi.waitFor(() => expect(fake.page).not.toBeNull());
    closePage();
    fake.page!(nextPage);
    await vi.waitFor(() => expect(useList.getState().items).toHaveLength(5));
    expect(getApp().selectedId).toBe(3);
  });
});
