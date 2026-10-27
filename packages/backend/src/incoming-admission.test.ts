import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGmailApiProvider } from "@terno/mail/portable";
import type { ProviderRegistry } from "@terno/mail";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const raw = Buffer.from("From: sender@example.test\r\nTo: me@example.test\r\nSubject: Synthetic\r\n\r\nSmall body").toString("base64url");

it("shares six incoming raw reads across accounts and drains all mail without extra sink batches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-incoming-"));
  let opened = false, active = 0, peak = 0, started = 0;
  const releases: (() => void)[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const account = new Headers(init?.headers).get("authorization")!.slice(7);
    if (url.pathname.endsWith("/profile")) return json({ historyId: "10" });
    if (url.pathname.endsWith("/messages")) return json({ messages: Array.from({ length: 8 }, (_, i) => ({ id: `mail-${i}` })) });
    const id = url.pathname.split("/").at(-1)!;
    if (url.searchParams.get("format") === "raw") {
      started++; active++; peak = Math.max(peak, active);
      try {
        if (!opened) await new Promise<void>((resolve) => releases.push(resolve));
        return json({ id, threadId: `${account}-${id}`, raw, labelIds: ["INBOX"] });
      } finally { active--; }
    }
    return json({ id, labelIds: ["INBOX"] });
  });
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => String(ctx.account.id), invalidate() {} }, buildRaw: async () => new Uint8Array() }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath: join(dir, "test.db"), providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  cleanup.push(async () => { opened = true; for (const release of releases) release(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  await backend.ready;
  const accounts = [];
  for (let i = 0; i < 2; i++) accounts.push((await backend.store.accounts.create({ kind: "gmail", email: `synthetic-${i}@example.test`, displayName: `Synthetic ${i}`, color: "indigo", now: 1 })).account);
  const ingest = vi.spyOn(backend.store.sync, "ingest");
  const run = Promise.all(accounts.map((account) => backend.syncAccount(account.id)));
  try {
    await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(6));
    await turn(); await turn();
    expect(started).toBe(6);
    expect(peak).toBe(6);
  } finally { opened = true; for (const release of releases) release(); await run; }
  expect(started).toBe(16);
  expect((await backend.store.debug.snapshot()).messages).toHaveLength(16);
  expect(ingest.mock.calls.map(([messages]) => messages.length).sort()).toEqual([8, 8]);
});
