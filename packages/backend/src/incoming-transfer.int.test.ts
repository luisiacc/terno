import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { Backend, plaintextCipher } from "./backend";
import { createNodeIncomingProcessor } from "./incoming-worker";

it.each(["base64", "quoted-printable"].flatMap((encoding) => [false, true].map((nested) => ({ encoding, nested }))))("processes encoded dense HTML through the emitted worker: $encoding nested=$nested", async ({ encoding, nested }) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-transfer-"));
  const html = "<p>Exact body</p>".repeat(80);
  const encoded = encoding === "base64" ? Buffer.from(html).toString("base64").match(/.{1,76}/g)!.join("\r\n") : html.replace(/</g, "=3C").replace(/>/g, "=3E");
  const headers = `Content-Type: text/html; charset=utf-8\r\ncOnTeNt-TrAnSfEr-EnCoDiNg: ${encoding}\r\n\r\n`;
  const content = nested ? `Content-Type: multipart/alternative; boundary=synthetic\r\n\r\n--synthetic\r\n${headers}${encoded}\r\n--synthetic--\r\n` : headers + encoded;
  const source = `From: sender@example.test\r\nSubject: Synthetic\r\n${content}`;
  const wire = new TextEncoder().encode(JSON.stringify({ id: "m", threadId: "t", raw: Buffer.from(source).toString("base64url") }));
  expect(wire.length).toBeLessThan(65536);
  expect(source.split("<").length - 1).toBe(0);
  const processor = createNodeIncomingProcessor();
  const process = vi.spyOn(processor, "run");
  const providers: ProviderRegistry = {
    create(ctx) { return createGmailApiProvider({ ...ctx, fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m" }] });
      return new Response(wire);
    } }, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }); },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath: join(dir, "synthetic.db"), incomingProcessor: processor, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  try {
    await backend.ready;
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
    await backend.syncAccount(account.id);
    expect(process).toHaveBeenCalledOnce();
    const snapshot = await backend.store.debug.snapshot();
    expect(snapshot.messages).toHaveLength(1);
    const expected = encoding === "quoted-printable" && !nested ? `${html}\n` : html;
    expect((await backend.store.threads.get(snapshot.messages[0]!.threadId))?.messages[0]?.bodyHtml).toBe(expected);
    expect((await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor).toEqual({ historyId: "10" });
    expect((await backend.store.accounts.get(account.id))?.syncState.status).toBe("idle");
  } finally { await backend.stop(); rmSync(dir, { recursive: true, force: true }); }
});
