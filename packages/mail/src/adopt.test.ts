/**
 * Plan 68 (Codex R4): a renamed folder's messages are recognised by envelope from an index built once: each taken
 * once, oldest first, never one already claimed. Its timing at scale is in adopt.perf.test.ts.
 */
import { expect, it, vi } from "vitest";
import { AdoptIndex, sortIds } from "./adopt";

it("a candidate the folder already holds is passed over; a dropped one is never taken", async () => {
  const e = { subject: "S", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex([{ id: 1, ...e }, { id: 2, ...e }, { id: 3, ...e }]);
  index.drop(2);
  expect(await index.take(e, async (id) => id !== 1)).toBe(3);
  expect(await index.take(e, async () => true)).toBeNull();
});

it("Codex R12: a candidate added later, older than ones still waiting, is taken in its place", async () => {
  const e = { subject: "S", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex([{ id: 5, ...e }, { id: 9, ...e }]);
  expect(await index.take(e, async () => true)).toBe(5);
  await index.add([7, 3], async (ids) => ids.map((id) => ({ id, ...e })));
  expect(await index.take(e, async () => true)).toBe(3);
  expect(await index.take(e, async () => true)).toBe(7);
  expect(await index.take(e, async () => true)).toBe(9);
});

it("Codex R13: a candidate taken or found by its own key is never one again, even if a reset lists it later", async () => {
  const e = { subject: "S", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex([{ id: 1, ...e }, { id: 2, ...e }]);
  expect(await index.take(e, async () => true)).toBe(1);
  index.drop(2);
  await index.add([1, 2, 3], async (ids) => ids.map((id) => ({ id, ...e })));
  expect(await index.take(e, async () => true)).toBe(3);
  expect(await index.take(e, async () => true)).toBeNull();
});

it("ordered late candidates need one typed buffer and no sorting, without touching the waiting run", async () => {
  const e = { subject: "Same", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex(Array.from({ length: 25_000 }, (_, i) => ({ id: 2 * i + 2, ...e })));
  expect(await index.take(e, async () => true)).toBe(2);
  const allocations: number[] = [];
  const sort = vi.spyOn(Float64Array.prototype, "sort");
  vi.stubGlobal("Float64Array", new Proxy(Float64Array, {
    construct(target, args) {
      const result = Reflect.construct(target, args) as Float64Array;
      allocations.push(result.length);
      return result;
    },
  }));
  try {
    await index.add(Array.from({ length: 25_000 }, (_, i) => 2 * i + 1), async (ids) => ids.map((id) => ({ id, ...e })));
    expect(sort).not.toHaveBeenCalled();
    expect(allocations).toEqual([25_000]);
  } finally {
    sort.mockRestore();
    vi.unstubAllGlobals();
  }
  for (let id = 1; id <= 50_000; id++) {
    if (id !== 2) expect(await index.take(e, async () => true)).toBe(id);
  }
  expect(index.size).toBe(0);
});

it("sortIds owns its result, keeps duplicates, and sorts a single-use iterator across run boundaries", async () => {
  for (const ids of [[], [1], [1, 1, 3], Array.from({ length: 25_000 }, (_, i) => 25_000 - i), ...[5000, 16_384, 24_999].map((at) => Array.from({ length: 25_000 }, (_, i) => i === at ? i - 2 : i)), [...Array.from({ length: 16_384 }, (_, i) => i + 1), 0, 0]]) {
    const original = [...ids];
    const sorted = await sortIds(ids.values());
    expect([...sorted]).toEqual([...original].sort((a, b) => a - b));
    sorted[0] = -1;
    expect(ids).toEqual(original);
  }
});

it("ordered single-use input still gives real timer turns while it is copied", async () => {
  let read = 0;
  let readAtTurn = 0;
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 5));
  const turn = new Promise<void>((resolve) => setTimeout(() => { readAtTurn = read; resolve(); }, 0));
  try {
    const ids = (function* () {
      for (let i = 0; i < 25_000; i++) { read++; yield i; }
    })();
    const sorted = await sortIds(ids);
    await turn;
    expect(readAtTurn).toBe(5000);
    expect([...sorted]).toEqual(Array.from({ length: 25_000 }, (_, i) => i));
  } finally {
    now.mockRestore();
  }
});

it("ordered input yields after its final partial copy when the budget is spent", async () => {
  let turnRan = false;
  let calls = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => calls++ === 0 ? 0 : 5);
  const turn = new Promise<void>((resolve) => setTimeout(() => { turnRan = true; resolve(); }, 0));
  try {
    expect([...await sortIds([1, 2, 3])]).toEqual([1, 2, 3]);
    expect(turnRan).toBe(true);
    await turn;
  } finally {
    now.mockRestore();
  }
});

it("ordered typed inputs are traversed once and never share the result's storage", async () => {
  const input = new Float64Array([1, 1, 2, 3]);
  let traversals = 0;
  const ids = { [Symbol.iterator]() { expect(++traversals).toBe(1); return input.values(); } };
  const result = await sortIds(ids);
  input[0] = 9;
  expect([...result]).toEqual([1, 1, 2, 3]);
  result[1] = 8;
  expect([...input]).toEqual([9, 1, 2, 3]);
});

it("ordered additions deduplicate across slices, retain exact signatures and never reclaim taken or dropped IDs", async () => {
  const e = { subject: "S", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const rows = [e, { ...e, subject: "T" }, { ...e, fromEmail: "b@x" }, { ...e, date: 2 }, { ...e, size: 2 }, { ...e, rfcMessageId: "m@x" }].map((r, i) => ({ id: i + 1, ...r }));
  const index = new AdoptIndex(rows.slice(0, 2));
  expect(await index.take(e, async () => true)).toBe(1);
  index.drop(2);
  const chunks: number[][] = [];
  await index.add([1, 2, 3, 3, 4, 5, 5, 6], async (ids) => { chunks.push(ids); return ids.map((id) => rows[id - 1]!); }, 3);
  expect(chunks).toEqual([[1, 2, 3], [4, 5], [6]]);
  expect(await index.take(e, async () => true)).toBeNull();
  expect(await index.take(rows[1]!, async () => true)).toBeNull();
  for (const row of rows.slice(2)) expect(await index.take(row, async () => true)).toBe(row.id);
  expect(index.size).toBe(0);
});
