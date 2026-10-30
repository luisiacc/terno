import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { ProviderAuthError, type MailProvider, type ProviderContext, type ProviderRegistry, type SyncSink } from "@terno/mail";
import { createGmailApiProvider } from "@terno/mail/portable";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
interface Scripted extends MailProvider {
  ctx: ProviderContext;
  sink: SyncSink;
  syncs: number;
  closes: number;
  watches: number;
  push: () => void;
  run: (sink: SyncSink) => Promise<void>;
}
async function setup(kind: "SQL" | "IndexedDB", accountKind: "imap" | "gmail" = "imap", autoSync = false) {
  const instances: Scripted[] = [];
  const gates: ReturnType<typeof gate>[] = [];
  const registry: ProviderRegistry = {
    create(ctx) {
      const p: Scripted = {
        ctx, sink: undefined as unknown as SyncSink, syncs: 0, closes: 0, watches: 0,
        push() {}, async run() {}, async verify() {}, async execute() {},
        async sync(sink) { p.sink = sink; p.syncs++; await p.run(sink); },
        watch(push) { p.push = push; p.watches++; return () => { p.watches--; }; },
        async close() { p.closes++; },
      };
      instances.push(p);
      return p;
    },
    async verifyImap() {},
    async connectGmail() { throw new Error("unused synthetic Gmail flow"); },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-account-lifecycle-"));
  const platform = { uuid: () => crypto.randomUUID(), yield: turn };
  const store = kind === "IndexedDB" ? await IdbMailStore.open({ name: "synthetic-lifecycle", factory: new IDBFactory(), platform }) : undefined;
  const backend = new Backend({ dbPath: join(dir, "test.db"), store, platform: store ? platform : undefined, version: "test", providers: registry, cipher: plaintextCipher, autoSync, iconTransport: null, openExternal: async () => {} });
  const ids: number[] = [];
  for (const name of ["first", "sibling"]) ids.push((await backend.store.accounts.create({ kind: accountKind, email: `${name}@example.test`, displayName: name, color: "indigo", providerConfig: { senderName: name }, now: 1 })).account.id);
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "lifecycle", origin: "renderer" });
  const client = new RpcClient(c);
  cleanup.push(async () => { for (const g of gates) g.release(); client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  return {
    backend, client, ids, instances, registry,
    gate() { const g = gate(); gates.push(g); return g; },
    async start(id = ids[0]!) {
      backend.startAccount((await backend.store.accounts.get(id))!);
      await expect.poll(() => instances.find((p) => p.ctx.account.id === id)?.syncs).toBe(1);
      await expect.poll(async () => (await backend.store.accounts.get(id))?.syncState.status).toBe("idle");
      await turn();
      return instances.find((p) => p.ctx.account.id === id)!;
    },
  };
}
function incoming(accountId: number): IncomingMessage {
  return { accountId, providerMsgId: "late", providerThreadId: null, rfcMessageId: "late@example.test", inReplyTo: null, references: [], from: { name: "Synthetic", email: "sender@example.test" }, to: [], cc: [], bcc: [], subject: "Late mail", date: 1, snippet: "", bodyText: "Synthetic", bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 9 };
}

describe.each(["SQL", "IndexedDB"] as const)("%s account lifetime: X06 / S16 / S28", (kind) => {
  it("a stale offline snapshot cannot retain a lifetime after successful account removal", async () => {
    const t = await setup(kind, "imap", true);
    await t.start();
    await t.start(t.ids[1]);
    const captured = t.gate(), blocked = t.gate(), announced = t.gate();
    const list = t.backend.store.accounts.list.bind(t.backend.store.accounts);
    const snapshot = vi.spyOn(t.backend.store.accounts, "list").mockImplementationOnce(async () => {
      const accounts = await list();
      captured.release();
      await blocked.promise;
      return accounts;
    });
    t.backend.networkChanged(false, "offline");
    await captured.promise;
    await t.client.call("accounts.remove", { id: t.ids[0]! });
    const emit = t.backend.emitAccounts.bind(t.backend);
    const emitted = vi.spyOn(t.backend, "emitAccounts").mockImplementationOnce(async () => {
      await emit();
      announced.release();
    });
    blocked.release();
    await announced.promise;
    snapshot.mockRestore();
    emitted.mockRestore();
    expect(await t.backend.store.accounts.get(t.ids[0]!)).toBeNull();
    const lifetimes = (t.backend as unknown as { lifetimes: Map<number, unknown> }).lifetimes;
    expect(lifetimes.has(t.ids[0]!)).toBe(false);
    expect(lifetimes.size).toBe(1);
    expect((await t.backend.store.accounts.get(t.ids[1]!))?.syncState.status).toBe("offline");
  });

  it("closes and cancels a blocked sync before waiting, discards push's trailing pass, and leaves its sibling working", async () => {
    const t = await setup(kind);
    const p = await t.start();
    const sibling = await t.start(t.ids[1]);
    const blocked = t.gate();
    p.run = async () => blocked.promise;
    const syncing = t.backend.syncAccount(t.ids[0]!);
    await expect.poll(() => p.syncs).toBe(2);
    p.push();
    const removing = t.client.call("accounts.remove", { id: t.ids[0]! });
    await turn(); await turn();
    const closedBeforeRelease = p.closes;
    const abortedBeforeRelease = p.sink.signal.aborted;
    blocked.release();
    await removing; await syncing; await turn();
    expect(closedBeforeRelease).toBe(1);
    expect(abortedBeforeRelease).toBe(true);
    expect(p.syncs).toBe(2);
    expect(p.watches).toBe(0);
    expect((await t.client.call("app.bootstrap", {})).accounts).toHaveLength(1);
    await t.backend.syncAccount(t.ids[1]!);
    expect(sibling.syncs).toBe(2);
    expect(sibling.sink.signal.aborted).toBe(false);
  });

  it("late provider callbacks cannot write mail, cursor, credentials or auth state after RPC removal", async () => {
    const t = await setup(kind);
    const p = await t.start();
    await t.client.call("accounts.remove", { id: t.ids[0]! });
    const ingest = vi.spyOn(t.backend.store.sync, "ingest");
    const cursor = vi.spyOn(t.backend.store.accounts, "setCursor");
    const auth = vi.spyOn(t.backend.store.accounts, "setSyncState");
    await Promise.allSettled([
      p.sink.ingest([incoming(t.ids[0]!)]),
      p.ctx.saveCursor({ stale: true }),
      p.ctx.setSecret("password", "synthetic-stale"),
      p.sink.setSyncState({ authRequired: true, status: "error" }),
    ]);
    expect(ingest).not.toHaveBeenCalled();
    expect(cursor).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(await t.backend.getSecret(`account:${t.ids[0]}:password`)).toBeNull();
    expect(await t.backend.store.accounts.get(t.ids[0]!)).toBeNull();
    ingest.mockRestore(); cursor.mockRestore(); auth.mockRestore();
  });

  it("a verified reconnect gets a fresh generation while late old completion cannot overwrite it", async () => {
    const t = await setup(kind);
    const old = await t.start();
    const blocked = t.gate();
    old.run = async () => { await blocked.promise; throw new ProviderAuthError("synthetic old refusal"); };
    const syncing = t.backend.syncAccount(t.ids[0]!);
    await expect.poll(() => old.syncs).toBe(2);
    let reconnected = false;
    const reconnect = t.client.call("accounts.reconnect", { id: t.ids[0]!, password: "synthetic-new" }).then((account) => { reconnected = true; return account; });
    await turn(); await turn(); await turn();
    const completedBeforeOldNetwork = await expect.poll(() => reconnected, { timeout: 1000 }).toBe(true).then(() => true, () => false);
    blocked.release();
    await reconnect; await syncing; await turn();
    const fresh = t.instances.filter((p) => p.ctx.account.id === t.ids[0]).at(-1)!;
    await fresh.ctx.saveCursor({ fresh: true });
    await Promise.allSettled([old.ctx.saveCursor({ stale: true }), old.ctx.setSecret("password", "synthetic-old"), old.sink.setSyncState({ authRequired: true, status: "error" })]);
    expect(completedBeforeOldNetwork).toBe(true);
    expect(fresh).not.toBe(old);
    expect(fresh.sink.signal.aborted).toBe(false);
    expect((await t.backend.store.accounts.config<{ cursor: unknown }>(t.ids[0]!))?.config.cursor).toEqual({ fresh: true });
    expect(await t.backend.getSecret(`account:${t.ids[0]}:password`)).toBe("synthetic-new");
    expect((await t.backend.store.accounts.get(t.ids[0]!))?.syncState.authRequired).toBe(false);
  });

  it("removal fences provider construction already waiting on account configuration", async () => {
    const t = await setup(kind);
    const waiting = t.gate();
    const read = t.backend.store.accounts.config.bind(t.backend.store.accounts);
    const config = vi.spyOn(t.backend.store.accounts, "config").mockImplementationOnce(async (id) => { await waiting.promise; return read(id); });
    const creating = t.backend.provider(t.ids[0]!);
    await turn();
    let removed = false;
    const removing = t.client.call("accounts.remove", { id: t.ids[0]! }).then(() => { removed = true; });
    await turn(); await turn(); await turn();
    const completedBeforeCreation = await expect.poll(() => removed, { timeout: 1000 }).toBe(true).then(() => true, () => false);
    waiting.release();
    await creating; await removing;
    config.mockRestore();
    expect(completedBeforeCreation).toBe(true);
    expect(t.instances).toHaveLength(0);
  });

  it.each(["before transaction", "after commit"] as const)("row deletion joins ingestion held %s and preserves active store errors", async (boundary) => {
    const t = await setup(kind);
    const p = await t.start();
    const sibling = await t.start(t.ids[1]);
    await sibling.sink.ingest([{ ...incoming(t.ids[1]!), subject: "Sibling mail", bodyText: "Sibling body", isRead: true }]);
    const baseline = await t.backend.store.debug.snapshot();
    const siblingAccount = await t.backend.store.accounts.get(t.ids[1]!);
    const waiting = t.gate(), entered = t.gate();
    const events: string[] = [];
    const real = t.backend.store.sync.ingest.bind(t.backend.store.sync);
    const remove = t.backend.store.accounts.remove.bind(t.backend.store.accounts);
    const deletion = vi.spyOn(t.backend.store.accounts, "remove").mockImplementation(async (...args) => {
      events.push("delete");
      return remove(...args);
    });
    const ingest = vi.spyOn(t.backend.store.sync, "ingest").mockImplementationOnce(async (...args) => {
      try {
        if (boundary === "before transaction") {
          entered.release();
          await waiting.promise;
          try { return await real(...args); }
          catch (error) {
            // Observe before account deletion can hide an illicit insert through cascading cleanup.
            expect(await t.backend.store.debug.snapshot()).toEqual(baseline);
            expect(await t.backend.store.accounts.get(t.ids[0]!)).not.toBeNull();
            throw error;
          }
        }
        const result = await real(...args);
        expect(result.inserted).toHaveLength(1);
        const committed = await t.backend.store.debug.snapshot();
        expect(committed.messages.filter((m) => m.accountId === t.ids[0])).toEqual([
          expect.objectContaining({ id: result.inserted[0], providerMsgId: "late", subject: "Late mail", bodyText: "Synthetic", isRead: false }),
        ]);
        entered.release();
        await waiting.promise;
        return result;
      } finally { events.push("terminal"); }
    });
    const writing = p.sink.ingest([incoming(t.ids[0]!)]);
    const written = Promise.allSettled([writing]);
    let removing: Promise<void> | undefined;
    try {
      await Promise.race([entered.promise, writing.then(() => { throw new Error("Ingestion settled before boundary entry"); })]);
      removing = t.backend.dropAccount(t.ids[0]!, { remove: true }).then(() => t.backend.store.accounts.remove(t.ids[0]!));
      expect(p.sink.signal.aborted).toBe(true);
      await turn(); await turn();
      expect(deletion).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(await t.backend.store.accounts.get(t.ids[0]!)).not.toBeNull();
      waiting.release();
      const [outcome] = await written;
      await removing;
      if (boundary === "before transaction") {
        expect(outcome?.status).toBe("rejected");
        if (outcome?.status === "rejected") expect(outcome.reason).toBe(p.sink.signal.reason);
      } else expect(outcome?.status).toBe("fulfilled");
      expect(events).toEqual(["terminal", "delete"]);
      expect(await t.backend.store.accounts.get(t.ids[0]!)).toBeNull();
      expect(await t.backend.store.debug.snapshot()).toEqual({ ...baseline, accounts: baseline.accounts.filter((a) => a.id !== t.ids[0]) });
      expect(await t.backend.store.accounts.get(t.ids[1]!)).toEqual(siblingAccount);
    } finally {
      waiting.release();
      await Promise.allSettled([writing, ...(removing ? [removing] : [])]);
      ingest.mockRestore();
      deletion.mockRestore();
    }
    const failure = new Error("synthetic durable failure");
    const broken = vi.spyOn(t.backend.store.sync, "ingest").mockRejectedValueOnce(failure);
    try { await expect(sibling.sink.ingest([incoming(t.ids[1]!)])).rejects.toBe(failure); }
    finally { broken.mockRestore(); }

    // A different AbortError is a store failure, even when it looks exactly like retirement.
    const failed = t.gate(), fail = t.gate();
    const distinctAbort = new DOMException("Account closed", "AbortError");
    const pendingFailure = vi.spyOn(t.backend.store.sync, "ingest").mockImplementationOnce(async () => {
      failed.release(); await fail.promise; throw distinctAbort;
    });
    const failing = sibling.sink.ingest([incoming(t.ids[1]!)]);
    const failures = Promise.allSettled([failing]);
    let dropping: Promise<void> | undefined;
    try {
      await failed.promise;
      expect(sibling.sink.signal.aborted).toBe(false);
      dropping = t.backend.dropAccount(t.ids[1]!, { remove: true });
      const dropped = Promise.allSettled([dropping]);
      expect(distinctAbort).not.toBe(sibling.sink.signal.reason);
      fail.release();
      for (const outcome of [...await failures, ...await dropped]) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason).toBe(distinctAbort);
      }
      expect(await t.backend.store.accounts.get(t.ids[1]!)).toEqual(siblingAccount);
      expect(await t.backend.store.debug.snapshot()).toEqual({ ...baseline, accounts: baseline.accounts.filter((a) => a.id !== t.ids[0]) });
    } finally {
      fail.release();
      await Promise.allSettled([failing, ...(dropping ? [dropping] : [])]);
      pendingFailure.mockRestore();
    }
  });

  it("removal does not wait for an uncooperative provider close", async () => {
    const t = await setup(kind);
    const p = await t.start();
    const closing = t.gate();
    p.close = async () => { p.closes++; await closing.promise; };
    let removed = false;
    const removing = t.client.call("accounts.remove", { id: t.ids[0]! }).then(() => { removed = true; });
    await turn(); await turn(); await turn();
    const completedBeforeClose = await expect.poll(() => removed, { timeout: 1000 }).toBe(true).then(() => true, () => false);
    closing.release();
    await removing;
    expect(completedBeforeClose).toBe(true);
    expect(p.closes).toBe(1);
  });

  it("stale location writes never reach either the removed mailbox or its replacement", async () => {
    const t = await setup(kind);
    const p = await t.start();
    const locations = t.backend.store.providerStore(t.ids[0]!).locations;
    const writes = [vi.spyOn(locations, "upsert"), vi.spyOn(locations, "remove"), vi.spyOn(locations, "setFlags"), vi.spyOn(locations, "resetMailbox")];
    await t.client.call("accounts.reconnect", { id: t.ids[0]!, password: "synthetic-new" });
    await Promise.allSettled([
      p.ctx.store.locations.upsert(9000, "INBOX", 1, 1, []),
      p.ctx.store.locations.remove(9000, "INBOX"),
      p.ctx.store.locations.setFlags(9000, "INBOX", "[]"),
      p.ctx.store.locations.resetMailbox("INBOX"),
    ]);
    for (const write of writes) { expect(write).not.toHaveBeenCalled(); write.mockRestore(); }
  });

  it("a send accepted after reconnect is durably settled once, despite its old provider lifetime", async () => {
    const t = await setup(kind);
    const p = await t.start();
    const submitted = t.gate();
    const answer = t.gate();
    let calls = 0;
    p.execute = async () => { calls++; submitted.release(); await answer.promise; return { providerMsgId: "accepted-once" }; };
    const queued = await t.client.call("compose.send", { accountId: t.ids[0]!, to: [{ name: "", email: "receiver@example.test" }], subject: "once", bodyText: "synthetic" });
    const worker = t.backend.runWorker();
    await submitted.promise;
    await t.client.call("accounts.reconnect", { id: t.ids[0]!, password: "synthetic-new" });
    answer.release();
    await worker;
    await t.backend.runWorker();
    expect(calls).toBe(1);
    expect((await t.client.call("ops.list", {})).find((op) => op.id === queued.opId)?.state).toBe("succeeded");
  });

  it.each(["MIME preparation", "request dispatch", "request dispatch late success"] as const)("Gmail cancellation after %s across reconnect preserves the dispatch boundary", async (phase) => {
    const entered = gate();
    const waiting = gate();
    const routes: string[] = [];
    const unexpected: string[] = [];
    let builds = 0;
    let sends = 0;
    let physicalSettled = false;
    let sendSignal: AbortSignal | undefined;
    const guardedFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const request = input as Request;
      const route = `${request.method} ${request.url}`;
      routes.push(route);
      if (route === "GET https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return Response.json({ emailAddress: "first@example.test", historyId: "1" });
      }
      if (route === "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        sends++;
        sendSignal = request.signal;
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-access");
        expect(await request.json()).toEqual({ raw: "c3ludGhldGljIHJhdw" });
        if (phase !== "MIME preparation") {
          entered.release();
          await waiting.promise;
          physicalSettled = true;
          if (phase === "request dispatch") throw new DOMException("Synthetic cancellation after dispatch", "AbortError");
        }
        physicalSettled = true;
        return Response.json({ id: "accepted-once", threadId: "accepted-thread" });
      }
      unexpected.push(route);
      throw new Error(`Unexpected synthetic transport route: ${route}`);
    });
    vi.stubGlobal("fetch", guardedFetch);
    cleanup.push(async () => { waiting.release(); vi.unstubAllGlobals(); });
    const t = await setup(kind, "gmail");
    cleanup.push(async () => { waiting.release(); });
    const managed = vi.spyOn(t.backend.net, "fetchGoogle");
    const contexts: ProviderContext[] = [];
    t.registry.create = (ctx) => {
      contexts.push(ctx);
      return {
        ...createGmailApiProvider(ctx, {
          tokens: { get: async () => "synthetic-access", invalidate() {} },
          buildRaw: async () => {
            if (++builds === 1 && phase === "MIME preparation") { entered.release(); await waiting.promise; }
            return new TextEncoder().encode("synthetic raw");
          },
        }),
        // The test drives real Gmail execution; no mailbox enumeration is needed (nor plan 68's label list).
        async sync() {},
        async folders() {},
      };
    };
    t.registry.connectGmail = async (o) => ({ email: o.loginHint!, name: "Synthetic", sub: "synthetic-subject", emailVerified: true, refreshToken: "synthetic-refresh", grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"] });
    await t.client.call("settings.update", { gmailClientId: "synthetic-client" });
    t.backend.startAccount((await t.backend.store.accounts.get(t.ids[0]!))!);
    await t.backend.syncAccount(t.ids[0]!);
    const queued = await t.client.call("compose.send", { accountId: t.ids[0]!, to: [{ name: "", email: "receiver@example.test" }], subject: "once", bodyText: "synthetic" });
    const old = contexts[0]!;
    const worker = t.backend.runWorker();
    await Promise.race([entered.promise, worker.then(() => { throw new Error("Worker settled before the expected cancellation boundary"); })]);
    expect(sends).toBe(phase === "MIME preparation" ? 0 : 1);
    expect(physicalSettled).toBe(false);
    old.google!.check({ endpoint: "gmail-api", purpose: "mail" });
    try {
      await t.client.call("accounts.reconnect", { id: t.ids[0]! });
      expect(() => old.google!.check({ endpoint: "gmail-api", purpose: "mail" })).toThrow();
      if (phase !== "MIME preparation") expect(sendSignal?.aborted).toBe(false);
      expect(await t.backend.getSecret(`account:${t.ids[0]}:refreshToken`)).toBe("synthetic-refresh");
    } finally {
      waiting.release();
    }
    await worker;
    await t.backend.runWorker();
    expect(sends).toBe(1);
    expect(physicalSettled).toBe(true);
    await expect.poll(() => t.backend.net.googlePending()).toBe(0);
    expect(unexpected).toEqual([]);
    expect(routes).toEqual(["GET https://gmail.googleapis.com/gmail/v1/users/me/profile", "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send"]);
    expect(managed).toHaveBeenCalledTimes(2);
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(builds).toBe(phase === "MIME preparation" ? 2 : 1);
    const op = (await t.client.call("ops.list", {})).find((item) => item.id === queued.opId);
    expect(op?.state).toBe(phase === "MIME preparation" ? "succeeded" : "unknown");
    expect(op?.awaitingAuth).not.toBe(true);
    await t.backend.runWorker();
    expect((await t.client.call("ops.list", {})).find((item) => item.id === queued.opId)).toEqual(op);
    expect(sends).toBe(1);
    managed.mockRestore();
  });

  it("an admitted store failure rejects both its caller and removal without deleting the account", async () => {
    const t = await setup(kind);
    const p = await t.start();
    const waiting = t.gate();
    const entered = t.gate();
    const ingest = vi.spyOn(t.backend.store.sync, "ingest").mockImplementationOnce(async () => { entered.release(); await waiting.promise; throw new Error("synthetic durable failure during removal"); });
    const writing = p.sink.ingest([incoming(t.ids[0]!)]);
    const writeOutcome = Promise.allSettled([writing]);
    await entered.promise;
    const removing = t.backend.dropAccount(t.ids[0]!).then(() => t.backend.store.accounts.remove(t.ids[0]!));
    const removeOutcome = Promise.allSettled([removing]);
    await turn(); await turn();
    waiting.release();
    expect((await writeOutcome)[0]).toMatchObject({ status: "rejected", reason: { message: "synthetic durable failure during removal" } });
    expect((await removeOutcome)[0]).toMatchObject({ status: "rejected", reason: { message: "synthetic durable failure during removal" } });
    expect(await t.backend.store.accounts.get(t.ids[0]!)).not.toBeNull();
    ingest.mockRestore();
  });


  it("closed-account queued work stays idle and resumes exactly once after reconnect", async () => {
    const t = await setup(kind);
    const p = await t.start();
    let calls = 0;
    p.execute = async () => { calls++; };
    const queued = await t.client.call("compose.send", { accountId: t.ids[0]!, to: [{ name: "", email: "receiver@example.test" }], subject: "wait", bodyText: "synthetic" });
    await t.backend.dropAccount(t.ids[0]!);
    const claim = t.backend.store.ops.claimReady.bind(t.backend.store.ops);
    let claims = 0;
    const bounded = vi.spyOn(t.backend.store.ops, "claimReady").mockImplementation(async (...args) => {
      if (++claims > 2) throw new Error("closed account repeatedly reclaimed queued work");
      return claim(...args);
    });
    const worker = await Promise.allSettled([t.backend.runWorker()]);
    bounded.mockRestore();
    expect(worker[0]?.status).toBe("fulfilled");
    expect(calls).toBe(0);
    expect((await t.client.call("ops.list", {})).find((op) => op.id === queued.opId)).toMatchObject({ state: "queued", awaitingAuth: true, attempts: 0 });
    await t.client.call("accounts.reconnect", { id: t.ids[0]!, password: "synthetic-new" });
    const fresh = t.instances.at(-1)!;
    fresh.execute = async () => { calls++; };
    await t.backend.runWorker();
    expect(calls).toBe(1);
    expect((await t.client.call("ops.list", {})).find((op) => op.id === queued.opId)?.state).toBe("succeeded");
  });


  it("an old finalizer and retained watch callback cannot consume a replacement's trailing sync", async () => {
    const t = await setup(kind);
    const old = await t.start();
    const oldGate = t.gate();
    old.run = async () => oldGate.promise;
    const oldPass = t.backend.syncAccount(t.ids[0]!);
    await expect.poll(() => old.syncs).toBe(2);
    await t.client.call("accounts.reconnect", { id: t.ids[0]!, password: "synthetic-new" });
    const fresh = t.instances.at(-1)!;
    await expect.poll(() => fresh.syncs).toBe(1);
    await expect.poll(async () => (await t.backend.store.accounts.get(t.ids[0]!))?.syncState.status).toBe("idle");
    await turn();
    const newGate = t.gate();
    fresh.run = async () => newGate.promise;
    const newPass = t.backend.syncAccount(t.ids[0]!);
    await expect.poll(() => fresh.syncs).toBe(2);
    fresh.push();
    oldGate.release();
    await oldPass;
    await turn();
    expect(fresh.syncs).toBe(2);
    fresh.run = async () => {};
    newGate.release();
    await newPass;
    await expect.poll(() => fresh.syncs).toBe(3);
    await turn();
    old.push();
    await turn(); await turn();
    expect(fresh.syncs).toBe(3);
  });

  it("repeated late sign-ins reject deleted accounts without retaining lifetimes", async () => {
    const t = await setup(kind);
    const lifetimes = (t.backend as unknown as { lifetimes: Map<number, unknown> }).lifetimes;
    for (let i = 0; i < 12; i++) {
      const account = (await t.backend.store.accounts.create({ kind: "imap", email: `removed${i}@example.test`, displayName: "Removed", color: "indigo", now: i + 2 })).account;
      await t.client.call("accounts.remove", { id: account.id });
      const install = vi.fn();
      await expect(t.backend.signedIn(account.id, install)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(install).not.toHaveBeenCalled();
      expect(await t.backend.store.accounts.get(account.id)).toBeNull();
      expect(lifetimes.has(account.id)).toBe(false);
    }
    expect(t.instances).toHaveLength(0);
  });

  it("a rejected sign-in preserves a deletion fence created during its account read", async () => {
    const t = await setup(kind);
    const waiting = t.gate();
    const entered = t.gate();
    const read = t.backend.store.accounts.get.bind(t.backend.store.accounts);
    const lookup = vi.spyOn(t.backend.store.accounts, "get").mockImplementationOnce(async (id) => { entered.release(); await waiting.promise; return read(id); });
    const pending = Promise.allSettled([t.backend.signedIn(t.ids[0]!)]);
    await entered.promise;
    await t.backend.dropAccount(t.ids[0]!, { remove: true });
    waiting.release();
    expect((await pending)[0]).toMatchObject({ status: "rejected", reason: { code: "NOT_FOUND" } });
    lookup.mockRestore();
    await expect(t.backend.signedIn(t.ids[0]!)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await t.backend.provider(t.ids[0]!)).toBeNull();
    expect(await t.backend.store.accounts.get(t.ids[0]!)).not.toBeNull();
  });

  it("a rejected sign-in cannot remove the newer generation that superseded its account read", async () => {
    const t = await setup(kind);
    const waiting = t.gate();
    const entered = t.gate();
    const read = t.backend.store.accounts.get.bind(t.backend.store.accounts);
    const lookup = vi.spyOn(t.backend.store.accounts, "get").mockImplementationOnce(async (id) => { entered.release(); await waiting.promise; return read(id); });
    const pending = Promise.allSettled([t.backend.signedIn(t.ids[0]!)]);
    await entered.promise;
    await t.backend.dropAccount(t.ids[0]!);
    await t.backend.signedIn(t.ids[0]!);
    const fresh = await t.start();
    waiting.release();
    expect((await pending)[0]).toMatchObject({ status: "rejected", reason: { code: "NOT_FOUND" } });
    lookup.mockRestore();
    await t.backend.syncAccount(t.ids[0]!);
    expect(fresh.syncs).toBe(2);
    expect(fresh.sink.signal.aborted).toBe(false);
    expect(await t.backend.provider(t.ids[0]!)).toBe(fresh);
  });

  it("removal owns its closed generation and cancels a pending verified sign-in", async () => {
    const t = await setup(kind);
    await t.start();
    const verified = t.gate();
    const waiting = t.gate();
    t.registry.verifyImap = async () => { verified.release(); await waiting.promise; };
    const reconnect = Promise.allSettled([t.client.call("accounts.reconnect", { id: t.ids[0]!, password: "synthetic-new" })]);
    await verified.promise;
    await t.backend.dropAccount(t.ids[0]!, { remove: true });
    await expect(t.backend.signedIn(t.ids[0]!)).rejects.toThrow();
    await expect(t.backend.dropAccount(t.ids[0]!)).rejects.toThrow();
    waiting.release();
    expect((await reconnect)[0]).toMatchObject({ status: "rejected" });
    expect(await t.backend.getSecret(`account:${t.ids[0]}:password`)).toBeNull();
    await t.backend.store.accounts.remove(t.ids[0]!);
    t.backend.accountRemoved(t.ids[0]!);
    expect(await t.backend.provider(t.ids[0]!)).toBeNull();
  });

});
