import { normalizeText, tokenize } from "@terno/core";
import { beforeAll, describe, expect, it } from "vitest";
import { StaleCursorError, type SearchCursor } from "../search";
import { oracleSearch, type SearchCorpus, type UiScope } from "./oracle";

export interface SearchHarness {
  /** the corpus the oracle evaluates: the store's data at the time of the call */
  corpus(): Promise<SearchCorpus>;
  now: number;
  search(query: string, scope: UiScope, cursor: SearchCursor | undefined, limit: number): Promise<{ threadIds: number[]; nextCursor: SearchCursor | null; strategy: string }>;
}

export interface SearchConformanceOptions {
  /** assert the planner's strategy per case (FTS5 only: other engines name theirs differently) */
  strategies?: boolean;
}

/** The oracle cases: [query, the FTS5 planner's strategy]. The fixture is generateDataset({ threads: 2500, accounts: 4, seed: 11 }). */
export const SEARCH_CASES: readonly [string, string][] = [
  ["factura", "fts"],
  ["reunión", "fts"],
  ["reunion", "fts"], // accent-insensitive
  ["REUNIÓN", "fts"],
  ["propu", "fts"], // prefix while typing
  ['"darse de baja"', "fts"],
  ['"baja darse"', "fts"],
  ["from:lucia", "fts"],
  ["de:garcía", "fts"],
  ["to:luis", "fts"],
  ["subject:propuesta", "fts"],
  ["subject:propuesta from:lucia", "fts"],
  ["factura -uber", "fts"],
  ["in:inbox factura", "fts"],
  ["factura has:attachment", "fts"],
  ["checkout from:notifications@github.com", "fts"],
  ["from:crew@morningbrew.com", "sender-index"],
  ["from:crew@morningbrew.com is:unread", "sender-index"],
  ["from:crew@morningbrew.com from:hola@platzi.com", "empty"],
  ["has:attachment", "walk"],
  ["is:unread", "walk"],
  ["is:starred", "walk"],
  ["in:spam", "walk"],
  ["in:trash", "walk"],
  ["in:sent", "walk"],
  ["category:facturas", "walk"],
  ["account:acme", "walk"],
  ["account:nonexistent", "empty"],
  ["category:nonexistent factura", "empty"],
  ["before:2025-06-01", "date-index"],
  ["after:30d", "walk"],
  ["after:90d has:attachment", "walk"],
  ["-factura", "fts-exclude"],
  ["-from:crew@morningbrew.com", "walk"],
  ["from:crew@morningbrew.com -markets", "sender-index"],
  ["has:attachment -factura", "walk"],
  ["before:2025-06-01 -factura", "date-index"],
  ["-account:acme", "walk"],
  ["factura -category:facturas", "fts"],
  ["-before:2025-06-01 has:attachment", "walk"],
  ["zzzqqqxx", "fts"],
  ["!!!", "walk"],
];

/**
 * Every case, every page (limit 37), against the brute-force oracle; plus UI
 * scope, same-message semantics and cursor identity. Engines and stores run
 * the same suite.
 */
export function defineSearchConformance(name: string, setup: () => Promise<SearchHarness>, options: SearchConformanceOptions = {}): void {
  describe(`search conformance: ${name}`, () => {
    let h: SearchHarness;
    let corpus: SearchCorpus;
    beforeAll(async () => {
      h = await setup();
      corpus = await h.corpus();
    });

    async function searchAll(query: string, scope: UiScope = {}, pageSize = 37) {
      const ids: number[] = [];
      const strategies = new Set<string>();
      let cursor: SearchCursor | undefined;
      for (let guard = 0; guard < 1000; guard++) {
        const page = await h.search(query, scope, cursor, pageSize);
        strategies.add(page.strategy);
        ids.push(...page.threadIds);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return { ids, strategies };
    }
    const oracle = (query: string, scope: UiScope = {}) => oracleSearch(corpus, query, h.now, scope);

    it.each(SEARCH_CASES)("%s", async (query, strategy) => {
      const { ids, strategies } = await searchAll(query);
      if (options.strategies) expect([...strategies]).toEqual([strategy]);
      expect(ids).toEqual(oracle(query));
    });

    it("finds a meaningful number of results for common queries (fixture sanity)", () => {
      expect(oracle("factura").length).toBeGreaterThan(50);
      expect(oracle("from:crew@morningbrew.com").length).toBeGreaterThan(10);
      expect(oracle("factura -uber").length).toBeLessThan(oracle("factura").length);
    });

    it("respects account and category scope from the UI", async () => {
      const account = [...corpus.accounts].sort((a, b) => a.id - b.id)[1]!.id;
      const category = [...corpus.categories].sort((a, b) => a.id - b.id)[0]!.id;
      expect((await searchAll("factura", { accountId: account })).ids).toEqual(oracle("factura", { accountId: account }));
      expect((await searchAll("factura", { categoryId: category })).ids).toEqual(oracle("factura", { categoryId: category }));
      expect((await searchAll("account:acme factura", { accountId: account })).ids).toEqual(oracle("account:acme factura", { accountId: account }));
    });

    it("requires message predicates to match the same message", async () => {
      // a thread where X sent a message, and a *different* message (not from X) mentions "presupuesto"
      const mentions = (s: string) => normalizeText(s).includes("presupuesto");
      const byThread = new Map<number, typeof corpus.messages[number][]>();
      for (const m of corpus.messages) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
      let found: { threadId: number; fromEmail: string } | undefined;
      for (const [threadId, msgs] of byThread) {
        const sender = msgs.find(
          (a) =>
            /@.+\./.test(a.fromEmail) &&
            msgs.some((b) => b.fromEmail !== a.fromEmail && mentions(b.body)) &&
            !msgs.some((c) => c.fromEmail === a.fromEmail && (mentions(c.body) || mentions(c.subject))),
        );
        if (sender) {
          found = { threadId, fromEmail: sender.fromEmail };
          break;
        }
      }
      expect(found).toBeTruthy();
      expect((await searchAll("presupuesto")).ids).toContain(found!.threadId); // positive control
      expect((await searchAll(`from:${found!.fromEmail}`)).ids).toContain(found!.threadId); // positive control
      expect((await searchAll(`from:${found!.fromEmail} presupuesto`)).ids).not.toContain(found!.threadId);
    });

    it("phrases stay inside one field and match whole tokens", async () => {
      const m = corpus.messages.find((x) => tokenize(x.subject).length >= 2 && tokenize(x.body).length >= 2)!;
      const lastOfSubject = tokenize(m.subject).at(-1)!;
      const firstOfBody = tokenize(m.body)[0]!;
      const spanning = `"${lastOfSubject} ${firstOfBody}"`;
      expect((await searchAll(spanning)).ids).toEqual(oracle(spanning));
    });

    it("cursors carry the query key and revision; a cursor of another query is refused", async () => {
      const page = await h.search("factura", {}, undefined, 5);
      expect(page.nextCursor).toBeTruthy();
      const cursor = page.nextCursor!;
      expect(typeof cursor.queryKey).toBe("string");
      expect(typeof cursor.revision.epoch).toBe("string");
      const next = await h.search("factura", {}, cursor, 5);
      expect(next.threadIds).toEqual(oracle("factura").slice(5, 10));
      await expect(h.search("reunión", {}, cursor, 5)).rejects.toBeInstanceOf(StaleCursorError);
    });

    it("a cursor minted by another database (epoch) or at another revision is refused", async () => {
      const cursor = (await h.search("factura", {}, undefined, 5)).nextCursor!;
      await expect(h.search("factura", {}, { ...cursor, revision: { epoch: "another-database", seq: cursor.revision.seq } }, 5)).rejects.toBeInstanceOf(StaleCursorError);
      await expect(h.search("factura", {}, { ...cursor, revision: { ...cursor.revision, seq: cursor.revision.seq + 1 } }, 5)).rejects.toBeInstanceOf(StaleCursorError);
    });
  });
}
