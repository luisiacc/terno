import { SHOWN_SENDERS_MAX } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me0@example.com" };
const esof = { name: "ESOF", email: "CASA+notices@TacSecurity.test" };

/**
 * Plan 240: the senders always shown in What matters. Each change is one command: the entry, the sender's own mute, and their
 * threads' facts (a shown sender's newest unanswered message waits, whatever it looks like); Needs you's walk takes every one
 * of their conversations, past the Inbox's hiding and the readings of their words, never past what was handled.
 */
export function defineShownSendersConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("senders always shown in What matters (plan 240)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      let seq = 0;
      const put = async (over: Partial<IncomingMessage> = {}) => {
        const id = `s-${seq++}`;
        await store.sync.ingest([msg({ date: NOW - 10_000 + seq, providerMsgId: id, from: esof, to: [me], isRead: false, listId: "casa.list", subject: `Notice ${seq}`, ...over, accountId: accountId! })], { applyFilters: false, now: NOW, classifier: null });
        return threadOf(store, id);
      };
      const waiting = async (thread: number) => (await store.threads.summaries([thread]))[0]!.waitingSince != null;
      const needs = async () => (await store.today.waitingPage({ now: NOW, after: null, limit: 50 })).map((p) => p.id);
      return { store, accountId: accountId!, put, waiting, needs };
    }

    it("a list's mail waits once its sender is shown, every conversation of theirs is in Needs you, and Stop puts it back", async () => {
      const { store, put, waiting, needs } = await setup();
      const first = await put();
      const second = await put({ subject: "Another" });
      expect(await waiting(first)).toBe(false);
      expect(await needs()).toEqual([]);
      const r = await store.today.shown.add({ id: "e1", email: esof.email, name: esof.name, at: NOW });
      expect(r).toMatchObject({ added: { id: "e1", key: "casa@tacsecurity.test", name: "ESOF", at: NOW }, unmuted: null });
      expect(new Set(r !== "full" ? r.threadIds : [])).toEqual(new Set([first, second]));
      expect(await waiting(first)).toBe(true);
      expect(await needs()).toEqual([second, first]);
      expect(await store.today.needsCount(NOW)).toBe(2);
      // who is a person doesn't change
      expect((await store.threads.summaries([first]))[0]!.person).toBe(false);
      // new mail from them waits as it comes
      const third = await put({ subject: "A third" });
      expect(await needs()).toEqual([third, second, first]);
      // shown already: nothing changes; a Stop naming another entry takes nothing off
      expect(await store.today.shown.add({ id: "e2", email: "casa@tacsecurity.test", name: "", at: NOW + 1 })).toEqual({ added: null, unmuted: null, threadIds: [] });
      expect(await store.today.shown.remove("casa@tacsecurity.test", "e2")).toEqual({ removed: null, threadIds: [] });
      const stopped = await store.today.shown.remove("casa@tacsecurity.test", "e1");
      expect(stopped.removed).toMatchObject({ id: "e1", key: "casa@tacsecurity.test" });
      expect(await waiting(first)).toBe(false);
      expect(await needs()).toEqual([]);
      expect(await store.today.shown.list()).toEqual([]);
    });

    it("kept newest first through a reopen, at most SHOWN_SENDERS_MAX; trusted as one you've written to", async () => {
      const { store: s } = await setup();
      await s.today.shown.add({ id: "a", email: "a@x.test", name: "A", at: NOW - 2 });
      await s.today.shown.add({ id: "b", email: "b@x.test", name: "B", at: NOW - 1 });
      const store = await reopen(s);
      expect((await store.today.shown.list()).map((e) => e.id)).toEqual(["b", "a"]);
      expect(await store.dated.trusted(["a@x.test", "c@x.test"])).toEqual(new Set(["a@x.test"]));
      expect(await store.dated.written(["a@x.test"])).toEqual(new Set());
      for (let i = 2; i < SHOWN_SENDERS_MAX; i++) await store.today.shown.add({ id: `n${i}`, email: `n${i}@x.test`, name: "", at: NOW + i });
      expect(await store.today.shown.add({ id: "over", email: "over@x.test", name: "", at: NOW + 10_000 })).toBe("full");
    });

    it("showing a sender ends their own mute in the same command (a kind from them stays hidden)", async () => {
      const { store } = await setup();
      await store.dated.mutes.add({ on: "sender", key: "casa@tacsecurity.test", name: "ESOF", at: NOW - DAY });
      await store.dated.mutes.add({ on: "pair", key: "pay|casa@tacsecurity.test", name: "ESOF", at: NOW - DAY });
      const r = await store.today.shown.add({ id: "e", email: esof.email, name: esof.name, at: NOW });
      expect(r).toMatchObject({ unmuted: { on: "sender", key: "casa@tacsecurity.test", name: "ESOF", at: NOW - DAY } });
      expect((await store.dated.mutes.list()).map((m) => m.on)).toEqual(["pair"]);
    });

    it("past the Inbox's hiding (a category hidden from it) and the readings of their words; never past what was handled, nor the waiting window", async () => {
      const { store, put, needs } = await setup();
      const hidden = await put({ subject: "Hidden" });
      const category = await store.categories.create("Security", "rose", {});
      await store.categories.add({ categoryId: category.id, threadIds: [hidden], addedBy: "user", now: NOW });
      await store.categories.update(category.id, { showInInbox: false });
      const thanks = await put({ subject: "Thanks", snippet: "Thanks!", bodyText: "Thanks!" });
      const noReply = await put({ subject: "FYI", snippet: "No action needed. Your scan is queued.", bodyText: "No action needed. Your scan is queued." });
      const old = await put({ subject: "Old", date: NOW - 40 * DAY });
      // someone else's mail in the hidden category stays out
      const other = await put({ from: { name: "Ana", email: "ana@friends.test" }, listId: null, subject: "Hidden too" });
      await store.categories.add({ categoryId: category.id, threadIds: [other], addedBy: "user", now: NOW });
      await store.today.shown.add({ id: "e", email: esof.email, name: esof.name, at: NOW });
      expect(new Set(await needs())).toEqual(new Set([hidden, thanks, noReply]));
      expect(old).toBeGreaterThan(0);
    });
  });
}
