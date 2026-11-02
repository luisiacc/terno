import { expect, it, vi } from "vitest";
import { openDatabase } from "./index";
import { nodePlatform } from "./node-driver";
import { SqlMailStore } from "./sql-store";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

it("answers exact ready-index queries without reading stored tokens in any account", async () => {
  const db = openDatabase(":memory:"), store = new SqlMailStore(db, { platform: nodePlatform, instantSearch: true });
  try {
    const [accountId, other] = await withAccounts(store, 2);
    const result = await store.sync.ingest([
      msg({ accountId: accountId!, providerThreadId: "one", subject: "Synthetic", bodyText: "alpha exact phrase ".repeat(4000), bodyState: "full" }),
      msg({ accountId: other!, providerThreadId: "other", subject: "Synthetic", bodyText: "unrelated account words ".repeat(4000), bodyState: "full" }),
    ], { now: 1, classifier: null, applyFilters: false });
    expect(await store.instant!.settled()).toBe(true);
    const own = (await store.threads.list({ view: "inbox", accountId: accountId!, limit: 10 })).items[0]!.id;
    let reads = 0, enumerations = 0;
    const all = db.all.bind(db);
    const enumeration = vi.spyOn(db, "all").mockImplementation((sql, ...args) => { if (sql.startsWith("SELECT DISTINCT c.id FROM body_captures")) enumerations++; return all(sql, ...args); });
    const get = db.get.bind(db);
    const spy = vi.spyOn(db, "get").mockImplementation((sql, ...args) => { if (sql === "SELECT ordinal,value FROM body_parts WHERE capture_id=? AND field=? AND ordinal=?") reads++; return get(sql, ...args); });
    try {
      for (const [query, ids] of [["absentmarker", []], ['"alpha exact phrase"', [own]], ["alpha -missing", [own]], ["-alpha", []], ["😀", [own]]] as const) {
        expect((await store.threads.searchText({ query, accountId: accountId!, now: 1, limit: 10 })).items.map((row) => row.id)).toEqual(ids);
      }
      expect(enumerations, "ready RAM answers must not enumerate published captures").toBe(0);
      expect(reads, "ready RAM answers must not scan any stored body-token parts").toBe(0);
      expect(result.touched).toHaveLength(2);
      await store.instant!.close();
      reads = 0; enumerations = 0;
      expect((await store.threads.searchText({ query: '"alpha exact phrase"', accountId: accountId!, now: 1, limit: 10 })).items.map((row) => row.id)).toEqual([own]);
      expect(reads).toBeGreaterThan(0);
      expect(enumerations).toBeGreaterThan(0);
    } finally { spy.mockRestore(); enumeration.mockRestore(); }
  } finally { await store.close(); }
});

it("keeps common positive and negative RAM phrases exact with captured candidates", async () => {
  let hold = false, armed = false, entered!: () => void, release!: () => void;
  const held = new Promise<void>((r) => { entered = r; }), resume = new Promise<void>((r) => { release = r; });
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (hold) { hold = false; entered(); await resume; } } };
  const db = openDatabase(":memory:"), store = new SqlMailStore(db, { platform, instantSearch: true });
  let searching: ReturnType<typeof store.threads.searchText> | undefined;
  try {
    const [accountId, other] = await withAccounts(store, 2);
    await store.sync.ingest(Array.from({ length: 513 }, (_, i) => msg({ accountId: accountId!, providerMsgId: `common-${i}`, providerThreadId: `common-${i}`, date: 1, subject: "Synthetic", bodyText: i === 0 ? "alpha gap beta ".repeat(3000) : "alpha gap beta" })), { now: 1, classifier: null, applyFilters: false });
    await store.sync.ingest([msg({ accountId: other!, date: 1, subject: "Unrelated", bodyText: "omega unrelated body ".repeat(3000) })], { now: 1, classifier: null, applyFilters: false });
    expect(await store.instant!.settled()).toBe(true);
    const ownCapture = db.get<{ capture_id: string }>("SELECT capture_id FROM body_heads WHERE message_id=1")!.capture_id;
    const reads = new Set<string>(), get = db.get.bind(db);
    const spy = vi.spyOn(db, "get").mockImplementation((sql, ...args) => { if (armed && sql === "SELECT text_parts,html_parts,token_parts,ready FROM body_captures WHERE id=?") { armed = false; hold = true; }
      if (sql === "SELECT ordinal,value FROM body_parts WHERE capture_id=? AND field=? AND ordinal=?") reads.add(String(args[0])); return get(sql, ...args); });
    try {
      for (const [query, expected] of [['-"alpha beta"', [513,512,511,510,509,508,507,506,505,504]], ['"alpha beta"', []], ['-"alpha gap"', []], ['-alp', []], ['"alpha gap"', [513,512,511,510,509,508,507,506,505,504]]] as const) {
        expect((await store.threads.searchText({ query, accountId: accountId!, now: 1, limit: 10 })).items.map((row) => row.id), query).toEqual(expected);
      }
      expect([...reads]).toEqual([ownCapture]);
      armed = true;
      searching = store.threads.searchText({ query: '-"alpha beta"', accountId: accountId!, now: 1, limit: 10 }); void searching.catch(() => {});
      await held;
      await store.sync.setBody(1, "alpha beta " + "fresh ".repeat(10000), null, { now: 2, classifier: null });
      release(); await expect(searching).rejects.toMatchObject({ code: "STALE" });
      expect(await store.instant!.settled()).toBe(true);
      expect((await store.threads.searchText({ query: '"alpha beta"', accountId: accountId!, now: 2, limit: 10 })).items.map((row) => row.id)).toEqual([1]);
    } finally { spy.mockRestore(); }
  } finally { release(); await searching?.catch(() => {}); await store.close(); }
});

it("finishes a prepared fallback when the actual RAM build becomes ready during its yielded read", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "terno-ready-transition-")), path = join(directory, "mail.db");
  let hold = false, armed = false, readEntered!: () => void, resumeRead!: () => void, buildEntered!: () => void, resumeBuild!: () => void;
  const reading = new Promise<void>((r) => { readEntered = r; }), readResume = new Promise<void>((r) => { resumeRead = r; }), building = new Promise<void>((r) => { buildEntered = r; }), buildResume = new Promise<void>((r) => { resumeBuild = r; });
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (hold) { hold = false; readEntered(); await readResume; } } };
  let store = new SqlMailStore(openDatabase(path), { platform, instantSearch: false });
  let searching: ReturnType<typeof store.threads.searchText> | undefined;
  const spies: { mockRestore(): void }[] = [];
  try {
    const [accountId] = await withAccounts(store, 1);
    await store.sync.ingest(Array.from({ length: 513 }, (_, i) => msg({ accountId: accountId!, providerThreadId: `transition-${i}`, date: 1, subject: "Synthetic", bodyText: i ? "alpha gap beta" : "alpha gap beta ".repeat(3000) })), { now: 1, classifier: null, applyFilters: false });
    await store.close();
    store = new SqlMailStore(openDatabase(path), { platform, instantSearch: true });
    const begin = store.feed.beginBuild.bind(store.feed);
    spies.push(vi.spyOn(store.feed, "beginBuild").mockImplementation(async () => { const actual = await begin(); return { ...actual, async *messages() { for await (const page of actual.messages()) { buildEntered(); await buildResume; yield page; } } }; }));
    await building;
    const db = store.db, get = db.get.bind(db);
    spies.push(vi.spyOn(db, "get").mockImplementation((sql, ...args) => { if (armed && sql === "SELECT text_parts,html_parts,token_parts,ready FROM body_captures WHERE id=?") { armed = false; hold = true; } return get(sql, ...args); }));
    armed = true; searching = store.threads.searchText({ query: '-"alpha beta"', accountId: accountId!, now: 1, limit: 10 }); void searching.catch(() => {});
    await reading; resumeBuild(); expect(await store.instant!.settled()).toBe(true); resumeRead();
    expect((await searching).items.map((row) => row.id)).toEqual([513,512,511,510,509,508,507,506,505,504]);
  } finally { resumeRead(); resumeBuild(); await searching?.catch(() => {}); for (const spy of spies) spy.mockRestore(); await store.close(); rmSync(directory, { recursive: true, force: true }); }
});
