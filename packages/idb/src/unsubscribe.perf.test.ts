import "fake-indexeddb/auto";
import type { IncomingMessage, Platform } from "@terno/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleAsync, settle } from "../../db/src/test/timing";
import { IdbMailStore } from "./store";

/**
 * Plan 94 on IndexedDB (Codex review #5): opening the menu on a 60,000-message conversation reads its
 * Unsubscribe source in one bounded pass (no copy and sort of the conversation), within a frame.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
const FRAME = 16;
const SIZE = 60_000;
const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };

let store: IdbMailStore;
let threadId = 0;
beforeAll(async () => {
  store = await IdbMailStore.open({ name: `unsubscribe-perf-${Date.now()}`, factory: indexedDB, platform, instantSearch: false });
  const { account } = await store.accounts.create({ kind: "gmail", email: "me@example.com", displayName: "Me", color: "indigo", now: 0 });
  const msg = (i: number): IncomingMessage => ({
    accountId: account.id, providerMsgId: `m${i}`, providerThreadId: "one", rfcMessageId: `m${i}@perf.test`, inReplyTo: null, references: [],
    from: { name: "List", email: i % 3 ? "list@lists.example" : "me@example.com" }, to: [{ name: "", email: "me@example.com" }], cc: [], bcc: [],
    subject: "Digest", date: 1_700_000_000_000 + ((i * 7919) % SIZE) * 1000, snippet: "", bodyText: null, bodyHtml: null, bodyState: "none", listId: "lists.example",
    // a third carry the header, scattered through the conversation's dates
    unsubscribe: i < SIZE / 3 ? { url: "https://lists.example/u" } : null,
    isRead: true, isStarred: false, inInbox: false, isSent: i % 3 === 0, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  });
  for (let i = 0; i < SIZE; i += 2000) await store.sync.ingest(Array.from({ length: 2000 }, (_, j) => msg(i + j)), { applyFilters: false, now: 0, classifier: null });
  threadId = (await store.debug.snapshot()).threads[0]!.id;
}, 900_000);
afterAll(async () => {
  await store?.close();
});

it("a 60,000-message conversation's source within a frame", async () => {
  expect(await store.threads.unsubscribeSource(threadId)).toMatchObject({ fromEmail: "list@lists.example" });
  await store.threads.unsubscribeSource(threadId);
  const samples = [];
  for (let i = 0; i < 9; i++) samples.push(await sampleAsync(() => store.threads.unsubscribeSource(threadId)));
  const { ms } = settle(samples);
  const median = [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]!;
  console.log(`unsubscribeSource, ${SIZE} messages: ${median.toFixed(2)} ms`);
  expect(median).toBeLessThan(FRAME * MULT);
});
