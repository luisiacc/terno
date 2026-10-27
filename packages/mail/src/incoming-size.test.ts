import { expect, it } from "vitest";
import { retainedIncomingBytes } from "./incoming-size";

it.each([
  [undefined, 0], [null, 0], [true, 8], [42, 8], ["A😀", 6],
  [{}, 64], [[], 64],
  [{ a: undefined, b: null, c: false, d: 1, e: "😀" }, 124],
  [["A", "😀", undefined], 94],
  [{ a: { text: "X" }, b: [] }, 218],
] as const)("charges normalized data without losing slots or UTF-16 units (%#)", (value, bytes) => {
  expect(retainedIncomingBytes(value)).toBe(bytes);
});

it("excludes inherited, symbol and nonenumerable values", () => {
  const value = { own: "A" };
  Object.setPrototypeOf(value, { inherited: "synthetic".repeat(1000) });
  Object.defineProperty(value, "hidden", { value: "synthetic".repeat(1000), enumerable: false });
  Object.defineProperty(value, Symbol("synthetic"), { value: "synthetic".repeat(1000), enumerable: true });
  expect(retainedIncomingBytes(value)).toBe(74);
});

it("charges sparse array entries and repeated object slots without double charging identities", () => {
  const sparse: unknown[] = [];
  sparse.length = 3;
  sparse[2] = "A";
  expect(retainedIncomingBytes(sparse)).toBe(74);
  const shared = { text: "X" };
  expect(retainedIncomingBytes([shared, shared])).toBe(154);
  const cycle: { next?: unknown } = {};
  cycle.next = cycle;
  expect(retainedIncomingBytes(cycle)).toBe(72);
});

it("charges the complete shared backing once and each distinct retained view", () => {
  const backing = new ArrayBuffer(1024);
  const first = new Uint8Array(backing, 511, 1);
  const second = new Uint8Array(backing, 512, 2);
  expect(retainedIncomingBytes([first, second])).toBe(1232);
  expect(retainedIncomingBytes([first, first])).toBe(1168);
  expect(retainedIncomingBytes(new ArrayBuffer(32))).toBe(32);
  expect(retainedIncomingBytes(new Uint8Array(new ArrayBuffer(64), 32, 0))).toBe(128);
});
