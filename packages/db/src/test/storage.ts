import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { SqlMailStore } from "../sql-store";
import type { Db } from "../sqlite";

/** Fills the store with mail and removes it through the storage commands; returns the store, still open. */
export async function filledAndEmptied(path: string, open: (path: string) => Db, afterFill?: (store: SqlMailStore) => Promise<SqlMailStore>) {
  let store = new SqlMailStore(open(path));
  const [a] = await withAccounts(store, 1);
  await store.accounts.setSyncState(a!, { lastSyncAt: 1 });
  await ingest(store, Array.from({ length: 400 }, (_, i) => msg({ accountId: a!, providerMsgId: `m${i}`, inInbox: false, isTrash: true, date: 1, bodyText: "x".repeat(3000) })));
  if (afterFill) store = await afterFill(store);
  const ids: number[] = [];
  for (let after = 0; ; ) {
    const rows = await store.storage.threads(after, 100);
    if (!rows.length) break;
    ids.push(...rows.map((r) => r.id));
    after = rows.at(-1)!.id;
  }
  for (;;) if (!(await store.storage.remove({ threadIds: ids, buckets: ["trash"], cutoff: Date.now(), maxMessages: 500 })).remaining) break;
  return store;
}
