import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingest, msg, withAccounts } from "../../store/src/conformance/fixtures";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";

it("physically seeks the continuation of the public flag initializer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-flag-init-"));
  const db = openDatabase(join(dir, "s.db"));
  const store = new SqlMailStore(db);
  try {
    const [account] = await withAccounts(store, 1);
    await ingest(store, Array.from({ length: 130 }, (_, i) => msg({ accountId: account!, providerMsgId: `header-${i}` })));
    for (const thread of (await store.debug.snapshot()).threads) await store.threads.act({ threadIds: [thread.id], action: "archive", now: 1, signal: null });
    for (const op of await store.ops.claimReady(2, 200)) await store.ops.complete(op.id, undefined, 3);
    const original = db.all.bind(db), plans: string[] = [];
    db.all = ((sql: string, ...args: Parameters<typeof db.all> extends [string, ...infer P] ? P : never) => {
      if (sql.startsWith("SELECT id,account_id,seq,kind,state FROM ops WHERE") && Number(args[2]) > 0) plans.push(...original<{ detail: string }>("EXPLAIN QUERY PLAN " + sql, ...args).map((row) => row.detail));
      return original(sql, ...args);
    }) as typeof db.all;
    await store.sync.beginObservation(account!, { authoritativeFlags: true });
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((plan) => plan.includes("seq>?") || plan.includes("(seq,id)>")), JSON.stringify(plans)).toBe(true);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
