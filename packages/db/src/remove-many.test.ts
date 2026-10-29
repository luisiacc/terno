/**
 * Plan 65 (Codex R36): an expunge's membership decision is made where the row is deleted, so a message made eligible
 * in between ("Not spam" on another of the thread's messages there) keeps the thread in the folder.
 */
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { expect, it, vi } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore, sqlDb } from "./sql-store";
import type { SqlValue } from "./connection";

it("a message of the thread made eligible just before the row goes keeps the thread in the folder", async () => {
  const store = new SqlMailStore(openDatabase(":memory:"));
  const [, m] = await withAccounts(store);
  await store.folders.replace(m!, [{ key: "F", path: ["F"], selectable: true }]);
  const loc = (uid: number) => [{ mailbox: "F", uidvalidity: 1, uid, flags: [] as string[] }];
  const r = await ingest(store, [msg({ accountId: m!, providerMsgId: "a", providerThreadId: "t", locations: loc(1) }), msg({ accountId: m!, providerMsgId: "b", providerThreadId: "t", isSpam: true, locations: loc(2) })]);
  const db = sqlDb(store);
  const thread = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", r.inserted[0]!)!.thread_id;
  expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'F' AND thread_id = ?", thread)!.c).toBe(1);
  // as the row is about to go, the spam one is marked not spam (another command, between the decision and the delete)
  const run = db.run.bind(db);
  let fired = false;
  const spy = vi.spyOn(db, "run").mockImplementation((sql: string, ...params: SqlValue[]) => {
    if (!fired && /DELETE FROM thread_folders/.test(sql)) {
      fired = true;
      run("UPDATE messages SET is_spam = 0 WHERE id = ?", r.inserted[1]!);
    }
    return run(sql, ...params);
  });
  try {
    await store.providerStore(m!).locations.removeMany([r.inserted[0]!], "F");
  } finally {
    spy.mockRestore();
  }
  expect(fired).toBe(true);
  expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'F' AND thread_id = ?", thread)!.c).toBe(1);
  await store.close();
});
