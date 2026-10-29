/**
 * Plan 65 (Codex R40): what a reset or a vanished folder reads first, a mailbox of 100,000 stored locations, comes a
 * page at a time from SQLite, the loop given a turn between pages: never a frame held before the deletes begin.
 */
import { openDatabase, SqlMailStore } from "@terno/db";
import { readMailbox } from "@terno/mail";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");

it("a mailbox of 100,000 locations read for a reset: the longest stall within a frame", { timeout: 1_800_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-mailbox-read-"));
  const store = new SqlMailStore(openDatabase(join(dir, "m.db")), { checkpointWorker: true });
  try {
    const [, m] = await withAccounts(store);
    for (let i = 0; i < 100_000; i += 5000) {
      await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: m!, providerMsgId: `r${i + j}`, locations: [{ mailbox: "Big", uidvalidity: 1, uid: i + j + 1, flags: [] }] })));
    }
    const locations = store.providerStore(m!).locations;
    const read = async () => {
      const loop = watchLoop(16);
      const gc = watchGc();
      const all = await readMailbox(locations, "Big", 1);
      const worst = stallLessGc(loop.stop(), await gc.stop());
      expect(all).toHaveLength(100_000);
      return worst;
    };
    await read();
    const worst = Math.min(await read(), await read(), await read());
    console.log(`read a mailbox of 100,000: longest stall ${worst.toFixed(1)} ms`);
    expect(worst).toBeLessThan(16 * MULT);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
