// @vitest-environment jsdom
/**
 * Plan 88: closed is idle (no render for category or account changes), and a
 * search renders only the matching values, however many categories there are.
 */
import type { Category } from "@terno/core";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, expect, it, vi } from "vitest";
import { setApp } from "~/state/app";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
vi.mock("~/rpc/connection", () => ({ client: { call: () => new Promise(() => {}), on: () => () => {} } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// cmdk measures and scrolls the selected item
Element.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const { CommandPalette } = await import("./command-palette");

const categories = (n: number): Category[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Category ${i + 1}`, color: "indigo", position: i, autoApply: false, showInInbox: true }) as Category);

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterAll(() => act(() => root.unmount()));

it("renders nothing while closed and doesn't re-render for the categories", async () => {
  let renders = 0;
  await act(async () =>
    root.render(
      <Profiler id="palette" onRender={() => renders++}>
        <CommandPalette />
      </Profiler>,
    ),
  );
  const first = renders;
  act(() => setApp({ categories: categories(500), selectedId: 1 }));
  act(() => setApp({ categories: categories(501) }));
  expect(renders).toBe(first);
  expect(document.querySelectorAll("[cmdk-item]")).toHaveLength(0);
});

it("a search renders only the values that match it", async () => {
  await act(async () => setApp({ dialog: "palette" }));
  const input = document.querySelector<HTMLInputElement>("[data-testid=palette-input]")!;
  expect(input).not.toBeNull();
  // the root lists each category once (Go to); Move and Add to wait for a query
  expect(document.querySelectorAll('[data-command^="move:"], [data-command^="addTo:"]')).toHaveLength(0);
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "move to category 42");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const moves = [...document.querySelectorAll<HTMLElement>('[data-command^="move:"]')];
  expect(moves.length).toBeGreaterThan(0);
  expect(moves.length).toBeLessThan(50);
  expect(moves[0]!.dataset.command).toBe("move:42");
  await act(async () => setApp({ dialog: null }));
});
