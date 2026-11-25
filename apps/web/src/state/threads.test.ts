// @vitest-environment jsdom
// (jsdom: the list's store reaches lib/appearance through What matters' state since plan 251, and it reads the document)
import type { ThreadDetail } from "@terno/core";
import { beforeEach, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

const calls: number[] = [];
type Pending = { id: number; resolve: (d: ThreadDetail) => void; reject: (e: Error) => void };
const pending: Pending[] = [];
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (_method: string, { threadId }: { threadId: number }) => {
      calls.push(threadId);
      return new Promise<ThreadDetail>((resolve, reject) => pending.push({ id: threadId, resolve, reject }));
    },
  },
}));

const { setApp } = await import("~/state/app");
const { invalidateThreads, keepOpening, loadThread, staleMarksForTests, threadCached, useThreads } = await import("~/state/threads");

const detail = (id: number, rev: number) => ({ thread: { id }, messages: [], rev }) as unknown as ThreadDetail;
const shown = (id: number) => useThreads.getState().details.get(id) as (ThreadDetail & { rev: number }) | undefined;
/** Answers the oldest pending fetch of `id`. */
function answer(id: number, rev: number): Promise<void> {
  const i = pending.findIndex((p) => p.id === id);
  pending.splice(i, 1)[0]!.resolve(detail(id, rev));
  return new Promise((r) => setTimeout(r, 0));
}
async function cached(id: number, rev: number): Promise<void> {
  const p = loadThread(id, true);
  await answer(id, rev);
  await p;
}

beforeEach(() => {
  calls.length = 0;
  pending.length = 0;
  useThreads.setState({ details: new Map(), gone: new Set(), version: 0 });
  setApp({ selectedId: null });
});

it("the open thread stays on screen when it changes; the next load replaces it, then the cache serves it", async () => {
  await cached(1, 1);
  setApp({ selectedId: 1 });
  const before = shown(1);
  invalidateThreads([1]);
  // same object: the reader doesn't blank (no skeleton, no remount)
  expect(shown(1)).toBe(before);
  calls.length = 0;
  const p = loadThread(1);
  expect(calls).toEqual([1]);
  expect(shown(1)).toBe(before);
  await answer(1, 2);
  await p;
  expect(shown(1)!.rev).toBe(2);
  calls.length = 0;
  await loadThread(1);
  expect(calls).toEqual([]);
});

it("other threads that change drop out, so their next view refetches", async () => {
  await cached(1, 1);
  await cached(2, 1);
  setApp({ selectedId: 1 });
  const version = useThreads.getState().version;
  invalidateThreads([2, 3]);
  expect(shown(2)).toBeUndefined();
  expect(shown(1)!.rev).toBe(1);
  expect(useThreads.getState().version).toBe(version + 1);
  // only the open one changed: nothing to re-render
  invalidateThreads([1]);
  expect(useThreads.getState().version).toBe(version + 1);
});

it("plan 271: the one a pane is about to open is kept through a change as the open one is, until it's let go", async () => {
  await cached(5, 1);
  keepOpening(5);
  const before = shown(5);
  invalidateThreads([5]);
  expect(shown(5)).toBe(before);
  // marked: its next load asks again
  calls.length = 0;
  const p = loadThread(5);
  expect(calls).toEqual([5]);
  await answer(5, 2);
  await p;
  keepOpening(null);
  invalidateThreads([5]);
  expect(shown(5)).toBeUndefined();
});

it("a fetch that left before the change can't pass for current", async () => {
  await cached(1, 1);
  setApp({ selectedId: 1 });
  const early = loadThread(1, true);
  invalidateThreads([1]);
  await answer(1, 2);
  await early;
  // shown (it is newer than what was on screen), but still stale: the next load asks again
  expect(shown(1)!.rev).toBe(2);
  calls.length = 0;
  const p = loadThread(1);
  expect(calls).toEqual([1]);
  await answer(1, 3);
  await p;
  expect(shown(1)!.rev).toBe(3);
});

it("a non-forced load doesn't join a fetch that left before the change", async () => {
  setApp({ selectedId: 4 });
  const first = loadThread(4);
  invalidateThreads([4]);
  calls.length = 0;
  const second = loadThread(4);
  expect(calls).toEqual([4]);
  // the newer answer lands first; the older one, arriving late, never replaces it
  pending.reverse();
  await answer(4, 2);
  await answer(4, 1);
  await Promise.all([first, second]);
  expect(shown(4)!.rev).toBe(2);
});

it("a failed refetch keeps what is on screen, and the next load tries again", async () => {
  await cached(1, 1);
  setApp({ selectedId: 1 });
  invalidateThreads([1]);
  const p = loadThread(1, true);
  pending.shift()!.reject(new Error("offline"));
  expect(await p).toBeNull();
  expect(shown(1)!.rev).toBe(1);
  calls.length = 0;
  void loadThread(1);
  expect(calls).toEqual([1]);
});

it("a thread gone from the backend stops being shown, and the reader can say so", async () => {
  const { RpcError } = await import("@terno/core/rpc");
  await cached(1, 1);
  setApp({ selectedId: 1 });
  invalidateThreads([1]);
  const p = loadThread(1, true);
  pending.shift()!.reject(new RpcError("NOT_FOUND", "That conversation no longer exists."));
  expect(await p).toBeNull();
  expect(shown(1)).toBeUndefined();
  expect(useThreads.getState().gone.has(1)).toBe(true);
  // back (an undo, a sync that restored it): shown again
  await cached(1, 2);
  expect(useThreads.getState().gone.has(1)).toBe(false);
});

it("stale marks don't outlive what they mark", async () => {
  await cached(1, 1);
  for (let i = 0; i < 50; i++) {
    setApp({ selectedId: 1 });
    invalidateThreads([1]);
    setApp({ selectedId: 2 });
    invalidateThreads([1]);
  }
  expect(staleMarksForTests()).toBe(0);
});

it("plan 221: past 150 conversations, or past the bodies' budget, the oldest go but never the open one nor the newest", async () => {
  setApp({ selectedId: 1 });
  for (let id = 1; id <= 160; id++) await cached(id, 1);
  expect(useThreads.getState().details.size).toBe(150);
  expect(shown(1)).toBeDefined();
  expect(shown(2)).toBeUndefined();
  // two bodies of 9M characters can't both stay with the open one: the older goes, the newest stays
  const big = (id: number) => ({ thread: { id }, messages: [{ bodyHtml: "x".repeat(9_000_000), bodyText: null }], rev: 1 }) as unknown as ThreadDetail;
  for (const id of [500, 501]) {
    const p = loadThread(id, true);
    pending.splice(pending.findIndex((q) => q.id === id), 1)[0]!.resolve(big(id));
    await p;
  }
  expect(shown(500)).toBeUndefined();
  expect(shown(501)).toBeDefined();
  expect(shown(1)).toBeDefined();
});

it("plan 221: a conversation counts as cached while its answer is current or on its way, and not once it changed", async () => {
  expect(threadCached(3)).toBe(false);
  const p = loadThread(3);
  expect(threadCached(3)).toBe(true);
  // changed while its fetch was on its way: that answer can't pass for current
  invalidateThreads([3]);
  expect(threadCached(3)).toBe(false);
  await answer(3, 1);
  await p;
  await cached(3, 2);
  expect(threadCached(3)).toBe(true);
  invalidateThreads([3]);
  expect(threadCached(3)).toBe(false);
});
