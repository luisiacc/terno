/**
 * The instant engine against FTS5 over the same store: built from the store's
 * search feed (lease, sliced scan, replay), checked on every page against the
 * FTS5 planner and the brute-force oracle, through random store commands and
 * a snapshot round-trip. FTS5 is its phrase doclist, as in production.
 */
import { parseSearch, resolveSearch } from "@terno/core";
import { generateDataset } from "@terno/mock-data";
import type { MailStore, Revision, SearchCursor, SearchFeed } from "@terno/store";
import { defineSearchConformance, generateQueries, ingest, msg, oracleSearch, type SearchCorpus, type UiScope } from "@terno/store/conformance";
import { InstantSearchEngine } from "@terno/store/instant";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "./index";
import { ftsTermMessages, loadScope } from "./search";
import { Fts5SearchEngine } from "./search-engine";
import { SqlMailStore } from "./sql-store";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const dir = mkdtempSync(join(tmpdir(), "unica-instant-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function catchUp(e: InstantSearchEngine, feed: SearchFeed): Promise<void> {
  for (;;) {
    const head = await feed.head();
    if (e.revision!.seq === head.seq) return;
    for (const b of await feed.changes(e.revision!, head, 50)) await e.apply(b);
  }
}

async function buildFrom(store: SqlMailStore): Promise<InstantSearchEngine> {
  const lease = await store.feed.beginBuild();
  try {
    const e = new InstantSearchEngine({ phrases: (term) => ftsTermMessages(store.db, term) });
    e.beginBuild(lease.from);
    for await (const page of lease.messages()) await e.loadMessages(page);
    for await (const page of lease.threads()) e.loadThreads(page);
    await e.finishBuild();
    await catchUp(e, store.feed);
    return e;
  } finally {
    await lease.release();
  }
}

const corpusOf = async (store: MailStore): Promise<SearchCorpus> => {
  const s = await store.debug.snapshot();
  return { messages: s.search.messages, threads: s.search.threads, accounts: s.accounts, categories: s.categories };
};

/** every page of a query, from one engine at one revision */
async function pages(store: SqlMailStore, engine: { query: InstantSearchEngine["query"] }, query: string, scope: UiScope = {}, limit = 37): Promise<{ ids: number[]; strategies: Set<string> }> {
  const at = await store.feed.head();
  const search = resolveSearch(parseSearch(query, NOW), query, scope, loadScope(store.db));
  const ids: number[] = [];
  const strategies = new Set<string>();
  let cursor: SearchCursor | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await engine.query({ search, cursor, limit }, at);
    strategies.add(page.strategy);
    ids.push(...page.threadIds);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { ids, strategies };
}

describe("instant engine over SqlMailStore", () => {
  let store: SqlMailStore;
  let engine: InstantSearchEngine;
  let fts: Fts5SearchEngine;
  let corpus: SearchCorpus;
  beforeAll(async () => {
    store = new SqlMailStore(openDatabase(join(dir, "seeded.db")));
    await store.dev.seed(generateDataset({ threads: 2500, accounts: 4, seed: 11, now: NOW }), { now: NOW });
    fts = new Fts5SearchEngine(store.db);
    engine = await buildFrom(store);
    corpus = await corpusOf(store);
  }, 120_000);
  afterAll(async () => {
    await store.close();
  });

  defineSearchConformance("InstantSearchEngine (built from the SQL feed)", async () => ({
    now: NOW,
    corpus: async () => corpus,
    search: async (query, scope, cursor, limit) => {
      const search = resolveSearch(parseSearch(query, NOW), query, scope, corpus);
      return engine.query({ search, cursor, limit }, await store.feed.head());
    },
  }));

  for (let chunk = 0; chunk < 5; chunk++) {
    it(`generated queries, part ${chunk + 1}/5: every page equals FTS5 and the oracle`, async () => {
      const all = generateQueries(corpus, 500, 404);
      for (const q of all.slice(chunk * 100, chunk * 100 + 100)) {
        const ram = await pages(store, engine, q);
        const disk = await pages(store, fts, q);
        expect(ram.ids, q).toEqual(disk.ids);
        expect(ram.ids, q).toEqual(oracleSearch(corpus, q, NOW));
      }
    }, 120_000);
  }

  it("frequent words that are rarely adjacent are settled by the FTS5 phrase doclist, exactly", async () => {
    const phrases = ['"hola equipo"', '"baja darse"', '"de equipo"', '"la factura de"', '"gracias saludos"', 'subject:"re factura"', "to:luis.cor"];
    const used = new Set<string>();
    for (const q of phrases) {
      const ram = await pages(store, engine, q);
      for (const s of ram.strategies) used.add(s);
      expect(ram.ids, q).toEqual((await pages(store, fts, q)).ids);
    }
    expect([...used].some((s) => s.endsWith("+phrases"))).toBe(true);
  });
});

describe("instant engine following store commands", () => {
  it("after every command and catch-up, every page equals FTS5; a snapshot restored mid-way keeps up", async () => {
    const store = new SqlMailStore(openDatabase(join(dir, "mutations.db")));
    await store.dev.seed(generateDataset({ threads: 400, accounts: 2, seed: 3, now: NOW }), { now: NOW });
    const fts = new Fts5SearchEngine(store.db);
    let engine = await buildFrom(store);
    const accounts = (await store.accounts.list()).map((a) => a.id);
    const cats = (await store.categories.list()).map((c) => c.id);
    let seed = 17;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const probe = ["presupuesto", "factura", "-factura", "is:unread", "in:trash", "in:inbox nuevo", "re", "cuerpo", '"cuerpo nuevo"', "category:fact", "has:attachment -factura", "from:ana"];
    const rfc: string[] = [];
    for (let step = 0; step < 80; step++) {
      const snap = await store.debug.snapshot();
      const threads = snap.threads.map((t) => t.id);
      const r = rand();
      if (r < 0.35) {
        const id = `mut${step}@x`;
        await ingest(store, [msg({ accountId: pick(accounts), rfcMessageId: id, inReplyTo: rfc.length && rand() < 0.5 ? pick(rfc) : null, subject: `Presupuesto ${step}`, bodyText: rand() < 0.3 ? null : `cuerpo nuevo ${step} factura`, bodyState: "full" })]);
        rfc.push(id);
      } else if (r < 0.55) {
        await store.threads.act({ threadIds: [pick(threads), pick(threads)], action: pick(["archive", "trash", "markRead", "markUnread", "star", "unstar", "moveToInbox", "spam"] as const), signal: null, now: NOW });
      } else if (r < 0.7) {
        await store.categories.add({ categoryId: pick(cats), threadIds: [pick(threads), pick(threads)], addedBy: "user", now: NOW });
      } else if (r < 0.8) {
        await store.categories.remove({ categoryId: pick(cats), threadIds: [pick(threads)], reason: "user", now: NOW });
      } else if (r < 0.92) {
        await store.sync.setBody(pick(snap.messages).id, rand() < 0.2 ? null : `cuerpo nuevo ${step} presupuesto`, null, { now: NOW, classifier: null });
      } else {
        await store.sync.remove([pick(snap.messages).id]);
      }
      await catchUp(engine, store.feed);
      if (step === 40) {
        const restored = new InstantSearchEngine({ phrases: (term) => ftsTermMessages(store.db, term) });
        expect(await restored.restore(await engine.snapshot())).toBe(true);
        engine = restored;
      }
      if (step % 4 === 0 || step > 70) {
        for (const q of probe) expect((await pages(store, engine, q)).ids, `step ${step}: ${q}`).toEqual((await pages(store, fts, q)).ids);
      }
    }
    await store.close();
  }, 120_000);

  it("refuses a stale cursor and answers only at its own revision", async () => {
    const store = new SqlMailStore(openDatabase(join(dir, "cursor.db")));
    const [a] = (await store.dev.seed(generateDataset({ threads: 100, accounts: 1, seed: 5, now: NOW }), { now: NOW })).accountIds;
    const engine = await buildFrom(store);
    const head: Revision = await store.feed.head();
    const search = resolveSearch(parseSearch("a", NOW), "a", {}, loadScope(store.db));
    const first = await engine.query({ search, limit: 5 }, head);
    await ingest(store, [msg({ accountId: a!, subject: "algo nuevo" })]);
    const next = await store.feed.head();
    await expect(engine.query({ search, limit: 5 }, next)).rejects.toThrow(/not at revision/);
    await catchUp(engine, store.feed);
    await expect(engine.query({ search, cursor: first.nextCursor!, limit: 5 }, next)).rejects.toMatchObject({ name: "StaleCursorError", reason: "revision" });
    await store.close();
  });
});
