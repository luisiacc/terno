/**
 * Writes stay interactive when the search log is full: pruning frees what one
 * commit needs in bounded steps, whatever the number of retained batches.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { applyThreadAction } from "./actions";
import { ingestMessages } from "./ingest";
import { SEARCH_LOG_BYTES } from "./outbox";
import { msg, withAccounts } from "./test/helpers";
import { BUDGET_MULTIPLIER, measure, report, type Stat } from "./test/perf";

const dir = mkdtempSync(join(tmpdir(), "terno-outbox-perf-"));
const stats: Stat[] = [];
afterAll(() => {
  report("outbox.json", "Search outbox", {}, stats);
  rmSync(dir, { recursive: true, force: true });
});

it("a triage write against a full log of 500,000 small batches stays ≤ 5 ms p95", () => {
  const db = openDatabase(join(dir, "full.db"));
  const [a] = withAccounts(db, 1);
  const threads = [...ingestMessages(db, Array.from({ length: 50 }, () => msg({ accountId: a! }))).touchedThreads];
  // fill the log past its cap with tiny commits, as months of single flag changes would
  const n = 500_000;
  const size = Math.ceil(SEARCH_LOG_BYTES / n) + 8;
  db.tx(() => {
    const head = db.get<{ seq: number }>("SELECT seq FROM search_state")!.seq;
    db.run(
      `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
       INSERT INTO search_outbox (seq, at, bytes, changes) SELECT ? + i, 0, ?, printf('%.*c', ?, 'x') FROM s`,
      n,
      head,
      size,
      size,
    );
    db.run("UPDATE search_state SET seq = seq + ?, bytes = (SELECT total(bytes) FROM search_outbox)", n);
  });
  expect(db.get<{ bytes: number }>("SELECT bytes FROM search_state")!.bytes).toBeGreaterThan(SEARCH_LOG_BYTES);
  const s = measure("triage write, log full of 500k small batches", 5, (i) => applyThreadAction(db, [threads[i % threads.length]!], i % 2 ? "moveToInbox" : "archive"), 100);
  stats.push(s);
  db.close();
  expect(s.p95).toBeLessThanOrEqual(5 * BUDGET_MULTIPLIER);
});
