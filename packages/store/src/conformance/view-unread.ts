import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 1, 12);

/**
 * Unread threads in each account's Archive and Spam, by "accountId:view": the sidebar's counts beside those folders.
 * A thread counts where its list shows it, read and trashed ones never (a trashed message isn't unread), and actions
 * move it.
 */
export function defineViewUnreadConformance(fresh: () => Promise<MailStore>): void {
  describe("unread in Archive and Spam", () => {
    it("counts each account's unread threads where their lists show them, and follows reads and moves", async () => {
      const store = await fresh();
      const [a, b] = await withAccounts(store, 2);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "inbox", inInbox: true }),
        msg({ accountId: a!, providerMsgId: "archived", inInbox: false }),
        msg({ accountId: a!, providerMsgId: "archived-read", inInbox: false, isRead: true }),
        msg({ accountId: a!, providerMsgId: "spam", inInbox: false, isSpam: true }),
        msg({ accountId: a!, providerMsgId: "spam-trash", inInbox: false, isSpam: true, isTrash: true }),
        msg({ accountId: a!, providerMsgId: "trash", inInbox: false, isTrash: true }),
        msg({ accountId: b!, providerMsgId: "b-archived", inInbox: false }),
      ]);
      const unread = async () => (await store.threads.counts(NOW)).viewUnread;
      expect(await unread()).toEqual({ [`${a}:archive`]: 1, [`${a}:spam`]: 1, [`${b}:archive`]: 1 });

      const inbox = await threadOf(store, "inbox");
      await store.threads.act({ threadIds: [inbox], action: "archive", signal: null, now: NOW });
      expect((await unread())?.[`${a}:archive`]).toBe(2);
      await store.threads.act({ threadIds: [await threadOf(store, "archived")], action: "markRead", signal: null, now: NOW });
      expect((await unread())?.[`${a}:archive`]).toBe(1);
      await store.threads.act({ threadIds: [inbox], action: "trash", signal: null, now: NOW });
      expect(await unread()).toEqual({ [`${a}:spam`]: 1, [`${b}:archive`]: 1 });
    });
  });
}
