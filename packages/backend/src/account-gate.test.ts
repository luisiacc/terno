/**
 * Plan 211: the gate every worker asks (an account's "Use AI" and "Show in What matters"), how it hears of a switch (before
 * any window does), and ingest's live marks. Each worker's own seam is tested beside the worker.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, type AiOptions, type ProviderConfig } from "@terno/ai";
import type { Account } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg } from "@terno/store/conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountGate, type GateChange } from "./account-gate";
import { Backend, plaintextCipher } from "./backend";

const NOW = new Date(2026, 10, 17, 12).getTime();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const account = (id: number, over: Partial<Account> = {}) => ({ id, ai: true, feed: true, ...over });

describe("AccountGate", () => {
  it("answers from the accounts it was given; one it hasn't heard of is on, its default", () => {
    const gate = new AccountGate();
    expect([gate.ai(1), gate.feed(1), gate.reads(1)]).toEqual([true, true, true]);
    gate.set([account(1, { ai: false }), account(2, { feed: false }), account(3)]);
    expect([gate.ai(1), gate.feed(1), gate.reads(1)]).toEqual([false, true, false]);
    expect([gate.ai(2), gate.feed(2), gate.reads(2)]).toEqual([true, false, false]);
    expect([gate.ai(3), gate.feed(3), gate.reads(3)]).toEqual([true, true, true]);
    expect([gate.aiOff, gate.feedOff, [...gate.readsOff].sort()]).toEqual([[1], [2], [1, 2]]);
    // an account gone leaves it
    gate.set([account(3)]);
    expect([gate.aiOff, gate.feedOff, gate.readsOff]).toEqual([[], [], []]);
  });

  it("tells each switch that moved, once, with what it was; an account added on or one written unchanged moves nothing", () => {
    const gate = new AccountGate();
    const heard: GateChange[][] = [];
    gate.onChange((c) => void heard.push([...c]));
    gate.set([account(1), account(2)]);
    gate.put(account(1));
    expect(heard).toEqual([]);
    gate.put(account(1, { ai: false }));
    gate.set([account(1, { ai: false }), account(2, { feed: false })]);
    gate.put(account(7, { feed: false }));
    expect(heard).toEqual([
      [{ accountId: 1, before: { ai: true, feed: true }, after: { ai: false, feed: true } }],
      [{ accountId: 2, before: { ai: true, feed: true }, after: { ai: true, feed: false } }],
      [{ accountId: 7, before: { ai: true, feed: true }, after: { ai: true, feed: false } }],
    ]);
  });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-gate-"));
  const factory = (config: ProviderConfig, options: AiOptions) => createAi(config, { ...options, transport: { complete: () => new Promise(() => {}) } });
  const backend = new Backend({ dbPath: join(dir, "g.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => NOW });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const a = (await backend.store.accounts.create({ kind: "gmail", email: "a@terno.test", displayName: "A", color: "brown", now: 0 })).account;
  const b = (await backend.store.accounts.create({ kind: "imap", email: "b@terno.test", displayName: "B", color: "brown", now: 0 })).account;
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, client, a, b };
}

describe("the gate in the backend (plan 211)", () => {
  it("a switch reaches the workers before any window hears of the account, and turning it off records when", async () => {
    const { backend, client, a } = await setup();
    const order: string[] = [];
    backend.gate.onChange(() => void order.push("workers"));
    client.on("accounts", (accounts) => void order.push(`window:${accounts.find((x) => x.id === a.id)?.ai}`));
    expect(await client.call("accounts.update", { id: a.id, ai: false })).toMatchObject({ ai: false, feed: true });
    await vi.waitFor(() => expect(order).toContain("window:false"));
    expect(order[0]).toBe("workers");
    expect(backend.gate.ai(a.id)).toBe(false);
    expect((await backend.store.accounts.config<Record<string, unknown>>(a.id))!.config).toMatchObject({ ai: false, aiOffAt: NOW });
    await client.call("accounts.update", { id: a.id, ai: true, feed: false });
    expect([backend.gate.ai(a.id), backend.gate.feed(a.id)]).toEqual([true, false]);
  });

  it("ingest marks a live slice of an account the AI may not read for nothing, and its sent mail still closes your waits", async () => {
    const { backend, client, a, b } = await setup();
    await client.call("settings.update", { ai: { provider: "fake" }, summaries: { enabled: true }, dated: { enabled: true }, followups: { enabled: true } });
    const ingest = vi.spyOn(backend.store.sync, "ingest");
    const live = (accountId: number) => backend.ingestSliced([msg({ accountId, date: NOW - 1000 })], true, undefined, undefined, undefined, undefined, { accountId, pass: 1 }, true);
    const asked = () => ingest.mock.calls.at(-1)![1];
    await live(a.id);
    // (on by default: no moment it went on)
    expect(asked()).toMatchObject({ newMail: { summary: true }, liveSent: { wanted: true }, datedMail: { since: null } });
    await client.call("accounts.update", { id: a.id, ai: false });
    await live(a.id);
    expect(asked().newMail).toBeUndefined();
    expect(asked().datedMail).toBeUndefined();
    expect(asked().liveSent).toMatchObject({ wanted: false });
    // What matters off: its other AI features still run, the feed's reading doesn't
    await client.call("accounts.update", { id: b.id, feed: false });
    await live(b.id);
    expect(asked()).toMatchObject({ newMail: { summary: true }, liveSent: { wanted: false } });
    expect(asked().datedMail).toBeUndefined();
  });
});
