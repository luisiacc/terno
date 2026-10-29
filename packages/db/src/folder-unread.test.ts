/**
 * Plan 68 (Codex R4): each folder's unread tally is kept by the memberships' own writes (triggers), so counts
 * read one row per folder. Through any sequence of ingests, reads, trash, label moves, deletions and an
 * account's removal, the tallies equal a count of the memberships.
 */
import type { ThreadAction } from "@terno/core";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";

it("the tallies always equal the unread memberships", async () => {
  const db = openDatabase(":memory:");
  const store = new SqlMailStore(db);
  const accounts = await withAccounts(store, 3);
  const gmail = [accounts[0]!, accounts[2]!];
  for (const a of gmail) await store.folders.replace(a, ["Label_1", "Label_2", "Label_3"].map((key) => ({ key, path: [key], selectable: true })));
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const labels = () => ["INBOX", ...["Label_1", "Label_2", "Label_3"].filter(() => rand() < 0.4)];
  const actions: ThreadAction[] = ["markRead", "markUnread", "trash", "moveToInbox", "spam", "notSpam", "archive"];
  const check = () => {
    // exactly the folders with unread mail: a tally at zero goes (Codex R22: churn and removed accounts leave none)
    const tallies = db.all<{ account_id: number; folder: string; n: number }>("SELECT account_id, folder, n FROM folder_unread ORDER BY 1, 2");
    const counted = db.all<{ account_id: number; folder: string; n: number }>("SELECT account_id, folder, count(*) AS n FROM thread_folders WHERE unread = 1 GROUP BY 1, 2 ORDER BY 1, 2");
    expect(tallies).toEqual(counted);
  };
  for (let step = 0; step < 300; step++) {
    const r = rand();
    const snap = await store.debug.snapshot();
    if (r < 0.45 || !snap.messages.length) {
      await ingest(store, [msg({ accountId: pick(gmail), isRead: rand() < 0.5, gmailLabels: labels(), inReplyTo: snap.messages.length && rand() < 0.3 ? pick(snap.messages).rfcMessageId : null })]);
    } else if (r < 0.75) {
      await store.threads.act({ threadIds: [pick(snap.threads).id], action: pick(actions), signal: null, now: 0 });
    } else if (r < 0.9) {
      const m = pick(snap.messages);
      await store.sync.updateFlags(m.accountId, [{ messageId: m.id, flags: {}, gmailLabels: labels() }]);
    } else {
      await store.sync.remove([pick(snap.messages).id]);
    }
    if (step % 25 === 0) check();
  }
  check();
  await store.accounts.remove(gmail[1]!);
  check();
  db.close();
});

it("Codex R22: churn through many folders, then an account's removal, leaves no tally behind", async () => {
  const db = openDatabase(":memory:");
  const store = new SqlMailStore(db);
  const [g] = await withAccounts(store, 1);
  // 200 labels, each unread then read again
  for (let i = 0; i < 200; i++) {
    await ingest(store, [msg({ accountId: g!, providerMsgId: `g${i}`, isRead: false, gmailLabels: ["INBOX", `Label_${i}`] })]);
    const t = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === `g${i}`)!.threadId;
    await store.threads.act({ threadIds: [t], action: "markRead", signal: null, now: 0 });
  }
  expect(db.get<{ c: number }>("SELECT count(*) AS c FROM folder_unread")!.c).toBe(0);
  await ingest(store, [msg({ accountId: g!, providerMsgId: "still", isRead: false, gmailLabels: ["Label_x"] })]);
  expect(db.get<{ c: number }>("SELECT count(*) AS c FROM folder_unread")!.c).toBe(1);
  db.run("DELETE FROM accounts WHERE id = ?", g!);
  expect(db.get<{ c: number }>("SELECT count(*) AS c FROM folder_unread")!.c).toBe(0);
  await store.close();
});
