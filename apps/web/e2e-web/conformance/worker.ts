/// <reference lib="webworker" />
/**
 * The adapter-independent suites, unchanged, in a dedicated worker of real
 * Chromium: what of the MailStore contract depends on real OPFS, the whole
 * contract on native IndexedDB, and the instant engine's conformance.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { generateDataset } from "@terno/mock-data";
import { openDatabaseWith, sqlDb, SqlMailStore, wasmSqliteDriver } from "@terno/db/wasm";
import { corpusFromDataset, defineEngineConformance, defineStoreConformance } from "@terno/store/conformance";
import { InstantSearchEngine } from "@terno/store/instant";
import { IdbMailStore } from "@terno/idb";
import { describe, expect, it, run, type TestResult } from "./shim";
import { defineIncomingWorkerConformance } from "./incoming";
import { defineNativeIndexAnswers } from "./idb-instant";
import { defineOpfsLifecycle } from "./opfs-lifecycle";
import { OPFS_CONTRACT } from "./opfs-subset";
import { defineUncertaintyConformance } from "./uncertainty";

declare const self: DedicatedWorkerGlobalScope;

export type ConformanceMessage = { type: "result"; result: TestResult } | { type: "done"; results: TestResult[] } | { type: "error"; message: string };

/** Set by a suite that runs part of what it defined. */
let keep: ((name: string) => boolean) | undefined;

async function defineSuites(suite: string): Promise<void> {
  if (suite === "idb-uncertainty") {
    defineUncertaintyConformance();
    return;
  }
  if (suite === "incoming") {
    defineIncomingWorkerConformance();
    return;
  }
  if (suite === "opfs-sqlite") {
    const sqlite3 = await sqlite3InitModule();
    const directory = ".terno-conformance";
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "terno-conformance", directory, clearOnInit: true, initialCapacity: 128 });
    const driver = wasmSqliteDriver(sqlite3, { pool });
    // migrating a new file is most of a test's time here (270 of its 370 ms); opfs-lifecycle.ts proves that step, so the rest copy its result
    openDatabaseWith(driver, "/template.db").close();
    const template = pool.exportFile("/template.db");
    let n = 0;
    const open = async (path: string) => {
      // every test opens a fresh mailbox: grow the pool ahead of it (database + journal)
      if (pool.getFileCount() + 4 > pool.getCapacity()) await pool.addCapacity(64);
      return new SqlMailStore(openDatabaseWith(driver, path));
    };
    defineOpfsLifecycle(driver, pool, directory);
    defineStoreConformance("SqlMailStore (wasm-opfs)", {
      strategies: true,
      open: async () => {
        const path = `/s${++n}.db`;
        if (pool.getFileCount() + 4 > pool.getCapacity()) await pool.addCapacity(64);
        pool.importDb(path, template);
        return open(path);
      },
      reopen: async (store) => {
        const path = sqlDb(store).path;
        await store.close();
        return open(path);
      },
    });
    keep = (name) => name.startsWith("OPFS lifecycle > ") || OPFS_CONTRACT.some((entry) => name.includes(entry));
    return;
  }
  if (suite === "idb") {
    // the browser's own IndexedDB with the instant index in front. Its exact scan is the mode the unit project's fake-indexeddb holds in full
    const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((r) => setTimeout(r, 0)) };
    let n = 0;
    const open = (name: string) => IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: true });
    defineStoreConformance("IdbMailStore (Chromium IndexedDB, instant index)", {
      open: () => open(`conformance-${Date.now()}-${++n}`),
      reopen: async (store) => {
        const name = (store as IdbMailStore).name;
        await store.close();
        return open(name);
      },
    });
    defineNativeIndexAnswers(open);
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
    const results = await run((result) => self.postMessage({ type: "result", result } satisfies ConformanceMessage), keep);
    self.postMessage({ type: "done", results } satisfies ConformanceMessage);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) } satisfies ConformanceMessage);
  }
};
