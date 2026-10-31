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
      const { account } = await backend.store.accounts.create({ kind: "gmail", email: `synthetic-${index}@example.test`, displayName: "Synthetic", color: "indigo", now: 1 });
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
