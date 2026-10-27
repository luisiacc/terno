import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { MemDb, Table } from "./mem";
import { IdbFlagRepository } from "./flag-intents";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

for (const instantSearch of [false, true]) {
  for (const selected of [1, 2]) it(`reads only ${selected} selected effects during partial supersession (instantSearch=${instantSearch})`, async () => {
    const factory = new IDBFactory(), name = crypto.randomUUID();
    let store = await IdbMailStore.open({ name, factory, instantSearch, platform });
    try {
      const [account] = await withAccounts(store, 1);
      await ingest(store, Array.from({ length: 12 }, (_, i) => msg({ accountId: account!, providerMsgId: `m${i}` })));
      await store.sync.beginObservation(account!, { authoritativeFlags: true });
      const initial = await store.debug.snapshot();
      const threads = initial.messages.map((message) => message.threadId);
      const action = await store.threads.act({ threadIds: threads, action: "markRead", signal: null, now: 1 });
      await store.threads.act({ threadIds: [], action: "markUnread", signal: null, now: 2 });
      const by = Table.prototype.by, get = Table.prototype.get;
      const loaded: number[] = [], attempts: unknown[][] = [];
      const bySpy = vi.spyOn(Table.prototype, "by").mockImplementation(function(this: Table, index, ...keys) {
        const rows = by.call(this, index, ...keys);
        if (this.spec.name === "flag_op_effects" && index === "fk_op_id") loaded.push(rows.length);
        return rows;
      });
      const getSpy = vi.spyOn(Table.prototype, "get").mockImplementation(function(this: Table, ...keys) {
        const row = get.call(this, ...keys);
        if (this.spec.name === "flag_op_effects" && keys[0] === action.opIds[0]) { attempts.push(keys); if (row) loaded.push(1); }
        return row;
      });
      try {
        await store.threads.act({ threadIds: threads.slice(0, selected), action: "markUnread", signal: null, now: 2 });
        expect(loaded.reduce((sum, count) => sum + count, 0)).toBe(selected * 2);
        expect(attempts).toHaveLength(selected * 6);
      } finally { bySpy.mockRestore(); getSpy.mockRestore(); }
      const snapshot = await store.debug.snapshot();
      expect(snapshot.messages.map((message) => message.isRead)).toEqual([...Array(selected).fill(false), ...Array(12 - selected).fill(true)]);
      const claimed = await store.ops.claimReady(3, 20);
      const remaining = claimed.find((op) => op.id === action.opIds[0]);
      expect(remaining!.id).toBe(action.opIds[0]);
      expect(JSON.parse(remaining!.target_json).messageIds).toHaveLength(12 - selected);
      await store.close();
      store = await IdbMailStore.open({ name, factory, instantSearch, platform });
      expect((await store.debug.snapshot()).messages.map((message) => message.isRead)).toEqual([...Array(selected).fill(false), ...Array(12 - selected).fill(true)]);
      await store.ops.complete(remaining!.id, undefined, 4);
      const pending = await store.providerStore(account!).pendingFlagSnapshots({ limit: 50 });
      expect(pending.items.map((item) => item.id).sort((a, b) => a - b)).toEqual(initial.messages.slice(selected).map((message) => message.id).sort((a, b) => a - b));
      const replacement = claimed.find((op) => op.id !== remaining!.id);
      await store.ops.complete(replacement!.id, undefined, 6);
      expect((await store.providerStore(account!).pendingFlagSnapshots({ limit: 50 })).items).toHaveLength(12);
    } finally { await store.close(); }
  });
}

  it("deduplicates selected keys and distinguishes empty from whole-operation reads", () => {
    const db = new MemDb([{ name: "flag_op_effects", key: ["op_id", "message_id", "field"], indexes: { fk_op_id: ["op_id"] } }], []);
    const repo = new IdbFlagRepository(db, () => "unused");
    const effect = { op_id: "op", message_id: 1, field: "isRead" as const, account_id: 1, intent_version: 1, value: 1, active: 1 };
    db.tx(() => repo.putEffect(effect));
    const original = Table.prototype.get, keys: unknown[][] = [];
    const spy = vi.spyOn(Table.prototype, "get").mockImplementation(function(this: Table, ...args) { keys.push(args); return original.call(this, ...args); });
    try {
      expect(repo.effects("op", [])).toEqual([]);
      expect(keys).toHaveLength(0);
      expect(repo.effects("op", [1, 1, 99])).toEqual([effect]);
      expect(keys).toHaveLength(10);
      expect(repo.effects("op")).toEqual([effect]);
    } finally { spy.mockRestore(); }
  });
