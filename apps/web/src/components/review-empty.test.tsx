// @vitest-environment jsdom
/**
 * Plan 192: an emptied Review goes on to the category with the most waiting, by itself after 5 s or at once when
 * pressed, and waits wherever the user is busy; with nothing left anywhere, it offers the Inbox.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  (globalThis as Record<string, unknown>).ResizeObserver = class { observe() {} disconnect() {} };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { connectionVersion: 1, call: () => new Promise(() => {}), on: () => () => {} } }));
vi.mock("~/lib/categorize", async () => {
  const { create } = await import("zustand");
  return { useReviewWork: create(() => ({ pending: 0 })) };
});
const announce = vi.hoisted(() => vi.fn());
vi.mock("~/lib/announce", () => ({ announce }));

const { ReviewEmpty, NEXT_MS } = await import("./review-empty");
const { getApp, setApp } = await import("~/state/app");
const { useSnack } = await import("~/lib/snack");
const { useReviewWork } = await import("~/lib/categorize");
const { useList } = await import("~/state/list");
const { focusQuietly } = await import("~/lib/quiet-focus");

const cat = (id: number, name: string) => ({ id, name, color: "brown" }) as never;
const categories = [cat(1, "Viajes"), cat(2, "Clientes"), cat(3, "Facturas")];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  announce.mockClear();
  useSnack.setState({ paused: [], undoing: 0 });
  useReviewWork.setState({ pending: 0 });
  setApp({ view: "all", categories, reviewCategoryId: 1, selectedId: null, dialog: null, menuOpen: false, compose: null, heldView: null, counts: { ...getApp().counts, categorySuggestions: { 2: 14, 3: 8 } } });
  // (the list's own load, asked for by the view above, never answers here: it's the loaded, emptied one)
  useList.setState({ key: "review", itemsKey: "review", items: [], loading: false, error: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const show = () => act(async () => root.render(<ReviewEmpty category={categories[0]!} />));
const pill = () => host.querySelector<HTMLButtonElement>("[data-testid=review-next]");
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

it("goes on to the category with the most waiting after 5 s, saying where and when", async () => {
  await show();
  expect(pill()!.textContent).toBe("Next: Clientes");
  expect(pill()!.getAttribute("aria-label")).toBe("Go to Clientes now");
  expect(host.textContent).toContain("Nothing’s left to sort in Viajes.");
  expect(announce).toHaveBeenCalledWith("Going on to Clientes in 5 seconds.");
  await wait(NEXT_MS - 50);
  expect(getApp().reviewCategoryId).toBe(1);
  await wait(60);
  expect(getApp().reviewCategoryId).toBe(2);
  expect(announce).toHaveBeenLastCalledWith("Sorting Clientes.");
});

it("pressed, it goes at once", async () => {
  await show();
  await act(async () => pill()!.click());
  expect(getApp().reviewCategoryId).toBe(2);
});

it("the next is never the category in view, though its own count hasn't caught up yet", async () => {
  setApp({ counts: { ...getApp().counts, categorySuggestions: { 1: 30, 3: 8 } } });
  await show();
  expect(pill()!.textContent).toBe("Next: Facturas");
});

it("holds wherever the user is busy, and resumes with the time it had", async () => {
  await show();
  await wait(3000);
  const holds: [string, () => void, () => void][] = [
    ["a dialog", () => setApp({ dialog: "settings" as never }), () => setApp({ dialog: null })],
    ["a menu", () => setApp({ menuOpen: true }), () => setApp({ menuOpen: false })],
    ["a conversation open", () => setApp({ selectedId: 9 }), () => setApp({ selectedId: null })],
    ["a message being written", () => setApp({ compose: {} as never }), () => setApp({ compose: null })],
    ["the dock in use", () => useSnack.setState({ paused: ["hover"] }), () => useSnack.setState({ paused: [] })],
    ["an undo on its way", () => useSnack.setState({ undoing: 1 }), () => useSnack.setState({ undoing: 0 })],
    ["an answer on its way", () => useReviewWork.setState({ pending: 1 }), () => useReviewWork.setState({ pending: 0 })],
    ["covered by a page or a modal", () => host.setAttribute("aria-hidden", "true"), () => host.removeAttribute("aria-hidden")],
    ["inert", () => host.setAttribute("inert", ""), () => host.removeAttribute("inert")],
  ];
  for (const [what, on, off] of holds) {
    await act(async () => on());
    // (the observer's records arrive as a microtask)
    await act(async () => {});
    expect(pill()!.hasAttribute("data-held"), what).toBe(true);
    await wait(10_000);
    expect(getApp().reviewCategoryId, what).toBe(1);
    await act(async () => off());
    await act(async () => {});
    expect(pill()!.hasAttribute("data-held"), what).toBe(false);
    await wait(100);
  }
  // 3 s, then 100 ms after each hold: what's left of the 5 s is still to come
  const spent = 3000 + holds.length * 100;
  await wait(NEXT_MS - spent - 20);
  expect(getApp().reviewCategoryId).toBe(1);
  await wait(40);
  expect(getApp().reviewCategoryId).toBe(2);
});

it("the pointer over it, or focus the user puts there, holds it; focus it takes itself doesn't", async () => {
  // focus left on nothing (the last row's own button went): the way on takes it, and keeps counting
  (document.activeElement as HTMLElement | null)?.blur();
  await show();
  expect(document.activeElement).toBe(pill());
  expect(pill()!.hasAttribute("data-held")).toBe(false);
  // Tab away and back: held while there
  await act(async () => pill()!.blur());
  await act(async () => pill()!.focus());
  expect(pill()!.hasAttribute("data-held")).toBe(true);
  await act(async () => pill()!.blur());
  expect(pill()!.hasAttribute("data-held")).toBe(false);
  // handed there by the app (a page closing, the emptied list): not the user's, it keeps counting
  await act(async () => focusQuietly(pill()));
  expect(document.activeElement).toBe(pill());
  expect(pill()!.hasAttribute("data-held")).toBe(false);
  await act(async () => pill()!.blur());
  const slot = pill()!.parentElement!;
  await act(async () => void slot.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: null })));
  expect(pill()!.hasAttribute("data-held")).toBe(true);
  await act(async () => void slot.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: null })));
  expect(pill()!.hasAttribute("data-held")).toBe(false);
});

it("a window hidden holds it", async () => {
  await show();
  const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
  await wait(10_000);
  expect(getApp().reviewCategoryId).toBe(1);
  state.mockRestore();
  await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
  await wait(NEXT_MS);
  expect(getApp().reviewCategoryId).toBe(2);
});

it("a new destination is a fresh 5 s, said again", async () => {
  await show();
  await wait(4500);
  await act(async () => setApp({ counts: { ...getApp().counts, categorySuggestions: { 2: 1, 3: 8 } } }));
  expect(pill()!.textContent).toBe("Next: Facturas");
  expect(announce).toHaveBeenLastCalledWith("Going on to Facturas in 5 seconds.");
  await wait(NEXT_MS - 100);
  expect(getApp().reviewCategoryId).toBe(1);
  await wait(200);
  expect(getApp().reviewCategoryId).toBe(3);
});

it("with nothing left anywhere it offers the Inbox, no countdown; mail to sort arriving starts one", async () => {
  setApp({ counts: { ...getApp().counts, categorySuggestions: {} } });
  await show();
  expect(pill()).toBeNull();
  expect(host.textContent).toContain("Nothing’s left to sort.");
  await wait(NEXT_MS * 2);
  expect(getApp().reviewCategoryId).toBe(1);
  await act(async () => setApp({ counts: { ...getApp().counts, categorySuggestions: { 3: 2 } } }));
  expect(pill()!.textContent).toBe("Next: Facturas");
  await act(async () => setApp({ counts: { ...getApp().counts, categorySuggestions: {} } }));
  const inbox = host.querySelector<HTMLButtonElement>("[data-testid=review-inbox]")!;
  expect(inbox.textContent).toBe("Go to Inbox");
  await act(async () => inbox.click());
  expect(getApp()).toMatchObject({ view: "inbox", reviewCategoryId: null, categoryId: null, accountId: null });
});

it("gone (Undo brought the rows back), it goes nowhere", async () => {
  await show();
  await wait(2000);
  await act(async () => root.render(<div />));
  await wait(NEXT_MS * 2);
  expect(getApp().reviewCategoryId).toBe(1);
});
