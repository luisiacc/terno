import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGmailApiProvider, IncomingPipeline, type ProviderRegistry } from "@terno/mail/portable";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { createNodeIncomingProcessor } from "./incoming-worker";
import { incomingGmailFixture } from "./incoming-gmail-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

it("shares prefix/promotion ownership across accounts through actual worker and durable store acknowledgement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-pipeline-"));
  const text = "qualified synthetic body ".repeat(15000) + "End.";
  const raw = Buffer.from(`From: sender@example.test\r\nTo: me@example.test\r\nSubject: Synthetic\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`).toString("base64url");
  const sources: { account: string; pulls: number }[] = [];
  let continuePrefix!: () => void, continueWrite!: () => void;
  const prefix = new Promise<void>((resolve) => { continuePrefix = resolve; });
  const writing = new Promise<void>((resolve) => { continueWrite = resolve; });
  let writes = 0, granted = 0;
  const original = IncomingPipeline.prototype.promote;
  vi.spyOn(IncomingPipeline.prototype, "promote").mockImplementation(async function (this: IncomingPipeline, ...args) {
    const release = await original.apply(this, args);
    if (++granted === 1) await prefix;
    return release;
  });
  const fixture = incomingGmailFixture({
    ids: Array.from({ length: 3 }, (_, index) => `mail-${index}`),
    async observe(url, token) {
      const cursor = (await backend.store.accounts.config<{ cursor?: unknown }>(Number(token)))?.config.cursor;
      if (url.searchParams.get("format") === "minimal") expect(cursor).toMatchObject({ reconciliation: { stage: "refresh", baseline: "10", pages: 1 } });
      if (url.pathname.endsWith("/history")) {
        expect(url.searchParams.get("startHistoryId")).toBe("10");
        expect(cursor).toMatchObject({ reconciliation: { stage: "catchup", baseline: "10", pages: 1 } });
        expect(cursor).not.toHaveProperty("historyId");
      }
    },
    raw(id, account) {
      const bytes = new TextEncoder().encode(JSON.stringify({ id, threadId: `${account}-${id}`, labelIds: ["INBOX"], raw }));
      const source = { account, pulls: 0 };
      sources.push(source);
      let offset = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          source.pulls++;
          if (offset === bytes.length) { controller.close(); return; }
          const end = Math.min(bytes.length, offset + 65536);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      }, { highWaterMark: 0 }));
    },
  });
  const processor = createNodeIncomingProcessor();
  const process = vi.spyOn(processor, "run");
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => String(ctx.account.id), invalidate() {} }, buildRaw: async () => new Uint8Array() }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath: join(dir, "synthetic.db"), incomingProcessor: processor, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  cleanups.push(async () => { continuePrefix(); continueWrite(); try { expect(backend.net.googlePending()).toBe(0); } finally { try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } } });
  await backend.ready;
  const accounts = [];
  for (let index = 0; index < 2; index++) {
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: `synthetic-${index}@example.test`, displayName: "Synthetic", color: "indigo", now: 1 });
    accounts.push(account);
    fixture.accounts.set(String(account.id), account.email);
  }
  const ingest = backend.store.sync.ingest.bind(backend.store.sync);
  vi.spyOn(backend.store.sync, "ingest").mockImplementation(async (...args) => { writes++; if (writes === 1) await writing; return ingest(...args); });
  const work = Promise.all(accounts.map((account) => backend.syncAccount(account.id)));
  try {
    await vi.waitFor(() => expect(sources).toHaveLength(6));
    await vi.waitFor(() => expect(sources.every((source) => source.pulls >= 5)).toBe(true));
    expect(sources.map((source) => source.pulls)).toEqual([5, 5, 5, 5, 5, 5]);
    expect(writes).toBe(0);
    continuePrefix();
    await vi.waitFor(() => expect(writes).toBe(1));
    await turn();
    expect(sources.filter((source) => source.pulls > 5)).toHaveLength(1);
    expect((await backend.store.debug.snapshot()).messages).toHaveLength(0);
    for (const account of accounts) {
      const cursor = (await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor;
      expect(cursor).toMatchObject({ reconciliation: { stage: "enumerate", baseline: "10", pages: 0 } });
      expect(cursor).not.toHaveProperty("historyId");
    }
  } finally { continuePrefix(); continueWrite(); await work; }
  const snapshot = await backend.store.debug.snapshot();
  expect(snapshot.messages).toHaveLength(6);
  expect(snapshot.messages.map((message) => message.bodyText)).toEqual(Array(6).fill(`${text}\n`));
  expect(writes).toBe(6);
  expect(process).toHaveBeenCalledTimes(6);
  for (const result of process.mock.results) expect((await result.value).kind).toBe("gmail");
  expect(backend.net.googlePending()).toBe(0);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.requests.filter(({ url }) => url.searchParams.get("format") === "minimal")).toHaveLength(6);
  for (const account of accounts) {
    expect((await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor).toEqual({ historyId: "10" });
    expect((await backend.store.accounts.get(account.id))?.syncState.status).toBe("idle");
  }
});
