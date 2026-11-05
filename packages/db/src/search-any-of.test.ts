import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { openDatabase, SqlMailStore } from "./index";
import { copyMigrated } from "./test/helpers";
import { defineAnyOfSearch } from "./test/search-any-of";

for (const instant of [false, true]) {
  defineAnyOfSearch(`SQL (${instant ? "instant" : "fallback"})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-any-of-"));
    const store = new SqlMailStore(openDatabase(copyMigrated(join(dir, "mail.db"))), { instantSearch: instant });
    return {
      store, captures: true,
      search: (query) => store.threads.searchText({ query, limit: 100, now: Date.now() }),
      ready: async () => { if (instant) expect(await store.instant!.settled()).toBe(true); },
      close: async () => { try { await store.close(); } finally { rmSync(dir, { recursive: true, force: true }); } },
    };
  });
}
