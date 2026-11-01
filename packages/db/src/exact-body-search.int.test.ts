import { expect, it } from "vitest";
import { openDatabase } from "./index";
import { nodePlatform } from "./node-driver";
import { SqlMailStore } from "./sql-store";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

it("keeps literal thread search sets unchanged by an unrelated segmented body", async () => {
  const store = new SqlMailStore(openDatabase(":memory:"), { platform: nodePlatform, instantSearch: false });
  try {
    const [accountId, unrelatedAccount] = await withAccounts(store, 2);
    const result = await store.sync.ingest([
      msg({ accountId: accountId!, providerThreadId: "shared", bodyText: "invoice paid", bodyState: "full" }),
      msg({ accountId: accountId!, providerThreadId: "shared", bodyText: "receipt delivered", bodyState: "full" }),
      msg({ accountId: accountId!, providerThreadId: "other", bodyText: "receipt pending", bodyState: "full" }),
    ], { now: 1, classifier: null, applyFilters: false });
    const shared = result.touched[0]!, other = result.touched[1]!;
    const cases: [string, number[]][] = [
      ['😀 -"invoice"', [other]], ['-"invoice"', [other]], ['😀 receipt -invoice', [shared, other]],
      ['"invoice paid"', [shared]], ['"invoice receipt"', []], ['😀', [shared, other]], ['-😀', [shared, other]],
      ['😀 -"receipt delivered"', [other]], ['invoice -😀', [shared]], ['😀 invoice receipt', []],
    ];
    for (const segmented of [false, true]) {
      if (segmented) await store.sync.ingest([msg({ accountId: unrelatedAccount!, providerThreadId: "unrelated", isTrash: true, inInbox: false, bodyText: "unrelated large body ".repeat(5000), bodyState: "full" })], { now: 2, classifier: null, applyFilters: false });
      for (const [query, expected] of cases) {
        const ids = (await store.threads.searchText({ query, accountId, now: 2, limit: 10 })).items.map((thread) => thread.id).sort((a, b) => a - b);
        expect(ids, `${segmented ? "segmented" : "ordinary"}: ${query}`).toEqual([...expected].sort((a, b) => a - b));
      }
    }
  } finally { await store.close(); }
});
