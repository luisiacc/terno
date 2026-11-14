import "fake-indexeddb/auto";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { afterEach, expect, it } from "vitest";
import type { Ctx } from "./mail";
import { IdbMailStore } from "./store";

/**
 * Plan 204, the second panel round: Needs you reads an acknowledgment's text from its body, which IndexedDB keeps out
 * of memory until a unit reads it ahead. After a reopen nothing is in memory: the read must fetch it, not throw.
 */
const NOW = Date.UTC(2026, 10, 5, 12);
const me = { name: "Me", email: "me0@example.com" };
const opened: IdbMailStore[] = [];
const open = async (name: string) => {
  const store = await IdbMailStore.open({ name, factory: indexedDB, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} }, instantSearch: false });
  opened.push(store);
  return store;
};
afterEach(async () => {
  for (const store of opened.splice(0)) if (store.isOpen) await store.close();
});

it("an acknowledgment's body, not in memory after a reopen, is read ahead and decides", async () => {
  const name = crypto.randomUUID();
  let store = await open(name);
  const [accountId] = await withAccounts(store, 1);
  const talk = async (who: string, date: number, text: string) => {
    const email = `${who.toLowerCase()}@people.test`;
    await ingest(store, [msg({ accountId: accountId!, date: date - 500, providerMsgId: `${who}-out`, providerThreadId: who, from: me, to: [{ name: who, email }], isSent: true, isRead: true, listId: null, subject: `About ${who}` })], NOW);
    await ingest(store, [msg({ accountId: accountId!, date, providerMsgId: `${who}-in`, providerThreadId: who, from: { name: who, email }, to: [me], isRead: false, listId: null, subject: `Re: About ${who}`, inReplyTo: `${who}-out`, snippet: text, bodyText: text })], NOW);
    return threadOf(store, `${who}-in`);
  };
  const thanks = await talk("Ana", NOW - 9000, "Thanks!");
  const asks = await talk("Bea", NOW - 8000, "Thanks, can you send it Friday?");
  await store.close();

  store = await open(name);
  const c = (store as unknown as { c: Ctx }).c;
  await store.today.digestLive([]); // the messages loaded, no body read
  const last = c.db.table("messages").by("fk_thread_id", thanks).find((m) => !m.is_sent)!;
  expect(c.db.table("message_bodies").get(last.id as number)).toBeUndefined();
  expect(await store.today.needsCount(NOW)).toBe(1);
  expect(await store.today.waitingAmong([thanks, asks], NOW)).toEqual([asks]);
  expect((await store.today.countWith([thanks], NOW)).needs).toBe(1);
});
