// @vitest-environment jsdom
/**
 * Plan 210 (Codex code review, round 2): the keys back on What matters' feed: the item is brought into view even when it's
 * drawn (the overscan reaches past the edge), and the ring is the move's: kept for F6 and the skip link, gone after a key
 * the app answered. Iteration 2: by the row's own id, two rows of one conversation apart.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => null), on: () => () => {}, connectionVersion: 1 } }));

const { feedScroller, focusFeed, focusFeedItem, focusedFeedItem } = await import("./feed-focus");
const { setApp } = await import("~/state/app");
const { useFeedRow, useToday } = await import("~/state/today");

const ids = ["dated:1", "dated:2", "promise:3"];
const scrolled: string[] = [];
beforeEach(() => {
  document.body.innerHTML = `<section data-testid="wm-feed">${ids.map((id) => `<div data-row-id="${id}"><button data-testid="wm-item-open">${id}</button></div>`).join("")}</section>`;
  document.documentElement.setAttribute("data-focus-ring", "");
  scrolled.length = 0;
  feedScroller.toRow = (id) => scrolled.push(id);
  // two rows of conversation 9: the second is the open one
  useToday.setState({ rows: [{ id: "dated:1", threadId: 4 }, { id: "dated:2", threadId: 9 }, { id: "promise:3", threadId: 9 }] });
  useFeedRow.setState({ opened: "promise:3", cursor: null });
  setApp({ selectedId: 9 });
});
afterEach(() => {
  feedScroller.toRow = undefined;
  setApp({ selectedId: null });
});

it("the open row, not its conversation's first, is scrolled into view too, then focused; F6's and the skip link's move keep the ring", () => {
  expect(focusFeed()).toBe(true);
  expect(focusedFeedItem()).toBe("promise:3");
  expect(scrolled).toEqual(["promise:3"]);
  expect(document.documentElement.hasAttribute("data-focus-ring")).toBe(true);
});

it("after a key the app answered (j/k, Esc), no ring; with none open, the row put away", () => {
  focusFeed({ quiet: true });
  expect(focusedFeedItem()).toBe("promise:3");
  expect(document.documentElement.hasAttribute("data-focus-ring")).toBe(false);
  document.documentElement.setAttribute("data-focus-ring", "");
  focusFeedItem("dated:2");
  expect(focusedFeedItem()).toBe("dated:2");
  expect(document.documentElement.hasAttribute("data-focus-ring")).toBe(false);
  setApp({ selectedId: null });
  useFeedRow.setState({ opened: null, cursor: "dated:1" });
  focusFeed({ quiet: true });
  expect(focusedFeedItem()).toBe("dated:1");
});
