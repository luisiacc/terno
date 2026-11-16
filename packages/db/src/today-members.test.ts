import { refKey } from "@terno/core";
import { msg, threadOf } from "@terno/store/conformance";
import { expect, it, vi } from "vitest";
import { getDated } from "./dated";
import { getFollowup } from "./followups";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { itemMembers } from "./today";

const N = 1000;

it("plan 210 (Codex code review of iteration 3): a thousand items' members are read whole, one read a table, never a row each", async () => {
  const db = openDatabase(":memory:");
  const store = new SqlMailStore(db);
  const { account } = await store.accounts.create({ kind: "gmail", email: "me@members.test", displayName: "Me", color: "brown", now: 0 });
  await store.sync.ingest([msg({ accountId: account.id, providerMsgId: "m-1" })], { applyFilters: false, now: 1, classifier: null });
  const thread = await threadOf(store, "m-1");
  for (let i = 0; i < N; i++) {
    db.run(
      `INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, arrived_at, state, revision, created_at)
       VALUES (?, ?, 0, 'respond', 'Send the form', 'send the form', 'a@b.test', '2026-12-07', 5, 0, 1, 4, 3, 'settled', 1, 2)`,
      thread,
      1000 + i,
    );
    db.run(
      `INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, revision, created_at, same_as)
       VALUES (?, ?, 0, 'promise', 'send the form', 1, 5, 1, 'open', 0, 2, ?)`,
      thread,
      5000 + i,
      i % 2 ? refKey({ source: "dated", id: i + 1 }) : null,
    );
  }
  const keys = Array.from({ length: N }, (_, i) => refKey({ source: "dated", id: i + 1 }));
  const reads = [vi.spyOn(db, "all"), vi.spyOn(db, "get")];
  const members = itemMembers(db, keys);
  expect(reads.reduce((n, spy) => n + spy.mock.calls.length, 0)).toBeLessThanOrEqual(2);
  for (const spy of reads) spy.mockRestore();
  expect(members.dated).toEqual(Array.from({ length: N }, (_, i) => getDated(db, i + 1)));
  expect(members.promises.map((p) => p.id)).toEqual(Array.from({ length: N / 2 }, (_, i) => 2 * i + 2));
  expect(members.promises).toEqual(members.promises.map((p) => getFollowup(db, p.id)));
  db.close();
});
