import "fake-indexeddb/auto";
import { generateDataset } from "@terno/mock-data";
import type { MailStore, Platform } from "@terno/store";
import { defineSearchConformance, defineStoreConformance, seedThroughCommands } from "@terno/store/conformance";
import { afterAll, expect } from "vitest";
import { IdbMailStore } from "./store";

const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };
let n = 0;
const open = (name: string, instantSearch: boolean) => IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch });
const reopen = async (store: MailStore, instantSearch: boolean) => {
  const name = (store as IdbMailStore).name;
  await store.close();
  return open(name, instantSearch);
};

// every search on the exact scan (the index never answers)
defineStoreConformance("IdbMailStore (fake-indexeddb, exact scan)", {
  open: () => open(`scan-${++n}`, false),
  reopen: (store) => reopen(store, false),
});

// the instant index in front (searches the index hasn't caught up with still scan)
defineStoreConformance("IdbMailStore (fake-indexeddb, instant index)", {
  open: () => open(`instant-${++n}`, true),
  reopen: (store) => reopen(store, true),
});

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
