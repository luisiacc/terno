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
