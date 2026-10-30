import { folderRef } from "@terno/core";
import { expect } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, withAccounts } from "./fixtures";

export async function checkCountCoverage(store: MailStore) {
  const [account] = await withAccounts(store, 1);
  const a = account!;
  await store.accounts.update(a, { syncWindowDays: 30 });
  await store.folders.replace(a, [{ key: "Label_1", path: ["Projects"], selectable: true }]);
  const counts = () => store.threads.counts(1_800_000_000_000);
  const key = folderRef(a, "Label_1");
  expect((await counts()).folderUnread?.[key]).toBeUndefined();
  await ingest(store, [
    msg({ accountId: a, providerMsgId: "old", providerThreadId: "old", date: 1_600_000_000_000, bodyState: "none", bodyText: null, gmailLabels: ["Label_1"], inInbox: false }),
    msg({ accountId: a, providerMsgId: "folder-read", providerThreadId: "mixed", isRead: true, gmailLabels: ["Label_1"], inInbox: false }),
    msg({ accountId: a, providerMsgId: "other-unread", providerThreadId: "mixed", gmailLabels: [], inInbox: false }),
    msg({ accountId: a, providerMsgId: "trash-folder-read", providerThreadId: "trash-mixed", isRead: true, gmailLabels: ["Label_1"], inInbox: false }),
    msg({ accountId: a, providerMsgId: "trash-unread", providerThreadId: "trash-mixed", gmailLabels: [], inInbox: false, isTrash: true }),
    msg({ accountId: a, providerMsgId: "spam-folder-read", providerThreadId: "spam-mixed", isRead: true, gmailLabels: ["Label_1"], inInbox: false }),
    msg({ accountId: a, providerMsgId: "spam-unread", providerThreadId: "spam-mixed", gmailLabels: [], inInbox: false, isSpam: true }),
  ]);
  expect((await counts()).folderUnread?.[key]).toBe(3);
  expect((await counts()).inboxUnread).toBe(0);
}
