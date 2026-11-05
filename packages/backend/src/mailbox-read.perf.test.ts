/**
 * Plan 68 (Codex R40): what a reset or a vanished folder reads first, a mailbox of 100,000 stored locations, comes a
 * page at a time from SQLite, the loop given a turn between pages: never a frame held before the deletes begin.
 * Only the locations table is read, so the mailbox is a copy with one location per message, put there in SQL: 100,000
 * rows are what a read without turns needs to run past the frame (20,000 of them take less than one).
 */
import { openDatabase, sqlDb, SqlMailStore } from "@terno/db";
import { readMailbox } from "@terno/mail";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyMailbox, LARGE_MAILBOX } from "../../db/src/test/perf-mailbox";
import { stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const ROWS = 100_000;

it("a mailbox of 100,000 locations read for a reset: the longest stall within a frame", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-mailbox-read-"));
  const m = copyMailbox(LARGE_MAILBOX, join(dir, "m.db")).accountIds[0]!;
  const store = new SqlMailStore(openDatabase(join(dir, "m.db")), { checkpointWorker: true });
  try {
    const fill = () => sqlDb(store).run("INSERT INTO message_locations (message_id, account_id, mailbox, uidvalidity, uid, flags) SELECT id, ?, 'Big', 1, id, '[]' FROM messages LIMIT ?", m, ROWS);
    fill();
    const locations = store.providerStore(m).locations;
    const read = async () => {
      const loop = watchLoop(16);
      const gc = watchGc();
      const all = await readMailbox(locations, "Big", 1);
      const worst = stallLessGc(loop.stop(), await gc.stop());
      expect(all).toHaveLength(ROWS);
      return worst;
    };
    await read();
    let worst = Infinity;
    for (let attempt = 0; attempt < 3 && worst >= 16 * MULT; attempt++) worst = Math.min(worst, await read());
    console.log(`read a mailbox of 100,000: longest stall ${worst.toFixed(1)} ms`);
    expect(worst).toBeLessThan(16 * MULT);
    // Codex R41: and the reset itself, its ids taken as each slice deletes them. Over the frame it's run again, up to
    // three times, and the best counts: a stall of ours repeats, a commit the OS held doesn't (timing.ts)
    let reset = Infinity;
    for (let attempt = 1; attempt <= 3 && reset >= 16 * MULT; attempt++) {
      if (attempt > 1) fill();
      const loop = watchLoop(16);
      const gc = watchGc();
      const gone = await locations.resetMailbox("Big");
      reset = Math.min(reset, stallLessGc(loop.stop(), await gc.stop()));
      expect(new Set(gone).size).toBe(ROWS);
    }
    console.log(`reset a mailbox of 100,000: longest stall ${reset.toFixed(1)} ms`);
    expect(reset).toBeLessThan(16 * MULT);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
