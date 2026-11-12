import "fake-indexeddb/auto";
import type { Platform } from "@terno/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleAsync, settle } from "../../db/src/test/timing";
import { IdbMailStore } from "./store";

/**
 * Plan 96 on IndexedDB (Codex review #5): opening the menu on a 60,000-message conversation reads its
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
  const { account } = await store.accounts.create({ kind: "gmail", email: "me@example.com", displayName: "Me", color: "brown", now: 0 });
  await store.whenLoaded();
  // the conversation as the mirror holds it (through ingest, a reply chain of 60,000 is minutes)
  const db = (store as unknown as { db: { table(n: string): { load(row: Record<string, unknown>): void } } }).db;
  threadId = 1;
  db.table("threads").load({ id: threadId, account_id: account.id, provider_thread_id: "one", last_date: 1_700_000_000_000 + SIZE * 1000, message_count: SIZE, unread_count: 0 });
  for (let i = 0; i < SIZE; i++) {
    db.table("messages").load({
      id: i + 1, account_id: account.id, thread_id: threadId, provider_msg_id: `m${i}`, rfc_message_id: `m${i}@perf.test`, from_name: "List", from_email: i % 3 ? "list@lists.example" : "me@example.com",
      subject: "Digest", date: 1_700_000_000_000 + ((i * 7919) % SIZE) * 1000, body_state: "none", list_id: "lists.example",
      // a third carry the header, scattered through the conversation's dates
      unsubscribe: i < SIZE / 3 ? JSON.stringify({ url: "https://lists.example/u" }) : null,
      is_sent: i % 3 === 0 ? 1 : 0, is_draft: 0, is_trash: 0, is_spam: 0, size: 100,
    });
  }
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
