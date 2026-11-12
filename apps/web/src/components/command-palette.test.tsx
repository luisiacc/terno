// @vitest-environment jsdom
/**
 * Plan 88: closed is idle (no render for category or account changes), and a
 * search renders only the matching values, however many categories there are;
 * "Create … and move" moves what it was picked for, whatever is selected by
 * the time the category exists.
 */
import type { Category } from "@terno/core";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, expect, it, vi } from "vitest";
import { setApp } from "~/state/app";

const rpc = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  return { create: null as ((c: unknown) => void) | null, fail: null as ((e: Error) => void) | null };
});
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string) => (method === "categories.create" ? new Promise((resolve, reject) => ((rpc.create = resolve), (rpc.fail = reject))) : new Promise(() => {})),
    on: () => () => {},
  },
}));
const errors = vi.hoisted(() => [] as string[]);
vi.mock("~/lib/snack", async (original) => {
  const real = await original<typeof import("~/lib/snack")>();
  return { ...real, snack: Object.assign((...a: Parameters<typeof real.snack>) => real.snack(...a), real.snack, { error: (title: string) => (errors.push(title), "") }) };
});
const moves = vi.hoisted(() => [] as { categoryId: number; ids: readonly number[] }[]);
vi.mock("~/lib/categorize", async (original) => ({
  ...(await original<typeof import("~/lib/categorize")>()),
  moveToCategory: (categoryId: number, ids: readonly number[]) => (moves.push({ categoryId, ids }), Promise.resolve(null)),
}));
const pinCalls = vi.hoisted(() => [] as string[]);
vi.mock("~/lib/pins", async (original) => ({
  ...(await original<typeof import("~/lib/pins")>()),
  pinThreads: () => (pinCalls.push("pin"), Promise.resolve(true)),
  unpinThreads: () => (pinCalls.push("unpin"), Promise.resolve(true)),
  togglePin: () => void pinCalls.push("toggle"),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// cmdk measures and scrolls the selected item
Element.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const { CommandPalette } = await import("./command-palette");
const { useList } = await import("~/state/list");
const { usePins } = await import("~/state/pins");

const categories = (n: number): Category[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Category ${i + 1}`, color: "brown", position: i, autoApply: false, showInInbox: true }) as Category);

async function type(text: string) {
  const input = document.querySelector<HTMLInputElement>("[data-testid=palette-input]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

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

it("Create and move moves the conversation it was picked for, not the one selected while the category was created", async () => {
  await act(async () => setApp({ categories: categories(3), selectedId: 7, checked: new Set(), scope: null, dialog: "palette" }));
  await act(async () => document.querySelector<HTMLElement>("[data-testid=palette-move]")!.click());
  await type("Nueva");
  await act(async () => document.querySelector<HTMLElement>("[data-testid=palette-create]")!.click());
  // the selection moves on while the category is being created
  await act(async () => setApp({ selectedId: 8 }));
  await act(async () => rpc.create!({ id: 99, name: "Nueva", color: "brown", position: 3, autoApply: false, showInInbox: true }));
  expect(moves).toEqual([{ categoryId: 99, ids: [7] }]);
});

it("a category that can't be created says so (no unhandled rejection) and moves nothing", async () => {
  moves.length = 0;
  await act(async () => setApp({ categories: categories(3), selectedId: 7, checked: new Set(), scope: null, dialog: "palette" }));
  await act(async () => document.querySelector<HTMLElement>("[data-testid=palette-move]")!.click());
  await type("Otra");
  await act(async () => document.querySelector<HTMLElement>("[data-testid=palette-create]")!.click());
  await act(async () => rpc.fail!(new Error("name taken")));
  expect(errors).toEqual(["Couldn’t add: name taken"]);
  expect(moves).toEqual([]);
});

it("plan 179 (Codex review): a mixed selection offers Pin to top and Unpin, and each does what it says (only P toggles)", async () => {
  const row = (id: number) => ({ id, lastDate: 1e9 - id, unread: false, starred: false, hasAttachments: false, categoryIds: [] }) as never;
  await act(async () => setApp({ dialog: null }));
  useList.setState({ items: [row(7), row(8)], index: new Map([[7, 0], [8, 1]]) });
  usePins.setState({ ids: new Set([7]), loaded: true });
  await act(async () => setApp({ selectedId: 7, checked: new Set([7, 8]), scope: null, dialog: "palette" }));
  const pin = document.querySelector<HTMLElement>("[data-testid=palette-pin]");
  const unpin = document.querySelector<HTMLElement>("[data-testid=palette-unpin]");
  expect(pin?.textContent).toContain("Pin to top");
  expect(unpin?.textContent).toContain("Unpin");
  await act(async () => unpin!.click());
  expect(pinCalls).toEqual(["unpin"]);
});
