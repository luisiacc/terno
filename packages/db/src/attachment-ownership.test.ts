import { expect, it } from "vitest";
import { SqlMailStore } from "./sql-store";
import { testDb } from "./test/helpers";
import { withAccounts } from "@terno/store/conformance";

it("rolls back send completion and its operation pin together", async () => {
  const db = testDb(); const store = new SqlMailStore(db, { instantSearch: false });
  const [accountId] = await withAccounts(store, 1);
  const ref = await store.attachments.create({ accountId: accountId!, filename: "empty", mime: "text/plain", size: 0, now: 0 });
  await store.attachments.seal(accountId!, ref.assetId);
  const send = await store.compose.queueSend({ accountId: accountId!, to: [], cc: [], bcc: [], subject: "atomic", bodyText: "", attachments: [ref], recordReply: false, now: 0 });
  await store.ops.claimReady(0, 1);
  await store.sync.remove([(await store.threads.get(send.threadId))!.messages[0]!.id]);
  db.exec("CREATE TRIGGER refuse_pin_release BEFORE DELETE ON attachment_links BEGIN SELECT RAISE(ABORT, 'synthetic pin failure'); END");
  await expect(store.ops.complete(send.opId, {}, 1)).rejects.toThrow("synthetic pin failure");
  expect((await store.ops.get(send.opId))!.state).toBe("running");
  await expect(store.attachments.discard(accountId!, ref.assetId)).rejects.toThrow();
  db.exec("DROP TRIGGER refuse_pin_release");
  await store.ops.complete(send.opId, {}, 2);
  await store.attachments.discard(accountId!, ref.assetId);
});
