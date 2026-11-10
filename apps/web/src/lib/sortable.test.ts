import { describe, expect, it } from "vitest";
import { clampDy, moved, shiftsFor, slotOf, type Block } from "./sortable";

/** five touching 28 px rows */
const rows: Block[] = [0, 28, 56, 84, 112].map((top) => ({ top, height: 28 }));
/** an open account (its row and three folders) between two closed ones */
const accounts: Block[] = [
  { top: 0, height: 28 },
  { top: 28, height: 112 },
  { top: 140, height: 28 },
];

describe("slotOf", () => {
  it("moves once its leading edge passes a neighbour's middle", () => {
    expect(slotOf(rows, 1, 13)).toBe(1);
    expect(slotOf(rows, 1, 15)).toBe(2);
    expect(slotOf(rows, 1, 57)).toBe(3);
    expect(slotOf(rows, 3, -15)).toBe(2);
    expect(slotOf(rows, 3, -84)).toBe(0);
  });

  it("works for blocks of any height", () => {
    // the first account, dragged down: its bottom (28 + dy) past the open one's middle (28 + 56)
    expect(slotOf(accounts, 0, 55)).toBe(0);
    expect(slotOf(accounts, 0, 57)).toBe(1);
    expect(slotOf(accounts, 0, 141)).toBe(2);
    // the open one dragged up: its top (28 + dy) past the first's middle (14)
    expect(slotOf(accounts, 1, -15)).toBe(0);
    expect(slotOf(accounts, 1, -13)).toBe(1);
  });
});

describe("a tall open account (Codex plan review #4)", () => {
  // 400 px of row and folders above a 32 px row: it can only go 32 px down, and that's enough to pass it
  const tall: Block[] = [
    { top: 0, height: 400 },
    { top: 400, height: 32 },
  ];
  it("passes a short neighbour within the room it has, both ways", () => {
    expect(clampDy(tall, 0, 300)).toBe(32);
    expect(slotOf(tall, 0, clampDy(tall, 0, 300))).toBe(1);
    expect(slotOf(tall, 0, 15)).toBe(0);
    expect(slotOf(tall, 0, 17)).toBe(1);
    // the short one up past it: its top past the tall one's middle (200)
    expect(slotOf(tall, 1, clampDy(tall, 1, -500))).toBe(0);
    expect(slotOf(tall, 1, -199)).toBe(1);
    expect(slotOf(tall, 1, -201)).toBe(0);
  });
});

describe("clampDy", () => {
  it("keeps the block inside its group", () => {
    expect(clampDy(rows, 1, -100)).toBe(-28);
    expect(clampDy(rows, 1, 500)).toBe(84);
    expect(clampDy(rows, 1, 10)).toBe(10);
    expect(clampDy(accounts, 1, 100)).toBe(28);
  });
});

describe("shiftsFor", () => {
  it("moves the blocks it passed by its height, the other way", () => {
    expect(shiftsFor(rows, 1, 3)).toEqual([0, 0, -28, -28, 0]);
    expect(shiftsFor(rows, 3, 1)).toEqual([0, 28, 28, 0, 0]);
    expect(shiftsFor(rows, 2, 2)).toEqual([0, 0, 0, 0, 0]);
    expect(shiftsFor(accounts, 1, 2)).toEqual([0, 0, -112]);
  });

  it("keeps the column's gap", () => {
    const gapped: Block[] = [0, 32, 64].map((top) => ({ top, height: 28 }));
    expect(shiftsFor(gapped, 0, 2)).toEqual([0, -32, -32]);
  });
});

describe("moved", () => {
  it("takes the item out and puts it at the slot", () => {
    expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moved(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moved(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});
