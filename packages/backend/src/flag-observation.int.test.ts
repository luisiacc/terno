import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { IdbMailStore } from "@terno/idb";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

async function setup(kind: "SQL" | "IDB" | "IDB instant", automatic = false) {
  let timeAdvance = 0;
  const elapsedNow = performance.now.bind(performance);
  const dir = mkdtempSync(join(tmpdir(), "terno-observation-"));
  const captured = gate(), response = gate(), freshResponse = gate();
  let hold = false, blockFresh = false, authoritative = true, emptyHistory = false, requests = 0, history = 10;
  let historyRefusal: number | undefined;
  let heldHistory: { captured: ReturnType<typeof gate>; response: ReturnType<typeof gate> } | undefined;
  let heldMutation: { at: number; captured: ReturnType<typeof gate>; response: ReturnType<typeof gate> } | undefined;
  let heldSend: { captured: ReturnType<typeof gate>; response: ReturnType<typeof gate> } | undefined;
  let minimalRequests = 0;
  const labels = new Set(["INBOX", "UNREAD"]);
  const mutations: unknown[] = [];
  const raw = Buffer.from("From: sender@example.test\r\nTo: synthetic@example.test\r\nSubject: Synthetic\r\n\r\nExact body\r\n").toString("base64url");
  const respond = async (input: string, init?: RequestInit): Promise<Response> => {
      requests++;
      const url = new URL(String(input));
      if (url.pathname.endsWith("/messages/send")) {
        if (heldSend) { heldSend.captured.release(); await heldSend.response.promise; }
        return Response.json({ id: "sent-synthetic" });
      }
      if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: decodeURIComponent(url.pathname.split("/")[1]!), historyId: String(history) });
      if (url.pathname.endsWith("/history")) {
        const held = heldHistory;
        heldHistory = undefined;
        if (held) { held.captured.release(); await held.response.promise; }
        if (historyRefusal) return Response.json({ error: { message: "Synthetic refusal" } }, { status: historyRefusal });
        return Response.json({ historyId: String(history), history: emptyHistory || url.searchParams.get("startHistoryId") === String(history) ? [] : [{ labelsAdded: [{ message: { id: "m" } }] }] });
      }
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m" }] });
      if (url.pathname.endsWith("/batchModify")) {
        const change = JSON.parse(String(init?.body)) as { addLabelIds: string[]; removeLabelIds: string[] };
        mutations.push(change);
        if (heldMutation?.at === mutations.length) { heldMutation.captured.release(); await heldMutation.response.promise; }
        for (const label of change.addLabelIds) labels.add(label);
        for (const label of change.removeLabelIds) labels.delete(label);
        history++;
        return new Response(null, { status: 204 });
      }
      const snapshot = { id: "m", threadId: "t", historyId: String(history), labelIds: [...labels], ...(url.searchParams.get("format") === "raw" ? { raw } : {}) };
      if (url.searchParams.get("format") === "minimal") {
        minimalRequests++;
        if (hold) { hold = false; captured.release(); await response.promise; }
        else if (blockFresh) await freshResponse.promise;
      }
      return Response.json(snapshot);
  };
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const reply = await respond(`http://127.0.0.1${req.url}`, { method: req.method, body: Buffer.concat(chunks).toString() });
      res.writeHead(reply.status, Object.fromEntries(reply.headers));
      res.end(Buffer.from(await reply.arrayBuffer()));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const providers: ProviderRegistry = {
    create(ctx) {
      // Keep saved-Google admission and native request phases; only the remote endpoint is synthetic.
      const provider = createGmailApiProvider(ctx, { endpoints: { api: `${origin}/${encodeURIComponent(ctx.account.email)}` }, tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
      if (!authoritative) delete provider.flagSnapshots;
      return provider;
    },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const store = kind === "SQL" ? undefined : await IdbMailStore.open({ name: "synthetic-observation", factory: new IDBFactory(), platform, instantSearch: kind === "IDB instant" });
  const backend = new Backend({ dbPath: join(dir, "synthetic.db"), store, platform: store ? platform : undefined, providers, cipher: plaintextCipher, version: "test", autoSync: automatic, instantSearch: false, iconTransport: null, now: () => Date.now() + timeAdvance });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "synthetic", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => { heldHistory?.response.release(); heldMutation?.response.release(); heldSend?.response.release(); response.release(); freshResponse.release(); client.close(); await backend.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
  await backend.syncAccount(account.id);
  expect((await backend.store.accounts.get(account.id))?.syncState).toMatchObject({ status: "idle", lastError: null });
  const threadId = (await backend.store.debug.snapshot()).messages[0]!.threadId;
  minimalRequests = 0; // W03 full reconciliation includes an initial minimal snapshot.
  return { backend, account, threadId, client, captured, response, mutations,
    refuseHistory(status: number) { historyRefusal = status; heldHistory = { captured: gate(), response: gate() }; return heldHistory; },
    allowHistory() {
      historyRefusal = undefined;
      // A genuine 429 now persists a cooldown. Advance both clocks past its finite wait.
      timeAdvance += 360_000;
      vi.spyOn(performance, "now").mockImplementation(() => elapsedNow() + timeAdvance);
    },
    holdMutation(at: number) { heldMutation = { at, captured: gate(), response: gate() }; return heldMutation; },
    holdSend() { heldSend = { captured: gate(), response: gate() }; return heldSend; },
    minimalRequests: () => minimalRequests,
    setEmptyHistory() { emptyHistory = true; }, setRemote(next: string[]) { labels.clear(); for (const label of next) labels.add(label); }, requests: () => requests, setCapable(value: boolean) { authoritative = value; }, remoteLabels: () => [...labels], hold() { hold = true; blockFresh = true; history++; }, releaseFresh() { blockFresh = false; freshResponse.release(); } };
}

it.each([401, 429])("a queued flag reconciliation rechecks admission after history returns %s", async (status) => {
  const t = await setup("SQL", true);
  t.setEmptyHistory();
  vi.spyOn(t.backend, "kickWorker").mockImplementation(() => {});
  const sync = vi.spyOn(t.backend, "syncAccount");
  const held = t.refuseHistory(status);
  const running = t.backend.syncAccount(t.account.id);
  try {
    await held.captured.promise;
    await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markRead", signal: null, now: 1 });
    expect(await t.backend.runWorker()).toBe(1);
  } finally { held.response.release(); await running; }
  await Promise.all(sync.mock.results.map((result) => result.value));
  expect.soft(sync).toHaveBeenCalledTimes(1);
  expect.soft(t.minimalRequests()).toBe(0);
  expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toHaveLength(1);
  t.allowHistory();
  await t.backend.syncAccount(t.account.id);
  expect(t.minimalRequests()).toBe(1);
  expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
});

it("an explicit trailing sync consumes the simultaneous automatic request without another pass", async () => {
  const t = await setup("SQL", true);
  vi.spyOn(t.backend, "kickWorker").mockImplementation(() => {});
  const sync = vi.spyOn(t.backend, "syncAccount");
  const held = t.refuseHistory(401);
  const running = t.backend.syncAccount(t.account.id);
  await held.captured.promise;
  const explicit = t.backend.syncAccount(t.account.id);
  try {
    await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markRead", signal: null, now: 1 });
    expect(await t.backend.runWorker()).toBe(1);
  } finally { held.response.release(); await Promise.all([running, explicit]); }
  expect(sync).toHaveBeenCalledTimes(3);
  expect(t.minimalRequests()).toBe(1);
  t.allowHistory();
});

it("retirement forgets an automatic trailing reconciliation", async () => {
  const t = await setup("SQL", true);
  vi.spyOn(t.backend, "kickWorker").mockImplementation(() => {});
  const sync = vi.spyOn(t.backend, "syncAccount");
  const held = t.refuseHistory(429);
  const running = t.backend.syncAccount(t.account.id);
  try {
    await held.captured.promise;
    await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markRead", signal: null, now: 1 });
    expect(await t.backend.runWorker()).toBe(1);
    await t.backend.dropAccount(t.account.id);
  } finally { held.response.release(); await running; }
  expect(sync).toHaveBeenCalledTimes(1);
  expect(t.minimalRequests()).toBe(0);
});



it("terminal flag outcomes reconcile once at the claimed worker batch boundary", async () => {
  const t = await setup("SQL", true);
  vi.spyOn(t.backend, "kickWorker").mockImplementation(() => {});
  for (const action of ["markRead", "star", "archive"] as const) await t.backend.store.threads.act({ threadIds: [t.threadId], action, signal: null, now: 1 });
  const sync = vi.spyOn(t.backend, "syncAccount");
  const held = t.holdMutation(2);
  const worker = t.backend.runWorker();
  try {
    await held.captured.promise;
    expect.soft(sync).not.toHaveBeenCalled();
  } finally { held.response.release(); expect(await worker).toBe(3); }
  await Promise.all(sync.mock.results.map((result) => result.value));
  expect(sync).toHaveBeenCalledTimes(1);
  expect(t.mutations).toHaveLength(3);
  expect((await t.backend.store.debug.snapshot()).ops.map((op) => op.state)).toEqual(["succeeded", "succeeded", "succeeded"]);
  sync.mockClear();
  await t.backend.store.threads.act({ threadIds: [t.threadId], action: "unstar", signal: null, now: 2 });
  expect(await t.backend.runWorker()).toBe(1);
  await Promise.all(sync.mock.results.map((result) => result.value));
  expect(sync).toHaveBeenCalledTimes(1);
});

it("a stalled sibling Send does not hold a finished account's flag reconciliation", async () => {
  const t = await setup("SQL", true);
  vi.spyOn(t.backend, "kickWorker").mockImplementation(() => {});
  const { account: sibling } = await t.backend.store.accounts.create({ kind: "gmail", email: "sibling@example.test", displayName: "Sibling", color: "indigo", now: 2 });
  await t.backend.syncAccount(sibling.id);
  await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markRead", signal: null, now: 2 });
  const flag = (await t.backend.store.debug.snapshot()).ops[0]!;
  const send = await t.backend.store.compose.queueSend({ accountId: sibling.id, to: [{ name: "", email: "recipient@example.test" }], cc: [], bcc: [], subject: "Synthetic", bodyText: "Exact send", recordReply: false, now: 2 });
  const complete = t.backend.store.ops.complete.bind(t.backend.store.ops), committed = gate();
  vi.spyOn(t.backend.store.ops, "complete").mockImplementation(async (...args) => {
    const result = await complete(...args);
    if (args[0] === flag.id) committed.release();
    return result;
  });
  const sync = vi.spyOn(t.backend, "syncAccount");
  const held = t.holdSend();
  const worker = t.backend.runWorker();
  try {
    await Promise.all([held.captured.promise, committed.promise]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sync).toHaveBeenCalledExactlyOnceWith(t.account.id);
    expect((await t.backend.store.ops.get(send.opId))?.state).toBe("running");
  } finally { held.response.release(); expect(await worker).toBe(2); }
  await Promise.all(sync.mock.results.map((result) => result.value));
  expect((await t.backend.store.ops.get(send.opId))?.state).toBe("succeeded");
});

it("a committed terminal flag still reconciles when its event cannot be emitted", async () => {
  const t = await setup("SQL", true);
  vi.spyOn(t.backend, "kickWorker").mockImplementation(() => {});
  await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markRead", signal: null, now: 1 });
  const emit = t.backend.server.emit.bind(t.backend.server);
  vi.spyOn(t.backend.server, "emit").mockImplementation((name, payload) => {
    if (name === "op" && payload && typeof payload === "object" && "state" in payload && payload.state === "succeeded") throw new Error("Synthetic terminal event failure");
    emit(name, payload);
  });
  const sync = vi.spyOn(t.backend, "syncAccount");
  expect(await t.backend.runWorker()).toBe(1);
  await Promise.all(sync.mock.results.map((result) => result.value));
  expect(sync).toHaveBeenCalledExactlyOnceWith(t.account.id);
  expect(t.mutations).toHaveLength(1);
  expect((await t.backend.store.debug.snapshot()).ops[0]?.state).toBe("succeeded");
});

describe.each(["SQL", "IDB", "IDB instant"] as const)("%s settled flag observation", (kind) => {
  it.each(["markRead", "star", "archive"] as const)("fresh snapshots reconcile acknowledged %s even after its history was consumed", async (action) => {
    const t = await setup(kind);
    await t.client.call("threads.act", { threadIds: [t.threadId], action });
    expect(await t.backend.runWorker()).toBe(1);
    const op = (await t.backend.store.debug.snapshot()).ops.find((row) => row.kind === action)!;
    expect(op.state).toBe("succeeded");
    expect(t.mutations).toHaveLength(1);
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toHaveLength(1);
    t.setEmptyHistory();
    t.setRemote(["INBOX", "UNREAD"]);
    const before = t.requests();
    await t.backend.syncAccount(t.account.id);
    expect.soft(t.requests() - before).toBe(2);
    expect.soft((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    expect.soft((await t.backend.store.debug.snapshot()).messages[0]).toMatchObject({ isRead: false, isStarred: false, inInbox: true });
    expect(t.mutations).toHaveLength(1);
  });

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

  it("committed inverse cancellation wakes reconciliation even with no new operation", async () => {
    const t = await setup(kind, true);
    vi.spyOn(t.backend, "kickWorker").mockImplementation(() => {});
    await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markRead", signal: null, now: 1 });
    await t.backend.store.ops.claimReady(2, 20);
    await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markUnread", signal: null, now: 3 });
    const sync = vi.spyOn(t.backend, "syncAccount").mockResolvedValue();
    await t.client.call("threads.act", { threadIds: [t.threadId], action: "markRead" });
    expect((await t.backend.store.debug.snapshot()).ops.filter((op) => op.state === "queued")).toEqual([]);
    expect(sync).toHaveBeenCalledWith(t.account.id);
  });

  it("committed uncertain discard and successful flag delivery each wake reconciliation", async () => {
    const t = await setup(kind, true);
    vi.spyOn(t.backend, "kickWorker").mockImplementation(() => {});
    await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markRead", signal: null, now: 1 });
    const [uncertain] = await t.backend.store.ops.claimReady(2, 20);
    await t.backend.store.ops.markUnknown(uncertain!.id, "Synthetic uncertain outcome", 3);
    const sync = vi.spyOn(t.backend, "syncAccount").mockResolvedValue();
    await t.client.call("ops.resolveUnknown", { opId: uncertain!.id, resolution: "discard" });
    expect(sync).toHaveBeenCalledWith(t.account.id);
    sync.mockClear();
    await t.backend.store.threads.act({ threadIds: [t.threadId], action: "star", signal: null, now: 4 });
    expect(await t.backend.runWorker()).toBe(1);
    expect(t.mutations).toHaveLength(1);
    expect(sync).toHaveBeenCalledWith(t.account.id);
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


it.each(["sign-in", "backoff"] as const)("committed reconciliation respects %s admission until a new allowed action", async (blocked) => {
  const t = await setup("SQL", true);
  vi.spyOn(t.backend, "kickWorker").mockImplementation(() => {});
  await t.backend.store.threads.act({ threadIds: [t.threadId], action: "markRead", signal: null, now: 1 });
  const [op] = await t.backend.store.ops.claimReady(2, 20);
  await t.backend.store.ops.markUnknown(op!.id, "Synthetic uncertainty", 3);
  const sync = vi.spyOn(t.backend, "syncAccount").mockResolvedValue();
  if (blocked === "sign-in") t.backend.connectivity.waitForSignIn(t.account.id, true);
  else t.backend.connectivity.failed(t.account.id, t.backend.connectivity.epoch);
  await t.client.call("ops.resolveUnknown", { opId: op!.id, resolution: "discard" });
  expect(sync).not.toHaveBeenCalled();
  expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toHaveLength(1);
  if (blocked === "sign-in") t.backend.connectivity.waitForSignIn(t.account.id, false);
  else t.backend.connectivity.succeeded(t.account.id);
  await t.client.call("threads.act", { threadIds: [t.threadId], action: "star" });
  expect(sync).toHaveBeenCalledWith(t.account.id);
});
