// @vitest-environment jsdom
/** The pane offers what would change something, as rows change under the selection (mail read elsewhere). */
import type { ThreadSummary } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SelectionBar } = await import("./selection-bar");
const { setApp } = await import("~/state/app");
const { useList } = await import("~/state/list");

const row = (id: number, o: Partial<ThreadSummary>) => ({ id, unread: false, starred: false, categoryIds: [], ...o }) as ThreadSummary;
const put = (items: ThreadSummary[]) => useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
const bar = (id: string) => document.querySelector(`[data-testid=${id}]`);

it("read state and star follow the rows, without a new selection", async () => {
  put([row(1, { unread: true }), row(2, { unread: true }), row(3, {})]);
  setApp({ view: "inbox", query: "", checked: new Set([1, 2]), scope: null });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<SelectionBar />));
  expect(bar("bar-read")).not.toBeNull();
  expect(bar("bar-unread")).toBeNull();
  expect(bar("bar-star")?.textContent).toContain("Star");

  await act(async () => put([row(1, { starred: true }), row(2, { starred: true }), row(3, {})]));
  expect(bar("bar-read")).toBeNull();
  expect(bar("bar-unread")).not.toBeNull();
  expect(bar("bar-star")?.textContent).toContain("Unstar");
  await act(async () => root.unmount());
});
