/** Plan 68 (Codex R20): an ID-less message's twins, by exactly its envelope (the `twins` bucket), at 50,000 in a cohort. */
import "fake-indexeddb/auto";
import { measureTwins, twinSubject } from "@terno/store/conformance";
import { IDBFactory } from "fake-indexeddb";
import { it } from "vitest";
import { IdbMailStore } from "./store";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

it("twins by envelope at 50,000 in a cohort, one store holding all of them: lookups and pages, ID-less and with a reused Message-ID", { timeout: 300_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  try {
    const rows = (store as unknown as { c: { db: { table(name: string): { load(row: Record<string, unknown>): void } } } }).c.db.table("messages");
    let id = 0;
    await measureTwins(store, (accountId, c) => {
      // the rows as loaded (what's measured is the buckets over them); no thread needed by what's read
      for (let i = 0; i < c.n; i++) rows.load({ id: ++id, account_id: accountId, thread_id: id, provider_msg_id: `${c.providerPrefix}${i}`, rfc_message_id: c.rfcMessageId, from_email: c.fromEmail, subject: twinSubject(c, i), date: c.date, size: c.size, is_trash: 0, is_spam: 0 });
    }, { budget: MULT, log: (line) => console.log(line) });
  } finally {
    await store.close();
  }
});
