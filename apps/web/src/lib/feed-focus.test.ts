// @vitest-environment jsdom
/**
 * Plan 210 (Codex code review, round 2): the keys back on What matters' feed: the item is brought into view even when it's
 * drawn (the overscan reaches past the edge), and the ring is the move's: kept for F6 and the skip link, gone after a key
 * the app answered.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => null), on: () => () => {}, connectionVersion: 1 } }));

const { focusFeed, focusFeedItem } = await import("./feed-focus");
const { listScroller } = await import("./list-scroller");
const { setApp } = await import("~/state/app");
const { useList } = await import("~/state/list");

const scrolled: number[] = [];
beforeEach(() => {
  document.body.innerHTML = `<section data-testid="wm-feed">${[1, 2, 3].map((id) => `<div data-item-id="${id}"><button data-testid="wm-item-open">${id}</button></div>`).join("")}</section>`;
  document.documentElement.setAttribute("data-focus-ring", "");
  scrolled.length = 0;
  listScroller.scrollToIndex = (i) => scrolled.push(i);
  useList.setState({ index: new Map([[1, 0], [2, 1], [3, 2]]) });
  setApp({ selectedId: 3 });
});
afterEach(() => {
  listScroller.scrollToIndex = undefined;
  setApp({ selectedId: null });
});

const focused = () => document.activeElement?.closest("[data-item-id]")?.getAttribute("data-item-id");

it("a drawn item is scrolled into view too, then focused; F6's and the skip link's move keep the ring", () => {
  expect(focusFeed()).toBe(true);
  expect(focused()).toBe("3");
  expect(scrolled).toEqual([2]);
  expect(document.documentElement.hasAttribute("data-focus-ring")).toBe(true);
});

it("after a key the app answered (j/k, Esc), no ring", () => {
  focusFeed({ quiet: true });
  expect(focused()).toBe("3");
  expect(document.documentElement.hasAttribute("data-focus-ring")).toBe(false);
  document.documentElement.setAttribute("data-focus-ring", "");
  focusFeedItem(2);
  expect(focused()).toBe("2");
  expect(document.documentElement.hasAttribute("data-focus-ring")).toBe(false);
});
