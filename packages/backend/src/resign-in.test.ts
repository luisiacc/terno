/**
 * Plan 25 in the backend, with a scripted provider: an account whose sign-in was refused is asked
 * for no more than it must be (no poll, no probe, no knocking ops), says so at once, and a new sign-in
 * clears it at once, releases what waited and never lets a refusal of the old credentials undo it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, enqueueOp, sqlDb } from "@terno/db";
import { AWAITING_NETWORK } from "@terno/store";
import { ProviderAuthError, type MailProvider, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

interface Scripted extends MailProvider {
  syncs: number;
  /** logins of a saved-password recheck (plan 25) */
  verifies: number;
  /** push watchers started (each logs in with the saved password) */
  watches: number;
  executed: string[];
  /** the password this provider was created with (a sign-in re-creates it) */
  password: string | null;
  refuseSync: boolean;
  /** an op of this kind is refused (SMTP for "send") */
  refuseOps: Set<string>;
  /** while set, an op waits for it */
  opGate: Promise<void> | null;
  /** while set, a sync waits for it */
  syncGate: Promise<void> | null;
  /** plan 184: push's own login is refused (sync's session may still work) */
  refuseWatch: boolean;
  /** plan 184: a send goes through SMTP, then its Sent copy's IMAP login is refused */
  refuseCopy: boolean;
  /** while set, a server search waits for it */
  searchGate: Promise<void> | null;
}

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(o: { syncIntervalMs?: number; kinds?: ("imap" | "gmail")[] } = {}) {
  const providers = new Map<number, Scripted>();
  /** passwords the IMAP and SMTP sign-in check was asked about, and those it accepts */
  const verified: string[] = [];
  const accepts = new Set(["new-password"]);
  /** while set, a saved-password check waits for it */
  let verifyGate: Promise<void> | null = null;
  let clock = Date.now();
  /** what the next provider of an account starts with (a test sets it before a sign-in) */
  const script = new Map<number, Partial<Pick<Scripted, "refuseSync" | "refuseOps" | "refuseWatch">>>();
  const registry: ProviderRegistry = {
    create(ctx) {
      const p: Scripted = {
        syncs: 0,
        verifies: 0,
        watches: 0,
        executed: [],
        password: null,
        refuseSync: false,
        refuseOps: new Set(),
        opGate: null,
        syncGate: null,
        refuseWatch: false,
        refuseCopy: false,
        searchGate: null,
        ...script.get(ctx.account.id),
        async verify() { p.verifies++; },
        watch() {
          p.watches++;
          // push's login, refused: it stops and says so (the IMAP watcher's way)
          if (p.refuseWatch) queueMicrotask(() => ctx.refused?.(new ProviderAuthError("IMAP login failed: Invalid credentials")));
          return () => {};
        },
        async search() {
          const refuse = p.refuseSync;
          if (p.searchGate) await p.searchGate;
          if (refuse) throw new ProviderAuthError("IMAP login failed: Invalid credentials");
          return { hits: [], partial: false };
        },
        async sync() {
          p.syncs++;
          // what the server answers is decided as the pass starts (a gate only delays the answer)
          const refuse = p.refuseSync;
          if (p.syncGate) await p.syncGate;
          if (refuse) throw new ProviderAuthError("IMAP login failed: Invalid credentials");
        },
        async execute(op) {
          const refuse = p.refuseSync || p.refuseOps.has(op.kind);
          if (p.opGate) await p.opGate;
          p.executed.push(op.kind);
          if (refuse) throw new ProviderAuthError("SMTP authentication failed: 535");
          // SMTP took it; the copy's IMAP login didn't (the IMAP provider's appendCopy)
          if (op.kind === "send" && p.refuseCopy) ctx.refused?.(new ProviderAuthError("IMAP login failed: Invalid credentials"));
          if (op.kind === "send") return { providerMsgId: `sent-${op.id}` };
        },
        async close() {},
      };
      void ctx.getSecret("password").then((v) => (p.password = v), () => {});
      providers.set(ctx.account.id, p);
      return p;
    },
    async verifyImap(_config, password) {
      verified.push(password);
      if (verifyGate) await verifyGate;
      if (!accepts.has(password)) throw new ProviderAuthError("IMAP login failed: Invalid credentials");
    },
    async connectGmail() {
      throw new Error("not in tests");
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-signin-unit-"));
  const backend = new Backend({
    dbPath: join(dir, "t.db"),
    version: "t",
    cipher: plaintextCipher,
    providers: registry,
    autoSync: true,
    syncIntervalMs: o.syncIntervalMs ?? 3_600_000,
    connectivity: { delays: [150, 300, 600], settleMs: 30, offlineRetryMs: 60_000 },
    now: () => clock,
  });
  await backend.store.ready;
  const ids: number[] = [];
  for (const [i, kind] of (o.kinds ?? ["imap", "imap"]).entries()) {
    ids.push(createAccount(sqlDb(backend.store), { kind, email: `a${i}@example.com`, displayName: `A${i}`, color: "brown", providerConfig: {} }).id);
  }
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const db = () => sqlDb(backend.store);
  const state = (id: number) => JSON.parse(db().get<{ s: string }>("SELECT sync_state s FROM accounts WHERE id = ?", id)!.s) as { status: string; authRequired?: boolean; authScope?: string | null };
  const op = (accountId: number, kind: string) => enqueueOp(db(), { accountId, kind, target: {}, payload: kind === "send" ? {
    from: { name: "", email: "sender@example.com" }, to: [{ name: "", email: "recipient@example.com" }], cc: [], bcc: [],
    subject: "Hola", text: "Synthetic body", messageId: "synthetic@example.com", inReplyTo: null, references: [], providerThreadId: null,
  } : { subject: "Hola" } })!;
  const opRow = (id: string) => db().get<{ state: string; attempts: number }>("SELECT state, attempts FROM ops WHERE id = ?", id)!;
  /** a refusal the last session saw: kept across the quit, which protocol refused it unknown */
  const keptRefusal = (id: number) => db().run("UPDATE accounts SET sync_state = ? WHERE id = ?", JSON.stringify({ ...state(id), status: "error", lastError: "IMAP login failed: Invalid credentials", authRequired: true, authScope: null }), id);
  const advance = (ms: number) => void (clock += ms);
  const awaitNetwork = (id: string) => db().run("UPDATE ops SET next_attempt_at = ? WHERE id = ?", AWAITING_NETWORK, id);
  return { backend, client, providers, script, ids, state, op, opRow, verified, accepts, keptRefusal, advance, awaitNetwork, holdVerify: (gate: Promise<void> | null) => { verifyGate = gate; } };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("plan 25: an account that needs a sign-in", () => {
  it("the poll leaves it alone (no refused login every two minutes); a network change still tries it once", async () => {
    const t = await setup({ syncIntervalMs: 60 });
    const [refused, fine] = t.ids as [number, number];
    t.script.set(refused, { refuseSync: true });
    await t.backend.start();
    await expect.poll(() => t.state(refused)).toMatchObject({ status: "error", authRequired: true });
    const before = t.providers.get(refused)!.syncs;
    const others = t.providers.get(fine)!.syncs;
    await tick(500);
    // the other account was polled several times; this one wasn't asked again
    expect(t.providers.get(fine)!.syncs).toBeGreaterThan(others + 3);
    expect(t.providers.get(refused)!.syncs).toBe(before);
    t.backend.networkChanged(true, "network");
    await expect.poll(() => t.providers.get(refused)!.syncs).toBe(before + 1);
    await tick(300);
    expect(t.providers.get(refused)!.syncs).toBe(before + 1);
  });

  it("a refusal kept across a quit: a launch and a network change recheck the saved password with IMAP and SMTP; once accepted, Retry lifts it and what waited goes", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    t.keptRefusal(id);
    await t.backend.setSecret(`account:${id}:password`, "saved-password");
    const parked = t.op(id, "archive");
    await t.backend.start();
    // the launch tried it once (the whole sign-in check: which protocol refused is unknown); still refused
    await expect.poll(() => t.verified).toEqual(["saved-password"]);
    await t.backend.runWorker();
    expect(t.opRow(parked)).toEqual({ state: "queued", attempts: 0 });
    expect(t.state(id)).toMatchObject({ status: "error", authRequired: true, authScope: null });
    t.backend.networkChanged(true, "network");
    await expect.poll(() => t.verified).toHaveLength(2);
    expect(t.state(id)).toMatchObject({ authRequired: true });
    // the server takes it again (a lockout lifted): the user's Retry lifts the refusal as a sign-in would
    t.accepts.add("saved-password");
    await t.client.call("sync.now", { accountId: id, reason: "user" });
    await expect.poll(() => t.state(id)).toMatchObject({ status: "idle", authRequired: false, authScope: null, lastError: null });
    await expect.poll(() => t.opRow(parked).state).toBe("succeeded");
    await expect.poll(() => t.providers.get(id)?.syncs ?? 0).toBeGreaterThan(0);
    expect(t.verified).toHaveLength(3);
  });

  it("a network change: a server slow to answer one account's login holds up no other account's mail", async () => {
    const t = await setup();
    const [slow, other] = t.ids as [number, number];
    t.keptRefusal(slow);
    await t.backend.setSecret(`account:${slow}:password`, "saved-password");
    await t.backend.start();
    await expect.poll(() => t.verified).toEqual(["saved-password"]);
    const waiting = t.op(slow, "archive"), parked = t.op(other, "archive");
    t.awaitNetwork(waiting);
    t.awaitNetwork(parked);
    let answer!: () => void, synced!: () => void;
    t.holdVerify(new Promise<void>((resolve) => { answer = resolve; }));
    // a finished sync resumes its account's mail too: held, what goes can only be the network change's doing
    t.providers.get(other)!.syncGate = new Promise<void>((resolve) => { synced = resolve; });
    t.backend.networkChanged(true, "network");
    await expect.poll(() => t.verified).toHaveLength(2);
    await expect.poll(() => t.opRow(parked).state).toBe("succeeded");
    // its own order holds: looked at first, its mail then
    expect(t.opRow(waiting)).toEqual({ state: "queued", attempts: 0 });
    t.holdVerify(null);
    answer();
    synced();
    await expect.poll(async () => (await t.backend.store.ops.nextAttemptAt()) !== AWAITING_NETWORK).toBe(true);
    expect(t.state(slow)).toMatchObject({ authRequired: true });
  });

  it("downloading a message's body learns its state without reading any body", async () => {
    const t = await setup({ kinds: ["imap"] });
    const get = vi.spyOn(t.backend.store.threads, "get");
    await expect(t.backend.hydrateBody(1, 1)).resolves.toEqual({ changed: false });
    expect(get).toHaveBeenCalledWith(1, { bodyFormat: "parts" });
  });

  it("Codex review: a refusal kept across a quit: the launch's recheck is its only login (no watcher knocks); accepted, the account watches and syncs at once", async () => {
    const refused = await setup();
    const [id] = refused.ids as [number];
    refused.keptRefusal(id);
    await refused.backend.setSecret(`account:${id}:password`, "saved-password");
    await refused.backend.start();
    await expect.poll(() => refused.verified).toHaveLength(1);
    await tick(100);
    expect(refused.providers.get(id)?.watches ?? 0).toBe(0);
    expect(refused.providers.get(id)?.syncs ?? 0).toBe(0);

    const accepted = await setup();
    const [other] = accepted.ids as [number];
    accepted.keptRefusal(other);
    await accepted.backend.setSecret(`account:${other}:password`, "saved-password");
    accepted.accepts.add("saved-password");
    await accepted.backend.start();
    await expect.poll(() => accepted.state(other)).toMatchObject({ status: "idle", authRequired: false });
    await expect.poll(() => accepted.providers.get(other)?.syncs ?? 0).toBeGreaterThan(0);
    await expect.poll(() => accepted.providers.get(other)?.watches ?? 0).toBe(1);
  });

  it("a window's focus rechecks at most every ten minutes, Retry whenever asked; a Gmail refusal is a revoked grant, never rechecked", async () => {
    const t = await setup({ kinds: ["imap", "gmail"] });
    const [imap, gmail] = t.ids as [number, number];
    for (const id of t.ids) t.keptRefusal(id);
    await t.backend.setSecret(`account:${imap}:password`, "saved-password");
    await t.backend.start();
    await expect.poll(() => t.verified).toHaveLength(1);
    await t.client.call("sync.now", { reason: "focus" });
    await t.client.call("sync.now", { reason: "focus" });
    await tick(50);
    expect(t.verified).toHaveLength(1);
    t.advance(10 * 60_000);
    await t.client.call("sync.now", { reason: "focus" });
    await expect.poll(() => t.verified).toHaveLength(2);
    await t.client.call("sync.now", { reason: "user" });
    await expect.poll(() => t.verified).toHaveLength(3);
    await t.client.call("sync.now", { accountId: gmail, reason: "user" });
    await tick(50);
    expect(t.verified).toHaveLength(3);
    expect(t.providers.get(gmail)?.verifies ?? 0).toBe(0);
    expect(t.state(gmail)).toMatchObject({ authRequired: true });
    expect(t.state(imap)).toMatchObject({ authRequired: true });
  });

  it("a refusal IMAP made is rechecked by an IMAP login alone: Retry lifts it once the server takes the password", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    t.script.set(id, { refuseSync: true });
    await t.backend.start();
    await expect.poll(() => t.state(id).authRequired).toBe(true);
    const p = t.providers.get(id)!;
    const verifies = p.verifies;
    // still refused: the login fails and nothing changes
    p.verify = async () => { p.verifies++; throw new ProviderAuthError("IMAP login failed: Invalid credentials"); };
    await t.client.call("sync.now", { accountId: id, reason: "user" });
    await expect.poll(() => p.verifies).toBe(verifies + 1);
    expect(t.state(id)).toMatchObject({ status: "error", authRequired: true });
    // taken again
    p.verify = async () => void p.verifies++;
    p.refuseSync = false;
    await t.client.call("sync.now", { accountId: id, reason: "user" });
    await expect.poll(() => t.state(id)).toMatchObject({ status: "idle", authRequired: false, authScope: null });
    expect(p.verifies).toBe(verifies + 2);
    expect(t.verified).toEqual([]);
  });

  it("offline, a refused account gets no probe (Codex review #7), and Retry now (the network's) skips it", async () => {
    const t = await setup();
    const [refused, fine] = t.ids as [number, number];
    t.script.set(refused, { refuseSync: true });
    await t.backend.start();
    await expect.poll(() => t.state(refused).authRequired).toBe(true);
    await expect.poll(() => t.state(fine).status).toBe("idle");
    t.backend.networkChanged(false, "offline");
    const connectivity = (t.backend as unknown as { connectivity: { pending(id: number): boolean; retryNow(id: number | null, reason: "user"): number[] } }).connectivity;
    expect(connectivity.pending(refused)).toBe(false);
    expect(connectivity.pending(fine)).toBe(true);
    // (the backend's Retry now syncs what this returns; a healthy account's success while "offline" is then a
    // network change, which does try every account once: plan 20's rule, not a probe)
    expect(connectivity.retryNow(null, "user")).toEqual([fine]);
    expect(connectivity.retryNow(refused, "user")).toEqual([]);
  });

  it("an action refused for its sign-in parks (attempt given back) and marks the account; later ones don't knock", async () => {
    const t = await setup({ kinds: ["gmail"] });
    const [id] = t.ids as [number];
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    const p = t.providers.get(id)!;
    p.refuseOps.add("star");
    const events: { accounts: number; ops: { awaitingAuth?: true }[] } = { accounts: 0, ops: [] };
    t.client.on("accounts", () => void events.accounts++);
    t.client.on("op", (o) => void events.ops.push(o));
    const first = t.op(id, "star");
    await t.backend.runWorker();
    expect(t.opRow(first)).toEqual({ state: "queued", attempts: 0 });
    expect(t.state(id)).toMatchObject({ status: "error", authRequired: true, authScope: null });
    await expect.poll(() => events.ops.at(-1)?.awaitingAuth).toBe(true);
    expect((await t.client.call("ops.list", {})).find((o) => o.id === first)).toMatchObject({ awaitingAuth: true });
    // three more, of any kind: none reaches the provider
    const more = [t.op(id, "archive"), t.op(id, "send"), t.op(id, "markRead")];
    await t.backend.runWorker();
    expect(p.executed).toEqual(["star"]);
    for (const m of more) expect(t.opRow(m)).toEqual({ state: "queued", attempts: 0 });
    // a second refusal of the same account isn't announced again
    const accountEvents = events.accounts;
    await t.backend.runWorker();
    expect(events.accounts).toBe(accountEvents);
  });

  it("signing in again clears it before the sync runs, releases what waited, and the account syncs", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    t.script.set(id, { refuseSync: true });
    await t.backend.start();
    await expect.poll(() => t.state(id).authRequired).toBe(true);
    const parked = t.op(id, "archive");
    await t.backend.runWorker();
    expect(t.opRow(parked).state).toBe("queued");
    // a wrong password changes nothing
    await expect(t.client.call("accounts.reconnect", { id, password: "wrong" })).rejects.toThrow(/Invalid credentials/);
    expect(t.state(id).authRequired).toBe(true);
    // the right one: the next provider works; its first sync is held to read the state meanwhile
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.script.set(id, { refuseSync: false });
    const reconnected = t.client.call("accounts.reconnect", { id, password: "new-password" });
    await expect.poll(() => t.providers.get(id)?.password).toBe("new-password");
    t.providers.get(id)!.syncGate = gate;
    await reconnected;
    expect(t.state(id)).toMatchObject({ status: "idle", authRequired: false, authScope: null });
    await expect.poll(() => t.opRow(parked).state).toBe("succeeded");
    release();
    await expect.poll(() => t.state(id).status).toBe("idle");
  });

  it("Codex review #3: an action refused with the old credentials after the sign-in runs again on the new ones", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    const old = t.providers.get(id)!;
    old.refuseOps.add("archive");
    let release!: () => void;
    old.opGate = new Promise<void>((r) => (release = r));
    const op = t.op(id, "archive");
    void t.backend.runWorker();
    await expect.poll(() => t.opRow(op).state).toBe("running");
    // signed in again while the op still talks with the old password
    await t.client.call("accounts.reconnect", { id, password: "new-password" });
    expect(t.providers.get(id)).not.toBe(old);
    release();
    // the old refusal doesn't park it or mark the account: it ran again, on the new provider
    await expect.poll(() => t.opRow(op).state).toBe("succeeded");
    expect(t.providers.get(id)!.executed).toEqual(["archive"]);
    expect(t.state(id).authRequired).toBe(false);
  });

  it("Codex code review #1: a sign-in landing while an old refusal is being parked: the op still runs, the account stays signed in", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    t.script.set(id, { refuseOps: new Set(["send"]) });
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    // the sign-in completes (its resume runs) in the middle of the park
    const ops = t.backend.store.ops;
    const park = ops.awaitAuth.bind(ops);
    let once = true;
    ops.awaitAuth = async (...args) => {
      if (once) {
        once = false;
        t.script.set(id, {});
        await t.client.call("accounts.reconnect", { id, password: "new-password" });
      }
      return park(...args);
    };
    const send = t.op(id, "send");
    await t.backend.runWorker();
    await expect.poll(() => t.opRow(send).state).toBe("succeeded");
    expect(t.state(id)).toMatchObject({ authRequired: false, authScope: null });
  });

  it("Codex review #2: IMAP works and SMTP refuses: only sends wait, a sync doesn't clear it, the poll keeps syncing", async () => {
    const t = await setup({ syncIntervalMs: 60 });
    const [id] = t.ids as [number];
    t.script.set(id, { refuseOps: new Set(["send"]) });
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    const send = t.op(id, "send");
    await t.backend.runWorker();
    expect(t.opRow(send)).toEqual({ state: "queued", attempts: 0 });
    expect(t.state(id)).toMatchObject({ status: "idle", authRequired: true, authScope: "send" });
    const p = t.providers.get(id)!;
    const syncs = p.syncs;
    // the poll keeps syncing (incoming mail works) and a success doesn't release the send
    await expect.poll(() => p.syncs).toBeGreaterThan(syncs + 2);
    expect(t.state(id)).toMatchObject({ authRequired: true, authScope: "send" });
    // other actions run; another send waits without knocking
    const archive = t.op(id, "archive");
    const second = t.op(id, "send");
    await t.backend.runWorker();
    expect(t.opRow(archive).state).toBe("succeeded");
    expect(t.opRow(second)).toEqual({ state: "queued", attempts: 0 });
    expect(p.executed).toEqual(["send", "archive"]);
    // signing in again lets both sends go
    t.script.set(id, {});
    await t.client.call("accounts.reconnect", { id, password: "new-password" });
    await expect.poll(() => [t.opRow(send).state, t.opRow(second).state]).toEqual(["succeeded", "succeeded"]);
    expect(t.state(id)).toMatchObject({ authRequired: false, authScope: null });
  });

  it("a refused sync of the old credentials, landing after a renew, says nothing; the next pass decides", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    const p = t.providers.get(id)!;
    let release!: () => void;
    p.syncGate = new Promise<void>((r) => (release = r));
    p.refuseSync = true;
    const pass = t.backend.syncAccount(id);
    await expect.poll(() => p.syncs).toBe(2);
    // the web's renew path: new credentials without restarting the provider
    await t.backend.signedIn(id);
    p.syncGate = null;
    p.refuseSync = false;
    release();
    await pass;
    await expect.poll(() => p.syncs).toBe(3);
    await expect.poll(() => t.state(id)).toMatchObject({ status: "idle", authRequired: false });
  });
});

describe("plan 184: whichever call a refused sign-in comes out of, the account says so", () => {
  const search = (t: Awaited<ReturnType<typeof setup>>, id: number) => t.backend.runForAccount(id, (provider) => provider.search!({ queries: [{ terms: ["x"] }], before: Date.now(), limit: 10, signal: new AbortController().signal }));

  it("a server search refused: the account needs a sign-in before the search's caller hears of it", async () => {
    const t = await setup();
    const [id, other] = t.ids as [number, number];
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    t.providers.get(id)!.refuseSync = true;
    await expect(search(t, id)).rejects.toBeInstanceOf(ProviderAuthError);
    // IMAP refused it: IMAP taking the password again can lift it (a recheck), as a sync's refusal
    expect(t.state(id)).toMatchObject({ status: "error", authRequired: true, authScope: null });
    expect(t.state(other)).toMatchObject({ authRequired: false });
    // and what it holds: actions park without reaching the server
    const parked = t.op(id, "archive");
    await t.backend.runWorker();
    expect(t.opRow(parked)).toEqual({ state: "queued", attempts: 0 });
    expect(t.providers.get(id)!.executed).toEqual([]);
  });

  it("push's login refused while sync's session works: the account says so (no silent account without new mail)", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    t.script.set(id, { refuseWatch: true });
    await t.backend.start();
    await expect.poll(() => t.state(id)).toMatchObject({ status: "error", authRequired: true, authScope: null });
    expect(t.providers.get(id)!.watches).toBe(1);
  });

  it("a Sent copy's login refused after SMTP took the message: the account says so, the message is sent once", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    const p = t.providers.get(id)!;
    p.refuseCopy = true;
    const sent = t.op(id, "send");
    await t.backend.runWorker();
    expect(t.opRow(sent).state).toBe("succeeded");
    expect(t.state(id)).toMatchObject({ authRequired: true, authScope: null });
    await t.backend.runWorker();
    expect(p.executed).toEqual(["send"]);
  });

  it("a search refused with credentials a sign-in has since replaced says nothing", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    const p = t.providers.get(id)!;
    let release!: () => void;
    p.searchGate = new Promise<void>((r) => (release = r));
    p.refuseSync = true;
    const searching = search(t, id);
    await tick(20);
    // the renew path: new credentials, same provider
    await t.backend.signedIn(id);
    release();
    await expect(searching).rejects.toBeInstanceOf(ProviderAuthError);
    expect(t.state(id)).toMatchObject({ authRequired: false });
  });

  it("code review #1: a recheck lifting the refusal while the refused action is still being parked: the action goes", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    const p = t.providers.get(id)!;
    p.refuseOps.add("archive");
    const action = t.op(id, "archive");
    const park = t.backend.store.ops.awaitAuth.bind(t.backend.store.ops);
    vi.spyOn(t.backend.store.ops, "awaitAuth").mockImplementationOnce(async (...args) => {
      // the boundary marked it already; IMAP takes the saved password again (Retry) before this park lands
      expect(t.state(id)).toMatchObject({ authRequired: true });
      p.refuseOps.clear();
      // the sync the recheck starts doesn't finish (a slow or failing server): it can't be what lets the action go
      p.syncGate = new Promise<void>((r) => (release = r));
      await t.client.call("sync.now", { accountId: id, reason: "user" });
      await expect.poll(() => t.state(id).authRequired).toBe(false);
      return park(...args);
    });
    let release!: () => void;
    try {
      await t.backend.runWorker();
      await expect.poll(() => t.opRow(action).state).toBe("succeeded");
      expect(p.executed).toEqual(["archive", "archive"]);
    } finally { release?.(); }
  });

  it("an IMAP send refused by SMTP is only its sending, wherever it's reported", async () => {
    const t = await setup();
    const [id] = t.ids as [number];
    await t.backend.start();
    await expect.poll(() => t.state(id).status).toBe("idle");
    t.providers.get(id)!.refuseOps.add("send");
    t.op(id, "send");
    await t.backend.runWorker();
    expect(t.state(id)).toMatchObject({ authRequired: true, authScope: "send" });
  });
});
