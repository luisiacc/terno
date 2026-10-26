import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { openDatabase, SqlMailStore } from "./index";
import { defineDateSearch } from "./test/search-dates";

for (const instant of [false, true]) {
  defineDateSearch(`SQL (${instant ? "instant" : "fallback"})`, async (now) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-date-search-"));
    const store = new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: instant });
    return {
      store, instant, fallback: "sql",
      search: (query, cursor, limit = 100) => store.threads.searchText({ query, cursor, limit, now }),
      ready: async () => { if (instant) expect(await store.instant!.settled()).toBe(true); },
      close: async () => { try { await store.close(); } finally { rmSync(dir, { recursive: true, force: true }); } },
    };
  });
}
