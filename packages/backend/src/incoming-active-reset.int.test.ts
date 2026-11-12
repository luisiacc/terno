import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imapkit from "imapkit";
import { expect, it, vi } from "vitest";
import { createRegistry } from "@terno/mail";
import { createIncomingProcessor } from "@terno/mail/incoming-processing";
import type { ProviderContext, MailProvider } from "@terno/mail/portable";
import { Backend, plaintextCipher } from "./backend";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
it.each(["reset", "close"] as const)("%s cancels a dispatched native processor and keeps capacity until observed termination", async (action) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-active-reset-"));
  const file = join(dir, "holding.cjs");
  writeFileSync(file, `const {parentPort}=require("node:worker_threads"); let owned;
parentPort.on("message", value => {
  if (value !== "late") { owned=value; parentPort.postMessage("entered"); return; }
  const bytes=new Uint8Array([17,0,255]);
  parentPort.postMessage({type:"result",incarnation:owned.incarnation,job:owned.job,result:{kind:"mime",message:{rfcMessageId:null,inReplyTo:null,references:[],from:{name:"",email:"sender@example.test"},replyTo:[],to:[],cc:[],bcc:[],subject:"Synthetic",date:null,listId:null,bulk:false,text:"Late stale body",html:null,attachments:[{filename:"late.bin",mime:"application/octet-stream",size:3,bytes}]}}},[bytes.buffer]);
  parentPort.postMessage("late-sent");
});`);
  let entered!: () => void, retire!: () => void, late!: () => void;
  let native!: Worker;
  let transferred: Uint8Array[] = [];
  const lateReply = new Promise<void>((resolve) => { late = resolve; });
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const retirement = new Promise<void>((resolve) => { retire = resolve; });
  let ending = 0, signal: AbortSignal | undefined;
  const processor = createIncomingProcessor((events) => {
    const worker = native = new Worker(file, { execArgv: [], env: {} });
    worker.on("message", (value) => { if (value === "entered") entered(); else if (value === "late-sent") late(); else events.message(value); });
    worker.on("error", events.fault); worker.on("exit", events.fault);
    return { postMessage: (request, transfers) => worker.postMessage(request, transfers), async terminate() { ending++; await retirement; await worker.terminate(); } };
  });
  const run = processor.run.bind(processor);
  processor.run = (input, captured) => { signal = captured; transferred = [...input.chunks]; return run(input, captured); };
  const server = imapkit({ plugins: ["SPECIAL-USE"], storage: { INBOX: {} } });
  const port = await server.start(0, "127.0.0.1");
  server.control.addMessage("INBOX", { raw: "From: sender@example.test\r\nSubject: Synthetic\r\nMessage-ID: <active@example.test>\r\n\r\nExact body\r\n" });
  let provider!: MailProvider, context!: ProviderContext, caller!: AbortSignal;
  const registry = createRegistry({ imap: { allowInsecure: true } });
  const unexpected: string[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { unexpected.push("Unexpected HTTP during native IMAP lifetime"); throw new Error("Unexpected HTTP during native IMAP lifetime"); });
  const backend = new Backend({ dbPath: join(dir, "test.db"), providers: { ...registry, create(ctx) { context = ctx; provider = registry.create(ctx);
      return { ...provider, sync(sink) { caller = sink.signal; return provider.sync(sink); } }; } }, incomingProcessor: processor, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let work: Promise<unknown> | undefined, stopped: Promise<void> | undefined;
  let releaseWaiter: (() => void) | undefined;
  try {
    await backend.ready;
    const { account } = await backend.store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "brown", now: 1 });
    await backend.store.accounts.setProviderConfig(account.id, { imap: { host: "127.0.0.1", port, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" } });
    await backend.store.secrets.put(`account:${account.id}:password`, await plaintextCipher.encrypt("testpass"));
    work = backend.syncAccount(account.id);
    await entering;
    expect(transferred.every((chunk) => chunk.buffer.byteLength === 0)).toBe(true);
    const captured = signal!;
    expect(captured.aborted).toBe(false);
    const before = await context.store.pendingBodies(10);
    expect(before).toHaveLength(1);
    const cursor = (await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor;
    if (action === "reset") provider.reset!();
    else stopped = provider.close();
    expect(caller.aborted).toBe(false);
    expect(captured.aborted, "captured reset/close must reach already dispatched processing").toBe(true);
    await turn();
    expect(ending).toBe(1);
    native.postMessage("late"); await lateReply; await turn();
    let available = false;
    const waiting = context.incoming!.promote!(account.id + 1, new AbortController().signal).then((release) => { available = true; releaseWaiter = release; });
    await turn(); await turn();
    expect(available).toBe(false);
    expect(await context.store.pendingBodies(10)).toEqual(before);
    expect((await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor).toEqual(cursor);
    const pending = (await backend.store.debug.snapshot()).messages[0]!;
    expect(pending.bodyState).not.toBe("full");
    expect(await backend.store.attachments.current(account.id, { id: pending.id })).toEqual([]);
    retire(); await processor.whenIdle(); await waiting;
    expect(available).toBe(true);
    releaseWaiter!();
    // Prevent automatic retry of the deliberately held fixture host; preserve its exact durable debt.
    await processor.close();
    await work; await stopped;
    expect(await context.store.pendingBodies(10)).toEqual(before);
    expect((await backend.store.debug.snapshot()).messages[0]!.bodyState).not.toBe("full");
  } finally {
    retire(); releaseWaiter?.();
    await processor.close();
    try { await work; await stopped; } finally { try { await backend.stop(); } finally { await server.stop(); fetch.mockRestore(); rmSync(dir, { recursive: true, force: true }); expect(unexpected).toEqual([]); } }
  }
});
