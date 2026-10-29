/**
 * Plan 65 (Codex R53): a folder of 50,000 messages with no other place, deleted on the server: reconciliation removes
 * them (and recomputes their threads) a batch at a time with turns between, never one transaction for all of them.
 */
import { openDatabase, SqlMailStore } from "@terno/db";
import { reconcileMessages } from "@terno/mail";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");

it("reconciling 50,000 orphans of a deleted folder: the longest stall within the worker's budget", { timeout: 1_800_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-reconcile-"));
  const store = new SqlMailStore(openDatabase(join(dir, "r.db")), { checkpointWorker: true });
  try {
    const [, m] = await withAccounts(store);
    for (let i = 0; i < 50_000; i += 5000) await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: m!, providerMsgId: `o${i + j}`, providerThreadId: `t${i + j}` })));
    const ids = (await store.debug.snapshot()).messages.filter((x) => x.accountId === m).map((x) => x.id);
    expect(ids).toHaveLength(50_000);
    const loop = watchLoop(32);
    const gc = watchGc();
    const t0 = performance.now();
    const orphans = await reconcileMessages(ids, {
      of: async () => [],
      providerIds: async (chunk) => new Map(chunk.map((id) => [id, `o${id}`] as const)),
      state: () => ({}) as never,
      updateFlags: async () => {},
      removeMessages: async (chunk) => {
        await store.sync.remove(chunk);
      },
    });
    const total = performance.now() - t0;
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`reconcile 50,000 orphans: ${total.toFixed(0)} ms, longest stall ${worst.toFixed(1)} ms`);
    expect(orphans).toHaveLength(50_000);
    expect((await store.debug.snapshot()).messages.filter((x) => x.accountId === m)).toHaveLength(0);
    expect(worst).toBeLessThan(32 * MULT);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
