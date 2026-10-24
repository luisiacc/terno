/// <reference lib="webworker" />
/**
 * The adapter-independent suites, unchanged, in a dedicated worker of real
 * Chromium: the MailStore contract on SQLite-WASM over OPFS (sahpool), and
 * the instant engine's conformance.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { generateDataset } from "@terno/mock-data";
import { openDatabaseWith, sqlDb, SqlMailStore, wasmSqliteDriver } from "@terno/db/wasm";
import { corpusFromDataset, defineEngineConformance, defineStoreConformance } from "@terno/store/conformance";
import { InstantSearchEngine } from "@terno/store/instant";
import { IdbMailStore } from "@terno/idb";
import { describe, expect, it, run, type TestResult } from "./shim";

declare const self: DedicatedWorkerGlobalScope;

export type ConformanceMessage = { type: "result"; result: TestResult } | { type: "done"; results: TestResult[] } | { type: "error"; message: string };

async function defineSuites(suite: string): Promise<void> {
  if (suite === "opfs-sqlite") {
    const sqlite3 = await sqlite3InitModule();
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "unica-conformance", directory: ".unica-conformance", clearOnInit: true, initialCapacity: 16 });
    const driver = wasmSqliteDriver(sqlite3, { pool });
    let n = 0;
    const open = async (path: string) => {
      // every test opens a fresh mailbox: grow the pool ahead of it (database + journal)
      if (pool.getFileCount() + 4 > pool.getCapacity()) await pool.addCapacity(16);
      return new SqlMailStore(openDatabaseWith(driver, path));
    };
    defineStoreConformance("SqlMailStore (wasm-opfs)", {
      strategies: true,
      open: () => open(`/s${++n}.db`),
      reopen: async (store) => {
        const path = sqlDb(store).path;
        await store.close();
        return open(path);
      },
    });
    return;
  }
  if (suite === "idb") {
    // the browser's own IndexedDB, with and without the instant index in front
    const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((r) => setTimeout(r, 0)) };
    let n = 0;
    for (const instantSearch of [false, true]) {
      const open = (name: string) => IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch });
      defineStoreConformance(`IdbMailStore (Chromium IndexedDB, ${instantSearch ? "instant index" : "exact scan"})`, {
        open: () => open(`conformance-${Date.now()}-${++n}`),
        reopen: async (store) => {
          const name = (store as IdbMailStore).name;
          await store.close();
          return open(name);
        },
      });
    }
    return;
  }
  if (suite === "engine") {
    const NOW = Date.UTC(2026, 9, 22, 15, 30);
    const data = corpusFromDataset(generateDataset({ threads: 2500, accounts: 4, seed: 11, now: NOW }));
    defineEngineConformance(
      "InstantSearchEngine (Chromium worker)",
      {
        build: async (docs, revision) => {
          const e = new InstantSearchEngine();
          e.beginBuild(revision);
          await e.loadMessages(docs.messages);
          e.loadThreads(docs.threads);
          await e.finishBuild();
          return e;
        },
        empty: () => new InstantSearchEngine(),
        compact: (e) => (e as InstantSearchEngine).compacted(),
      },
      data,
    );
    return;
  }
  if (suite === "canary") {
    // proves the runner: a failing expectation is a failure, a skipped test is a skip
    describe("canary", () => {
      it("passes", () => expect({ a: [1, 2] }).toEqual({ a: [1, 2] }));
      it("fails", () => expect(1).toBe(2));
      it.runIf(false)("is skipped", () => {});
    });
    return;
  }
  throw new Error(`unknown suite ${suite}`);
}

self.onmessage = async (event: MessageEvent<{ suite: string }>) => {
  try {
    await defineSuites(event.data.suite);
    const results = await run((result) => self.postMessage({ type: "result", result } satisfies ConformanceMessage));
    self.postMessage({ type: "done", results } satisfies ConformanceMessage);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) } satisfies ConformanceMessage);
  }
};
