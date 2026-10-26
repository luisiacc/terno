import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { generateDataset } from "@terno/mock-data";
import { IdbMailStore } from "./store";
import { Table } from "./mem";

let store: IdbMailStore | undefined;
afterEach(async () => { await store?.close(); vi.restoreAllMocks(); });
it("idle IMAP capture never walks the account index with 50,000 completed messages", async () => {
  store = await IdbMailStore.open({ name: "capture-pending-50k", factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } });
  const data = generateDataset({ threads: 30000, accounts: 1, seed: 7, now: 0, bodyScale: 0.01 });
  for (const m of data.messages) { m.attachments = []; m.hasAttachments = false; m.bodyState = "full"; }
  const { accountIds, messageCount } = await store.dev.seed(data, { now: 0, categorizeRate: 0 });
  expect(messageCount).toBeGreaterThanOrEqual(50000);
  const by = vi.spyOn(Table.prototype, "by");
  expect(await store.providerStore(accountIds[0]!).pendingBodies(50)).toEqual([]);
  expect(await store.providerStore(accountIds[0]!).countPendingBodies()).toBe(0);
  const accountWalk = by.mock.calls.some((args, i) => { const context = by.mock.contexts[i]; return context instanceof Table && context.spec.name === "messages" && args[0] === "fk_account_id"; });
  expect(accountWalk).toBe(false);
}, 60000);
