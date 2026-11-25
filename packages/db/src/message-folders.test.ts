import { ingest, msg, outlookAccount } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { IN_MESSAGE_FOLDERS } from "./message-folders";
import { SqlMailStore } from "./sql-store";
import { testDb } from "./test/helpers";

/** Plan 259: an Outlook message's folder row lives exactly as long as its message, whichever way that goes (Codex code review #9). */
it("a message's folder goes with the message, and with its account", async () => {
  const db = testDb();
  const store = new SqlMailStore(db);
  const a = await outlookAccount(store);
  const b = await outlookAccount(store, "other@outlook.example");
  const { inserted: [gone] } = await ingest(store, [msg({ accountId: a, providerMsgId: "a1", inInbox: false, folder: "F" }), msg({ accountId: a, providerMsgId: "a2", inInbox: false, folder: "F" }), msg({ accountId: b, providerMsgId: "b1", inInbox: false, folder: "F" })]);
  const rows = () => db.all<{ account_id: number }>("SELECT account_id FROM message_folders ORDER BY message_id").map((r) => r.account_id);
  expect(rows()).toEqual([a, a, b]);
  await store.sync.remove([gone!]);
  expect(rows()).toEqual([a, b]);
  await store.accounts.remove(a);
  expect(rows()).toEqual([b]);
});

/** Membership reads a thread's messages' folders by the thread index and one primary-key probe each, never a walk of them all. */
it("membership's read of the folders seeks by thread, then by message", () => {
  const db = testDb();
  db.exec("ANALYZE");
  const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${IN_MESSAGE_FOLDERS("?")}`, "[1]").map((r) => r.detail);
  expect(plan.join(" | ")).toMatch(/SEARCH m USING INDEX messages_thread.*SEARCH f USING INTEGER PRIMARY KEY/);
  expect(plan.some((d) => d.startsWith("SCAN f") || d.startsWith("SCAN m"))).toBe(false);
});
