/**
 * Plan 191 in the backend, with scripted providers: an agent's wait for new mail on one account checks only that
 * account, every few ms (as a focus does), and ends with what a pass inserts as live mail outside Spam.
 * (The wait alone is agent-mail-waits.test.ts; the timing, quick-checks.test.ts.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import { ProviderAuthError, type MailProvider, type ProviderRegistry, type SyncSink } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { msg } from "@terno/store/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { SYNC_INTERVAL_MS } from "./core";

interface Scripted extends MailProvider {
  passes: ("quick" | "full")[];
  /** what the next pass brings as live mail */
  next: IncomingMessage[];
  /** runs after the pass's ingest, in the same pass */
  after: ((sink: SyncSink) => Promise<void>) | null;
}

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const EVERY = 40;

async function setup(kinds: ("quick" | "push")[]) {
  const providers = new Map<number, Scripted>();
  const byEmail = new Map<string, "quick" | "push">();
  const registry: ProviderRegistry = {
    create(ctx) {
      const kind = byEmail.get(ctx.account.email)!;
      const p: Scripted = {
        passes: [],
        next: [],
        after: null,
        async verify() {},
        async sync(sink: SyncSink) {
          p.passes.push(sink.quick ? "quick" : "full");
          const live = p.next.splice(0);
          if (live.length) await sink.ingest(live, { live: true });
          const after = p.after;
          p.after = null;
          await after?.(sink);
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
  const dir = mkdtempSync(join(tmpdir(), "terno-agent-wait-"));
  const backend = new Backend({
    dbPath: join(dir, "t.db"),
    version: "t",
    cipher: plaintextCipher,
    providers: registry,
    autoSync: true,
    syncIntervalMs: 3_600_000,
    connectivity: { delays: [60_000], settleMs: 30, offlineRetryMs: 60_000 },
    quickChecks: { everyMs: EVERY, forMs: 400 },
  });
  await backend.store.ready;
  const ids = kinds.map((kind, i) => {
    byEmail.set(`a${i}@example.com`, kind);
    return createAccount(sqlDb(backend.store), { kind: "imap", email: `a${i}@example.com`, displayName: `A${i}`, color: "indigo", providerConfig: {} }).id;
  });
  const connect = (clientId: string, origin: "renderer" | "mcp") => {
    const [c, s] = createMemoryTransportPair();
    const disconnect = backend.connect(s, { clientId, origin });
    return { client: new RpcClient(c), disconnect };
  };
  const renderer = connect("r", "renderer");
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await backend.start();
  const state = (id: number) => JSON.parse(sqlDb(backend.store).get<{ s: string }>("SELECT sync_state s FROM accounts WHERE id = ?", id)!.s) as { status: string; lastSyncAt: number | null };
  await expect.poll(() => ids.every((id) => state(id).status === "idle" && state(id).lastSyncAt !== null)).toBe(true);
  await renderer.client.call("settings.update", { agents: { enabled: true, access: "read" } });
  const agent = connect("agent", "mcp");
  const quick = (id: number) => providers.get(id)!.passes.filter((p) => p === "quick").length;
  return { backend, providers, ids, renderer, agent, quick, state };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("plan 191: an agent waits for new mail on one account", () => {
  it("polls every 40 s unless told otherwise (the owner)", () => {
    expect(SYNC_INTERVAL_MS).toBe(40_000);
  });

  it("checks only that account, every few ms, and ends with the mail a pass brings", async () => {
    const t = await setup(["quick", "quick"]);
    const [a, b] = t.ids as [number, number];
    const wait = t.agent.client.call("sync.agentWait", { accountId: a, waitSeconds: 30 });
    await expect.poll(() => t.quick(a)).toBeGreaterThanOrEqual(2);
    expect(t.quick(b)).toBe(0);
    t.providers.get(a)!.next.push(msg({ accountId: a, subject: "Your code is 314159", date: Date.now() }));
    const r = await wait;
    expect(r.items.map((i) => i.subject)).toEqual(["Your code is 314159"]);
    expect(r.checks).toBe("quick");
    // the wait is over: no more checks, no timer
    const n = t.quick(a);
    await tick(4 * EVERY);
    expect(t.quick(a)).toBe(n);
    expect(t.backend.quickChecks.active).toBe(false);
  });

  it("waits past mail that doesn't match, and past mail a pass moves to Spam after inserting it", async () => {
    const t = await setup(["quick"]);
    const [a] = t.ids as [number];
    const p = t.providers.get(a)!;
    const wait = t.agent.client.call("sync.agentWait", { accountId: a, from: "github.com", waitSeconds: 30 });
    await expect.poll(() => t.quick(a)).toBeGreaterThanOrEqual(1);
    p.next.push(msg({ accountId: a, subject: "Newsletter", date: Date.now() }));
    // inserted clean, then the same pass learns it is spam (a later flag read): never reported
    const later = msg({ accountId: a, from: { name: "GitHub", email: "noreply@github.com" }, subject: "Spammy code", date: Date.now() });
    p.next.push(later);
    p.after = async (sink) => {
      const { id } = sqlDb(t.backend.store).get<{ id: number }>("SELECT id FROM messages WHERE provider_msg_id = ?", later.providerMsgId)!;
      await sink.updateFlags([{ messageId: id, flags: { isSpam: true, inInbox: false } }]);
    };
    await expect.poll(() => p.after).toBe(null);
    const at = t.quick(a);
    await expect.poll(() => t.quick(a)).toBeGreaterThan(at + 1);
    expect(t.backend.agentWaits.size).toBe(1);
    p.next.push(msg({ accountId: a, from: { name: "GitHub", email: "noreply@github.com" }, subject: "[GitHub] Your code", date: Date.now() }));
    expect((await wait).items.map((i) => i.subject)).toEqual(["[GitHub] Your code"]);
  });

  it("a push account isn't checked; it hears by push and says so", async () => {
    const t = await setup(["push"]);
    const [a] = t.ids as [number];
    const wait = t.agent.client.call("sync.agentWait", { accountId: a, waitSeconds: 5 });
    await tick(4 * EVERY);
    expect(t.providers.get(a)!.passes).toEqual(["full"]);
    // IDLE says something came: an ordinary pass, as push makes
    t.providers.get(a)!.next.push(msg({ accountId: a, subject: "Pushed", date: Date.now() }));
    void t.backend.syncAccount(a);
    const r = await wait;
    expect(r).toMatchObject({ checks: "push", items: [expect.objectContaining({ subject: "Pushed" })] });
  });

  it("the agent's connection going ends its wait and its checks", async () => {
    const t = await setup(["quick"]);
    const [a] = t.ids as [number];
    void t.agent.client.call("sync.agentWait", { accountId: a, waitSeconds: 30 }).catch(() => {});
    await expect.poll(() => t.quick(a)).toBeGreaterThanOrEqual(1);
    t.agent.disconnect();
    await expect.poll(() => t.backend.agentWaits.size).toBe(0);
    expect(t.backend.quickChecks.active).toBe(false);
  });

  it("an agent that went while its call was admitted leaves no wait behind (Codex critique #7)", async () => {
    const t = await setup(["quick"]);
    const [a] = t.ids as [number];
    // the call outlived its connection: its disconnect (which ends the client's waits) came while it was admitted
    const gone = { clientId: "gone", origin: "mcp" as const };
    await expect(t.backend.server.invoke("sync.agentWait", { accountId: a, waitSeconds: 30 }, gone)).rejects.toThrow("The agent's connection closed.");
    expect(t.backend.agentWaits.size).toBe(0);
    expect(t.backend.quickChecks.active).toBe(false);
  });

  it("is for agents only, and refuses an account that can't bring mail, in plain words", async () => {
    const t = await setup(["quick"]);
    const [a] = t.ids as [number];
    await expect(t.renderer.client.call("sync.agentWait", { accountId: a, waitSeconds: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(t.agent.client.call("sync.agentWait", { accountId: 999, waitSeconds: 5 })).rejects.toThrow("No account 999. list_accounts gives the ids.");
    // the server refused the account's login: it needs a sign-in
    t.providers.get(a)!.after = async () => {
      throw new ProviderAuthError("sign in");
    };
    await t.backend.syncAccount(a);
    await expect(t.agent.client.call("sync.agentWait", { accountId: a, waitSeconds: 5 })).rejects.toThrow(/sign in again/);
  });
});
