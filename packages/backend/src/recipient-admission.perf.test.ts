import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { expect, it } from "vitest";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
for (const engine of ["SQL", "IDB"] as const) for (const shape of ["long", "dense"] as const) it(`${engine} recipient admission yields on a maximum-size ${shape} envelope`, async () => {
  const store = engine === "SQL" ? new SqlMailStore(openDatabase(":memory:"), { platform }) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: new IDBFactory(), platform, instantSearch: false });
  try {
    const { account } = await store.accounts.create({ kind: "imap", email: "sender@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: false }, now: 1 });
    const addresses = Array.from({ length: 1000 }, (_, i) => ({ name: shape === "long" ? "ñ".repeat(250) : "a ".repeat(150), email: `r${i}@example.test` }));
    let previous = process.threadCpuUsage(), max = 0, turns = 0, active = true;
    const record = () => { const usage = process.threadCpuUsage(previous); max = Math.max(max, (usage.user + usage.system) / 1000); previous = process.threadCpuUsage(); };
    const heartbeat = () => { record(); turns++; if (active) scheduled = setImmediate(heartbeat); };
    let scheduled = setImmediate(heartbeat);
    let opId = "";
    try { ({ opId } = await store.compose.queueSend({ accountId: account.id, to: addresses, cc: addresses, bcc: addresses, subject: "Synthetic", bodyText: "Exact", recordReply: false, now: 2 })); record(); }
    finally { active = false; clearImmediate(scheduled); }
    process.stderr.write(`[${engine} ${shape} recipient admission] ${turns} turns, max CPU ${max.toFixed(2)} ms\n`);
    const op = (await store.ops.get(opId))!;
    const payload = JSON.parse(op.payload_json) as { to: unknown[]; cc: unknown[]; bcc: unknown[] };
    expect([payload.to.length, payload.cc.length, payload.bcc.length]).toEqual([1000, 1000, 1000]);
    expect((await store.recipientReceipts.get(opId))?.count).toBe(3000);
    expect((await store.threads.searchText({ query: "to:r999@example.test", accountId: account.id, limit: 10, now: 3 })).items).toHaveLength(1);
    expect(max).toBeLessThanOrEqual(15);
  } finally { await store.close(); }
});
