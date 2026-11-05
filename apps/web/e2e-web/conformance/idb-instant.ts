import type { IdbMailStore } from "@terno/idb";
import { generateDataset } from "@terno/mock-data";
import { oracleSearch, SEARCH_CASES, seedThroughCommands } from "@terno/store/conformance";
import { describe, expect, it } from "./shim";

const NOW = Date.UTC(2026, 9, 22, 15, 30);

/**
 * The index fed from the browser's own stores: once caught up, each search is the index's answer, the same as the
 * oracle's, and stays so across a change and a reopen. Every case on the full fixture is the unit project's
 * (fake-indexeddb), and the engine alone is this page's `engine` suite; what's native here is what feeds it.
 */
export function defineNativeIndexAnswers(open: (name: string) => Promise<IdbMailStore>): void {
  describe("the instant index on native IndexedDB", () => {
    it("answers once caught up, as the oracle does, through a change and a reopen", async () => {
      const name = `conformance-indexed-${Date.now()}`;
      let store = await open(name);
      await seedThroughCommands(store, generateDataset({ threads: 300, accounts: 4, seed: 11, now: NOW }), NOW);
      const answers = async () => {
        expect(await store.instant!.settled()).toBe(true);
        const s = await store.debug.snapshot();
        const corpus = { messages: s.search.messages, threads: s.search.threads, accounts: s.accounts, categories: s.categories };
        for (const [query] of SEARCH_CASES) {
          const ids: number[] = [];
          let cursor: Parameters<typeof store.threads.searchText>[0]["cursor"];
          do {
            const page = await store.threads.searchText({ query, cursor, limit: 37, now: NOW });
            expect(page.strategy, query).toMatch(/^instant:/);
            ids.push(...page.items.map((t) => t.id));
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          expect(ids, query).toEqual(oracleSearch(corpus, query, NOW, {}));
        }
      };
      await answers();
      const inbox = await store.threads.searchText({ query: "in:inbox", limit: 1, now: NOW });
      await store.threads.act({ threadIds: [inbox.items[0]!.id], action: "archive", signal: null, now: NOW });
      await answers();
      const reopened = store.name;
      await store.close();
      store = await open(reopened);
      await answers();
      await store.close();
    });
  });
}
