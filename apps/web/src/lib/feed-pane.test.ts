// @vitest-environment jsdom
/**
 * Codex's code review of plan 210's iteration 4: Esc puts the conversation away and the keys come back to its row a frame
 * or two later. Those frames land only while nothing moved since: the keys put on another row meanwhile stay there (the
 * cause of what-matters-feed.spec's flake: Esc on the rent, the keys on payroll, then Enter opened the rent).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const frames: FrameRequestCallback[] = [];
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => null), on: () => () => {}, connectionVersion: 1 } }));

const { closeFeedConversation } = await import("./feed-pane");
const { focusedFeedItem } = await import("./feed-focus");
const { setApp } = await import("~/state/app");
const { openFeedRow, useFeedRow, useToday } = await import("~/state/today");

/** every frame asked for so far, and those they ask for, in order */
const runFrames = () => {
  while (frames.length) frames.shift()!(0);
};
const button = (id: string) => document.querySelector<HTMLElement>(`[data-row-id="${id}"] [data-testid=wm-item-open]`)!;

beforeEach(() => {
  frames.length = 0;
  document.body.innerHTML = `<section data-testid="wm-feed">${["dated:1", "dated:2"].map((id) => `<div data-row-id="${id}"><button data-testid="wm-item-open">${id}</button></div>`).join("")}</section><div data-testid="reader"><button id="in-reader">reply</button></div>`;
  useToday.setState({ rows: [{ id: "dated:1", threadId: 4 }, { id: "dated:2", threadId: 9 }] as never });
  setApp({ today: true, selectedId: 4 });
  useFeedRow.setState({ opened: "dated:1", cursor: null });
  document.getElementById("in-reader")!.focus();
});
afterEach(() => setApp({ today: false, selectedId: null }));

it("Esc: the keys come back to the row it was opened from, two frames on", () => {
  expect(closeFeedConversation()).toBe(true);
  document.querySelector("[data-testid=reader]")!.remove();
  runFrames();
  expect(focusedFeedItem()).toBe("dated:1");
});

it("the keys put on another row before the frames came stay there", () => {
  expect(closeFeedConversation()).toBe(true);
  document.querySelector("[data-testid=reader]")!.remove();
  button("dated:2").focus();
  runFrames();
  expect(focusedFeedItem()).toBe("dated:2");
});

it("a row opened, or another put-away, before the frames came: the older one's frames land nowhere", () => {
  expect(closeFeedConversation()).toBe(true);
  openFeedRow("dated:2");
  setApp({ selectedId: 9 });
  button("dated:2").blur();
  runFrames();
  expect(focusedFeedItem()).toBeNull();
});
