/**
 * SqlMailStore with instant search: revision-gated routing (RAM only when it
 * is exactly at the store's revision, FTS5 otherwise), the background build,
 * catch-up after commits, snapshots across restarts (missing, damaged,
 * foreign, behind a pruned log), memory caps and compaction.
 */
import { generateDataset } from "@unica/mock-data";
import { defineSearchConformance, ingest, msg, type SearchCorpus } from "@unica/store/conformance";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodePlatform, openDatabase } from "./index";
import { SqlMailStore, type SqlMailStoreOptions } from "./sql-store";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const root = mkdtempSync(join(tmpdir(), "unica-instant-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshPath = () => join(mkdtempSync(join(root, `s${n++}-`)), "unica.db");

function open(path: string, instant: SqlMailStoreOptions["instantSearch"] = true, dbOptions: Parameters<typeof openDatabase>[1] = {}) {
  return new SqlMailStore(openDatabase(path, dbOptions), { instantSearch: instant, platform: nodePlatform });
}

async function seeded(path: string, threads = 300, instant: SqlMailStoreOptions["instantSearch"] = true) {
  const store = open(path, instant);
  await store.dev.seed(generateDataset({ threads, accounts: 2, seed: 9, now: NOW }), { now: NOW });
  return store;
}

const ids = async (store: SqlMailStore, query: string, limit = 1000) => {
  const page = await store.threads.searchText({ query, limit, now: NOW });
  return { ids: page.items.map((t) => t.id), strategy: page.strategy };
};

describe("search conformance with instant search on", () => {
  let store: SqlMailStore;
  beforeAll(async () => {
    store = open(freshPath());
    await store.dev.seed(generateDataset({ threads: 2500, accounts: 4, seed: 11, now: NOW }), { now: NOW });
    expect(await store.instant!.settled()).toBe(true);
  }, 120_000);
  afterAll(async () => {
    await store.close();
  });

  defineSearchConformance("SqlMailStore (instant)", async () => ({
    now: NOW,
    corpus: async (): Promise<SearchCorpus> => {
      const s = await store.debug.snapshot();
      return { messages: s.search.messages, threads: s.search.threads, accounts: s.accounts, categories: s.categories };
    },
    search: async (query, scope, cursor, limit) => {
      const page = await store.threads.searchText({ query, ...scope, cursor, limit, now: NOW });
      return { threadIds: page.items.map((t) => t.id), nextCursor: page.nextCursor, strategy: page.strategy };
    },
  }));

  it("answered from RAM, exactly at the store's revision", async () => {
    const page = await store.threads.searchText({ query: "factura", limit: 10, now: NOW });
    expect(page.strategy).toMatch(/^instant:/);
    expect(page.revision).toEqual(await store.feed.head());
    expect(page.complete).toBe(true);
    expect(store.capabilities.search).toBe("instant+fts5");
  });
});

describe("routing", () => {
  it("FTS5 answers until the index is current, then RAM, with the same results", async () => {
    const store = await seeded(freshPath());
    const before = await ids(store, "factura");
    expect(before.strategy).not.toMatch(/^instant/);
    expect(await store.instant!.settled()).toBe(true);
    const after = await ids(store, "factura");
    expect(after.strategy).toMatch(/^instant/);
    expect(after.ids).toEqual(before.ids);
    await store.close();
  });

  it("a write is searchable at once: FTS5 answers while the index catches up after the commit", async () => {
    const store = await seeded(freshPath());
    await store.instant!.settled();
    const [account] = (await store.accounts.list()).map((a) => a.id);
    await ingest(store, [msg({ accountId: account!, subject: "Zanahoria morada" })]);
    const now = await ids(store, "zanahoria");
    expect(now.ids).toHaveLength(1);
    expect(now.strategy).not.toMatch(/^instant/);
    await store.instant!.settled();
    expect(await ids(store, "zanahoria")).toEqual({ ids: now.ids, strategy: expect.stringMatching(/^instant/) });
    // and a delete disappears the same way
    await store.threads.act({ threadIds: now.ids, action: "trash", signal: null, now: NOW });
    expect((await ids(store, "zanahoria")).ids).toEqual([]);
    await store.instant!.settled();
    expect(await ids(store, "zanahoria")).toEqual({ ids: [], strategy: expect.stringMatching(/^instant/) });
    expect((await ids(store, "in:trash zanahoria")).ids).toEqual(now.ids);
    await store.close();
  });

  it("over its memory cap the index gives up and FTS5 keeps answering", async () => {
    const warnings: string[] = [];
    const store = new SqlMailStore(openDatabase(freshPath()), {
      instantSearch: { memory: { steadyBytes: 256 * 1024, peakBytes: 512 * 1024 } },
      platform: nodePlatform,
      log: (level, message) => void (level === "warn" && warnings.push(message)),
    });
    await store.dev.seed(generateDataset({ threads: 300, accounts: 2, seed: 9, now: NOW }), { now: NOW });
    expect(await store.instant!.settled()).toBe(false);
    expect(store.instant!.report).toMatchObject({ state: "disabled", disabled: expect.stringMatching(/cap/) });
    expect(warnings.some((w) => /disabled/.test(w))).toBe(true);
    const r = await ids(store, "factura");
    expect(r.strategy).not.toMatch(/^instant/);
    expect(r.ids.length).toBeGreaterThan(0);
    await store.close();
  });

  it("closing while the index builds stops it and releases its lease", async () => {
    const path = freshPath();
    const seed = await seeded(path, 600, false);
    await seed.close();
    const store = open(path);
    await new Promise((r) => setTimeout(r, 5));
    await store.close();
    const db = openDatabase(path);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM search_leases")!.c).toBe(0);
    db.close();
  });

  it("compacts tombstones in the background and keeps answering the same", async () => {
    const store = await seeded(freshPath(), 600);
    await store.instant!.settled();
    const messages = (await store.debug.snapshot()).messages.slice(0, 2600);
    for (let i = 0; i < messages.length; i += 200) {
      for (const m of messages.slice(i, i + 200)) await store.sync.setBody(m.id, `cuerpo renovado ${m.id} factura`, null, { now: NOW, classifier: null });
    }
    await store.instant!.settled();
    const fts = await ids(store, "renovado");
    for (let i = 0; i < 400 && store.instant!.report.compactions === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(store.instant!.report.compactions).toBeGreaterThan(0);
    await store.instant!.settled();
    const ram = await ids(store, "renovado");
    expect(ram.strategy).toMatch(/^instant/);
    expect(ram.ids).toEqual(fts.ids);
    await store.close();
  }, 60_000);
});

describe("snapshots", () => {
  it("close writes one atomically; the next start restores it and replays writes made meanwhile before answering", async () => {
    const path = freshPath();
    let store = await seeded(path);
    await store.instant!.settled();
    await store.close();
    expect(existsSync(`${path}.search`)).toBe(true);
    expect(readdirSync(join(path, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // a write while the index isn't running (another process, an older version)
    store = open(path, false);
    const [account] = (await store.accounts.list()).map((a) => a.id);
    await ingest(store, [msg({ accountId: account!, subject: "Escrito sin índice" })]);
    await store.close();

    store = open(path);
    expect(await store.instant!.settled()).toBe(true);
    expect(store.instant!.report.restore).toBeDefined();
    expect(store.instant!.report.build).toBeUndefined();
    const r = await ids(store, "indice escrito");
    expect(r.strategy).toMatch(/^instant/);
    expect(r.ids).toHaveLength(1);
    await store.close();
  });

  it("a missing, truncated, bit-flipped or foreign snapshot is never trusted: the index rebuilds", async () => {
    const path = freshPath();
    let store = await seeded(path);
    await store.instant!.settled();
    const expected = await ids(store, "factura");
    await store.close();
    const good = readFileSync(`${path}.search`);
    const other = freshPath();
    const o = await seeded(other, 50);
    await o.instant!.settled();
    await o.close();
    const flipped = Buffer.from(good);
    flipped[flipped.length >> 1]! ^= 1;
    const cases: [string, (() => void)][] = [
      ["missing", () => rmSync(`${path}.search`)],
      ["truncated", () => writeFileSync(`${path}.search`, good.subarray(0, good.length >> 1))],
      ["bit-flipped", () => writeFileSync(`${path}.search`, flipped)],
      ["garbage", () => writeFileSync(`${path}.search`, "hola")],
      ["another database's", () => copyFileSync(`${other}.search`, `${path}.search`)],
    ];
    for (const [label, damage] of cases) {
      damage();
      store = open(path);
      expect(await store.instant!.settled(), label).toBe(true);
      expect(store.instant!.report.restore, label).toBeUndefined();
      expect(store.instant!.report.build, label).toBeDefined();
      expect(await ids(store, "factura"), label).toEqual({ ids: expected.ids, strategy: expect.stringMatching(/^instant/) });
      await store.close();
    }
  }, 60_000);

  it("a snapshot that can't be written leaves the index serving (retried later)", async () => {
    const warnings: string[] = [];
    const store = new SqlMailStore(openDatabase(freshPath()), {
      instantSearch: true,
      platform: { ...nodePlatform, files: { ...nodePlatform.files!, replace: async () => Promise.reject(new Error("disk full")) } },
      log: (level, message) => void (level === "warn" && warnings.push(message)),
    });
    await store.dev.seed(generateDataset({ threads: 200, accounts: 2, seed: 9, now: NOW }), { now: NOW });
    expect(await store.instant!.settled()).toBe(true);
    for (let i = 0; i < 200 && !warnings.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(warnings).toContain("could not write the search snapshot");
    expect((await ids(store, "factura")).strategy).toMatch(/^instant/);
    expect(store.instant!.report).toMatchObject({ state: "ready", rebuilds: 0 });
    await store.close();
  });

  it("a snapshot behind a pruned log is discarded and rebuilt", async () => {
    const path = freshPath();
    let store = await seeded(path);
    await store.instant!.settled();
    await store.close();
    // a tiny log: these writes prune past the snapshot's revision
    store = new SqlMailStore(openDatabase(path, { searchLogBytes: 64 }));
    const [account] = (await store.accounts.list()).map((a) => a.id);
    for (let i = 0; i < 20; i++) await ingest(store, [msg({ accountId: account!, subject: `Podado ${i}` })]);
    await store.close();
    store = open(path);
    expect(await store.instant!.settled()).toBe(true);
    expect(store.instant!.report.build).toBeDefined();
    expect((await ids(store, "podado")).ids).toHaveLength(20);
    await store.close();
  });
});
