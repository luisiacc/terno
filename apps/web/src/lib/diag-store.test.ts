import type { ErrorRecord } from "@terno/core/diag";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { mergeRecords, openDiagDb, readRecords, writeBatch } from "./diag-store";

let seq = 0;
const record = (ts: number): ErrorRecord => ({
  id: (++seq).toString(16).padStart(32, "0"),
  ts,
  kind: "error",
  proc: "renderer",
  code: "ui.boundary",
  fatal: false,
  crumbs: [],
  context: { version: "0.1.0", build: "0.1.0+abc", channel: "test", session: "s", os: "web" },
});

describe("the shared diagnostics store", () => {
  it("one tab's write never deletes a record another tab wrote (review finding 2)", async () => {
    const factory = new IDBFactory();
    const tabA = await openDiagDb(factory);
    const tabB = await openDiagDb(factory);
    const now = Date.now();
    // B opened first and knows nothing of A's record; A records an error; then B flushes its own
    const fromA = record(now - 1000);
    await writeBatch(tabA, [], [fromA], now);
    const fromB = record(now - 500);
    await writeBatch(tabB, [], [fromB], now);
    expect((await readRecords(tabA)).map((r) => r.id)).toEqual([fromB.id, fromA.id]);
  });

  it("keeps the newest 20 within 30 days, across every tab's writes", async () => {
    const factory = new IDBFactory();
    const a = await openDiagDb(factory);
    const b = await openDiagDb(factory);
    const now = Date.now();
    const old = record(now - 31 * 86_400_000);
    await writeBatch(a, [], [old], now);
    const fresh = Array.from({ length: 24 }, (_, i) => record(now - 10_000 + i));
    await writeBatch(a, [], fresh.slice(0, 12), now);
    await writeBatch(b, [], fresh.slice(12), now);
    const kept = await readRecords(a);
    expect(kept).toHaveLength(20);
    expect(kept.map((r) => r.id)).toEqual(fresh.slice(4).reverse().map((r) => r.id));
  });

  it("merges what a tab captured with what the database held, newest first", () => {
    const stored = [record(10), record(5)];
    const captured = [record(20)];
    expect(mergeRecords(stored, captured).map((r) => r.ts)).toEqual([20, 10, 5]);
  });
});
