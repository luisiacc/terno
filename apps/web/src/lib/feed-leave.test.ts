// @vitest-environment jsdom
/**
 * The list's keys on What matters' rows: what a thread action takes out of the feed (Archive a person waiting, Trash and
 * Spam everything, never a task), the keys going on to the next row, and Undo's put-back waiting for the answer that
 * holds the row (the read after an Undo can answer before the backend has the conversation in What matters again).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const frames: FrameRequestCallback[] = [];
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => null), on: () => () => {}, connectionVersion: 1 } }));

const { dropFeedRows, feedBefore, feedRowsLeaving, reopenFeedRow, restoreFeedRow } = await import("./feed-leave");
const { feedKeyThread, focusedFeedItem, placeFeedKeys } = await import("./feed-focus");
const { keyThread } = await import("./select");
const { getApp, setApp } = await import("~/state/app");
const { useFeedRow, useToday } = await import("~/state/today");
const { useAppearance } = await import("~/lib/appearance");

const runFrames = () => {
  while (frames.length) frames.shift()!(0);
};
const waiting = (id: number) => ({ id: `waiting:${id}`, threadId: id, entry: { why: { kind: "waiting" } } });
const task = (id: number) => ({ id: `dated:${id}`, threadId: id, entry: { why: { kind: "dated" } }, task: {} });
const ROWS = [task(1), waiting(2), waiting(3), waiting(4)];
const draw = (ids: readonly string[]) => {
  document.body.innerHTML = `<section data-testid="wm-feed">${ids.map((id) => `<div data-row-id="${id}"><button data-testid="wm-item-open">${id}</button></div>`).join("")}</section>`;
};
const button = (id: string) => document.querySelector<HTMLElement>(`[data-row-id="${id}"] [data-testid=wm-item-open]`)!;

beforeEach(() => {
  frames.length = 0;
  useToday.setState({ rows: ROWS as never });
  draw(ROWS.map((r) => r.id));
  useAppearance.setState({ layout: "split" });
  setApp({ today: true, selectedId: null });
  useFeedRow.setState({ opened: null, cursor: null, carried: null });
});
afterEach(() => setApp({ today: false, selectedId: null }));

it("Archive takes out only a person waiting on your answer; Trash and Spam every row; nothing else any", () => {
  expect(feedRowsLeaving("archive", [1, 2])).toEqual(["waiting:2"]);
  expect(feedRowsLeaving("trash", [1, 2])).toEqual(["dated:1", "waiting:2"]);
  expect(feedRowsLeaving("spam", [1])).toEqual(["dated:1"]);
  expect(feedRowsLeaving("markRead", [2])).toEqual([]);
});

it("with nothing open the keys' row is the target, and when it leaves the keys and the place go on to the next", () => {
  expect(feedKeyThread()).toBeNull();
  button("waiting:2").focus();
  placeFeedKeys("waiting:2");
  expect(feedKeyThread()).toBe(2);
  expect(dropFeedRows(["waiting:2"])).toBe(true);
  expect(useFeedRow.getState().cursor).toBe("waiting:3");
  runFrames();
  expect(focusedFeedItem()).toBe("waiting:3");
});

it("the open row leaving opens the next, the keys with it when they were on it", () => {
  setApp({ today: true, selectedId: 2 });
  useFeedRow.setState({ opened: "waiting:2" });
  button("waiting:2").focus();
  dropFeedRows(["waiting:2"]);
  expect(useFeedRow.getState().opened).toBe("waiting:3");
  expect(getApp().selectedId).toBe(3);
  runFrames();
  expect(focusedFeedItem()).toBe("waiting:3");
});

it("Undo's put-back waits for the answer that holds the row, then the keys come back to it", () => {
  button("waiting:2").focus();
  placeFeedKeys("waiting:2");
  const before = feedBefore();
  dropFeedRows(["waiting:2"]);
  const back = vi.fn();
  // the first answer after the Undo doesn't hold it yet
  reopenFeedRow(before, back);
  expect(back).not.toHaveBeenCalled();
  useToday.setState({ rows: ROWS.filter((r) => r.id !== "waiting:2") as never });
  expect(back).not.toHaveBeenCalled();
  useToday.setState({ rows: ROWS as never });
  expect(back).toHaveBeenCalledOnce();
  expect(useFeedRow.getState().cursor).toBe("waiting:2");
});

it("a put-back still waiting is dropped once the user moves, and gives up after a few answers", () => {
  button("waiting:2").focus();
  placeFeedKeys("waiting:2");
  const before = feedBefore();
  dropFeedRows(["waiting:2"]);
  const back = vi.fn();
  reopenFeedRow(before, back);
  useFeedRow.setState(({ moves }) => ({ opened: "waiting:3", moves: moves + 1 }));
  setApp({ today: true, selectedId: 3 });
  useToday.setState({ rows: ROWS as never });
  expect(getApp().today).toBe(true);
  expect(back).not.toHaveBeenCalled();

  useToday.setState({ rows: ROWS.filter((r) => r.id !== "waiting:4") as never });
  setApp({ today: true, selectedId: null });
  useFeedRow.setState({ opened: null });
  const later = vi.fn();
  reopenFeedRow({ ...before, cursor: "waiting:4" }, later);
  for (let i = 0; i < 4; i++) useToday.setState({ rows: ROWS.filter((r) => r.id !== "waiting:4").slice() as never });
  useToday.setState({ rows: ROWS as never });
  expect(getApp().today).toBe(true);
  expect(later).not.toHaveBeenCalled();
});

it("with a conversation open, it's the target wherever focus is (a dialog's field, another row, the digest's)", () => {
  setApp({ today: true, selectedId: 2 });
  useFeedRow.setState({ opened: "waiting:2", cursor: "waiting:3" });
  button("waiting:4").focus();
  placeFeedKeys("waiting:4");
  expect(useFeedRow.getState().cursor).toBe("waiting:3");
  expect(keyThread()).toBe(2);
});

it("a put-back still waiting ends when What matters is left, with no answer after it", () => {
  button("waiting:2").focus();
  placeFeedKeys("waiting:2");
  const before = feedBefore();
  dropFeedRows(["waiting:2"]);
  const back = vi.fn();
  reopenFeedRow(before, back);
  setApp({ today: false });
  setApp({ today: true, selectedId: null });
  useToday.setState({ rows: ROWS as never });
  expect(back).not.toHaveBeenCalled();
});

it("plan 216 (Codex code review, #1): Undo's open row back takes back the keys the act moved on to the next row", () => {
  setApp({ today: true, selectedId: 2 });
  useFeedRow.setState({ opened: "waiting:2" });
  button("waiting:2").focus();
  const before = feedBefore();
  dropFeedRows(["waiting:2"]);
  runFrames();
  expect(focusedFeedItem()).toBe("waiting:3");
  const moved = useFeedRow.getState().moves;
  // the Undo's read holds the row again
  useToday.setState({ rows: ROWS as never });
  restoreFeedRow(before, moved, 3);
  expect(useFeedRow.getState().opened).toBe("waiting:2");
  runFrames();
  expect(focusedFeedItem()).toBe("waiting:2");
});
