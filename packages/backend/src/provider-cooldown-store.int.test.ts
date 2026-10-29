import { fixtureCleanup } from "./provider-cooldown.test-utils";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync as removeSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as nativeTimeout, clearTimeout as clearNativeTimeout } from "node:timers";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import type { MailStore } from "@terno/store";
import type { ProviderRegistry } from "@terno/mail";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { ProviderCooldown, ProviderCooldownError, type CooldownPersistence } from "./provider-cooldown";
import { requestHttp, type RequestDescriptor } from "../../mail/src/provider-http";


const cleanup = fixtureCleanup();
beforeEach(() => cleanup.assertAvailable());
afterEach(() => cleanup.finish());
const rmSync: typeof removeSync = (...args) => { cleanup.remove(() => removeSync(...args)); };
const mailboxA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const mailboxB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const gmail: RequestDescriptor = { request: { endpoint: "gmail-api", purpose: "mail" } };
const userinfo: RequestDescriptor = { request: { endpoint: "google-userinfo", purpose: "photos" } };
const wallNow = () => 1000;
const elapsedNow = () => 10;

function memoryPort(): CooldownPersistence {
  let value: string | null = null;
  return {
    read: async () => value,
    update: async (fn) => {
      const next = fn(value);
      value = next.encoded;
      return next.result;
    },
  };
}

function realPort(store: MailStore): CooldownPersistence {
  return store.providerCooldown;
}

async function wire(handle: (path: string, response: ServerResponse) => void) {
  const calls: string[] = [], sockets = new Set<Socket>(), held = new Set<ServerResponse>(), bodies: Response[] = [];
  const abort = new AbortController();
  let stopped = false, stopResult: Promise<void> | undefined;
  let setupTerminal!: () => void;
  const actualSetupTerminal = new Promise<void>((resolve) => { setupTerminal = resolve; });
  let watchdog: ReturnType<typeof nativeTimeout> | undefined;
  const server = createServer((request, response) => {
    if (calls.length >= 8) { abort.abort(new Error("Synthetic request bound")); response.destroy(); return; }
    calls.push(request.url!);
    response.sendDate = false;
    handle(request.url!, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    if (stopped) socket.destroy();
  });
  const closeServer = () => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
  const stop = () => stopResult ??= (async () => {
    stopped = true;
    if (watchdog) clearNativeTimeout(watchdog);
    abort.abort();
    for (const response of held) response.destroy();
    const socketCloses = [...sockets].map((socket) => new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.destroy(); }));
    // A logical setup timeout is not a terminal listen event. Retain this owner until the
    // real listening/error callback arrives; the fixture join can report uncertainty.
    await actualSetupTerminal;
    const closed = closeServer();
    const terminal = await Promise.allSettled([...socketCloses, closed]);
    const cancellations = await Promise.allSettled(bodies.filter((response) => !response.bodyUsed && !response.body?.locked).map((response) => response.body?.cancel()));
    const cancelFailures = cancellations.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (cancelFailures.length) throw new AggregateError(cancelFailures.map((result) => result.reason), "Synthetic body cancellation failed");
    const failures = terminal.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Synthetic server cleanup failed");
    expect(sockets.size).toBe(0);
  })();
  // Registration precedes listen/setup, including every setup failure branch.
  cleanup.independent("HTTP/server", stop);
  server.once("listening", setupTerminal);
  server.once("error", setupTerminal);
  server.on("error", (error) => { cleanup.fault(error); });
  let rejectSetup!: (error: unknown) => void;
  const listening = new Promise<void>((resolve, reject) => {
    rejectSetup = reject;
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError); server.once("listening", onListening);
    try { server.listen(0, "127.0.0.1"); }
    catch (error) { server.off("error", onError); server.off("listening", onListening); setupTerminal(); reject(error); }
  });
  watchdog = nativeTimeout(() => {
    const error = new Error("Synthetic HTTP native watchdog");
    abort.abort(error); rejectSetup(error);
    cleanup.fault(error);
    void stop().catch((failure: unknown) => { cleanup.fault(failure); });
  }, 5000);
  await listening;
  const address = server.address();
  if (!address || typeof address === "string" || stopped) throw new Error("No synthetic HTTP port");
  return { calls, fetch: async (path: string) => { const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { signal: abort.signal }); bodies.push(response); return response; } };
}

function reply(response: ServerResponse, status: number, directive?: string) {
  response.writeHead(status, { "content-type": "application/json", ...(directive === undefined ? {} : { "retry-after": directive }) });
  response.end("{}");
}

async function responseOrRefusal(work: Promise<Response>): Promise<Response | ProviderCooldownError> {
  try {
    const response = await work;
    await response.text();
    return response;
  } catch (error) {
    if (error instanceof ProviderCooldownError) return error;
    throw error;
  }
}

describe("latent cooldown first RED", () => {
  it("01 headers block second HTTP", async () => {
    const t = await wire((path, response) => reply(response, path === "/first" ? 429 : 200, "120"));
    const gate = await ProviderCooldown.open(memoryPort(), { wallNow, elapsedNow, random: () => 0.5 });
    cleanup.push(() => gate.close());
    const policy = gate.requestsFor(mailboxA);
    const first = await requestHttp(policy, gmail, () => t.fetch("/first"), wallNow);
    expect(first.status).toBe(429);
    await first.text();
    await responseOrRefusal(requestHttp(policy, gmail, () => t.fetch("/second"), wallNow));
    expect(t.calls.length).toBe(1);
    expect(t.calls).toEqual(["/first"]);
  });

  it("02 missing header uses one sample", async () => {
    let samples = 0;
    const t = await wire((path, response) => reply(response, path === "/first" ? 429 : 200));
    const gate = await ProviderCooldown.open(memoryPort(), { wallNow, elapsedNow, random: () => { samples++; return 0.5; } });
    cleanup.push(() => gate.close());
    const policy = gate.requestsFor(mailboxA);
    await responseOrRefusal(requestHttp(policy, gmail, () => t.fetch("/first"), wallNow));
    await responseOrRefusal(requestHttp(policy, gmail, () => t.fetch("/second"), wallNow));
    expect(t.calls.length).toBe(1);
    expect(samples).toBe(1);
    expect(gate.state(mailboxA, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
  });

  it("03 ordinary HTTP stays admitted", async () => {
    const t = await wire((_path, response) => reply(response, 200));
    const gate = await ProviderCooldown.open(memoryPort(), { wallNow, elapsedNow, random: () => 0.5 });
    cleanup.push(() => gate.close());
    const policy = gate.requestsFor(mailboxA);
    const first = await requestHttp(policy, gmail, () => t.fetch("/first"), wallNow);
    expect(first.status).toBe(200);
    await first.text();
    const second = await requestHttp(policy, gmail, () => t.fetch("/second"), wallNow);
    expect(second.status).toBe(200);
    await second.text();
    expect(t.calls).toEqual(["/first", "/second"]);
  });

  it("04 other scopes stay admitted", async () => {
    const t = await wire((path, response) => reply(response, path === "/first" ? 429 : 200, "120"));
    const gate = await ProviderCooldown.open(memoryPort(), { wallNow, elapsedNow, random: () => 0.5 });
    cleanup.push(() => gate.close());
    const first = await requestHttp(gate.requestsFor(mailboxA), gmail, () => t.fetch("/first"), wallNow);
    expect(first.status).toBe(429);
    await first.text();
    const otherMailbox = await requestHttp(gate.requestsFor(mailboxB), gmail, () => t.fetch("/other"), wallNow);
    expect(otherMailbox.status).toBe(200);
    await otherMailbox.text();
    const otherService = await requestHttp(gate.requestsFor(mailboxA), userinfo, () => t.fetch("/userinfo"), wallNow);
    expect(otherService.status).toBe(200);
    await otherService.text();
    expect(t.calls).toEqual(["/first", "/other", "/userinfo"]);
  });

  const stores = [
    { name: "05 SQL reopens with minimum", kind: "SQL", instant: false },
    { name: "06 IDB off reopens with minimum", kind: "IDB", instant: false },
    { name: "07 IDB on reopens with minimum", kind: "IDB", instant: true },
  ] as const;
  for (const store of stores) {
    it(store.name, async () => {
      const dir = mkdtempSync(join(tmpdir(), "terno-cooldown-red-"));
      const factory = new IDBFactory();
      const databaseName = crypto.randomUUID();
      const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
      const providers: ProviderRegistry = {
        create() { throw new Error("No provider activation in latent fixture"); },
        async verifyImap() {},
        async connectGmail() { throw new Error("No consent in latent fixture"); },
      };
      let owner: Backend | undefined;
      cleanup.push(async () => {
        try { await owner?.stop(); }
        finally { rmSync(dir, { recursive: true, force: true }); }
      });
      const open = async () => {
        owner = new Backend({
          dbPath: join(dir, "synthetic.db"),
          store: store.kind === "IDB" ? await IdbMailStore.open({ name: databaseName, factory, platform, instantSearch: store.instant }) : undefined,
          platform, version: "test", providers, cipher: plaintextCipher,
          autoSync: false, instantSearch: false, iconTransport: null,
        });
        await owner.ready;
        return owner;
      };
      const t = await wire((path, response) => reply(response, path === "/first" ? 429 : 200, "120"));
      const before = await open();
      const firstGate = await ProviderCooldown.open(realPort(before.store), { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.push(() => firstGate.close());
      const first = await requestHttp(firstGate.requestsFor(mailboxA), gmail, () => t.fetch("/first"), wallNow);
      expect(first.status).toBe(429);
      await first.text();
      await firstGate.close();
      await before.stop();
      owner = undefined;
      const reopened = await open();
      const secondGate = await ProviderCooldown.open(realPort(reopened.store), { wallNow, elapsedNow: () => 20, random: () => 0.5 });
      cleanup.push(() => secondGate.close());
      await responseOrRefusal(requestHttp(secondGate.requestsFor(mailboxA), gmail, () => t.fetch("/second"), wallNow));
      expect(secondGate.state(mailboxA, "gmail-api")).toEqual({ kind: "at", atMs: 121000 });
      expect(t.calls).toEqual(["/first"]);
    });
  }
});

const verifiedMailbox = "580852f44dc8a5bc68cbd0130926bedcbfb143d6ca60f3f40fdf6ff7b4dd820f";

function terminalDelivery(factory: IDBFactory) {
  let armed = false, release!: () => void, observed!: () => void;
  let hold = Promise.resolve();
  const originalOpen = factory.open.bind(factory);
  factory.open = (...args) => {
    const request = originalOpen(...args);
    request.addEventListener("success", () => {
      const db = request.result, transaction = db.transaction.bind(db);
      db.transaction = ((stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) => {
        const tx = transaction(stores, mode, options);
        if (!armed || mode !== "readwrite" || !(typeof stores === "string" ? [stores] : stores).includes("settings")) return tx;
        armed = false;
        const add = tx.addEventListener.bind(tx);
        tx.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
          if (!listener) return;
          if (type !== "complete" && type !== "abort") { add(type, listener, options); return; }
          add(type, (event) => {
            observed();
            void hold.then(() => { if (typeof listener === "function") listener.call(tx, event); else listener.handleEvent(event); });
          }, options);
        }) as typeof tx.addEventListener;
        return tx;
      }) as typeof db.transaction;
    });
    return request;
  };
  return { arm: () => {
    armed = true;
    hold = new Promise<void>((r) => { release = r; });
    const seen = new Promise<void>((r) => { observed = r; });
    return { seen, release: () => release() };
  } };
}
type StoreMode = "SQL" | "IDB off" | "IDB on";
async function storeFixture(mode: StoreMode) {
  const dir = mkdtempSync(join(tmpdir(), "terno-cooldown-stage1-")), factory = new IDBFactory(), name = crypto.randomUUID();
  const terminal = terminalDelivery(factory);
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const providers: ProviderRegistry = { create() { throw new Error("Latent fixture cannot activate a provider"); }, async verifyImap() {}, async connectGmail() { throw new Error("Latent fixture cannot sign in"); } };
  let owner: Backend | undefined;
  cleanup.push(async () => { try { await owner?.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  const open = async () => {
    owner = new Backend({ dbPath: join(dir, "fixture.db"), store: mode === "SQL" ? undefined : await IdbMailStore.open({ name, factory, platform, instantSearch: mode === "IDB on" }), platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
    await owner.ready;
    return owner.store;
  };
  const store = await open();
  return { store, terminal, backend: () => owner!, reopen: async () => { await owner!.stop(); owner = undefined; return open(); } };
}
async function account(store: MailStore, n: number, kind: "gmail" | "imap" = "gmail") {
  return (await store.accounts.create({ kind, email: `synthetic${n}@example.test`, displayName: "Synthetic", color: "indigo", providerConfig: {}, now: 1 })).account;
}
async function sendOp(store: MailStore, accountId: number) {
  return (await store.compose.queueSend({ accountId, to: [{ email: "recipient@example.test", name: "" }], cc: [], bcc: [], subject: "Synthetic", bodyText: "Synthetic", recordReply: false, now: 1000 })).opId;
}
const emptyAdmission = { blockedAccountIds: [] as number[], verifiedAccountIds: [] as number[], blockUnverifiedGoogle: false, blockAllGoogle: false };
function rowLedger() {
  return JSON.stringify({ version: 1, revision: "1", overflow: false, bindings: [], rows: [{ owner: mailboxA, service: "gmail-api", revision: "1", phaseRevision: "1", minimum: "121000", wall: "1000", replay: "120000", sample: 2000, position: 1, hold: null, repair: null }] });
}
for (const mode of ["SQL", "IDB off", "IDB on"] as const) {
  describe(`private cooldown store ${mode}`, () => {
    it("02 ordinary and other scope survive reopen", async () => {
      const f = await storeFixture(mode);
      await f.store.providerCooldown.update(() => ({ encoded: rowLedger(), result: undefined }));
      const reopened = await f.reopen();
      const g = await ProviderCooldown.open(reopened.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate("integration/healthy-close", g);
      expect(g.state(mailboxA, "gmail-api")).toEqual({ kind: "at", atMs: 121000 });
      expect(g.state(mailboxB, "gmail-api")).toEqual({ kind: "ready" });
      expect(g.state(mailboxA, "google-userinfo")).toEqual({ kind: "ready" });
    });
    it("03 corrupt and unknown versions hold", async () => {
      const f = await storeFixture(mode);
      for (const encoded of ["{", '{"version":9}']) {
        await f.store.settings.set("provider-cooldown:v1", encoded);
        const g = await ProviderCooldown.open(f.store.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
        cleanup.gate("integration/healthy-close", g);
        expect(g.state(mailboxA, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
        await expect(f.store.providerCooldown.read()).rejects.toThrow();
      }
    });
    it("04 binding checks current full stamp", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1), stamp = (await f.store.accounts.stamp(a.id))!;
      await f.store.providerCooldown.update(() => { const v = JSON.parse(rowLedger()); v.rows[0].owner = "installation"; v.rows[0].hold = "calendar"; return { encoded: JSON.stringify(v), result: undefined }; });
      expect(await f.store.providerCooldown.bind(stamp, verifiedMailbox)).toBe(true);
      expect(await f.store.providerCooldown.bind(stamp, mailboxB)).toBe(false);
      expect(await f.store.providerCooldown.bind({ ...stamp, createdAt: 2 }, verifiedMailbox)).toBe(false);
      expect(await f.store.providerCooldown.bind({ ...stamp, email: "other@example.test" }, verifiedMailbox)).toBe(false);
      const value = await f.store.providerCooldown.read();
      expect(value).not.toContain(stamp.email);
      expect(JSON.parse(value!).bindings).toHaveLength(1);
      const rows = JSON.parse(value!).rows;
      expect(rows.map((row: { owner: string }) => row.owner).sort()).toEqual(["installation", verifiedMailbox].sort());
      expect(rows.every((row: { minimum: string; hold: string }) => row.minimum === "121000" && row.hold === "calendar")).toBe(true);
    });
    it("05 deleted stamp cannot bind reused slot", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1), stamp = (await f.store.accounts.stamp(a.id))!;
      await f.store.accounts.remove(a.id);
      expect(await f.store.providerCooldown.bind(stamp, verifiedMailbox)).toBe(false);
      expect(await f.store.providerCooldown.read()).toBe(null);
    });
    it("06 imported metadata proves nothing", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1);
      await f.store.accounts.setProviderConfig(a.id, { verified: true, mailboxKey: mailboxA });
      const g = await ProviderCooldown.open(f.store.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate("integration/healthy-close", g);
      const stamp = (await f.store.accounts.stamp(a.id))!;
      const snapshot = await g.admission((id) => id === a.id ? { ...stamp, kind: "gmail" } : undefined);
      expect(snapshot.verifiedAccountIds).toEqual([]);
      expect(await f.store.providerCooldown.read()).toBe(null);
    });
    it("07 duplicate bindings share exclusion", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1), b = await account(f.store, 1);
      const sa = (await f.store.accounts.stamp(a.id))!, sb = (await f.store.accounts.stamp(b.id))!;
      await f.store.providerCooldown.bind(sa, verifiedMailbox); await f.store.providerCooldown.bind(sb, verifiedMailbox);
      await f.store.providerCooldown.update((current) => { const v = JSON.parse(current!); v.revision = "3"; v.rows = JSON.parse(rowLedger()).rows.map((row: Record<string, unknown>) => ({ ...row, owner: verifiedMailbox })); return { encoded: JSON.stringify(v), result: undefined }; });
      const g = await ProviderCooldown.open(f.store.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate("integration/healthy-close", g);
      const stamps = new Map([[a.id, { ...sa, kind: "gmail" }], [b.id, { ...sb, kind: "gmail" }]]);
      const admission = await g.admission((id) => stamps.get(id));
      expect(admission.blockedAccountIds).toEqual([a.id, b.id]);
      const x = await sendOp(f.store, a.id), y = await sendOp(f.store, b.id);
      expect(await f.store.ops.claimReady(1000, 2, admission)).toEqual([]);
      expect(await f.store.ops.nextAttemptAt(admission)).toBe(null);
      expect((await f.store.ops.get(x))?.attempts).toBe(0); expect((await f.store.ops.get(y))?.attempts).toBe(0);
      await g.close();
      await f.store.providerCooldown.update((current) => { const v = JSON.parse(current!); v.rows[0].service = "oauth-token"; return { encoded: JSON.stringify(v), result: undefined }; });
      const cached = await ProviderCooldown.open(f.store.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate("integration/cached-healthy-close", cached);
      const policy = await cached.requestsForAccount(sa, () => true);
      cleanup.push(async () => { policy.close(); });
      expect((await cached.admission((id) => stamps.get(id))).blockedAccountIds).toEqual([]);
      expect(() => policy.check(gmail)).not.toThrow();
      policy.tokenUnavailable();
      expect((await cached.admission((id) => stamps.get(id))).blockedAccountIds).toEqual([a.id]);
      policy.accessAvailable();
      expect((await cached.admission((id) => stamps.get(id))).blockedAccountIds).toEqual([]);
      expect(cached.state(verifiedMailbox, "oauth-token")).toEqual({ kind: "at", atMs: 121000 });
    });
    it("08 exclusion precedes claim limit", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1), b = await account(f.store, 2);
      const x = await sendOp(f.store, a.id), y = await sendOp(f.store, b.id);
      const admission = { ...emptyAdmission, blockedAccountIds: [a.id] };
      expect((await f.store.ops.claimReady(1000, 1, admission)).map((o) => o.id)).toEqual([y]);
      expect((await f.store.ops.get(x))?.attempts).toBe(0);
      expect(await f.store.ops.nextAttemptAt(admission)).toBe(null);
    });
    it("09 unverified pause preserves IMAP", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1), b = await account(f.store, 2), c = await account(f.store, 3, "imap");
      await sendOp(f.store, a.id); const y = await sendOp(f.store, b.id), z = await sendOp(f.store, c.id);
      const admission = { ...emptyAdmission, blockUnverifiedGoogle: true, verifiedAccountIds: [b.id] };
      expect((await f.store.ops.claimReady(1000, 3, admission)).map((o) => o.id)).toEqual([y, z]);
      expect(await f.store.ops.nextAttemptAt(admission)).toBe(null);
    });
    it("10 refund is a running-only transition", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1), id = await sendOp(f.store, a.id);
      const [before] = await f.store.ops.claimReady(1000, 1);
      await f.store.ops.defer(id, 1001, { refundClaim: true }); await f.store.ops.defer(id, 1002, { refundClaim: true });
      const after = (await f.store.ops.get(id))!;
      expect(after).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: before!.next_attempt_at, seq: before!.seq, payload_json: before!.payload_json, target_json: before!.target_json });
      const blocked = { ...emptyAdmission, blockedAccountIds: [a.id] };
      expect(await f.store.ops.nextAttemptAt(blocked)).toBe(null); expect(await f.store.ops.claimReady(9999, 1, blocked)).toEqual([]);
    });
    it("11 prior request retains claim attempt", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1), id = await sendOp(f.store, a.id);
      await f.store.ops.claimReady(1000, 1); await f.store.ops.defer(id, 1001, { refundClaim: false });
      expect((await f.store.ops.get(id))?.attempts).toBe(1);
      await f.store.ops.claimReady(1001, 1); await f.store.ops.markUnknown(id, "Synthetic unknown acceptance", 1002);
      await f.store.ops.defer(id, 1003, { refundClaim: true });
      expect((await f.store.ops.get(id))?.state).toBe("unknown");
      expect(await f.store.ops.claimReady(9999, 1)).toEqual([]);
      const accepted = await sendOp(f.store, a.id); await f.store.ops.claimReady(1004, 1);
      await f.store.ops.complete(accepted, { providerMsgId: "accepted-fixture" }, 1005);
      await f.store.ops.defer(accepted, 1006, { refundClaim: true });
      expect((await f.store.ops.get(accepted))?.state).toBe("succeeded");
      expect((await f.store.ops.get(accepted))?.attempts).toBe(1);
    });
    it("12 location order survives exclusion", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1);
      await f.store.sync.ingest([{ accountId: a.id, providerMsgId: "location-fixture", providerThreadId: "location-thread", rfcMessageId: "<location@example.test>", inReplyTo: null, references: [], from: { email: "sender@example.test", name: "Synthetic" }, to: [{ email: a.email, name: "" }], cc: [], bcc: [], subject: "Location", date: 1000, snippet: "Synthetic", bodyText: "Synthetic", bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 9 }], { applyFilters: false, now: 1000, classifier: null });
      const message = (await f.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "location-fixture")!;
      expect(message.inInbox).toBe(true);
      const first = await f.store.threads.act({ threadIds: [message.threadId], action: "archive", signal: null, now: 1002 });
      const second = await f.store.threads.act({ threadIds: [message.threadId], action: "trash", signal: null, now: 1003 });
      expect(first.opIds).toHaveLength(1); expect(second.opIds).toHaveLength(1);
      const admission = { ...emptyAdmission, blockedAccountIds: [a.id] };
      expect(await f.store.ops.claimReady(1004, 2, admission)).toEqual([]); expect(await f.store.ops.nextAttemptAt(admission)).toBe(null);
      const claimed = await f.store.ops.claimReady(1004, 2);
      expect(claimed.map((o) => o.id)).toEqual(first.opIds);
      expect(await f.store.ops.nextAttemptAt()).toBe(null);
      await f.store.ops.complete(first.opIds[0]!, undefined, 1005);
      expect((await f.store.ops.claimReady(1005, 2)).map((o) => o.id)).toEqual(second.opIds);
    });
    it("13 fixed bytes and synchronous callback", async () => {
      const f = await storeFixture(mode);
      await f.store.providerCooldown.update(() => ({ encoded: rowLedger(), result: undefined }));
      const before = await f.store.providerCooldown.read();
      await expect(f.store.providerCooldown.update(() => ({ encoded: " ".repeat(65537), result: undefined }))).rejects.toThrow();
      const bad = (() => Promise.resolve({ encoded: rowLedger(), result: undefined })) as unknown as Parameters<MailStore["providerCooldown"]["update"]>[0];
      await expect(f.store.providerCooldown.update(bad)).rejects.toThrow();
      await expect(f.store.providerCooldown.update(() => ({ encoded: rowLedger(), result: Promise.resolve(undefined) }))).rejects.toThrow();
      expect(await f.store.providerCooldown.read()).toBe(before);
      const reads = Array.from({ length: 64 }, () => f.store.providerCooldown.read());
      await expect(f.store.providerCooldown.read()).rejects.toThrow("capacity");
      await Promise.all(reads);
      await expect(f.store.ops.claimReady(1000, 1, { ...emptyAdmission, blockedAccountIds: [NaN] })).rejects.toThrow();
    });
    it("14 private ledger stays off public reads", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1);
      await f.store.providerCooldown.update(() => ({ encoded: rowLedger(), result: undefined }));
      expect(await f.store.providerStore(a.id).setting("provider-cooldown:v1")).toBe(null);
      const [local, remote] = createMemoryTransportPair(), frames: unknown[] = [];
      local.onMessage((frame) => frames.push(frame));
      f.backend().connect(remote, { clientId: "cooldown-fixture", origin: "renderer" });
      const client = new RpcClient(local, { defaultTimeoutMs: 5000 });
      cleanup.independent("integration14/RPC-close", async () => { client.close(); });
      const bootstrap = await client.call("app.bootstrap", {});
      expect(bootstrap.accounts.some((row) => row.id === a.id)).toBe(true);
      expect(frames.length).toBeGreaterThan(0);
      expect(JSON.stringify(frames)).not.toContain(mailboxA);
      expect(JSON.stringify(frames)).not.toContain("provider-cooldown:v1");
      expect(JSON.stringify(await f.store.accounts.list())).not.toContain(mailboxA);
      expect(JSON.stringify(new ProviderCooldownError("gmail-api", "1", "timed"))).not.toContain("revision");
    });
    it("15 committed then thrown reads real store", async () => {
      const f = await storeFixture(mode), actual = f.store.providerCooldown;
      const g = await ProviderCooldown.open({ read: actual.read, update: async (fn) => { await actual.update(fn); throw new Error("Synthetic postcommit return failure"); } }, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate("integration/healthy-close", g);
      const ticket = g.requestsFor(mailboxA).reserve(gmail); await ticket.dispatch(async () => new Response(null, { status: 429 }));
      expect(await ticket.headers429({ received: { source: "date-now", kind: "wall", wallMs: 1000 }, minimum: { kind: "at", basis: "delay", atMs: 121000 } })).toBe("committed"); ticket.release();
      const stored = await actual.read();
      expect(JSON.parse(stored!).rows[0].minimum).toBe("121000");
      await g.close(); const reopened = await f.reopen();
      expect(await reopened.providerCooldown.read()).toBe(stored);
      const real = reopened.providerCooldown;
      let fail = true, samples = 0;
      const broken = await ProviderCooldown.open({ read: real.read, update: (fn) => fail ? Promise.reject(new Error("Synthetic beforecommit failure")) : real.update(fn) }, { wallNow, elapsedNow, random: () => { samples++; return 0.5; } });
      cleanup.gate("integration15/recovered-healthy-close", broken);
      const http = await wire((_path, response) => reply(response, 429, "120"));
      const response = await requestHttp(broken.requestsFor(mailboxB), gmail, () => http.fetch("/first"), wallNow);
      expect(response.status).toBe(429); await response.text();
      expect(broken.state(mailboxB, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
      expect(await real.read()).toBe(stored); expect(http.calls).toEqual(["/first"]); expect(samples).toBe(1);
      await broken.drain(5000); fail = false;
      expect(await broken.recoverStorage()).toBe("confirmed"); expect(samples).toBe(1);
      await broken.close();
      const recovered = await f.reopen();
      const b = JSON.parse((await recovered.providerCooldown.read())!).rows.find((row: { owner: string }) => row.owner === mailboxB);
      expect(b.minimum).toBe("121000"); expect(b.sample).toBe(2000);
    });
    it("16 withheld completion retains owner", async () => {
      const f = await storeFixture(mode), actual = f.store.providerCooldown;
      let release!: () => void, reached!: () => void;
      const held = new Promise<void>((r) => { release = r; }), committed = new Promise<void>((r) => { reached = r; });
      // SQL is synchronous: hold its postcommit return. IDB holds delivery of the real terminal event.
      const terminal = mode === "SQL" ? undefined : f.terminal.arm();
      cleanup.release(() => { terminal?.release(); release(); });
      const port: CooldownPersistence = mode === "SQL" ? { read: actual.read, update: async (fn) => { const result = await actual.update(fn); reached(); await held; return result; } } : actual;
      const g = await ProviderCooldown.open(port, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate("integration/healthy-close", g);
      const ticket = g.requestsFor(mailboxA).reserve(gmail); await ticket.dispatch(async () => new Response(null, { status: 429 }));
      const ack = cleanup.watch("integration16/ack", ticket.headers429({ received: { source: "date-now", kind: "wall", wallMs: 1000 }, minimum: { kind: "at", basis: "delay", atMs: 121000 } })); ticket.release();
      await (terminal?.seen ?? committed);
      let closed = false; const stop = cleanup.watch("integration16/explicit-close", g.close().then(() => { closed = true; }));
      await Promise.resolve(); expect(closed).toBe(false); expect(g.resources().writer).toBe(true);
      terminal?.release(); release();
      expect(await ack).toBe("committed"); await stop; expect(closed).toBe(true);
      const reopened = await f.reopen(); expect(JSON.parse((await reopened.providerCooldown.read())!).rows[0].minimum).toBe("121000");
    });
  });
}

type ReviewLedger = import("@terno/store").CooldownLedger;
type ReviewEvidence = import("@terno/mail/portable").Observation429;

function reviewLatch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function reviewEvidence(wall: number, atMs?: number): ReviewEvidence {
  return { received: { source: "date-now", kind: "wall", wallMs: wall }, minimum: atMs === undefined ? { kind: "none", reason: "not-visible" } : { kind: "at", basis: "delay", atMs } };
}

async function reviewLedger(store: MailStore): Promise<ReviewLedger> {
  const encoded = await store.providerCooldown.read();
  if (encoded === null) throw new Error("Missing review ledger fixture");
  return JSON.parse(encoded);
}

async function reviewPhase(mode: StoreMode, outcome: "normal" | "before" | "after" = "normal") {
  const f = await storeFixture(mode), actual = f.store.providerCooldown;
  const a = await account(f.store, 1), stamp = (await f.store.accounts.stamp(a.id))!;
  expect(await actual.bind(stamp, verifiedMailbox)).toBe(true);
  const held = reviewLatch<void>(), reached = reviewLatch<void>();
  cleanup.release(() => held.resolve());
  let wall = 1000, elapsed = 10, samples = 0, updates = 0, reads = 0, transports = 0;
  let fail = outcome === "before";
  const gate = await ProviderCooldown.open({
    read: () => { reads++; return actual.read(); },
    update: async (fn) => {
      const ordinal = ++updates;
      if (ordinal === 2) {
        reached.resolve(); await held.promise;
        if (fail) throw new Error("Synthetic second phase precommit failure");
      }
      const result = await actual.update(fn);
      if (ordinal === 2 && outcome === "after") throw new Error("Synthetic second phase postcommit failure");
      return result;
    },
  }, { wallNow: () => wall, elapsedNow: () => elapsed, random: () => { samples++; return 0.5; } });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    fail = false; held.resolve();
    await gate.drain(5000);
    expect(await gate.recoverStorage()).toBe("confirmed");
    await gate.close();
  })();
  cleanup.gate(`review/F1/${mode}/${outcome}`, { close: stop, resources: () => gate.resources() });
  const policy = await gate.requestsForAccount(stamp, () => true);
  const reserve = () => policy.reserve(gmail);
  const dispatch = async (ticket: ReturnType<typeof reserve>, status = 429) => {
    return ticket.dispatch(async () => { transports++; return new Response(null, { status }); });
  };
  const issue = async (atMs?: number) => {
    const ticket = reserve(); await dispatch(ticket);
    const ack = cleanup.watch(`review/F1/${mode}/observation`, ticket.headers429(reviewEvidence(wall, atMs)));
    ticket.release(); return ack;
  };
  return {
    store: f.store, actual, gate, policy, stamp, held, reached, stop, reserve, dispatch, issue,
    time: (nextWall: number, nextElapsed: number) => { wall = nextWall; elapsed = nextElapsed; },
    samples: () => samples, reads: () => reads, updates: () => updates, transports: () => transports,
    reopen: async () => { await stop(); return f.reopen(); },
  };
}

for (const mode of ["SQL", "IDB off", "IDB on"] as const) {
  describe(`cooldown review real store ${mode}`, () => {
    it("F1 two binds retain second accepted phase", async () => {
      const f = await reviewPhase(mode);
      expect(await f.issue()).toBe("committed"); await f.gate.drain(5000);
      f.time(3000, 2010);
      const second = cleanup.watch(`review/F1/${mode}/second`, f.issue());
      await f.reached.promise;
      expect(f.gate.resources().writer).toBe(true); expect(f.samples()).toBe(2);
      expect(await f.gate.refreshAfterBind()).toBe("pending-terminal");
      expect(await f.actual.bind(f.stamp, verifiedMailbox)).toBe(true);
      expect(await f.actual.bind(f.stamp, verifiedMailbox)).toBe(true);
      const old = (await reviewLedger(f.store)).rows.find((r) => r.owner === verifiedMailbox)!;
      expect({ minimum: old.minimum, sample: old.sample, position: old.position }).toEqual({ minimum: "3000", sample: 2000, position: 1 });
      f.held.resolve(); expect(await second).toBe("committed"); await f.gate.drain(5000);
      const stored = (await reviewLedger(f.store)).rows.find((r) => r.owner === verifiedMailbox)!;
      expect({ minimum: stored.minimum, replay: stored.replay, sample: stored.sample, position: stored.position }).toEqual({ minimum: "8000", replay: "5000", sample: 5000, position: 2 });
      f.time(8000, 7010); expect(await f.issue()).toBe("committed");
      expect(f.samples()).toBe(3); expect(f.transports()).toBe(3);
      const reopened = await f.reopen();
      expect((await reviewLedger(reopened)).rows.find((r) => r.owner === verifiedMailbox)).toMatchObject({ minimum: "23000", sample: 15000, position: 3 });
    });

    it("F1 no bind preserves the same phase timeline", async () => {
      const f = await reviewPhase(mode);
      expect(await f.issue()).toBe("committed"); await f.gate.drain(5000); f.time(3000, 2010);
      const second = cleanup.watch(`review/F1/${mode}/no-bind`, f.issue());
      await f.reached.promise; f.held.resolve(); expect(await second).toBe("committed"); await f.gate.drain(5000);
      expect((await reviewLedger(f.store)).rows.find((r) => r.owner === verifiedMailbox)).toMatchObject({ minimum: "8000", sample: 5000, position: 2 });
      f.time(8000, 7010); expect(await f.issue()).toBe("committed");
      const reopened = await f.reopen();
      expect((await reviewLedger(reopened)).rows.find((r) => r.owner === verifiedMailbox)).toMatchObject({ minimum: "23000", sample: 15000, position: 3 });
      expect(f.samples()).toBe(3); expect(f.transports()).toBe(3);
    });

    it("F1 later healthy reset outranks pending phase", async () => {
      const f = await reviewPhase(mode);
      expect(await f.issue()).toBe("committed"); await f.gate.drain(5000); f.time(3000, 2010);
      const second = cleanup.watch(`review/F1/${mode}/reset-pending`, f.issue());
      await f.reached.promise;
      f.time(8000, 7010); const success = f.reserve();
      expect((await f.dispatch(success, 200)).status).toBe(200); success.headers(200); success.release();
      f.held.resolve(); expect(await second).toBe("committed"); await f.gate.drain(5000);
      expect((await reviewLedger(f.store)).rows.find((r) => r.owner === verifiedMailbox)?.position).toBe(0);
      expect(await f.issue()).toBe("committed");
      const reopened = await f.reopen();
      expect((await reviewLedger(reopened)).rows.find((r) => r.owner === verifiedMailbox)).toMatchObject({ minimum: "10000", sample: 2000, position: 1 });
      expect(f.samples()).toBe(3); expect(f.transports()).toBe(4);
    });

    it("F1 metadata is not precommit phase confirmation", async () => {
      const f = await reviewPhase(mode, "before"), first = f.reserve(), late = f.reserve();
      await f.dispatch(first); await f.dispatch(late);
      expect(await first.headers429(reviewEvidence(1000, 121000))).toBe("committed"); first.release(); await f.gate.drain(5000);
      const ack = cleanup.watch(`review/F1/${mode}/precommit-ack`, late.headers429(reviewEvidence(1000, 121000))); late.release();
      await f.reached.promise; expect(await f.actual.bind(f.stamp, verifiedMailbox)).toBe(true);
      f.held.resolve(); const result = await ack; await f.gate.drain(5000);
      expect(f.samples()).toBe(2); expect(f.reads()).toBe(2);
      expect(result).toBe("unconfirmed");
      expect(f.gate.resources()).toMatchObject({ tickets: 1, pendingScopes: 1, writer: false });
      expect(f.gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
      expect((await reviewLedger(f.store)).rows.find((r) => r.owner === verifiedMailbox)).toMatchObject({ minimum: "121000", replay: "120000", sample: 2000, position: 1 });
      const reopened = await f.reopen();
      expect((await reviewLedger(reopened)).rows.find((r) => r.owner === verifiedMailbox)).toMatchObject({ minimum: "121000", sample: 5000, position: 2 });
      expect(f.samples()).toBe(2); expect(f.transports()).toBe(2);
    });

    it("F1 real commit before throw confirms exact phase", async () => {
      const f = await reviewPhase(mode, "after");
      expect(await f.issue()).toBe("committed"); await f.gate.drain(5000); f.time(3000, 2010);
      const second = cleanup.watch(`review/F1/${mode}/postcommit-ack`, f.issue());
      await f.reached.promise; f.held.resolve(); expect(await second).toBe("committed"); await f.gate.drain(5000);
      expect(f.reads()).toBe(2); expect(f.samples()).toBe(2);
      expect(f.gate.resources()).toMatchObject({ tickets: 0, pendingScopes: 0, writer: false });
      const reopened = await f.reopen();
      expect((await reviewLedger(reopened)).rows.find((r) => r.owner === verifiedMailbox)).toMatchObject({ minimum: "8000", sample: 5000, position: 2 });
      expect(f.samples()).toBe(2);
    });

    it("F1 old installation phase cannot undo reset", async () => {
      const f = await storeFixture(mode), actual = f.store.providerCooldown;
      const a = await account(f.store, 1), stamp = (await f.store.accounts.stamp(a.id))!;
      const seed: ReviewLedger = { version: 1, revision: "1", overflow: false, bindings: [], rows: [{ owner: "installation", service: "gmail-api", revision: "1", phaseRevision: "1", minimum: "3000", wall: "1000", replay: "2000", sample: 2000, position: 1, hold: null, repair: null }] };
      await actual.update(() => ({ encoded: JSON.stringify(seed), result: undefined }));
      expect(await actual.bind(stamp, verifiedMailbox)).toBe(true);
      let wall = 1000, elapsed = 10, samples = 0;
      const clock = { wallNow: () => wall, elapsedNow: () => elapsed, random: () => { samples++; return 0.5; } };
      const gate = await ProviderCooldown.open(actual, clock);
      cleanup.gate(`review/F1/${mode}/installation-reset-before`, gate);
      wall = 3000; elapsed = 2010;
      const policy = await gate.requestsForAccount(stamp, () => true), success = policy.reserve(gmail);
      await success.dispatch(async () => new Response(null, { status: 200 })); success.headers(200); success.release(); await gate.drain(5000);
      expect((await reviewLedger(f.store)).rows.find((r) => r.owner === verifiedMailbox)?.position).toBe(0);
      await gate.close(); expect(await actual.bind(stamp, verifiedMailbox)).toBe(true);
      const rebound = await reviewLedger(f.store);
      expect(rebound.rows.find((r) => r.owner === "installation")?.position).toBe(1);
      expect(rebound.rows.find((r) => r.owner === verifiedMailbox)?.position).toBe(0);
      const reopened = await f.reopen(), after = await ProviderCooldown.open(reopened.providerCooldown, clock);
      cleanup.gate(`review/F1/${mode}/installation-reset-after`, after);
      wall = 5000; elapsed = 4010;
      const nextPolicy = await after.requestsForAccount(stamp, () => true), next = nextPolicy.reserve(gmail);
      await next.dispatch(async () => new Response(null, { status: 429 }));
      expect(await next.headers429(reviewEvidence(5000))).toBe("committed"); next.release(); await after.drain(5000);
      expect((await reviewLedger(reopened)).rows.find((r) => r.owner === verifiedMailbox)).toMatchObject({ minimum: "7000", sample: 2000, position: 1 });
      expect(samples).toBe(1);
    });

    it("F1 binding still fences old clock repair", async () => {
      const f = await storeFixture(mode), actual = f.store.providerCooldown;
      const a = await account(f.store, 1), stamp = (await f.store.accounts.stamp(a.id))!;
      expect(await actual.bind(stamp, verifiedMailbox)).toBe(true);
      let wall = 1000, elapsed = 10, samples = 0;
      const gate = await ProviderCooldown.open(actual, { wallNow: () => wall, elapsedNow: () => elapsed, random: () => { samples++; return 0.5; } });
      cleanup.gate(`review/F1/${mode}/clock-fence`, gate);
      const policy = await gate.requestsForAccount(stamp, () => true), ticket = policy.reserve(gmail);
      await ticket.dispatch(async () => new Response(null, { status: 429 }));
      expect(await ticket.headers429(reviewEvidence(1000))).toBe("committed"); ticket.release(); await gate.drain(5000);
      wall = 999; elapsed = 11;
      expect(gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "hold", reason: "clock" }); await gate.drain(5000);
      const obsolete = gate.revisionFor(verifiedMailbox, "gmail-api")!;
      expect(await actual.bind(stamp, verifiedMailbox)).toBe(true);
      expect(await gate.refreshAfterBind()).toBe("confirmed");
      const stored = await actual.read(); wall = 2000; elapsed = 30;
      expect(gate.checkClock(verifiedMailbox, "gmail-api", obsolete)).toEqual({ kind: "hold", reason: "clock" });
      expect(await actual.read()).toBe(stored);
      const current = gate.revisionFor(verifiedMailbox, "gmail-api")!;
      expect(current).not.toBe(obsolete);
      expect(gate.checkClock(verifiedMailbox, "gmail-api", current)).toEqual({ kind: "at", atMs: 3000 }); await gate.drain(5000);
      wall = 4000; elapsed = 2030;
      expect(gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "ready" }); expect(samples).toBe(1);
    });

    it("F1 legacy phase ambiguity holds after reopen", async () => {
      const f = await storeFixture(mode), legacy = JSON.parse(rowLedger());
      delete legacy.rows[0]!.phaseRevision;
      const encoded = JSON.stringify(legacy);
      await f.store.settings.set("provider-cooldown:v1", encoded);
      const reopened = await f.reopen(); let samples = 0, calls = 0;
      const gate = await ProviderCooldown.open(reopened.providerCooldown, { wallNow, elapsedNow, random: () => { samples++; return 0.5; } });
      cleanup.gate(`review/F1/${mode}/legacy-closed`, gate);
      expect(gate.state(mailboxA, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
      expect(await responseOrRefusal(requestHttp(gate.requestsFor(mailboxA), gmail, async () => { calls++; return new Response(); }, wallNow))).toBeInstanceOf(ProviderCooldownError);
      expect(await gate.recoverStorage()).toBe("unconfirmed");
      expect(await reopened.settings.get("provider-cooldown:v1", null)).toBe(encoded);
      expect(samples).toBe(0); expect(calls).toBe(0);
    });

    it("F2 impossible pair fails closed after reopen", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1), stamp = (await f.store.accounts.stamp(a.id))!;
      expect(await f.store.providerCooldown.bind(stamp, verifiedMailbox)).toBe(true);
      const g = await ProviderCooldown.open(f.store.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate(`review/F2/${mode}/initial`, g);
      const p = await g.requestsForAccount(stamp, () => true), ticket = p.reserve(gmail);
      await ticket.dispatch(async () => new Response(null, { status: 429 }));
      expect(await ticket.headers429(reviewEvidence(1000))).toBe("committed"); ticket.release(); await g.drain(5000); await g.close();
      const ledger = await reviewLedger(f.store);
      expect(ledger.bindings[0]).toMatchObject({ emailDigest: verifiedMailbox, mailboxKey: verifiedMailbox });
      expect(ledger.rows.find((r) => r.owner === verifiedMailbox)?.minimum).toBe("3000");
      ledger.bindings[0]!.mailboxKey = mailboxB;
      await f.store.settings.set("provider-cooldown:v1", JSON.stringify(ledger));
      const reopened = await f.reopen();
      const gate = await ProviderCooldown.open(reopened.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate(`review/F2/${mode}/corrupt`, gate);
      let calls = 0;
      const result = await responseOrRefusal((async () => {
        const policy = await gate.requestsForAccount(stamp, () => true);
        return requestHttp(policy, gmail, async () => { calls++; return new Response(null, { status: 200 }); }, wallNow);
      })());
      expect(calls).toBe(0);
      expect(result).toBeInstanceOf(ProviderCooldownError);
      expect(gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
      const admission = await gate.admission((id) => id === a.id ? { ...stamp, kind: "gmail" } : undefined);
      expect(admission.blockAllGoogle).toBe(true); expect(admission.verifiedAccountIds).toEqual([]);
      await expect(reopened.providerCooldown.read()).rejects.toThrow();
    });

    it("F2 intact pair retains its own pause", async () => {
      const f = await storeFixture(mode), a = await account(f.store, 1), stamp = (await f.store.accounts.stamp(a.id))!;
      expect(await f.store.providerCooldown.bind(stamp, verifiedMailbox)).toBe(true);
      const g = await ProviderCooldown.open(f.store.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate(`review/F2/${mode}/valid-before`, g);
      const p = await g.requestsForAccount(stamp, () => true), ticket = p.reserve(gmail);
      await ticket.dispatch(async () => new Response(null, { status: 429 }));
      expect(await ticket.headers429(reviewEvidence(1000))).toBe("committed"); ticket.release(); await g.drain(5000); await g.close();
      const reopened = await f.reopen(), gate = await ProviderCooldown.open(reopened.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate(`review/F2/${mode}/valid-after`, gate);
      const policy = await gate.requestsForAccount(stamp, () => true); let calls = 0;
      const result = await responseOrRefusal(requestHttp(policy, gmail, async () => { calls++; return new Response(); }, wallNow));
      expect(result).toBeInstanceOf(ProviderCooldownError); expect(calls).toBe(0);
      expect(gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
      const admission = await gate.admission((id) => id === a.id ? { ...stamp, kind: "gmail" } : undefined);
      expect(admission.blockAllGoogle).toBe(false); expect(admission.verifiedAccountIds).toEqual([a.id]); expect(admission.blockedAccountIds).toEqual([a.id]);
    });

    it("F2 other verified scope and service remain live", async () => {
      const other = "77a8ca914405d79cd4e7477264c80077fad349a3d2fb9a5a24111e17d65b164b";
      const f = await storeFixture(mode), a = await account(f.store, 1), b = await account(f.store, 2);
      const sa = (await f.store.accounts.stamp(a.id))!, sb = (await f.store.accounts.stamp(b.id))!;
      expect(await f.store.providerCooldown.bind(sa, verifiedMailbox)).toBe(true); expect(await f.store.providerCooldown.bind(sb, other)).toBe(true);
      const g = await ProviderCooldown.open(f.store.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate(`review/F2/${mode}/other-before`, g);
      const aPolicy = await g.requestsForAccount(sa, () => true);
      await responseOrRefusal(requestHttp(aPolicy, gmail, async () => new Response(null, { status: 429 }), wallNow)); await g.drain(5000); await g.close();
      const reopened = await f.reopen(), gate = await ProviderCooldown.open(reopened.providerCooldown, { wallNow, elapsedNow, random: () => 0.5 });
      cleanup.gate(`review/F2/${mode}/other-after`, gate);
      const first = await gate.requestsForAccount(sa, () => true), second = await gate.requestsForAccount(sb, () => true), paths: string[] = [];
      expect((await requestHttp(second, gmail, async () => { paths.push("other"); return new Response(); }, wallNow)).status).toBe(200);
      expect((await requestHttp(first, userinfo, async () => { paths.push("userinfo"); return new Response(); }, wallNow)).status).toBe(200);
      expect(await responseOrRefusal(requestHttp(first, gmail, async () => { paths.push("blocked"); return new Response(); }, wallNow))).toBeInstanceOf(ProviderCooldownError);
      expect(paths).toEqual(["other", "userinfo"]);
    });
  });
}

async function r2BoundClock(mode: StoreMode, initialElapsed = 10) {
  const f = await storeFixture(mode), actual = f.store.providerCooldown;
  const a = await account(f.store, 1), stamp = (await f.store.accounts.stamp(a.id))!;
  expect(await actual.bind(stamp, verifiedMailbox)).toBe(true);
  let wall = 1000, elapsed = initialElapsed, samples = 0, calls = 0;
  const clock = { wallNow: () => wall, elapsedNow: () => elapsed, random: () => { samples++; return 0.5; } };
  const gate = await ProviderCooldown.open(actual, clock);
  cleanup.gate(`R2/${mode}/bound-clock`, gate);
  const requests = await gate.requestsForAccount(stamp, () => true), ticket = requests.reserve(gmail);
  await ticket.dispatch(async () => { calls++; return new Response(null, { status: 429 }); });
  expect(await ticket.headers429(reviewEvidence(1000))).toBe("committed"); ticket.release();
  expect(await gate.drain(5000)).toBe("drained");
  const original = (await reviewLedger(f.store)).rows.find((row) => row.owner === verifiedMailbox)!;
  expect(original).toMatchObject({ minimum: "3000", replay: "2000", sample: 2000, position: 1, hold: null });
  return { f, actual, stamp, gate, clock, original,
    time: (w: number, e: number) => { wall = w; elapsed = e; },
    samples: () => samples, calls: () => calls };
}
async function r2BoundRollback(mode: StoreMode, kind: "elapsed" | "wall" | "fractional" | "no-bind") {
  const f = await r2BoundClock(mode, kind === "fractional" ? 10.75 : 10);
  const obsolete = f.gate.revisionFor(verifiedMailbox, "gmail-api")!;
  if (kind !== "no-bind") expect(await f.actual.bind(f.stamp, verifiedMailbox)).toBe(true);
  f.time(kind === "wall" ? 999 : 1001, kind === "fractional" ? 10.5 : kind === "wall" ? 11 : 9);
  if (kind === "no-bind") {
    expect(f.gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
    expect(await f.gate.drain(5000)).toBe("drained");
    expect(await f.gate.recoverStorage()).toBe("confirmed");
  } else expect(await f.gate.refreshAfterBind()).toBe("confirmed");
  const held = (await reviewLedger(f.f.store)).rows.find((row) => row.owner === verifiedMailbox)!;
  expect(held.hold).toBe("clock");
  expect(held).toMatchObject({ minimum: "3000", replay: "2000", phaseRevision: f.original.phaseRevision, sample: 2000, position: 1, repair: null });
  expect(f.gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
  const requests = await f.gate.requestsForAccount(f.stamp, () => true);
  expect(await responseOrRefusal(requestHttp(requests, gmail, async () => { throw new Error("R2 held transport reached"); }, f.clock.wallNow))).toBeInstanceOf(ProviderCooldownError);
  expect(f.calls()).toBe(1); expect(f.samples()).toBe(1);
  await f.gate.close();
  const reopened = await f.f.reopen(), stored = await reopened.providerCooldown.read();
  const after = await ProviderCooldown.open(reopened.providerCooldown, f.clock);
  cleanup.gate(`R2/${mode}/${kind}/reopened`, after);
  expect(after.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
  f.time(4000, 100);
  expect(after.checkClock(verifiedMailbox, "gmail-api", obsolete)).toEqual({ kind: "hold", reason: "clock" });
  expect(await reopened.providerCooldown.read()).toBe(stored);
  const current = after.revisionFor(verifiedMailbox, "gmail-api")!;
  expect(current).not.toBe(obsolete);
  expect(after.checkClock(verifiedMailbox, "gmail-api", current)).toEqual({ kind: "at", atMs: 3000 });
  expect(await after.drain(5000)).toBe("drained");
  const repaired = await reopened.providerCooldown.read();
  f.time(4500, 600);
  expect(after.checkClock(verifiedMailbox, "gmail-api", current)).toEqual({ kind: "at", atMs: 3000 });
  expect(await reopened.providerCooldown.read()).toBe(repaired);
  f.time(5999, 2099); expect(after.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
  f.time(6000, 2100); expect(after.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "ready" });
  expect((await reviewLedger(reopened)).rows.find((row) => row.owner === verifiedMailbox)).toMatchObject({ minimum: "3000", replay: "2000", phaseRevision: f.original.phaseRevision, sample: 2000, position: 1, repair: current });
  expect(f.samples()).toBe(1); expect(f.calls()).toBe(1);
}

for (const mode of ["SQL", "IDB off", "IDB on"] as const) {
  describe(`R2 bind clock ${mode}`, () => {
    it("01 repeat bind preserves elapsed rollback evidence", async () => { await r2BoundRollback(mode, "elapsed"); });
    it("02 no bind detects the same elapsed rollback", async () => { await r2BoundRollback(mode, "no-bind"); });
    it("03 repeat bind preserves wall rollback evidence", async () => { await r2BoundRollback(mode, "wall"); });
    it("04 repeat bind preserves fractional raw rollback evidence", async () => { await r2BoundRollback(mode, "fractional"); });
    it("05 forward repeat bind preserves the original deadline", async () => {
      const f = await r2BoundClock(mode);
      expect(await f.actual.bind(f.stamp, verifiedMailbox)).toBe(true);
      f.time(2999, 2009);
      expect(await f.gate.refreshAfterBind()).toBe("confirmed");
      expect(f.gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
      f.time(3000, 2010);
      expect(f.gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "ready" });
      expect((await reviewLedger(f.f.store)).rows.find((row) => row.owner === verifiedMailbox)).toMatchObject({ minimum: "3000", replay: "2000", phaseRevision: f.original.phaseRevision, sample: 2000, position: 1, hold: null });
      expect(f.samples()).toBe(1); expect(f.calls()).toBe(1);
    });
    it("06 forward fractional bind preserves ceil floor boundary", async () => {
      const f = await r2BoundClock(mode, 10.75);
      expect(await f.actual.bind(f.stamp, verifiedMailbox)).toBe(true);
      f.time(2999, 2009.75);
      expect(await f.gate.refreshAfterBind()).toBe("confirmed");
      f.time(3000, 2010.75);
      expect(f.gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
      f.time(3000, 2011);
      expect(f.gate.state(verifiedMailbox, "gmail-api")).toEqual({ kind: "ready" });
      expect((await reviewLedger(f.f.store)).rows.find((row) => row.owner === verifiedMailbox)).toMatchObject({ minimum: "3000", replay: "2000", phaseRevision: f.original.phaseRevision, sample: 2000, position: 1, hold: null });
      expect(f.samples()).toBe(1); expect(f.calls()).toBe(1);
    });
  });

  describe(`R2 equal phase ${mode}`, () => {
    for (const conflict of ["sample", "position", "identical", "newer"] as const) {
      it(conflict === "sample" ? "01 conflicting sample refuses bind and preserves evidence" : conflict === "position" ? "02 conflicting position refuses bind and preserves evidence" : conflict === "identical" ? "03 identical phase binds and preserves lineage" : "04 newer phase binds and preserves its sample", async () => {
        const f = await storeFixture(mode), a = await account(f.store, 1), stamp = (await f.store.accounts.stamp(a.id))!;
        const ledger: ReviewLedger = JSON.parse(rowLedger());
        const installation = { ...ledger.rows[0]!, owner: "installation" };
        const mailbox = { ...installation, owner: verifiedMailbox, revision: conflict === "newer" ? "2" : "1", phaseRevision: conflict === "newer" ? "2" : "1", sample: conflict === "sample" || conflict === "newer" ? 5000 : 2000, position: conflict === "position" || conflict === "newer" ? 2 : 1 };
        ledger.revision = conflict === "newer" ? "2" : "1";
        for (const row of [installation, mailbox]) {
          const individual = JSON.stringify({ ...ledger, rows: [row] });
          await f.store.providerCooldown.update(() => ({ encoded: individual, result: undefined }));
          expect(await f.store.providerCooldown.read()).toBe(individual);
        }
        ledger.rows = [installation, mailbox];
        const encoded = JSON.stringify(ledger);
        await f.store.providerCooldown.update(() => ({ encoded, result: undefined }));
        let durableStore = f.store;
        if (conflict === "identical" || conflict === "newer") {
          expect(await f.store.providerCooldown.bind(stamp, verifiedMailbox)).toBe(true);
          const next = await reviewLedger(f.store);
          expect(next.rows.map((row) => ({ owner: row.owner, phase: row.phaseRevision, sample: row.sample, position: row.position, minimum: row.minimum, replay: row.replay }))).toEqual([
            { owner: "installation", phase: "1", sample: 2000, position: 1, minimum: "121000", replay: "120000" },
            { owner: verifiedMailbox, phase: conflict === "newer" ? "2" : "1", sample: conflict === "newer" ? 5000 : 2000, position: conflict === "newer" ? 2 : 1, minimum: "121000", replay: "120000" },
          ]);
          expect(next.bindings).toEqual([{ id: stamp.id, createdAt: stamp.createdAt, emailDigest: verifiedMailbox, mailboxKey: verifiedMailbox }]);
          const durable = await f.store.providerCooldown.read(), reopened = await f.reopen();
          expect(await reopened.providerCooldown.read()).toBe(durable);
          expect(await reopened.providerCooldown.bind(stamp, verifiedMailbox)).toBe(true);
          const after = await reviewLedger(reopened);
          expect(after.rows.map((row) => ({ phase: row.phaseRevision, sample: row.sample, position: row.position }))).toEqual([{ phase: "1", sample: 2000, position: 1 }, { phase: conflict === "newer" ? "2" : "1", sample: conflict === "newer" ? 5000 : 2000, position: conflict === "newer" ? 2 : 1 }]);
          durableStore = reopened;
        } else {
          await expect(f.store.providerCooldown.bind(stamp, verifiedMailbox)).rejects.toThrow(/^Private cooldown action failed$/);
          expect(await f.store.providerCooldown.read()).toBe(encoded);
          const reopened = await f.reopen();
          expect(await reopened.providerCooldown.read()).toBe(encoded);
          await expect(reopened.providerCooldown.bind(stamp, verifiedMailbox)).rejects.toThrow(/^Private cooldown action failed$/);
          expect(await reopened.providerCooldown.read()).toBe(encoded);
          const after = await reviewLedger(reopened);
          expect(after.bindings).toEqual([]);
          expect(after.rows).toEqual([installation, mailbox]);
          durableStore = reopened;
        }
        let samples = 0, transports = 0;
        const gate = await ProviderCooldown.open(durableStore.providerCooldown, { wallNow, elapsedNow, random: () => { samples++; return 0.5; } });
        cleanup.gate(`R2/${mode}/phase-${conflict}/reopened`, gate);
        expect(await responseOrRefusal((async () => {
          const requests = await gate.requestsForAccount(stamp, () => true);
          return requestHttp(requests, gmail, async () => { transports++; return new Response(); }, wallNow);
        })())).toBeInstanceOf(ProviderCooldownError);
        expect(samples).toBe(0); expect(transports).toBe(0);
      });
    }
  });
}
