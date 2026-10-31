import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createMemoryTransportPair, type RpcMessage, type Transport } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import type { ProviderRegistry } from "@terno/mail";
import { withAccounts, ingest, msg, threadOf } from "@terno/store/conformance";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
vi.mock("~/rpc/connection", async () => {
  const { RpcClient } = await import("@terno/core/rpc"); return { client: new RpcClient() };
});
const { client } = await import("./connection");
const { installQueryRecovery } = await import("./reconnect");
const { loadThread, useThreads } = await import("~/state/threads");
const { setApp, getApp } = await import("~/state/app");
const { useList } = await import("~/state/list");
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider traffic"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider traffic"); }, verifyImap: unexpected, connectGmail: unexpected };

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const action of ["markRead", "star", "archive"] as const) it(`${adapter}: ${action} accepted-unconfirmed ownership survives reconnect and an old matching observation`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-reconnect-intent-"));
  const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
  const ports: Transport[] = [];
  let stop = () => {};
  const attach = (hold = false) => {
    const [c, s] = createMemoryTransportPair(); ports.push(c, s);
    const held: RpcMessage[] = [];
    const server: Transport = { ...s, send: (m) => { if (hold && m.t === "res" && m.ok && typeof m.r === "object" && m.r !== null && "messages" in m.r) held.push(m); else s.send(m); } };
    backend.connect(server, { clientId: crypto.randomUUID(), origin: "renderer" }); client.attach(c);
    return { held, release: () => { for (const m of held.splice(0)) s.send(m); } };
  };
  try {
    const [a, b] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "owned" }), msg({ accountId: b!, providerMsgId: "independent" })]);
    const id = await threadOf(store, "owned"), sibling = await threadOf(store, "independent");
    const messageId = (await store.threads.get(id))!.messages[0]!.id;
    attach();
    setApp({ selectedId: id, accounts: await store.accounts.list() });
    await loadThread(id, true);
    const old = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
    await client.call("threads.act", { threadIds: [id], action });
    const [op] = await store.ops.claimReady(Date.now(), 20);
    expect(op!.kind).toBe(action);
    await store.ops.complete(op!.id, undefined, Date.now()); // store acceptance, not provider-wire proof
    const matching = action === "markRead" ? { isRead: true } : action === "star" ? { isStarred: true } : { inInbox: false };
    await store.sync.updateFlags(a!, [{ messageId, expectedProviderMsgId: "owned", flags: matching }], old);
    expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([{ id: messageId, providerMsgId: "owned" }]);
    const oldTransport = attach(true);
    const delayed = loadThread(id, true);
    await vi.waitFor(() => expect(oldTransport.held).toHaveLength(1));
    const inverse = action === "markRead" ? "markUnread" : action === "star" ? "unstar" : "moveToInbox";
    await client.call("threads.act", { threadIds: [id], action: inverse });
    const queued = (await store.debug.snapshot()).ops.filter((o) => o.state === "queued");
    expect(queued.map((o) => ({ kind: o.kind, messageIds: o.messageIds }))).toEqual([{ kind: inverse, messageIds: [messageId] }]);
    stop = installQueryRecovery({ covered: () => false, readerShown: () => true });
    const previous = client.connectionVersion; attach();
    expect(client.connectionVersion).toBeGreaterThan(previous);
    await delayed; oldTransport.release();
    await store.sync.updateFlags(a!, [{ messageId, expectedProviderMsgId: "owned", flags: matching }], old);
    await vi.waitFor(() => expect(useThreads.getState().details.get(id)?.thread).toMatchObject({ id, unread: true, starred: false, inInbox: true }));
    await vi.waitFor(() => expect(useList.getState().items.map((t) => t.id).sort()).toEqual([id, sibling].sort()));
    await vi.waitFor(() => expect(getApp().counts.inboxUnread).toBe(2));
    expect((await store.debug.snapshot()).ops.filter((o) => o.state === "queued")).toEqual(queued);
    // Only a later authoritative observation can retire the delivered inverse.
    const [newOp] = await store.ops.claimReady(Date.now(), 20);
    await store.ops.complete(newOp!.id, undefined, Date.now());
    const fresh = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
    expect(fresh.epoch).toBeGreaterThan(old.epoch);
    expect(fresh.protocolId).toBe(old.protocolId);
    await store.sync.updateFlags(a!, [{ messageId, expectedProviderMsgId: "owned", flags: { isRead: false, isStarred: false, inInbox: true, isTrash: false, isSpam: false } }], fresh);
    expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    expect((await store.threads.get(sibling))!.thread).toMatchObject({ unread: true, starred: false, inInbox: true });
  } finally {
    stop(); client.close(); for (const p of ports) p.close();
    await backend.stop(); useThreads.setState({ details: new Map(), gone: new Set() });
    rmSync(dir, { recursive: true, force: true }); expect(client.pendingCount).toBe(0);
  }
});
