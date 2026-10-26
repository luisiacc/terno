/**
 * Plan 20 in the backend, with a scripted provider: what a network change, offline and the poll do
 * to providers, push and account state. (The real-socket version is network.int.test.ts.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import { ProviderAuthError, ProviderError, type MailProvider, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

interface Scripted extends MailProvider {
  up: boolean;
  failWith: (() => Error) | null;
  /** while set, a sync waits for it */
  gate: Promise<void> | null;
  syncs: number;
  resets: number;
  heartbeats: number;
  watching: number;
  watches: number;
}

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(o: { syncIntervalMs?: number; accounts?: number } = {}) {
  const providers = new Map<number, Scripted>();
  const registry: ProviderRegistry = {
    create(ctx) {
      const p: Scripted = {
        up: true,
        failWith: null,
        gate: null,
        syncs: 0,
        resets: 0,
        heartbeats: 0,
        watching: 0,
        watches: 0,
        async verify() {},
        async sync() {
          p.syncs++;
          if (p.gate) await p.gate;
          if (p.failWith) throw p.failWith();
          if (!p.up) throw ProviderError.network("IMAP: connect ECONNREFUSED");
        },
        async execute() {},
        watch() {
          p.watching++;
          p.watches++;
          return () => void p.watching--;
        },
        reset: () => void p.resets++,
        heartbeat: () => void p.heartbeats++,
        async close() {},
      };
      providers.set(ctx.account.id, p);
      return p;
    },
    async verifyImap() {},
    async connectGmail() {
      throw new Error("not in tests");
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-net-unit-"));
  let resets = 0;
  const backend = new Backend({
    dbPath: join(dir, "t.db"),
    version: "t",
    cipher: plaintextCipher,
    providers: registry,
    autoSync: true,
    syncIntervalMs: o.syncIntervalMs ?? 3_600_000,
    onNetworkReset: () => void resets++,
    connectivity: { delays: [150, 300, 600], settleMs: 30, offlineRetryMs: 60_000 },
  });
  const ids: number[] = [];
  for (let i = 0; i < (o.accounts ?? 2); i++) ids.push(createAccount(sqlDb(backend.store), { kind: "imap", email: `a${i}@example.com`, displayName: `A${i}`, color: "indigo", providerConfig: {} }).id);
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const state = (id: number) => JSON.parse(sqlDb(backend.store).get<{ s: string }>("SELECT sync_state s FROM accounts WHERE id = ?", id)!.s) as Record<string, unknown> & { status: string; connection?: { state: string; retryAt: number | null } | null };
  return { backend, client, providers, ids, state, hostResets: () => resets };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("plan 20: the backend and the network", () => {
  it("a network change resets every provider and the host's HTTP pool once, and syncs every account", async () => {
    const t = setup();
    await t.backend.start();
    await expect.poll(() => [...t.providers.values()].every((p) => p.syncs === 1)).toBe(true);
    t.backend.networkChanged(true, "network");
    t.backend.networkChanged(true, "wake");
    await expect.poll(() => [...t.providers.values()].map((p) => p.syncs)).toEqual([2, 2]);
    expect([...t.providers.values()].map((p) => p.resets)).toEqual([1, 1]);
    expect(t.hostResets()).toBe(1);
    // push wasn't restarted needlessly (the provider's reset reconnects it)
    expect([...t.providers.values()].map((p) => p.watches)).toEqual([1, 1]);
  });

  it("offline stops push and marks accounts offline (not one in error); online brings push back and syncs", async () => {
    const t = setup();
    await t.backend.start();
    await expect.poll(() => t.providers.size).toBe(2);
    await expect.poll(() => [...t.providers.values()].every((p) => p.syncs === 1)).toBe(true);
    const [a, b] = t.ids as [number, number];
    t.providers.get(b)!.failWith = () => new ProviderAuthError("sign in again");
    await t.backend.syncAccount(b);
    expect(t.state(b)).toMatchObject({ status: "error", authRequired: true });
    t.providers.get(a)!.up = false;
    t.providers.get(b)!.up = false;
    t.backend.networkChanged(false, "offline");
    await expect.poll(() => t.state(a).connection?.state).toBe("offline");
    expect(t.state(a)).toMatchObject({ status: "offline", lastErrorI18n: { key: "errors.network.offline" } });
    expect(t.state(b)).toMatchObject({ status: "error", authRequired: true });
    expect([...t.providers.values()].map((p) => p.watching)).toEqual([0, 0]);
    t.providers.get(a)!.up = true;
    t.providers.get(b)!.failWith = null;
    t.providers.get(b)!.up = true;
    t.backend.networkChanged(true, "online");
    await expect.poll(() => [t.state(a).status, t.state(b).status]).toEqual(["idle", "idle"]);
    expect([...t.providers.values()].map((p) => p.watching)).toEqual([1, 1]);
    expect(t.state(a).connection).toBeNull();
    // a success clears the sign-in flag
    expect(t.state(b).authRequired).toBe(false);
  });

  it("the first failure is quiet; the second shows offline with its retry; a retry reads reconnecting, then a success clears it", async () => {
    const t = setup({ accounts: 1 });
    await t.backend.start();
    const [a] = t.ids as [number];
    await expect.poll(() => t.state(a).status).toBe("idle");
    const p = t.providers.get(a)!;
    p.up = false;
    await t.backend.syncAccount(a);
    expect(t.state(a)).toMatchObject({ status: "syncing", connection: null });
    await expect.poll(() => t.state(a).connection?.state, { timeout: 3000, interval: 5 }).toBe("offline");
    expect(t.state(a).connection!.retryAt).toBeGreaterThan(Date.now());
    // seen while a retry runs: reconnecting, never a healthy flash in between
    let sawReconnecting = false;
    const seen = new Set<string>();
    const watcher = setInterval(() => {
      const c = t.state(a).connection;
      seen.add(c ? c.state : "null");
      if (c?.state === "reconnecting") sawReconnecting = true;
    }, 1);
    p.up = true;
    await expect.poll(() => t.state(a).status, { timeout: 3000, interval: 5 }).toBe("idle");
    clearInterval(watcher);
    expect(t.state(a).connection).toBeNull();
    expect(sawReconnecting || seen.has("offline")).toBe(true);
  });

  it("the poll leaves accounts in backoff alone, asks push for a heartbeat, and does nothing offline", async () => {
    const t = setup({ syncIntervalMs: 200, accounts: 2 });
    await t.backend.start();
    await expect.poll(() => t.providers.size).toBe(2);
    const [a, b] = t.ids as [number, number];
    await expect.poll(() => t.state(a).status).toBe("idle");
    t.providers.get(a)!.up = false;
    // a's failures back off (150, 300, 600 ms …); b is polled every 200 ms
    await t.backend.syncAccount(a);
    const before = { a: t.providers.get(a)!.syncs, b: t.providers.get(b)!.syncs };
    await tick(1000);
    const polled = { a: t.providers.get(a)!.syncs - before.a, b: t.providers.get(b)!.syncs - before.b };
    expect(polled.b).toBeGreaterThanOrEqual(3);
    expect(polled.a).toBeLessThanOrEqual(3);
    expect(t.providers.get(b)!.heartbeats).toBeGreaterThanOrEqual(3);
    t.providers.get(b)!.up = false;
    t.backend.networkChanged(false, "offline");
    await tick(50);
    const offline = { a: t.providers.get(a)!.syncs, b: t.providers.get(b)!.syncs, hb: t.providers.get(b)!.heartbeats };
    await tick(800);
    expect({ a: t.providers.get(a)!.syncs, b: t.providers.get(b)!.syncs, hb: t.providers.get(b)!.heartbeats }).toEqual(offline);
  });

  it("focus retries offline accounts at once (rate-limited); the user's retry starts the schedule over", async () => {
    const t = setup({ accounts: 1 });
    await t.backend.start();
    const [a] = t.ids as [number];
    await expect.poll(() => t.state(a).status).toBe("idle");
    const p = t.providers.get(a)!;
    p.up = false;
    await t.backend.syncAccount(a);
    await t.backend.syncAccount(a);
    const n = p.syncs;
    await t.client.call("sync.now", { reason: "focus" });
    await t.client.call("sync.now", { reason: "focus" });
    await expect.poll(() => p.syncs).toBe(n + 1);
    await t.client.call("sync.now", { accountId: a });
    await expect.poll(() => p.syncs).toBe(n + 2);
    expect(t.backend.connectivity.failures(a)).toBe(1);
  });

  it("an account removed during a network change gets nothing later (no sync, no reset after removal)", async () => {
    const t = setup({ accounts: 2 });
    await t.backend.start();
    await expect.poll(() => t.providers.size).toBe(2);
    const [a] = t.ids as [number];
    const p = t.providers.get(a)!;
    await expect.poll(() => p.syncs).toBe(1);
    t.backend.networkChanged(true, "network");
    await t.client.call("accounts.remove", { id: a });
    await tick(400);
    expect(p.syncs).toBe(1);
    expect(p.watching).toBe(0);
  });
  it("Codex review: a pass that works after the host went offline keeps the account's probe (it would never be tried again)", async () => {
    const t = setup({ accounts: 1 });
    await t.backend.start();
    const [a] = t.ids as [number];
    await expect.poll(() => t.state(a).status).toBe("idle");
    const p = t.providers.get(a)!;
    let release!: () => void;
    p.gate = new Promise((r) => (release = r));
    const pass = t.backend.syncAccount(a);
    await expect.poll(() => p.syncs).toBe(2);
    t.backend.networkChanged(false, "offline");
    p.gate = null;
    release();
    await pass;
    expect(t.state(a)).toMatchObject({ status: "offline", connection: { state: "offline" } });
    expect(t.state(a).connection!.retryAt).toBeGreaterThan(Date.now());
    expect(t.backend.connectivity.pending(a)).toBe(true);
  });
});

