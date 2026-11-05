import "fake-indexeddb/auto";
import { nodeBodyPreparationFactory } from "../../db/src/node-driver";
import { generateDataset } from "@terno/mock-data";
import type { CategorizeScope } from "@terno/core";
import type { MailStore, Platform } from "@terno/store";
import { defineSearchConformance, defineSearchStateConformance, defineStoreConformance, seedThroughCommands } from "@terno/store/conformance";
import { afterAll, afterEach, expect, vi } from "vitest";
import { IdbMailStore } from "./store";

// Node has no browser Worker: large bodies tokenize on the Node worker the web platform's stands in for (w11)
const platform: Pick<Platform, "uuid" | "yield" | "bodyPreparation"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)), bodyPreparation: nodeBodyPreparationFactory };
let n = 0;
const open = (name: string, instantSearch: boolean) => IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch });
const reopen = async (store: MailStore, instantSearch: boolean) => {
  const name = (store as IdbMailStore).name;
  await store.close();
  return open(name, instantSearch);
};

// the whole contract, every search on the exact scan (the index never answers)
defineStoreConformance("IdbMailStore (fake-indexeddb, exact scan)", {
  searchPageSize: 500,
  ruleSample: 5,
  open: () => open(`scan-${++n}`, false),
  reopen: (store) => reopen(store, false),
});

/**
 * The instant option changes three things (`store.ts`): `searchPage`, a query `resolveScope` (and the count on it)
 * and a notification after each commit. So its mode runs what those answer, and each answer waits for the index and
 * proves it answered: an instant store silently scans until caught up (Codex revision 9 of plan 139).
 */
const indexAnswers = (real: IdbMailStore): IdbMailStore => {
  const scan = vi.spyOn(real as unknown as { scan: () => Promise<unknown> }, "scan");
  const fromIndex = vi.spyOn(real as unknown as { queryIdsFromIndex: () => number[] }, "queryIdsFromIndex");
  const answered = async <V,>(work: () => Promise<V>): Promise<V> => {
    expect(await real.instant!.settled()).toBe(true);
    scan.mockClear();
    fromIndex.mockClear();
    try {
      return await work();
    } finally {
      expect(scan, "the exact scan answered").not.toHaveBeenCalled();
    }
  };
  const threads: MailStore["threads"] = {
    ...real.threads,
    searchText: (p) => answered(async () => {
      const page = await real.threads.searchText(p);
      expect(page.strategy, p.query).toMatch(/^instant:/);
      return page;
    }),
  };
  const query = async <V,>(scope: CategorizeScope, work: () => Promise<V>): Promise<V> => {
    const result = await answered(work);
    if (scope.kind === "query") expect(fromIndex, scope.query).toHaveBeenCalled();
    return result;
  };
  const categorize: MailStore["categorize"] = {
    ...real.categorize,
    resolveScope: (categoryId, scope, now, limit) => query(scope, () => real.categorize.resolveScope(categoryId, scope, now, limit)),
    countScope: (categoryId, scope, now) => query(scope, () => real.categorize.countScope(categoryId, scope, now)),
  };
  return new Proxy(real, {
    get(target, key) {
      if (key === "threads") return threads;
      if (key === "categorize") return categorize;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
};
const instantStores: MailStore[] = [];
afterEach(async () => { for (const s of instantStores.splice(0)) if (s.isOpen) await s.close(); });
const opened = (store: IdbMailStore) => { const answering = indexAnswers(store); instantStores.push(answering); return answering; };
defineSearchStateConformance(
  "IdbMailStore (instant index, caught up)",
  async () => opened(await open(`instant-${++n}`, true)),
  async (store) => opened(await reopen(store, true) as IdbMailStore),
);

// and every search case answered by the index itself, once it caught up with the seeded mailbox
const NOW = Date.UTC(2026, 9, 22, 15, 30);
let indexed: IdbMailStore;
afterAll(async () => indexed?.close());
defineSearchConformance("IdbMailStore (instant index, caught up)", async () => {
  indexed = await open(`indexed-${++n}`, true);
  await seedThroughCommands(indexed, generateDataset({ threads: 2500, accounts: 4, seed: 11, now: NOW }), NOW);
  expect(await indexed.instant!.settled()).toBe(true);
  return {
    now: NOW,
    corpus: async () => {
      const s = await indexed.debug.snapshot();
      return { messages: s.search.messages, threads: s.search.threads, accounts: s.accounts, categories: s.categories };
    },
    search: async (query, scope, cursor, limit) => {
      const page = await indexed.threads.searchText({ query, ...scope, cursor, limit, now: NOW });
      expect(page.strategy).toMatch(/^instant:/);
      return { threadIds: page.items.map((t) => t.id), nextCursor: page.nextCursor, strategy: page.strategy };
    },
  };
});
