import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const addr = (email: string, name = "") => ({ name, email });
const ONE_CLICK = { oneClick: "https://news.example/u/1", url: "https://news.example/u/1" };

/**
 * Plan 94: List-Unsubscribe kept at ingest (a later copy without it keeps it), and the message a
 * conversation's Unsubscribe acts on: the newest that isn't yours with the header, else the newest's body.
 */
export function defineUnsubscribeConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("unsubscribe (plan 94)", () => {
    it("keeps the header through a reopen and a re-ingest without it", async () => {
      const s = await fresh();
      const [a] = await withAccounts(s, 1);
      await ingest(s, [msg({ accountId: a!, providerMsgId: "n", from: addr("news@news.example", "News"), unsubscribe: ONE_CLICK })]);
      await ingest(s, [msg({ accountId: a!, providerMsgId: "n", from: addr("news@news.example", "News"), unsubscribe: null })]);
      const store = await reopen(s);
      const t = await threadOf(store, "n");
      expect((await store.debug.snapshot()).messages.find((m) => m.providerMsgId === "n")!.unsubscribe).toBe(JSON.stringify(ONE_CLICK));
      expect(await store.threads.unsubscribeSource(t)).toMatchObject({ accountId: a, fromName: "News", fromEmail: "news@news.example", unsubscribe: ONE_CLICK, bodyHtml: null, bodyText: null });
    });

    it("skips your own mail and drafts; the newest with the header wins, else the newest's body", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "old", rfcMessageId: "old@t", from: addr("list@lists.example"), date: 1000, unsubscribe: { mailto: "mailto:off@lists.example" } }),
        msg({ accountId: a!, providerMsgId: "mid", rfcMessageId: "mid@t", inReplyTo: "old@t", references: ["old@t"], from: addr("list@lists.example"), date: 2000, bodyHtml: '<a href="https://lists.example/u">Unsubscribe</a>' }),
        msg({ accountId: a!, providerMsgId: "mine", rfcMessageId: "mine@t", inReplyTo: "mid@t", references: ["old@t", "mid@t"], from: addr("me0@example.com"), isSent: true, date: 3000, unsubscribe: { url: "https://mine.example/u" } }),
        // a copy of your own mail that came back (not marked sent): still yours
        msg({ accountId: a!, providerMsgId: "echo", rfcMessageId: "echo@t", inReplyTo: "mine@t", references: ["old@t", "mid@t", "mine@t"], from: addr("Me0@Example.com"), date: 4000, unsubscribe: { url: "https://echo.example/u" } }),
      ]);
      const t = await threadOf(store, "old");
      expect(await threadOf(store, "echo")).toBe(t);
      const source = await store.threads.unsubscribeSource(t);
      expect(source).toMatchObject({ fromEmail: "list@lists.example", unsubscribe: { mailto: "mailto:off@lists.example" }, bodyHtml: null });

      const other = await fresh();
      const [b] = await withAccounts(other, 1);
      await ingest(other, [
        msg({ accountId: b!, providerMsgId: "p1", rfcMessageId: "p1@t", from: addr("shop@shop.example"), date: 1000, bodyText: "first" }),
        msg({ accountId: b!, providerMsgId: "p2", rfcMessageId: "p2@t", inReplyTo: "p1@t", references: ["p1@t"], from: addr("shop@shop.example"), date: 2000, bodyText: "Unsubscribe: https://shop.example/u", bodyHtml: '<a href="https://shop.example/u">Unsubscribe</a>' }),
      ]);
      const p2 = (await other.debug.snapshot()).messages.find((m) => m.providerMsgId === "p2")!.id;
      expect(await other.threads.unsubscribeSource(await threadOf(other, "p1"))).toMatchObject({ messageId: p2, unsubscribe: null, bodyText: "Unsubscribe: https://shop.example/u", bodyHtml: '<a href="https://shop.example/u">Unsubscribe</a>' });
    });

    it("null for a conversation of only your mail, or one that doesn't exist", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "s", from: addr("me0@example.com"), isSent: true, unsubscribe: { url: "https://x.example/u" } })]);
      expect(await store.threads.unsubscribeSource(await threadOf(store, "s"))).toBeNull();
      expect(await store.threads.unsubscribeSource(999_999)).toBeNull();
    });
  });
}
