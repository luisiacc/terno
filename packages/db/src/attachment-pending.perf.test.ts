import { expect, it } from "vitest";
import { SqlMailStore } from "./sql-store";
import { testDb, withAccounts } from "./test/helpers";
import { BUDGET_MULTIPLIER, measureAsync } from "./test/perf";

it("idle IMAP pending lookups stay below 5 ms over 50,000 completed rows", async () => {
  const db = testDb(); const [accountId] = withAccounts(db, 1);
  db.run("INSERT INTO threads (id,account_id) VALUES (1,?)", accountId!);
  db.tx(() => {
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000)
      INSERT INTO messages (account_id,thread_id,provider_msg_id,date,body_state,attachments_captured)
      SELECT ${accountId},1,'complete:'||x,x,'full',1 FROM n`);
    db.run("INSERT INTO message_locations (message_id,account_id,mailbox,uidvalidity,uid,flags) SELECT id,account_id,'INBOX',1,id,'[]' FROM messages");
  });
  const provider = new SqlMailStore(db).providerStore(accountId!);
  const stat = await measureAsync("idle IMAP capture: list and count", 5, async () => { expect(await provider.pendingBodies(50)).toEqual([]); expect(await provider.countPendingBodies()).toBe(0); }, 100);
  expect(stat.p95).toBeLessThanOrEqual(5 * BUDGET_MULTIPLIER);
  process.stderr.write(`[50k SQL IMAP pending] p95 ${stat.p95.toFixed(3)} ms\n`);
});
