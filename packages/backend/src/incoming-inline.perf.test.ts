import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { createNodeIncomingProcessor } from "./incoming-worker";
import { Backend, plaintextCipher } from "./backend";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { watchLoop } from "../../db/src/test/timing";

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
  const response = new Response(wire);
  const processor = createNodeIncomingProcessor();
  const process = vi.spyOn(processor, "run");
  const providers: ProviderRegistry = {
    create(ctx) { return createGmailApiProvider({ ...ctx, fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m" }] });
      return response;
    } }, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }); },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath: join(dir, "synthetic.db"), providers, cipher: plaintextCipher, incomingProcessor: processor, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  try {
    await backend.ready;
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
    const budget = 15 * BUDGET_MULTIPLIER;
    const monitor = watchLoop(budget);
    let timing;
    try { await backend.syncAccount(account.id); }
    finally { timing = monitor.stop(); }
    expect(timing.stall, JSON.stringify(timing)).toBeLessThanOrEqual(budget);
    expect(process).toHaveBeenCalledTimes(promoted ? 1 : 0);
    const snapshot = await backend.store.debug.snapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.bodyText).toContain(_shape === "addresses" || _shape === "dense" ? "Exact body" : "synthetic");
    expect((await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor).toEqual({ historyId: "10" });
    expect((await backend.store.accounts.get(account.id))?.syncState.status).toBe("idle");
  } finally { await backend.stop(); rmSync(dir, { recursive: true, force: true }); }
});
