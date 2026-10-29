/**
 * Plan 68 (Codex R17): a web mailbox from before schema 24 gets its Gmail memberships through the backend's folder
 * runner, which publishes what each slice touched: the list and the counts refresh as it goes, and once done.
 */
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { databaseName, IdbMailStore } from "@terno/idb";
import type { ProviderRegistry } from "@terno/mail";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const platform = { uuid: () => crypto.randomUUID(), yield: turn };
// the raw database, as far as this test touches it (the backend's sources have no DOM types)
interface RawTx { objectStore(name: string): { clear(): void; put(value: unknown, key: string): void }; oncomplete: (() => void) | null; onerror: (() => void) | null; error: unknown }
interface RawDb { transaction(names: string[], mode: "readwrite"): RawTx; close(): void }
interface RawRequest<T> { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null }
const request = <T,>(r: RawRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

it("the upgrade's memberships come through the runner: a changed event names their threads, the folder lists them", async () => {
  const factory = new IDBFactory();
  const name = crypto.randomUUID();
  const legacy = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  const [g] = await withAccounts(legacy, 1);
  await legacy.folders.replace(g!, [{ key: "Label_1", path: ["Clientes"], selectable: true }]);
  await ingest(legacy, Array.from({ length: 120 }, (_, i) => msg({ accountId: g!, providerMsgId: `g${i}`, gmailLabels: ["Label_1"] })));
  const threads = new Set((await legacy.debug.snapshot()).messages.map((m) => m.threadId));
  await legacy.close();
  // as schema 23 left it: no memberships, the older schema in its meta
  const raw = await request(factory.open(databaseName(name)) as unknown as RawRequest<RawDb>);
  const tx = raw.transaction(["thread_folders", "meta"], "readwrite");
  tx.objectStore("thread_folders").clear();
  tx.objectStore("meta").put(23, "logicalSchema");
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  raw.close();

  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  const dir = mkdtempSync(join(tmpdir(), "terno-folders-upgrade-"));
  const registry = { create: () => { throw new Error("unused"); }, verifyImap: async () => {}, connectGmail: async () => { throw new Error("unused"); } } as unknown as ProviderRegistry;
  const backend = new Backend({ dbPath: join(dir, "t.db"), store, platform, version: "test", providers: registry, cipher: plaintextCipher, autoSync: false, iconTransport: null, openExternal: async () => {} });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "upgrade", origin: "renderer" });
  const client = new RpcClient(c);
  const changed = new Set<number>();
  client.on("changed", (e) => e.threadIds.forEach((t) => changed.add(t)));
  cleanup.push(async () => {
    client.close();
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await backend.start();
  await expect.poll(() => changed.size, { timeout: 30_000 }).toBe(threads.size);
  expect([...changed].sort((a, b) => a - b)).toEqual([...threads].sort((a, b) => a - b));
  const listed = await client.call("threads.list", { view: "all", accountId: g!, folder: "Label_1", limit: 500 });
  expect(listed.items).toHaveLength(threads.size);
  expect((await client.call("counts.get", {})).folderUnread?.[`${g}:Label_1`]).toBe(threads.size);
});
