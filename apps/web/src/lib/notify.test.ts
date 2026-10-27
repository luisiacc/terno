/**
 * Plan 38: a notification's click in the page (openFromNotice), in Split and
 * List. Node, the RPC client mocked (as page.test.ts).
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
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>> };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => fake.handlers[method]?.(params) ?? Promise.resolve({ items: [], nextCursor: null, undoId: null }),
    on: () => () => {},
  },
}));

const { useAppearance } = await import("~/lib/appearance");
const { currentPage } = await import("./page");
const { openFromNotice } = await import("./notify");
const { getApp, setApp } = await import("~/state/app");
const { listKey, useList } = await import("~/state/list");

const row = (id: number): ThreadSummary => ({ id, unread: true, starred: false, categoryIds: [], lastDate: 1000 - id }) as unknown as ThreadSummary;
const layout = (l: "split" | "list") => useAppearance.setState({ layout: l });

beforeEach(async () => {
  layout("split");
  setApp({ view: "inbox", query: "", categoryId: null, reviewCategoryId: null, accountId: null, checked: new Set(), scope: null, readerOpen: false, compose: null, dialog: null, listFilters: new Map() });
  await new Promise((r) => setTimeout(r, 0));
  const items = [row(1), row(2), row(3), row(4)];
  setApp({ selectedId: 1 });
  useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])), key: listKey(), itemsKey: listKey() });
});

describe("a notification's click (plan 38)", () => {
  it("from another mailbox, with Settings open: the unified Inbox, the conversation open, the dialog closed", async () => {
    setApp({ view: "archive", accountId: 2, dialog: "settings" });
    openFromNotice(42);
    expect(getApp()).toMatchObject({ view: "inbox", accountId: null, dialog: null, selectedId: 42, readerOpen: true });
    // the navigation's own reload lands later and must not pick its first row
    await new Promise((r) => setTimeout(r, 0));
    expect(getApp().selectedId).toBe(42);
  });

  it("Codex code review #7: Split, already in the Inbox with a selection: the selection ends and the conversation shows", () => {
    setApp({ checked: new Set([2, 3]), scope: { kind: "view", view: "inbox" } as never });
    openFromNotice(4);
    expect(getApp().checked.size).toBe(0);
    expect(getApp().scope).toBeNull();
    expect(getApp()).toMatchObject({ selectedId: 4, readerOpen: true });
  });

  it("Codex code review #8: List, a conversation's page over the Inbox: a summary's click (no thread) shows the Inbox itself", () => {
    layout("list");
    setApp({ selectedId: 2, readerOpen: true });
    expect(currentPage()).toBe("thread");
    openFromNotice(null);
    expect(currentPage()).toBe("list");
  });

  it("Codex code review #8: List, a new message over the Inbox: a summary's click shows the Inbox (the draft kept)", () => {
    layout("list");
    setApp({ compose: { key: "draft-1", seq: 1 } as never });
    expect(currentPage()).toBe("compose");
    openFromNotice(null);
    expect(currentPage()).toBe("list");
  });
});
