import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingProcessingInput, IncomingProcessingResult, IncomingProcessor, ProviderContext, ProviderRegistry } from "@terno/mail/portable";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderStore } from "@terno/store";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const result: IncomingProcessingResult = { kind: "mime", message: { rfcMessageId: null, inReplyTo: null, references: [], from: { name: "", email: "" }, replyTo: [], to: [], cc: [], bcc: [], subject: "Synthetic", date: null, listId: null, bulk: false, text: "exact", html: null, attachments: [] } };
const input = () => ({ kind: "mime" as const, chunks: [new Uint8Array([1, 2, 3])] });

async function setup(processor: IncomingProcessor) {
  const dir = mkdtempSync(join(tmpdir(), "terno-processor-owner-"));
  const contexts = new Map<number, ProviderContext>();
  const providers: ProviderRegistry = {
    create(ctx) { contexts.set(ctx.account.id, ctx); return { async verify() {}, async sync() {}, async execute() {}, async close() {} }; },
    async verifyImap() {}, async connectGmail() { throw new Error("unused"); },
  };
  const options = { dbPath: join(dir, "synthetic.db"), version: "test", cipher: plaintextCipher, providers, incomingProcessor: processor, autoSync: false, instantSearch: false, iconTransport: null };
  const backend = new Backend(options);
  const scopes = new Map<number, ProviderStore>();
  const scope = backend.store.providerStore.bind(backend.store);
  vi.spyOn(backend.store, "providerStore").mockImplementation((id) => {
    const value = scope(id);
    scopes.set(id, value);
    return value;
  });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= backend.stop();
  cleanups.push(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  const accounts = [];
  for (let index = 0; index < 2; index++) {
    const { account } = await backend.store.accounts.create({ kind: "imap", email: `synthetic${index}@example.test`, displayName: "Synthetic", color: "indigo", providerConfig: {}, now: index + 1 });
    accounts.push(account);
    await backend.provider(account.id);
  }
  return { backend, contexts, scopes, accounts, stop };
}

it("shares only the run capability and fences removed/replaced account generations", async () => {
  let release!: () => void;
  let receivedSignal: AbortSignal | undefined;
  const run = vi.fn(async (_input: IncomingProcessingInput, signal: AbortSignal) => { receivedSignal = signal; await new Promise<void>((resolve) => { release = resolve; }); return result; });
  const close = vi.fn(async () => {});
  const t = await setup({ run, close, async whenIdle() {} });
  const account = t.accounts[0]!;
  const old = t.contexts.get(account.id)!;
  expect(old.incomingProcessor).toBeDefined();
  expect(old.incomingProcessor).not.toHaveProperty("close");
  const pending = old.incomingProcessor!.run(input(), new AbortController().signal);
  const settled = pending.then(() => "resolved", (error: Error) => error.name);
  await turn();
  await t.backend.dropAccount(account.id);
  expect(receivedSignal?.aborted).toBe(true);
  release();
  expect(await settled).toBe("AbortError");
  const calls = run.mock.calls.length;
  await expect(old.incomingProcessor!.run(input(), new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(run).toHaveBeenCalledTimes(calls);
  await t.backend.signedIn(account.id);
  await t.backend.provider(account.id);
  expect(t.contexts.get(account.id)).not.toBe(old);
  expect(close).not.toHaveBeenCalled();
});

it("canceling another account never aborts the active parser job", async () => {
  let release!: () => void;
  let receivedSignal: AbortSignal | undefined;
  const processor: IncomingProcessor = { async run(_input, signal) { receivedSignal = signal; await new Promise<void>((resolve) => { release = resolve; }); return result; }, async close() {}, async whenIdle() {} };
  const t = await setup(processor);
  const first = t.accounts[0]!, sibling = t.accounts[1]!;
  const ctx = t.contexts.get(sibling.id)!;
  expect(ctx.incomingProcessor).toBeDefined();
  const pending = ctx.incomingProcessor!.run(input(), new AbortController().signal);
  await turn();
  await t.backend.dropAccount(first.id);
  expect(receivedSignal?.aborted).toBe(false);
  release();
  expect(await pending).toBe(result);
});

it("closes the processor on shutdown before closing its store", async () => {
  const close = vi.fn(async () => {});
  const t = await setup({ async run() { return result; }, close, async whenIdle() {} });
  let retired!: () => void;
  const retirement = new Promise<void>((resolve) => { retired = resolve; });
  close.mockImplementationOnce(async () => { await retirement; });
  const stopping = t.stop();
  try {
    await turn();
    expect(close).toHaveBeenCalledOnce();
    expect(t.backend.store.isOpen).toBe(true);
  } finally { retired(); }
  await stopping;
  expect(t.backend.store.isOpen).toBe(false);
});

it("keeps its store open through pending host retirement even when close settles promptly", async () => {
  let retire!: () => void;
  const retirement = new Promise<void>((resolve) => { retire = resolve; });
  const whenIdle = vi.fn(() => retirement);
  const t = await setup({ async run() { return result; }, async close() {}, whenIdle });
  const stopping = t.stop();
  try {
    await turn();
    expect(whenIdle).toHaveBeenCalledOnce();
    expect(t.backend.store.isOpen).toBe(true);
  } finally { retire(); await stopping; }
  expect(t.backend.store.isOpen).toBe(false);
});


it("exposes the durable-store capability and fences captured snapshot pages by account lifetime", async () => {
  const t = await setup({ async run() { return result; }, async close() {}, async whenIdle() {} });
  const first = t.accounts[0]!, sibling = t.accounts[1]!;
  const ctx = t.contexts.get(first.id)!;
  expect.soft(ctx).toHaveProperty("flagObservation", true);
  expect(ctx.store).toHaveProperty("pendingFlagSnapshots", expect.any(Function));
  expect(await ctx.store.pendingFlagSnapshots({ limit: 10 })).toEqual({ items: [], throughMessageId: 0, hasMore: false });
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const read = vi.spyOn(t.scopes.get(first.id)!, "pendingFlagSnapshots").mockImplementationOnce(async () => {
    enter(); await blocked;
    return { items: [{ id: 1, providerMsgId: "synthetic" }], throughMessageId: 1, hasMore: false };
  });
  const pending = ctx.store.pendingFlagSnapshots({ limit: 10 }).then(() => "published", (error: Error) => error.name);
  try {
    await entered;
    await t.backend.dropAccount(first.id);
  } finally { release(); }
  expect(await pending).toBe("AbortError");
  await expect(ctx.store.pendingFlagSnapshots({ limit: 10 })).rejects.toMatchObject({ name: "AbortError" });
  expect(read).toHaveBeenCalledOnce();
  expect(await t.contexts.get(sibling.id)!.store.pendingFlagSnapshots({ limit: 10 })).toEqual({ items: [], throughMessageId: 0, hasMore: false });
});
