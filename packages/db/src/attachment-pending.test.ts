import { expect, it, vi } from "vitest";
import { SqlMailStore } from "./sql-store";
import { testDb, withAccounts } from "./test/helpers";

it("idle IMAP capture seeks the pending index with 50,000 complete messages", async () => {
  const db = testDb(); const [accountId] = withAccounts(db, 1);
  db.run("INSERT INTO threads (id,account_id) VALUES (1,?)", accountId!);
  db.tx(() => {
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000)
      INSERT INTO messages (account_id,thread_id,provider_msg_id,date,body_state,attachments_captured)
      SELECT ${accountId},1,'complete:'||x,x,'full',1 FROM n`);
    db.run("INSERT INTO message_locations (message_id,account_id,mailbox,uidvalidity,uid,flags) SELECT id,account_id,'INBOX',1,id,'[]' FROM messages");
  });
  const store = new SqlMailStore(db);
  const all = vi.spyOn(db, "all");
  const provider = store.providerStore(accountId!);
  expect(await provider.pendingBodies(50)).toEqual([]);
  expect(await provider.countPendingBodies()).toBe(0);
  const [query, ...params] = all.mock.calls[0]!;
  const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params).map((r) => r.detail).join("\n");
  expect(plan).toContain("messages_capture_pending");
  expect(plan).not.toMatch(/SCAN m\b/);
});
