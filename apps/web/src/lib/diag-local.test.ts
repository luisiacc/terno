/**
 * The web's local diagnostics host against a real (fake) IndexedDB shared by
 * two "tabs": what one captures survives what the other writes, and a
 * capture made while a tab is still opening its store isn't lost.
 */
import type { ErrorRecord } from "@terno/core/diag";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";
import { openDiagDb, readRecords, writeBatch } from "./diag-store";

const g = globalThis as Record<string, unknown>;
let LocalDiag: typeof import("./diag-local").LocalDiag;
beforeAll(async () => {
  const store = new Map<string, string>();
  g.window ??= { addEventListener() {} };
  g.localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; } };
  ({ LocalDiag } = await import("./diag-local"));
});

let seq = 0;
const record = (ts = Date.now() - 1000 + ++seq): ErrorRecord => ({
  id: (++seq).toString(16).padStart(32, "0"),
  ts,
  kind: "error",
  proc: "renderer",
  code: "ui.boundary",
  fatal: false,
  crumbs: [],
  context: { version: "0.1.0", build: "0.1.0+abc", channel: "test", session: "s", os: "web" },
});

describe("LocalDiag", () => {
  it("a tab that opened earlier never deletes the record another tab captured since (review finding 2)", async () => {
    const factory = new IDBFactory();
    const tabB = new LocalDiag();
    await tabB.open(factory);
    const tabA = new LocalDiag();
    await tabA.open(factory);
    const fromA = record();
    tabA.capture(fromA);
    tabA.flush();
    await tabA.idle();
    const fromB = record();
    tabB.capture(fromB);
    tabB.flush();
    await tabB.idle();
    const db = await openDiagDb(factory);
    expect((await readRecords(db)).map((r) => r.id).sort()).toEqual([fromA.id, fromB.id].sort());
  });

  it("an error captured while the store is still opening is kept, in memory and on disk (review finding 8)", async () => {
    const factory = new IDBFactory();
    const earlier = record(Date.now() - 60_000);
    await writeBatch(await openDiagDb(factory), [], [earlier]);
    const tab = new LocalDiag();
    const opening = tab.open(factory);
    const meanwhile = record();
    tab.capture(meanwhile);
    await opening;
    expect(tab.records.map((r) => r.id)).toEqual([meanwhile.id, earlier.id]);
    await tab.idle();
    expect((await readRecords(await openDiagDb(factory))).map((r) => r.id)).toEqual([meanwhile.id, earlier.id]);
  });
});

