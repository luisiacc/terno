import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { createNodeIncomingProcessor } from "./incoming-worker";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { sqlDb } from "@terno/db";
import { Backend, plaintextCipher } from "./backend";
import { incomingGmailFixture } from "./incoming-gmail-fixture";

it("preserves valid complete large bodies without a monolithic parent SQL body bind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-exact-body-"));
  const text = "alpha e\u0301 \ud83d\ude00\r\n".repeat(90000) + " boundaryneedle acrossboundary ";
  const html = `<p>${"Exact &amp; complete. ".repeat(90000)}</p>`;
  const mime = ["From: sender@example.test", "Subject: Synthetic complete", "MIME-Version: 1.0", "Content-Type: multipart/mixed; boundary=m", "", "--m", "Content-Type: multipart/alternative; boundary=a", "", "--a", "Content-Type: text/plain; charset=utf-8", "", text, "--a", "Content-Type: text/html; charset=utf-8", "", html, "--a--", "--m", "Content-Type: application/octet-stream", "Content-Disposition: attachment; filename=witness.bin", "Content-Transfer-Encoding: base64", "", "AP+A", "--m--", ""].join("\r\n");
  const wire = JSON.stringify({ id: "large", threadId: "thread", labelIds: ["INBOX"], raw: Buffer.from(mime).toString("base64url") });
  const fixture = incomingGmailFixture({ ids: ["large"], raw() {
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === wire.length) { controller.close(); return; }
      const end = Math.min(offset + 65536, wire.length);
      controller.enqueue(new TextEncoder().encode(wire.slice(offset, end))); offset = end;
    } }, { highWaterMark: 0 }));
  } });
  const providers: ProviderRegistry = { create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }), async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); } };
  const backend = new Backend({ dbPath: join(dir, "test.db"), providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let largest = 0;
  try {
    await backend.ready;
    const db = sqlDb(backend.store), run = db.run.bind(db);
    vi.spyOn(db, "run").mockImplementation((sql, ...parameters) => {
      for (const value of parameters) if (typeof value === "string") largest = Math.max(largest, value.length);
      return run(sql, ...parameters);
    });
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
    fixture.accounts.set("synthetic", account.email);
    await backend.store.filters.save({ name: "boundary match", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "boundaryneedle acrossboundary" }], actions: [{ type: "star" }] } }, 1);
    await backend.syncAccount(account.id);
    const messages = (await backend.store.debug.snapshot()).messages;
    expect(messages).toHaveLength(1);
    const stored = (await backend.store.threads.get(messages[0]!.threadId))!.messages[0]!;
    expect(stored.bodyText === text.replace(/\r\n/g, "\n")).toBe(true);
    expect(stored.bodyHtml === html).toBe(true);
    expect(stored.isStarred).toBe(true);
    const attachment = stored.attachments[0]!;
    expect(await backend.store.attachments.read(account.id, attachment.assetId!, 0)).toBe("AP+A");
    const search = await backend.store.threads.searchText({ query: '"boundaryneedle acrossboundary"', limit: 10, now: 1 });
    expect(search.items.map((thread) => thread.id)).toEqual([messages[0]!.threadId]);
    expect(fixture.unexpected).toEqual([]);
    expect(largest, "a complete valid body must not be rebound as one indivisible parent string").toBeLessThanOrEqual(32768);
  } finally { try { await backend.stop(); } finally { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); } }
});


it("transports complete large normalized text without a monolithic worker-reply string", async () => {
  const body = "alpha e\u0301 \ud83d\ude00\r\n".repeat(90000);
  const raw = `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  const native = new Worker(new URL("../dist/incoming.worker.cjs", import.meta.url), { execArgv: [], env: {} });
  const processor = createNodeIncomingProcessor();
  try {
    const bytes = new TextEncoder().encode(raw);
    const reply = once(native, "message");
    native.postMessage({ type: "process", incarnation: 1, job: 1, input: { kind: "mime", chunks: [bytes] } }, [bytes.buffer]);
    const [received] = await reply;
    expect(received.type).toBe("result");
    const parts = Object.values(received.result.textParts ?? {}).flat() as Uint16Array[];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.byteOffset === 0 && part.byteLength === part.buffer.byteLength && part.byteLength <= 65536)).toBe(true);
    const result = await processor.run({ kind: "mime", chunks: [new TextEncoder().encode(raw)] }, new AbortController().signal);
    expect(result.message.text === body.replace(/\r\n/g, "\n")).toBe(true);
    expect(Math.max(received.result.message.text?.length ?? 0, received.result.message.html?.length ?? 0), "parent message delivery must not clone a whole large body").toBeLessThanOrEqual(32768);
  } finally { await processor.close(); await native.terminate(); }
});
