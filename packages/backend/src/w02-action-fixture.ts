import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { IdbMailStore } from "@terno/idb";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { expect, vi } from "vitest";
import { msg } from "../../store/src/conformance/fixtures";
import { Backend, plaintextCipher } from "./backend";

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
export type Mutation = { accountId: number; ids: string[]; add: string[]; remove: string[]; applied: boolean };
export async function actionFixture(kind: "SQL" | "IDB", count = 1, shared = true, register: (close: () => Promise<void>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "terno-w02-actions-"));
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const remote = new Map<number, Map<string, Set<string>>>();
  const emails = new Map<number, string>();
  const holds: ReturnType<typeof gate>[] = [];
  const mutations: Mutation[] = [], unexpected: string[] = [];
  const reads: { accountId: number; id: string; labels: string[] }[] = [];
  let heldMutation: { at: number; status: number; entered: ReturnType<typeof gate>; response: ReturnType<typeof gate> } | undefined;
  let heldSnapshot: { id: string; entered: ReturnType<typeof gate>; response: ReturnType<typeof gate> } | undefined;
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url), parts = url.pathname.split("/"), accountId = Number(parts[2]);
    const mail = remote.get(accountId), path = parts.slice(3).join("/");
    requests.push(`${request.method} ${url.pathname}`);
    const reject = () => { unexpected.push(`${request.method} ${url.pathname}`); throw new Error("Unexpected synthetic action route"); };
    if (url.origin !== "http://127.0.0.1" || parts[1] !== "fixture" || !mail) return reject();
    if (request.method === "GET") {
      if (path === "profile") return Response.json({ emailAddress: emails.get(accountId), historyId: "10" });
      if (path === "labels") return Response.json({ labels: [] });
      if (path === "history") return Response.json({ historyId: "10", history: [{ labelsAdded: [...mail.keys()].map((id) => ({ message: { id } })) }] });
      const id = parts[4]!;
      if (parts[3] === "messages" && parts.length === 5 && url.searchParams.get("format") === "minimal" && mail.has(id)) {
        const labels = [...mail.get(id)!];
        reads.push({ accountId, id, labels });
        const body = { id, threadId: shared && id !== "sibling" ? "shared" : `thread-${id}`, historyId: "10", labelIds: labels };
        if (heldSnapshot?.id === id) {
          const held = heldSnapshot; heldSnapshot = undefined;
          held.entered.release(); await held.response.promise;
        }
        return Response.json(body);
      }
      return reject();
    }
    if (request.method !== "POST" || path !== "messages/batchModify") return reject();
    const change = await request.json() as { ids: string[]; addLabelIds: string[]; removeLabelIds: string[] };
    if (!Array.isArray(change.ids) || !change.ids.length || change.ids.length > 1000 || !change.ids.every((id) => mail.has(id))) return reject();
    const mutation = { accountId, ids: change.ids, add: change.addLabelIds, remove: change.removeLabelIds, applied: false };
    mutations.push(mutation);
    const held = heldMutation?.at === mutations.length ? heldMutation : undefined;
    if (!held || held.status === 204) {
      for (const id of change.ids) {
        for (const label of change.addLabelIds) mail.get(id)!.add(label);
        for (const label of change.removeLabelIds) mail.get(id)!.delete(label);
      }
      mutation.applied = true;
    }
    if (held) { held.entered.release(); await held.response.promise; }
    return held && held.status !== 204 ? Response.json({ error: { message: "Synthetic refusal" } }, { status: held.status }) : new Response(null, { status: 204 });
  });
  const providers: ProviderRegistry = {
    create(ctx) { return createGmailApiProvider(ctx, { endpoints: { api: `http://127.0.0.1/fixture/${ctx.account.id}` }, tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }); },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const open = async () => {
    const store = kind === "IDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined;
    const b = new Backend({ dbPath: join(dir, "synthetic.db"), store, platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
    vi.spyOn(b, "kickWorker").mockImplementation(() => {});
    await b.ready;
    return b;
  };
  let backend = await open();
  let client: RpcClient;
  const attach = () => { const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "synthetic", origin: "renderer" }); client = new RpcClient(c); };
  attach();
  const close = async () => { for (const held of holds) held.release(); client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); expect(unexpected).toEqual([]); };
  register(close);
  const accounts: number[] = [];
  for (let index = 0; index < 2; index++) {
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: `account${index}@example.test`, displayName: "Synthetic", color: "indigo", now: 1 });
    accounts.push(account.id); emails.set(account.id, account.email);
    const ids = index ? ["m0"] : [...Array.from({ length: count }, (_, i) => `m${i}`), "sibling"];
    remote.set(account.id, new Map(ids.map((id) => [id, new Set(["INBOX", "UNREAD"])])));
    await backend.store.sync.ingest(ids.map((id, i) => msg({ accountId: account.id, providerMsgId: id, providerThreadId: shared && id !== "sibling" ? "shared" : `thread-${id}`, date: 100 + i, attachments: [], gmailLabels: ["INBOX", "UNREAD"] })), { applyFilters: false, now: 1, classifier: null });
    await backend.store.accounts.setCursor(account.id, { historyId: "10" });
    await backend.syncAccount(account.id);
    expect((await backend.store.accounts.get(account.id))?.syncState).toMatchObject({ status: "idle", lastError: null });
  }
  const initial = await backend.store.debug.snapshot();
  const selected = initial.messages.filter((m) => m.accountId === accounts[0] && m.providerMsgId !== "sibling");
  const siblings = initial.messages.filter((m) => !selected.some((s) => s.id === m.id));
  return {
    get backend() { return backend; }, get client() { return client; }, accounts, selected, siblings, mutations, remote, reads, requests,
    holdMutation(at: number, status = 204) { const held = { at, status, entered: gate(), response: gate() }; heldMutation = held; holds.push(held.response); return held; },
    holdSnapshot(id: string) { const held = { id, entered: gate(), response: gate() }; heldSnapshot = held; holds.push(held.response); return held; },
    async reopen() { client.close(); await backend.stop(); backend = await open(); attach(); },
    async drain() {
      const limit = (await backend.store.debug.snapshot()).ops.length + 1;
      let count = 0;
      for (let i = 0; i < limit; i++) { const n = await backend.runWorker(); count += n; if (!n) return count; }
      throw new Error("Synthetic action worker did not settle within its operation bound");
    },
    close,
  };
}
