import "fake-indexeddb/auto";
import { act } from "react";
import { setup, gate } from "./draft-presentation-r1-harness";
export async function realSetup(adapter: "SQL" | "IDB exact" | "IDB instant") {
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { openDatabase, SqlMailStore, nodePlatform } = await import("@terno/db"), { IdbMailStore } = await import("@terno/idb"), { BackendCore, plaintextCipher } = await import("../../../../packages/backend/src/core"), { RpcClient, createMemoryTransportPair, contract } = await import("@terno/core/rpc");
  const dir = mkdtempSync(join(tmpdir(), "terno-presentation-r2-"));
  const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  const providers: import("@terno/mail").ProviderRegistry = { create: () => { throw new Error("Unexpected provider"); }, connectGmail: async () => { throw new Error("Unexpected provider"); }, verifyImap: async () => { throw new Error("Unexpected provider"); } };
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "presentation-r2", origin: "renderer" }); const client = new RpcClient(c);
  const h = await setup("list"), calls: Promise<unknown>[] = [], methods: string[] = [];
  const call = <M extends keyof typeof contract>(method: M, p: Parameters<typeof client.call<M>>[1]) => { methods.push(method); const pending = client.call(method, p); calls.push(pending.catch(() => undefined)); return pending; };
  gate.call.mockImplementation(call);
  const loading = new Map<number, Promise<import("@terno/core").ThreadDetail | null>>();
  gate.load.mockImplementation((id: number, force = false) => {
    if (!force) {
      const cached = h.useThreads.getState().details.get(id); if (cached) return Promise.resolve(cached);
      const pending = loading.get(id); if (pending) return pending;
    }
    const pending = call("threads.get", { threadId: id }).then((detail) => { h.useThreads.setState((state) => ({ details: new Map(state.details).set(id, detail) })); return detail; }).catch(() => null).finally(() => { if (loading.get(id) === pending) loading.delete(id); });
    loading.set(id, pending); return pending;
  });
  h.drafts.setDraftTransport((method, p) => method === "drafts.save" ? call(method, contract[method].params.parse(p)) : call(method, contract[method].params.parse(p)));
  const publish = async (draft: import("@terno/core/rpc").Draft) => act(async () => { const local = h.drafts.fromServer(draft); h.drafts.useDrafts.setState({ drafts: { [h.key]: { ...local, key: h.key } } }); h.app.setApp({ accounts: await store.accounts.list(), accountId: (await store.accounts.list())[0]?.id ?? null, selectedId: null, readerOpen: false, compose: null }); });
  const cleanup = async () => { await h.cleanup(); await Promise.all(calls); c.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { ...h, store, client, call, contract, methods, publish, cleanup };
}

