import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { IdbMailStore } from "@terno/idb";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

async function setup(kind: "SQL" | "IDB" | "IDB instant", automatic = false) {
  const dir = mkdtempSync(join(tmpdir(), "terno-observation-"));
  const captured = gate(), response = gate(), freshResponse = gate();
  let hold = false, blockFresh = false, authoritative = true, requests = 0, history = 10;
  const labels = new Set(["INBOX", "UNREAD"]);
  const mutations: unknown[] = [];
  const raw = Buffer.from("From: sender@example.test\r\nTo: synthetic@example.test\r\nSubject: Synthetic\r\n\r\nExact body\r\n").toString("base64url");
  const providers: ProviderRegistry = {
    create(ctx) {
      const provider = createGmailApiProvider({ ...ctx, fetch: async (input, init) => {
      requests++;
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: String(history) });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: String(history), history: [{ labelsAdded: [{ message: { id: "m" } }] }] });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m" }] });
      if (url.pathname.endsWith("/batchModify")) {
        const change = JSON.parse(String(init?.body)) as { addLabelIds: string[]; removeLabelIds: string[] };
        mutations.push(change);
        for (const label of change.addLabelIds) labels.add(label);
        for (const label of change.removeLabelIds) labels.delete(label);
        history++;
        return new Response(null, { status: 204 });
      }
      const snapshot = { id: "m", threadId: "t", labelIds: [...labels], ...(url.searchParams.get("format") === "raw" ? { raw } : {}) };
      if (url.searchParams.get("format") === "minimal") {
        if (hold) { hold = false; captured.release(); await response.promise; }
        else if (blockFresh) await freshResponse.promise;
      }
      return Response.json(snapshot);
    } }, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
      if (!authoritative) delete provider.flagSnapshots;
      return provider;
    },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const store = kind === "SQL" ? undefined : await IdbMailStore.open({ name: "synthetic-observation", factory: new IDBFactory(), platform, instantSearch: kind === "IDB instant" });
  const backend = new Backend({ dbPath: join(dir, "synthetic.db"), store, platform: store ? platform : undefined, providers, cipher: plaintextCipher, version: "test", autoSync: automatic, instantSearch: false, iconTransport: null });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "synthetic", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => { response.release(); freshResponse.release(); client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
  await backend.syncAccount(account.id);
  expect((await backend.store.accounts.get(account.id))?.syncState).toMatchObject({ status: "idle", lastError: null });
  const threadId = (await backend.store.debug.snapshot()).messages[0]!.threadId;
  return { backend, account, threadId, client, captured, response, mutations, requests: () => requests, setCapable(value: boolean) { authoritative = value; }, remoteLabels: () => [...labels], hold() { hold = true; blockFresh = true; history++; }, releaseFresh() { blockFresh = false; freshResponse.release(); } };
}

describe.each(["SQL", "IDB", "IDB instant"] as const)("%s settled flag observation", (kind) => {
  it("refuses non-send dispatch locally when an active protocol loses provider capability", async () => {
    const t = await setup(kind);
    await t.backend.dropAccount(t.account.id);
    t.setCapable(false);
    await t.backend.signedIn(t.account.id);
    await t.client.call("threads.act", { threadIds: [t.threadId], action: "markRead" });
    const op = (await t.backend.store.debug.snapshot()).ops.find((row) => row.kind === "markRead")!;
    const requests = t.requests();
    expect(await t.backend.runWorker()).toBe(1);
    expect(t.requests()).toBe(requests);
    expect(t.mutations).toEqual([]);
    const after = await t.backend.store.ops.get(op.id);
    expect(after?.state).toBe("failed");
    expect(await t.backend.store.ops.nextAttemptAt()).toBeNull();
    expect(await t.backend.runWorker()).toBe(0);
    expect((await t.backend.store.debug.snapshot()).messages[0]!.isRead).toBe(true);
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toHaveLength(1);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState).toMatchObject({ authRequired: false, connection: null });
  });

  it("quiesce returns an undispatched flag claim while bounded preparation awaits", async () => {
    const t = await setup(kind);
    await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markRead", signal: null, now: 1 });
    const entered = gate(), blocked = gate();
    const begin = t.backend.store.sync.beginObservation.bind(t.backend.store.sync);
    vi.spyOn(t.backend.store.sync, "beginObservation").mockImplementationOnce(async (...args) => {
      entered.release(); await blocked.promise;
      return begin(...args);
    });
    const worker = t.backend.runWorker();
    try {
      await Promise.race([entered.promise, worker.then(() => { throw new Error("Flag transport ran before preparation"); })]);
      expect(await t.backend.quiesce(100)).toBe("idle");
      const op = (await t.backend.store.debug.snapshot()).ops.find((row) => row.kind === "markRead")!;
      expect(op).toMatchObject({ state: "queued", attempts: 0 });
    } finally { blocked.release(); await worker; }
    expect(t.mutations).toEqual([]);
  });

  it("fails closed locally when a persisted protocol meets an incapable replacement", async () => {
    const t = await setup(kind);
    const token = await t.backend.store.sync.beginObservation(t.account.id, { authoritativeFlags: true });
    await t.backend.dropAccount(t.account.id);
    t.setCapable(false);
    await t.backend.signedIn(t.account.id);
    const requests = t.requests();
    const failed = vi.spyOn(t.backend.connectivity, "failed");
    const succeeded = vi.spyOn(t.backend.connectivity, "succeeded");
    await t.backend.syncAccount(t.account.id);
    await t.backend.syncAccount(t.account.id);
    expect(t.requests()).toBe(requests);
    expect(failed).not.toHaveBeenCalled();
    expect(succeeded).not.toHaveBeenCalled();
    const state = (await t.backend.store.accounts.get(t.account.id))!.syncState;
    expect(state).toMatchObject({ status: "error", authRequired: false, authScope: null, connection: null });
    expect(state.lastErrorI18n).toMatchObject({ key: "errors.mail.flagConnection" });
    expect((await t.backend.store.debug.snapshot()).messages[0]?.bodyText).toBe("Exact body\n");
    const next = await t.backend.store.sync.beginObservation(t.account.id, { authoritativeFlags: true });
    expect(next?.protocolId).toBe(token?.protocolId);
    expect(next?.epoch).toBe(token!.epoch + 1);
  });
  it.each(["markRead", "star", "archive"] as const)("preserves acknowledged %s against a captured old minimal snapshot", async (action) => {
    const t = await setup(kind);
    const committed: { isRead: boolean; isStarred: boolean; inInbox: boolean }[] = [];
    const update = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => {
      const result = await update(...args);
      const row = (await t.backend.store.debug.snapshot()).messages[0];
      if (row) committed.push({ isRead: row.isRead, isStarred: row.isStarred, inInbox: row.inInbox });
      return result;
    });
    t.hold();
    const old = t.backend.syncAccount(t.account.id);
    try {
      await t.captured.promise;
      await t.client.call("threads.act", { threadIds: [t.threadId], action });
      const op = (await t.backend.store.debug.snapshot()).ops.find((op) => op.kind === action)!;
      expect(await t.backend.runWorker()).toBe(1);
      expect((await t.backend.store.ops.get(op.id))?.state).toBe("succeeded");
      expect(t.mutations).toHaveLength(1);
    } finally { t.response.release(); await old; }
    const expected = action === "markRead" ? { isRead: true } : action === "star" ? { isStarred: true } : { inInbox: false };
    expect.soft((await t.backend.store.debug.snapshot()).messages[0]).toMatchObject(expected);
    expect(committed).not.toHaveLength(0);
    for (const row of committed) expect.soft(row).toMatchObject(expected);
    expect(t.remoteLabels().sort()).toEqual((action === "markRead" ? ["INBOX"] : action === "star" ? ["INBOX", "STARRED", "UNREAD"] : ["UNREAD"]));
    t.releaseFresh();
    await t.backend.syncAccount(t.account.id);
    expect((await t.backend.store.debug.snapshot()).messages[0]).toMatchObject(expected);
  });
});
