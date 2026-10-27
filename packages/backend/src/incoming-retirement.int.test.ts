import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createIncomingProcessor, type IncomingProcessor, type IncomingWorkerHost } from "@terno/mail/incoming-processing";
import type { ProviderContext, ProviderRegistry } from "@terno/mail/portable";
import { openDatabase, SqlMailStore } from "@terno/db";
import { Backend, plaintextCipher } from "./backend";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function setup(processor: IncomingProcessor) {
  const dir = mkdtempSync(join(tmpdir(), "terno-retirement-"));
  const dbPath = join(dir, "synthetic.db");
  let context!: ProviderContext, providersClosed = 0;
  const providers: ProviderRegistry = {
    create(ctx) { context = ctx; return { async verify() {}, async sync() {}, async execute() {}, async close() { providersClosed++; } }; },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath, providers, cipher: plaintextCipher, incomingProcessor: processor, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
  await backend.provider(account.id);
  return { backend, context, account, dbPath, get providersClosed() { return providersClosed; }, async cleanup() {
    if (backend.store.isOpen) { processor.close = async () => {}; processor.whenIdle = async () => {}; await backend.stop(); }
    rmSync(dir, { recursive: true, force: true });
  } };
}

it("cleans all backend ownership after real client retirement fails and preserves its fixed error", async () => {
  const marker = "synthetic-private-termination-marker";
  const factory = vi.fn(() => ({ postMessage() {}, async terminate() { throw new Error(marker); } }));
  const processor = createIncomingProcessor(factory);
  const t = await setup(processor);
  const abort = new AbortController();
  const job = processor.run({ kind: "mime", chunks: [new Uint8Array([1])] }, abort.signal).catch((error: unknown) => error);
  abort.abort(); await job; await turn();
  try {
    const error = await t.backend.stop().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "worker-unavailable" });
    expect(String(error)).not.toContain(marker);
    expect(t.providersClosed).toBe(1);
    expect(t.backend.store.isOpen).toBe(false);
    await expect(processor.run({ kind: "mime", chunks: [new Uint8Array([2])] }, new AbortController().signal)).rejects.toMatchObject({ code: "worker-closed" });
    expect(factory).toHaveBeenCalledOnce();
  } finally { await t.cleanup(); }
});

it.each([false, true])("stops timers/providers and drains admitted writes while retirement waits; delayed startup=%s", async (delayed) => {
  let failRetirement!: () => void, attach!: (host: IncomingWorkerHost) => void, releaseWrite!: () => void, enterWrite!: () => void;
  const retiring = new Promise<void>((_resolve, reject) => { failRetirement = () => reject(new Error("synthetic-private-retirement-marker")); });
  const startup = new Promise<IncomingWorkerHost>((resolve) => { attach = resolve; });
  const host: IncomingWorkerHost = { postMessage() {}, terminate: () => retiring };
  const processor = createIncomingProcessor(() => delayed ? startup : host);
  const t = await setup(processor);
  const stopped = vi.spyOn(t.backend.connectivity, "stop");
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writing = new Promise<void>((resolve) => { enterWrite = resolve; });
  const put = t.backend.store.secrets.put.bind(t.backend.store.secrets);
  vi.spyOn(t.backend.store.secrets, "put").mockImplementation(async (...args) => { enterWrite(); await writeGate; return put(...args); });
  const write = t.context.setSecret("synthetic", "kept");
  await writing;
  const job = processor.run({ kind: "mime", chunks: [new Uint8Array([1])] }, new AbortController().signal).catch((error: unknown) => error);
  const stopping = t.backend.stop().catch((error: unknown) => error);
  try {
    await turn();
    expect(stopped).toHaveBeenCalledOnce();
    expect(t.providersClosed).toBe(1);
    expect(t.backend.store.isOpen).toBe(true);
    if (delayed) attach(host);
    await turn(); failRetirement(); await turn();
    expect(t.backend.store.isOpen).toBe(true);
    releaseWrite(); await write;
    expect(await stopping).toMatchObject({ code: "worker-unavailable" });
    expect(t.backend.store.isOpen).toBe(false);
    const reopened = new SqlMailStore(openDatabase(t.dbPath));
    try { expect(await plaintextCipher.decrypt((await reopened.secrets.get(`account:${t.account.id}:synthetic`))!)).toBe("kept"); }
    finally { await reopened.close(); }
  } finally { attach(host); failRetirement(); releaseWrite(); await write.catch(() => {}); await job; await stopping; await t.cleanup(); }
});
