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
import { ProviderAuthError, type MailProvider, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

interface Scripted extends MailProvider {
  syncs: number;
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
}

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(o: { syncIntervalMs?: number; kinds?: ("imap" | "gmail")[] } = {}) {
  const providers = new Map<number, Scripted>();
  /** what the next provider of an account starts with (a test sets it before a sign-in) */
  const script = new Map<number, Partial<Pick<Scripted, "refuseSync" | "refuseOps">>>();
  const registry: ProviderRegistry = {
    create(ctx) {
      const p: Scripted = {
        syncs: 0,
        executed: [],
        password: null,
        refuseSync: false,
        refuseOps: new Set(),
        opGate: null,
        syncGate: null,
        ...script.get(ctx.account.id),
        async verify() {},
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
          if (op.kind === "send") return { providerMsgId: `sent-${op.id}` };
        },
        async close() {},
      };
      void ctx.getSecret("password").then((v) => (p.password = v), () => {});
      providers.set(ctx.account.id, p);
      return p;
    },
    async verifyImap(_config, password) {
      if (password !== "new-password") throw new ProviderAuthError("IMAP login failed: Invalid credentials");
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
  });
  const ids: number[] = [];
  for (const [i, kind] of (o.kinds ?? ["imap", "imap"]).entries()) {
    ids.push(createAccount(sqlDb(backend.store), { kind, email: `a${i}@example.com`, displayName: `A${i}`, color: "indigo", providerConfig: {} }).id);
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
  const op = (accountId: number, kind: string) => enqueueOp(db(), { accountId, kind, target: {}, payload: { subject: "Hola" } })!;
  const opRow = (id: string) => db().get<{ state: string; attempts: number }>("SELECT state, attempts FROM ops WHERE id = ?", id)!;
  return { backend, client, providers, script, ids, state, op, opRow };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("plan 25: an account that needs a sign-in", () => {
  it("the poll leaves it alone (no refused login every two minutes); a network change still tries it once", async () => {
    const t = setup({ syncIntervalMs: 60 });
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

  it("offline, a refused account gets no probe (Codex review #7), and Retry now (the network's) skips it", async () => {
    const t = setup();
    const [refused, fine] = t.ids as [number, number];
    t.script.set(refused, { refuseSync: true });
    await t.backend.start();
    await expect.poll(() => t.state(refused).authRequired).toBe(true);
    await expect.poll(() => t.state(fine).status).toBe("idle");
    t.backend.networkChanged(false, "offline");
    const connectivity = (t.backend as unknown as { connectivity: { pending(id: number): boolean } }).connectivity;
    expect(connectivity.pending(refused)).toBe(false);
    expect(connectivity.pending(fine)).toBe(true);
    const syncs = t.providers.get(refused)!.syncs;
    await t.backend.retryNow(null, "user");
    await tick(50);
    expect(t.providers.get(refused)!.syncs).toBe(syncs);
  });

  it("an action refused for its sign-in parks (attempt given back) and marks the account; later ones don't knock", async () => {
    const t = setup({ kinds: ["gmail"] });
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
    const t = setup();
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
    const t = setup();
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
    const t = setup();
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
    const t = setup({ syncIntervalMs: 60 });
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
    const t = setup();
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
