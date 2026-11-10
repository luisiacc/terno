/**
 * Plan 176 in the backend, with scripted providers: which accounts the minute after a focus checks, and how quietly.
 * (The timing policy alone is quick-checks.test.ts; Gmail's quick pass is gmail-quick-pass.test.ts.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import { ProviderError, type MailProvider, type ProviderRegistry, type SyncSink } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

interface Scripted extends MailProvider {
  /** each pass: quick or ordinary */
  passes: ("quick" | "full")[];
  failWith: (() => Error) | null;
  gate: Promise<void> | null;
}

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const EVERY = 40;
const FOR = 400;

/** `kinds`: per account, "quick" (a provider that takes quick checks, like Gmail) or "push" (one with watch, like IMAP) */
async function setup(kinds: ("quick" | "push")[], o: { autoSync?: boolean } = {}) {
  const providers = new Map<number, Scripted>();
  const byEmail = new Map<string, "quick" | "push">();
  const registry: ProviderRegistry = {
    create(ctx) {
      const kind = byEmail.get(ctx.account.email)!;
      const p: Scripted = {
        passes: [],
        failWith: null,
        gate: null,
        async verify() {},
        async sync(sink: SyncSink) {
          p.passes.push(sink.quick ? "quick" : "full");
          if (p.gate) await p.gate;
          if (p.failWith) throw p.failWith();
        },
        async execute() {},
        ...(kind === "push" ? { watch: () => () => {} } : { quickChecks: true as const }),
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
  const dir = mkdtempSync(join(tmpdir(), "terno-quick-"));
  const backend = new Backend({
    dbPath: join(dir, "t.db"),
    version: "t",
    cipher: plaintextCipher,
    providers: registry,
    autoSync: o.autoSync ?? true,
    syncIntervalMs: 3_600_000,
    connectivity: { delays: [60_000], settleMs: 30, offlineRetryMs: 60_000 },
    quickChecks: { everyMs: EVERY, forMs: FOR },
  });
  await backend.store.ready;
  const ids = kinds.map((kind, i) => {
    byEmail.set(`a${i}@example.com`, kind);
    return createAccount(sqlDb(backend.store), { kind: "imap", email: `a${i}@example.com`, displayName: `A${i}`, color: "indigo", providerConfig: {} }).id;
  });
  const [c, s] = createMemoryTransportPair();
  const disconnect = backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  let accountEvents = 0;
  client.on("accounts", () => void accountEvents++);
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const state = (id: number) => JSON.parse(sqlDb(backend.store).get<{ s: string }>("SELECT sync_state s FROM accounts WHERE id = ?", id)!.s) as { status: string; lastSyncAt: number | null; lastError: string | null };
  const quick = (id: number) => providers.get(id)!.passes.filter((p) => p === "quick").length;
  return { backend, client, providers, ids, state, quick, disconnect, accountEvents: () => accountEvents };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** started, with every account's first (ordinary) pass done */
async function started(kinds: ("quick" | "push")[]) {
  const t = await setup(kinds);
  await t.backend.start();
  await expect.poll(() => t.ids.every((id) => t.state(id).status === "idle" && t.state(id).lastSyncAt !== null)).toBe(true);
  return t;
}

describe("plan 176: quick checks after a focus", () => {
  it("checks accounts that take quick checks, quietly, every few ms for the minute, and leaves push accounts alone", async () => {
    const t = await started(["quick", "push"]);
    const [gmail, imap] = t.ids as [number, number];
    const synced = t.state(gmail).lastSyncAt;
    const events = t.accountEvents();
    await t.client.call("sync.focus", { focused: true });
    await expect.poll(() => t.quick(gmail)).toBeGreaterThanOrEqual(3);
    await tick(FOR + 3 * EVERY);
    const n = t.quick(gmail);
    expect(n).toBeLessThanOrEqual(FOR / EVERY + 1);
    // the minute is over: nothing more
    await tick(3 * EVERY);
    expect(t.quick(gmail)).toBe(n);
    expect(t.providers.get(imap)!.passes).toEqual(["full"]);
    // nothing new: no "syncing", no new "synced at", nothing published
    expect(t.state(gmail)).toMatchObject({ status: "idle", lastSyncAt: synced });
    expect(t.accountEvents()).toBe(events);
    expect(t.backend.quickChecks.active).toBe(false);
  });

  it("a blur stops the checks, and so does the window's client going", async () => {
    const t = await started(["quick"]);
    const [a] = t.ids as [number];
    await t.client.call("sync.focus", { focused: true });
    await expect.poll(() => t.quick(a)).toBeGreaterThanOrEqual(1);
    await t.client.call("sync.focus", { focused: false });
    const n = t.quick(a);
    await tick(4 * EVERY);
    expect(t.quick(a)).toBe(n);
    await t.client.call("sync.focus", { focused: true });
    await expect.poll(() => t.quick(a)).toBeGreaterThan(n);
    t.disconnect();
    await tick(EVERY);
    const m = t.quick(a);
    await tick(4 * EVERY);
    expect(t.quick(a)).toBe(m);
    expect(t.backend.quickChecks.active).toBe(false);
  });

  it("an account whose pass failed isn't checked again every few ms (retryable or not); offline nothing is", async () => {
    const t = await started(["quick", "quick"]);
    const [a, b] = t.ids as [number, number];
    t.providers.get(a)!.failWith = () => new ProviderError("refused for good", false);
    t.providers.get(b)!.failWith = () => ProviderError.network("connect ECONNREFUSED");
    await t.client.call("sync.focus", { focused: true });
    await expect.poll(() => [t.quick(a), t.quick(b)]).toEqual([1, 1]);
    await tick(4 * EVERY);
    expect([t.quick(a), t.quick(b)]).toEqual([1, 1]);
    expect(t.state(a).status).toBe("error");

    const u = await started(["quick"]);
    const [c] = u.ids as [number];
    u.backend.networkChanged(false, "offline");
    await u.client.call("sync.focus", { focused: true });
    await tick(4 * EVERY);
    expect(u.quick(c)).toBe(0);
  });

  it("a pass already running isn't followed by a quick one (it reads the same mail)", async () => {
    const t = await started(["quick"]);
    const [a] = t.ids as [number];
    const p = t.providers.get(a)!;
    let release!: () => void;
    p.gate = new Promise((r) => (release = r));
    const running = t.backend.syncAccount(a);
    await t.client.call("sync.focus", { focused: true });
    await tick(4 * EVERY);
    expect(p.passes).toEqual(["full", "full"]);
    p.gate = null;
    release();
    await running;
    // the minute goes on: quick checks resume after it
    await expect.poll(() => t.quick(a)).toBeGreaterThanOrEqual(1);
    expect(p.passes.slice(0, 2)).toEqual(["full", "full"]);
  });

  it("with autoSync off nothing starts", async () => {
    const t = await setup(["quick"], { autoSync: false });
    await t.backend.start();
    await t.client.call("sync.focus", { focused: true });
    await tick(4 * EVERY);
    expect(t.providers.size).toBe(0);
    expect(t.backend.quickChecks.active).toBe(false);
  });
});
