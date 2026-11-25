// @vitest-environment jsdom
/** Plan 271: motion owed to a list's next change (an Undo's answer, Coming up), paid by the change it was owed to. */
import type { ThreadSummary } from "@terno/core";
import { expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: () => () => {}, onAttach: () => () => {} } }));

const { listKey, moveNextRows, movesOwed, movesPaid, rowsChange } = await import("~/state/list");

const row = (id: number) => ({ id }) as ThreadSummary;
const index = (ids: number[]) => new Map(ids.map((id, i) => [id, i]));

it("what an answer changes: the conversations it brings, how many go", () => {
  expect(rowsChange(index([1, 2, 3]), [1, 2, 3].map(row), [1, 4, 2, 3, 5].map(row))).toEqual({ came: [4, 5], went: 0 });
  expect(rowsChange(index([1, 2, 3]), [1, 2, 3].map(row), [1, 3].map(row))).toEqual({ came: [], went: 1 });
});

it("an Undo's motion is owed to the answer bringing one of its rows back, in its own list, for a moment", () => {
  vi.useFakeTimers();
  try {
    moveNextRows([7]);
    const key = listKey();
    expect(movesOwed(key)).toBe(true);
    // the backend's own news that changed something else: not this one's
    expect(movesOwed(key, { came: [8], went: 0 })).toBe(false);
    expect(movesOwed(key, { came: [8, 7], went: 0 })).toBe(true);
    // another list: not owed there
    expect(movesOwed(`${key}-other`, { came: [7], went: 0 })).toBe(false);
    movesPaid();
    expect(movesOwed(key)).toBe(false);
    // too late: a change long after the Undo isn't its
    moveNextRows([7]);
    vi.advanceTimersByTime(2500);
    expect(movesOwed(key, { came: [7], went: 0 })).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("Coming up's motion (no rows named) is owed to any change, never to an answer that changes nothing", () => {
  moveNextRows();
  const key = listKey();
  expect(movesOwed(key, { came: [], went: 0 })).toBe(false);
  expect(movesOwed(key, { came: [], went: 3 })).toBe(true);
  movesPaid();
});
