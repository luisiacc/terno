import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imapkit from "imapkit";
import { ImapFlow } from "imapflow";
import { afterEach, expect, it, vi } from "vitest";
import { createRegistry } from "@terno/mail";
import { IncomingPipeline } from "@terno/mail/portable";
import { Backend, plaintextCipher } from "./backend";
import { createNodeIncomingProcessor } from "./incoming-worker";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => vi.restoreAllMocks());

it.each(["complete", "limit", "cancel"] as const)("admits IMAP BODY through terminal/ACK and retains repair responsibility (%s)", async (mode) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-imap-retention-"));
  const server = imapkit({ plugins: ["SPECIAL-USE"], storage: { INBOX: {} } });
  const port = await server.start(0, "127.0.0.1");
  server.control.addMessage("INBOX", { raw: "From: sender@example.test\r\nTo: synthetic@example.test\r\nSubject: ingress\r\nMessage-ID: <ingress@example.test>\r\nDate: Fri, 30 Oct 2026 12:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nExact IMAP body\r\n" });
  const processor = createNodeIncomingProcessor(undefined, mode === "limit" ? { maxResultTextCodeUnits: 2 } : {});
  const processing = vi.spyOn(processor, "run");
  let bodyQueries = 0;
  const failures: unknown[] = [];
  const cancel = new AbortController();
  const registry = createRegistry({ imap: { allowInsecure: true } });
  const providers = { ...registry, create(ctx: Parameters<typeof registry.create>[0]) {
    const pending = ctx.store.pendingBodies.bind(ctx.store);
    vi.spyOn(ctx.store, "pendingBodies").mockImplementation(async (...args) => { bodyQueries++; return pending(...args); });
    const provider = registry.create(ctx);
    return { ...provider, async sync(sink: Parameters<typeof provider.sync>[0]) { try { await provider.sync({ ...sink, signal: AbortSignal.any([sink.signal, cancel.signal]) }); } catch (error) { failures.push(error); throw error; } } };
  } };
  const backend = new Backend({ dbPath: join(dir, "test.db"), providers, incomingProcessor: processor, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  const pipeline = new IncomingPipeline();
  const held = await pipeline.promote(99, new AbortController().signal);
  const originalPromote = IncomingPipeline.prototype.promote;
  let requests = 0, writes = 0;
  const promote = vi.spyOn(IncomingPipeline.prototype, "promote").mockImplementation(function (...args) { return originalPromote.apply(pipeline, args); });
  const fetch = ImapFlow.prototype.fetch;
  let terminalRelease!: () => void;
  const terminal = new Promise<void>((resolve) => { terminalRelease = resolve; });
  let delivered = 0;
  vi.spyOn(ImapFlow.prototype, "fetch").mockImplementation(async function* (this: ImapFlow, ...args) {
    if (args[1]?.source) requests++;
    for await (const message of fetch.apply(this, args)) {
      if (args[1]?.source) delivered++;
      yield message;
    }
    if (args[1]?.source) await terminal;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let work: Promise<unknown> | undefined;
  try {
    await backend.ready;
    const accounts = [];
    for (let index = 0; index < 2; index++) {
      const { account } = await backend.store.accounts.create({ kind: "imap", email: `synthetic-${index}@example.test`, displayName: "Synthetic", color: "brown", now: 1 });
      await backend.store.accounts.setProviderConfig(account.id, { imap: { host: "127.0.0.1", port, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" } });
      await backend.store.secrets.put(`account:${account.id}:password`, await plaintextCipher.encrypt("testpass"));
      accounts.push(account);
    }
    const setBody = backend.store.sync.setBody.bind(backend.store.sync);
    vi.spyOn(backend.store.sync, "setBody").mockImplementation(async (...args) => { writes++; await gate; return setBody(...args); });
    work = Promise.all(accounts.map((account) => backend.syncAccount(account.id)));
    await vi.waitFor(() => expect(bodyQueries).toBeGreaterThanOrEqual(2));
    await turn(); await turn();
    expect(requests, "BODY must not be issued before shared ingress grant").toBe(0);
    expect(promote).toHaveBeenCalledTimes(2);
    held();
    await vi.waitFor(() => expect(delivered).toBe(1));
    expect(requests).toBe(1);
    expect(processing).not.toHaveBeenCalled();
    if (mode === "cancel") {
      cancel.abort(new DOMException("Synthetic caller canceled", "AbortError"));
      let admitted = false;
      const waiting = pipeline.promote(100, new AbortController().signal).then((release) => { admitted = true; return release; });
      await turn(); await turn();
      expect(admitted, "caller abort is not the held command terminal").toBe(false);
      expect(requests).toBe(1);
      terminalRelease(); await work;
      (await waiting)();
      expect(processing).not.toHaveBeenCalled();
      expect(writes).toBe(0);
      for (const account of accounts) expect(await backend.store.providerStore(account.id).pendingBodies(10)).toHaveLength(1);
      return;
    }
    terminalRelease();
    if (mode === "limit") {
      await work;
      expect(writes).toBe(0);
      expect(failures).toHaveLength(2);
      for (const error of failures) expect(error).toMatchObject({ code: "result-limit", retryable: false, expected: true, i18n: { key: "errors.mail.processingLimit" } });
      for (const account of accounts) expect(await backend.store.providerStore(account.id).pendingBodies(10)).toHaveLength(1);
      expect((await backend.store.debug.snapshot()).messages.every((message) => message.bodyState !== "full")).toBe(true);
      return;
    }
    await vi.waitFor(() => expect(writes).toBe(1));
    expect(requests).toBe(1);
    expect(processing).toHaveBeenCalledOnce();
    release(); await work;
    expect(requests).toBe(2);
    expect(processing).toHaveBeenCalledTimes(2);
    const messages = (await backend.store.debug.snapshot()).messages;
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.bodyText)).toEqual(["Exact IMAP body\n", "Exact IMAP body\n"]);
    expect(new Set(messages.map((message) => message.accountId))).toEqual(new Set(accounts.map((account) => account.id)));
  } finally {
    held(); terminalRelease(); release();
    try { await work; } finally { promote.mockRestore(); pipeline.close(); try { await backend.stop(); } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); } }
  }
});
