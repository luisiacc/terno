// @vitest-environment jsdom
import type { ThreadDetail } from "@terno/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// the real cache (state/threads) under the scheduler; only the backend and the layout are stood in for
const calls: number[] = [];
const pending: { id: number; resolve: (d: ThreadDetail) => void }[] = [];
vi.mock("~/rpc/connection", () => ({
  client: {
    connectionVersion: 0,
    call: (_method: string, { threadId }: { threadId: number }) => {
      calls.push(threadId);
      return new Promise<ThreadDetail>((resolve) => pending.push({ id: threadId, resolve }));
    },
  },
}));
const layout = vi.hoisted(() => ({ list: false, reader: true }));
vi.mock("./page", () => ({ listLayout: () => layout.list, readerShown: () => layout.reader }));

const { setApp } = await import("~/state/app");
const { invalidateThreadConnection, invalidateThreads, useThreads } = await import("~/state/threads");
const { resetWarmForTests, warmNext, warmNothing, warmOnScreen } = await import("./warm");

const detail = (id: number) => ({ thread: { id, starred: false, unread: false, categoryIds: [] }, messages: [] }) as unknown as ThreadDetail;
async function answer(id: number): Promise<void> {
  pending.splice(pending.findIndex((p) => p.id === id), 1)[0]!.resolve(detail(id));
  await vi.advanceTimersByTimeAsync(0);
}
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  pending.length = 0;
  Object.assign(layout, { list: false, reader: true });
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  setApp({ selectedId: null });
  // nothing cached, nothing on its way from an earlier test
  invalidateThreadConnection();
  resetWarmForTests();
});
afterEach(() => {
  resetWarmForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("the rows on screen are warmed once the list rests, two at a time, the next starting as one lands", async () => {
  warmOnScreen([1, 2, 3, 4]);
  await vi.advanceTimersByTimeAsync(140);
  expect(calls).toEqual([]);
  await vi.advanceTimersByTimeAsync(10);
  expect(calls).toEqual([1, 2]);
  await answer(1);
  expect(calls).toEqual([1, 2, 3]);
  await answer(2);
  await answer(3);
  await answer(4);
  expect(calls).toEqual([1, 2, 3, 4]);
  // reported again (the list re-rendered): all cached, nothing asked
  warmOnScreen([1, 2, 3, 4]);
  await vi.advanceTimersByTimeAsync(200);
  expect(calls).toEqual([1, 2, 3, 4]);
});

it("while the list scrolls nothing starts, even on the same rows; a fling warms only where it rests", async () => {
  warmOnScreen([1, 2], true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toEqual([]);
  for (const rows of [[3, 4], [5, 6], [7, 8]]) {
    warmOnScreen(rows);
    await vi.advanceTimersByTimeAsync(50);
  }
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toEqual([7, 8]);
  // a scroll starts with work under way: what's queued waits, nothing more starts until it rests
  await answer(7);
  warmOnScreen([9, 10, 11], true);
  await answer(8);
  expect(calls).toEqual([7, 8]);
  warmOnScreen([9, 10, 11]);
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toEqual([7, 8, 9, 10]);
});

it("skips the digest's row, the open one, cached ones and ones on their way; rows that left the screen never start", async () => {
  setApp({ selectedId: 2 });
  warmOnScreen([0, 1, 2, 3, 4, 5]);
  await vi.advanceTimersByTimeAsync(150);
  // from the open row outward
  expect(calls).toEqual([1, 3]);
  warmOnScreen([1, 3, 6]);
  await vi.advanceTimersByTimeAsync(150);
  await answer(1);
  await answer(3);
  // 4 and 5 left the screen before they started
  expect(calls).toEqual([1, 3, 6]);
});

it("at most 48 rows a screen, the nearest to the open row first", async () => {
  const rows = Array.from({ length: 80 }, (_, i) => i + 1);
  setApp({ selectedId: 70 });
  warmOnScreen(rows);
  await vi.advanceTimersByTimeAsync(150);
  const asked = new Set<number>();
  while (pending.length) {
    const id = pending[0]!.id;
    asked.add(id);
    await answer(id);
  }
  expect(asked.size).toBe(48);
  expect([...asked].slice(0, 4)).toEqual([69, 71, 68, 72]);
  expect(asked.has(80)).toBe(true);
  expect(asked.has(1)).toBe(false);
});

it("the keyboard's next go first, without waiting, and replace the last ones", async () => {
  warmOnScreen([1, 2, 3]);
  warmNext([10, 11, 12]);
  expect(calls).toEqual([10, 11]);
  warmNext([20]);
  await answer(10);
  expect(calls).toEqual([10, 11, 20]);
  await vi.advanceTimersByTimeAsync(150);
  await answer(11);
  expect(calls).toEqual([10, 11, 20, 1]);
});

it("R12: List's list page warms nothing; under a conversation's page in List only the keyboard's next are", async () => {
  layout.reader = false;
  layout.list = true;
  warmOnScreen([1, 2]);
  warmNext([3]);
  await vi.advanceTimersByTimeAsync(500);
  expect(calls).toEqual([]);
  layout.reader = true;
  warmOnScreen([1, 2]);
  warmNext([3]);
  await vi.advanceTimersByTimeAsync(500);
  expect(calls).toEqual([3]);
});

it("a hidden window warms nothing and waits on one listener, which goes when it shows or when nothing is left", async () => {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  visibility = "hidden";
  warmOnScreen([1, 2]);
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toEqual([]);
  expect(add.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(calls).toEqual([1, 2]);
  expect(remove.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  // hidden again with work waiting, then the list goes: the listener goes with it
  visibility = "hidden";
  warmNext([5]);
  expect(add.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(2);
  warmNothing();
  expect(remove.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(2);
});

it("a conversation that changed while it was warming is fetched again when the screen is next reported", async () => {
  warmOnScreen([1]);
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toEqual([1]);
  // a backend change lands before the answer: that answer can't pass for current
  invalidateThreads([1]);
  await answer(1);
  warmOnScreen([1]);
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toEqual([1, 1]);
  await answer(1);
  expect(useThreads.getState().details.has(1)).toBe(true);
  warmOnScreen([1]);
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toEqual([1, 1]);
});
