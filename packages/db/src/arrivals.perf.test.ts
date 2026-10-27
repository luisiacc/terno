/**
 * Plan 41: notifications read new mail back by id (sync.arrivals), 200 ids
 * per read. What one read costs follows the ids, never the mailbox: at 50k+
 * threads it stays under 5 ms.
 */
import { generateDataset } from "@terno/mock-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, measureAsync } from "./test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);

it("sync.arrivals of 200 messages stays below 5 ms at 50,000 threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-arrivals-perf-"));
  const store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
  try {
    const seeded = await store.dev.seed(generateDataset({ threads: 50_000, accounts: 4, seed: 38, now: NOW, bodyScale: 0.2 }), { now: NOW });
    expect(seeded.threadCount).toBeGreaterThanOrEqual(50_000);
    const top = store.db.get<{ m: number }>("SELECT max(id) AS m FROM messages")!.m;
    const stat = await measureAsync(
      "sync.arrivals(200) at 50k threads",
      5,
      async (i) => {
        const from = top - (i % 50) * 200;
        const ids = Array.from({ length: 200 }, (_, k) => from - k);
        expect((await store.sync.arrivals(ids)).length).toBe(200);
      },
      60,
    );
    expect(stat.p95).toBeLessThanOrEqual(5 * BUDGET_MULTIPLIER);
    process.stderr.write(`[50k SQL arrivals(200)] p95 ${stat.p95.toFixed(3)} ms\n`);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
