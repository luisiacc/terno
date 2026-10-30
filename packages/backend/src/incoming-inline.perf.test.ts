import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { createNodeIncomingProcessor } from "./incoming-worker";
import { Backend, plaintextCipher } from "./backend";
import { incomingGmailFixture } from "./incoming-gmail-fixture";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { watchLoop } from "../../db/src/test/timing";

afterEach(() => { vi.restoreAllMocks(); });

const plain = Array(12).fill("synthetic ".repeat(350)).join("\r\n");
const html = Array(15).fill(`<p>${"synthetic ".repeat(300)}</p>`).join("\r\n");
const addresses = Array.from({ length: 32 }, (_, index) => `Synthetic ${index} <s${index}@example.test>`).join(", ");

it.each([
  ["plain", `Content-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n`, false],
  ["html", `Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`, false],
  ["addresses", `To: ${addresses}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nExact body\r\n`, false],
  ["dense", `Content-Type: text/html; charset=utf-8\r\n\r\n${"<p>Exact body</p>".repeat(40)}\r\n`, true],
] as const)("keeps qualified %s routing within a whole sync/store slice", async (_shape, content, promoted) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-inline-perf-"));
  const source = `From: sender@example.test\r\nSubject: Synthetic\r\n${content}`;
  const wire = new TextEncoder().encode(JSON.stringify({ id: "m", threadId: "t", labelIds: ["INBOX"], raw: Buffer.from(source).toString("base64url") }));
  expect(wire.length).toBeLessThanOrEqual(65536);
  const processor = createNodeIncomingProcessor();
  const process = vi.spyOn(processor, "run");
  const fixture = incomingGmailFixture({ ids: ["m"], raw: () => new Response(wire) });
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath: join(dir, "synthetic.db"), providers, cipher: plaintextCipher, incomingProcessor: processor, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  try {
    await backend.ready;
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
    fixture.accounts.set("synthetic", account.email);
    const budget = 15 * BUDGET_MULTIPLIER;
    const monitor = watchLoop(budget);
    let timing;
    try { await backend.syncAccount(account.id); }
    finally { timing = monitor.stop(); }
    expect.soft(process).toHaveBeenCalledTimes(promoted ? 1 : 0);
    const snapshot = await backend.store.debug.snapshot();
    console.info(JSON.stringify({ shape: _shape, timing, workerCalls: process.mock.calls.length, messages: snapshot.messages.length, rawRequests: fixture.requests.filter(({ url }) => url.searchParams.get("format") === "raw").length }));
    expect.soft(snapshot.messages).toHaveLength(1);
    const expectedText = _shape === "plain" ? `${plain.replaceAll("\r\n", "\n")}\n` : _shape === "addresses" ? "Exact body\n" : _shape === "html" ? "synthetic ".repeat(4500).trim() : Array(40).fill("Exact body").join(" ");
    expect.soft(snapshot.messages[0]?.bodyText).toBe(expectedText);
    const message = snapshot.messages[0] ? (await backend.store.threads.get(snapshot.messages[0].threadId))?.messages[0] : undefined;
    expect.soft(message?.bodyHtml).toBe(_shape === "html" ? `${html.replaceAll("\r\n", "\n")}\n` : _shape === "dense" ? `${"<p>Exact body</p>".repeat(40)}\n` : null);
    if (promoted) expect.soft((await process.mock.results[0]?.value)?.kind).toBe("gmail");
    expect.soft(timing.stall, JSON.stringify(timing)).toBeLessThanOrEqual(budget);
    expect((await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor).toEqual({ historyId: "10" });
    expect((await backend.store.accounts.get(account.id))?.syncState.status).toBe("idle");
    expect(backend.net.googlePending()).toBe(0);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.requests.filter(({ url }) => url.searchParams.get("format") === "raw")).toHaveLength(1);
    expect(fixture.requests.filter(({ url }) => url.searchParams.get("format") === "minimal")).toHaveLength(1);
  } finally {
    try { expect(backend.net.googlePending()).toBe(0); }
    finally { try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
  }
});
