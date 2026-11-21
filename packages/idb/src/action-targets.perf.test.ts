import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { UNCHANGED_NAMED } from "@terno/store";
import { measureLongConversationsAct } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { IdbMailStore } from "./index";
const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");

// plan 229: a Gmail action names each conversation's newest messages too: twenty long ones in one go stay within a turn
it("IDB: Mark as read on 20 Gmail conversations of 100 messages, one unread each, within the event loop's budget", async () => {
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
  const store = await IdbMailStore.open({ name: "synthetic-act-perf", factory: new IDBFactory(), platform, instantSearch: false });
  try {
    await store.whenLoaded();
    const { ms, named } = await measureLongConversationsAct(store);
    expect(named).toBe(20 * (1 + UNCHANGED_NAMED));
    expect(ms, "one act (ms)").toBeLessThanOrEqual(50 * MULT);
  } finally {
    await store.close();
  }
});
