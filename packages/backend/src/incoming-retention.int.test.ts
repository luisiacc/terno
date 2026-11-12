import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK } from "@terno/core";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { Backend, plaintextCipher } from "./backend";
import { incomingGmailFixture } from "./incoming-gmail-fixture";
import { createNodeIncomingProcessor } from "./incoming-worker";

const size = 512 * 1024 + 17;
const expected = (account: number, id: string) => Uint8Array.from({ length: size }, (_, offset) => (offset * 31 + Math.floor(offset / 251) + account * 47 + Number(id.slice(1)) * 73) % 256);
afterEach(() => vi.restoreAllMocks());

it.each([0, 1])("holds six readers and one decoded attachment consumer through EOF/store release (lifetime %s)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-mime-retention-"));
  const sources: { pulls: number; done: boolean }[] = [];
  const fixture = incomingGmailFixture({ ids: ["m0", "m1", "m2", "m3"], raw(id, token) {
    const data = expected(Number(token), id);
    const mime = `From: sender@example.test\r\nSubject: ${token}-${id}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="witness.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(data).toString("base64")}\r\n`;
    const wire = JSON.stringify({ id, threadId: `${token}-${id}`, labelIds: ["INBOX"], raw: Buffer.from(mime).toString("base64url") });
    const source = { pulls: 0, done: false };
    sources.push(source);
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      source.pulls++;
      if (offset === wire.length) { source.done = true; controller.close(); return; }
      const end = Math.min(offset + 65536, wire.length);
      controller.enqueue(new TextEncoder().encode(wire.slice(offset, end)));
      offset = end;
    } }, { highWaterMark: 0 }), { headers: { "content-length": "1" } });
  } });
  const processor = createNodeIncomingProcessor();
  const run = processor.run.bind(processor);
  const transferred: Uint8Array[][] = [];
  let active = 0, peak = 0;
  vi.spyOn(processor, "run").mockImplementation(async (input, signal) => {
    const chunks = [...input.chunks];
    expect(chunks.every((chunk) => chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength && chunk.byteLength <= 65536)).toBe(true);
    transferred.push(chunks);
    peak = Math.max(peak, ++active);
    try {
      const result = await run(input, signal);
      expect(chunks.every((chunk) => chunk.buffer.byteLength === 0)).toBe(true);
      const bytes = result.message.attachments[0]!.bytes!;
      expect(bytes.byteOffset).toBe(0);
      expect(bytes.buffer.byteLength).toBe(size);
      return result;
    } finally { active--; }
  });
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => String(ctx.account.id), invalidate() {} }, buildRaw: async () => new Uint8Array() }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath: join(dir, "synthetic.db"), providers, incomingProcessor: processor, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  let work: Promise<unknown> | undefined;
  try {
    await backend.ready;
    const accounts = [];
    for (let index = 0; index < 2; index++) {
      const { account } = await backend.store.accounts.create({ kind: "gmail", email: `synthetic-${index}@example.test`, displayName: "Synthetic", color: "brown", now: 1 });
      accounts.push(account);
      fixture.accounts.set(String(account.id), account.email);
    }
    const ingest = backend.store.sync.ingest.bind(backend.store.sync);
    vi.spyOn(backend.store.sync, "ingest").mockImplementation(async (...args) => {
      writes++;
      for (const message of args[0]) {
        const bytes = message.attachments?.[0]?.bytes;
        expect(bytes).toBeDefined();
        expect(Buffer.from(bytes!).equals(Buffer.from(expected(message.accountId, message.providerMsgId!)))).toBe(true);
      }
      await gate;
      return ingest(...args);
    });
    work = Promise.all(accounts.map((account) => backend.syncAccount(account.id)));
    await vi.waitFor(() => { expect(sources).toHaveLength(6); expect(writes).toBe(1); });
    expect(sources.filter((source) => source.done)).toHaveLength(1);
    expect(sources.filter((source) => !source.done).map((source) => source.pulls)).toEqual([5, 5, 5, 5, 5]);
    expect(transferred).toHaveLength(1);
    expect(active).toBe(0);
    expect((await backend.store.debug.snapshot()).messages).toHaveLength(0);
    release(); await work;
    expect(peak).toBe(1);
    expect(writes).toBe(8);
    expect(transferred).toHaveLength(8);
    expect(sources).toHaveLength(8);
    expect(sources.every((source) => source.done)).toBe(true);
    const snapshot = await backend.store.debug.snapshot();
    expect(snapshot.messages).toHaveLength(8);
    for (const account of accounts) {
      const messages = snapshot.messages.filter((message) => message.accountId === account.id);
      expect(messages.map((message) => message.providerMsgId).sort()).toEqual(["m0", "m1", "m2", "m3"]);
      for (const message of messages) {
        const stored = (await backend.store.threads.get(message.threadId))!.messages.find((item) => item.id === message.id)!;
        const ref = stored.attachments[0]!;
        expect(ref.assetId).toBeTypeOf("string");
        const chunks: Buffer[] = [];
        for (let index = 0; index < Math.ceil(size / ATTACHMENT_CHUNK); index++) chunks.push(Buffer.from((await backend.store.attachments.read(account.id, ref.assetId!, index))!, "base64"));
        expect(Buffer.concat(chunks).equals(Buffer.from(expected(account.id, message.providerMsgId!)))).toBe(true);
        expect(message.subject).toBe(`${account.id}-${message.providerMsgId}`);
      }
      expect((await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor).toEqual({ historyId: "10" });
    }
    expect(backend.net.googlePending()).toBe(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    release();
    try { await work; } finally { try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
  }
});

it("shares real small-result credits while a promoted consumer owns the pipeline", async () => {
  const { IncomingPipeline } = await import("@terno/mail/portable");
  const dir = mkdtempSync(join(tmpdir(), "terno-mixed-retention-"));
  let largeAccount = "";
  const text = Array(10).fill("s".repeat(3000)).join("\r\n");
  const large = "L".repeat(300000);
  const ids = Array.from({ length: 20 }, (_, index) => `m${index}`);
  const fixture = incomingGmailFixture({ ids, list: (token) => token === largeAccount ? ["m0"] : ids, raw(id, token) {
    const wire = JSON.stringify({ id, threadId: `${token}-${id}`, raw: Buffer.from(`From: sender@example.test\r\nSubject: ${token}-${id}\r\nContent-Type: text/plain\r\n\r\n${token === largeAccount ? large : text}\r\n`).toString("base64url") });
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === wire.length) { controller.close(); return; }
      const end = Math.min(offset + 65536, wire.length);
      controller.enqueue(new TextEncoder().encode(wire.slice(offset, end))); offset = end;
    } }, { highWaterMark: 0 }));
  } });
  let retained = 0, peak = 0, refused = 0;
  const retain = IncomingPipeline.prototype.retainCompleted;
  vi.spyOn(IncomingPipeline.prototype, "retainCompleted").mockImplementation(function (this: InstanceType<typeof IncomingPipeline>, bytes) {
    const release = retain.call(this, bytes);
    if (!release) { refused++; return; }
    retained += bytes; peak = Math.max(peak, retained);
    let done = false;
    return () => { if (!done) { done = true; retained -= bytes; } release(); };
  });
  const processor = createNodeIncomingProcessor();
  const processing = vi.spyOn(processor, "run");
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => String(ctx.account.id), invalidate() {} }, buildRaw: async () => new Uint8Array() }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath: join(dir, "synthetic.db"), providers, incomingProcessor: processor, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let largeWrites = 0;
  const work: Promise<unknown>[] = [];
  try {
    await backend.ready;
    const accounts = [];
    for (let index = 0; index < 5; index++) {
      const { account } = await backend.store.accounts.create({ kind: "gmail", email: `mixed-${index}@example.test`, displayName: "Synthetic", color: "brown", now: 1 });
      accounts.push(account); fixture.accounts.set(String(account.id), account.email);
    }
    largeAccount = String(accounts[0]!.id);
    const ingest = backend.store.sync.ingest.bind(backend.store.sync);
    vi.spyOn(backend.store.sync, "ingest").mockImplementation(async (...args) => {
      if (String(args[0][0]!.accountId) === largeAccount) largeWrites++;
      await gate;
      return ingest(...args);
    });
    work.push(backend.syncAccount(accounts[0]!.id));
    await vi.waitFor(() => expect(largeWrites).toBe(1));
    work.push(...accounts.slice(1).map((account) => backend.syncAccount(account.id)));
    await vi.waitFor(() => expect(refused).toBeGreaterThan(0));
    expect(peak).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(retained).toBeGreaterThan(3 * 1024 * 1024);
    expect(processing).toHaveBeenCalledOnce();
    expect(largeWrites).toBe(1);
    expect(fixture.unexpected).toEqual([]);
    release(); await Promise.all(work);
    expect(retained).toBe(0);
    expect(processing).toHaveBeenCalledTimes(1);
    const messages = (await backend.store.debug.snapshot()).messages;
    expect(messages).toHaveLength(81);
    for (const message of messages) expect(message.bodyText === `${String(message.accountId) === largeAccount ? large : text.replace(/\r\n/g, "\n")}\n`).toBe(true);
    expect(backend.net.googlePending()).toBe(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    release();
    try { await Promise.all(work); } finally { try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
  }
});
