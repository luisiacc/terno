import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGmailApiProvider, ProviderError } from "@terno/mail/portable";
import { decodeCooldown, mailboxDigest } from "@terno/store";
import type { ProviderRegistry } from "@terno/mail";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { createNodeIncomingProcessor } from "./incoming-worker";
import { incomingGmailFixture } from "./incoming-gmail-fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const raw = Buffer.from("From: sender@example.test\r\nTo: me@example.test\r\nSubject: Synthetic\r\n\r\nSmall body").toString("base64url");

it("shares six incoming raw reads across accounts and drains all mail without extra sink batches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-incoming-"));
  let opened = false, active = 0, peak = 0, started = 0;
  const releases: (() => void)[] = [];
  const fixture = incomingGmailFixture({
    ids: Array.from({ length: 8 }, (_, i) => `mail-${i}`),
    async raw(id, account) {
      started++; active++; peak = Math.max(peak, active);
      try {
        if (!opened) await new Promise<void>((resolve) => releases.push(resolve));
        return Response.json({ id, threadId: `${account}-${id}`, raw, labelIds: ["INBOX"] });
      } finally { active--; }
    },
  });
  const processor = createNodeIncomingProcessor();
  const process = vi.spyOn(processor, "run");
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => String(ctx.account.id), invalidate() {} }, buildRaw: async () => new Uint8Array() }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath: join(dir, "test.db"), incomingProcessor: processor, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  cleanup.push(async () => { opened = true; for (const release of releases) release(); try { expect(backend.net.googlePending()).toBe(0); } finally { try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } } });
  await backend.ready;
  const accounts = [];
  for (let i = 0; i < 2; i++) {
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: `synthetic-${i}@example.test`, displayName: `Synthetic ${i}`, color: "indigo", now: 1 });
    accounts.push(account);
    fixture.accounts.set(String(account.id), account.email);
  }
  const ingest = vi.spyOn(backend.store.sync, "ingest");
  const run = Promise.all(accounts.map((account) => backend.syncAccount(account.id)));
  try {
    await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(6));
    await turn(); await turn();
    expect(started).toBe(6);
    expect(peak).toBe(6);
  } finally { opened = true; for (const release of releases) release(); await run; }
  expect(started).toBe(16);
  const messages = (await backend.store.debug.snapshot()).messages;
  expect(messages).toHaveLength(16);
  expect(messages.map((message) => message.bodyText)).toEqual(Array(16).fill("Small body\n"));
  expect(process).not.toHaveBeenCalled();
  expect(backend.net.googlePending()).toBe(0);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.requests.filter(({ url }) => url.searchParams.get("format") === "minimal")).toHaveLength(16);
  expect(ingest.mock.calls.map(([messages]) => messages.length).sort()).toEqual([8, 8]);
  for (const account of accounts) {
    expect((await backend.store.accounts.get(account.id))?.syncState.status).toBe("idle");
    expect((await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor).toEqual({ historyId: "10" });
  }
});


it("refuses unsupported transport contracts and returns fresh consumable raw responses", async () => {
  const wire = new TextEncoder().encode(JSON.stringify({ id: "m", threadId: "t", raw }));
  const fixture = incomingGmailFixture({ ids: ["m"], raw: () => new Response(wire) });
  fixture.accounts.set("synthetic", "synthetic@example.test");
  const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/m?format=raw";
  const request = (resource = url, init: RequestInit = {}) => new Request(resource, { headers: { authorization: "Bearer synthetic" }, redirect: "error", ...init });
  const first = await fixture.transport(request()), second = await fixture.transport(request());
  expect(first).not.toBe(second);
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(wire);
  expect(new Uint8Array(await second.arrayBuffer())).toEqual(wire);
  expect(fixture.unexpected).toEqual([]);
  const invalid: Parameters<typeof fetch>[0][] = [
    url,
    request("https://external.example.test/messages/m?format=raw"),
    request(url.replace("messages/m", "messages/unknown")),
    request(url.replace("format=raw", "format=full")),
    request(url.replace("messages/m?format=raw", "labels?unexpected=true")),
    request(url, { method: "POST" }),
    request(url, { redirect: "follow" }),
    request(url, { headers: { authorization: "Bearer unknown" } }),
    request(url, { headers: { authorization: "synthetic" } }),
    request(`${url}&format=raw`),
  ];
  for (const input of invalid) await expect(fixture.transport(input)).rejects.toThrow("Unsupported incoming fixture request");
  expect(fixture.unexpected).toHaveLength(invalid.length);
  expect(fixture.requests).toHaveLength(2);
});

async function controlMailbox(options: Partial<Parameters<typeof incomingGmailFixture>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-incoming-control-"));
  const fixture = incomingGmailFixture({ ids: ["m"], raw: () => Response.json({ id: "m", threadId: "t", labelIds: ["INBOX"], raw }), ...options });
  let failure: unknown;
  const providers: ProviderRegistry = {
    create(ctx) {
      const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
      return { ...provider, async sync(sink) { try { await provider.sync(sink); } catch (error) { failure = error; throw error; } } };
    },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const backend = new Backend({ dbPath: join(dir, "synthetic.db"), providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  cleanup.push(async () => { try { expect(backend.net.googlePending()).toBe(0); } finally { try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } } });
  await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
  fixture.accounts.set("synthetic", account.email);
  return { backend, account, fixture, failure: () => failure, cursor: async () => (await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor };
}

it.each(["missing", "mismatched"] as const)("refuses a %s saved-mailbox profile before incoming work", async (identity) => {
  const t = await controlMailbox({ profile: () => ({ historyId: "10", ...(identity === "mismatched" && { emailAddress: "other@example.test" }) }) });
  await t.backend.syncAccount(t.account.id);
  expect(t.failure()).toBeInstanceOf(ProviderError);
  expect(t.fixture.requests.map(({ url }) => url.pathname.split("/").at(-1))).toEqual(["profile"]);
  expect((await t.backend.store.debug.snapshot()).messages).toEqual([]);
  expect(await t.cursor()).toBeUndefined();
  expect(decodeCooldown(await t.backend.store.providerCooldown.read()).bindings).toEqual([]);
  const state = (await t.backend.store.accounts.get(t.account.id))!.syncState;
  expect(state.status).not.toBe("idle");
  expect(state.lastSyncAt).toBeNull();
  expect(t.backend.net.googlePending()).toBe(0);
  expect(t.fixture.unexpected).toEqual([]);
});

it("retains real catchup progress and native HTTP evidence, then promotes only terminal history", async () => {
  let failing = true;
  const t = await controlMailbox({ history: () => failing
    ? Response.json({ error: { message: "Synthetic unavailable" } }, { status: 503, headers: { "retry-after": "7", date: "Thu, 29 Oct 2026 00:00:00 GMT" } })
    : Response.json({ historyId: "11" }) });
  await t.backend.syncAccount(t.account.id);
  expect(t.failure()).toBeInstanceOf(ProviderError);
  expect((t.failure() as ProviderError).httpResponse).toMatchObject({
    source: "http-response", status: 503, request: { endpoint: "gmail-api", purpose: "mail" },
    retryAfter: { kind: "value", value: "7" }, serverDate: { kind: "value", value: "Thu, 29 Oct 2026 00:00:00 GMT" },
  });
  expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "catchup", baseline: "10", pages: 1 } });
  expect(await t.cursor()).not.toHaveProperty("historyId");
  const before = (await t.backend.store.debug.snapshot()).messages;
  expect(before).toHaveLength(1);
  expect(before[0]!.bodyText).toBe("Small body\n");
  expect((await t.backend.store.accounts.get(t.account.id))!.syncState.lastSyncAt).toBeNull();
  expect(t.backend.net.googlePending()).toBe(0);
  const bindings = decodeCooldown(await t.backend.store.providerCooldown.read()).bindings;
  expect(bindings).toMatchObject([{ id: t.account.id, createdAt: 1, mailboxKey: await mailboxDigest(t.account.email, (bytes) => crypto.subtle.digest("SHA-256", bytes)) }]);
  failing = false;
  await t.backend.syncAccount(t.account.id);
  expect(await t.cursor()).toEqual({ historyId: "11" });
  expect((await t.backend.store.debug.snapshot()).messages).toEqual(before);
  expect((await t.backend.store.accounts.get(t.account.id))!.syncState).toMatchObject({ status: "idle", lastError: null });
  expect((await t.backend.store.accounts.get(t.account.id))!.syncState.lastSyncAt).not.toBeNull();
  expect(t.fixture.requests.filter(({ url }) => url.searchParams.get("format") === "raw")).toHaveLength(1);
  expect(t.fixture.requests.filter(({ url }) => url.pathname.endsWith("/history")).map(({ url }) => url.searchParams.get("startHistoryId"))).toEqual(["10", "10"]);
  expect(t.backend.net.googlePending()).toBe(0);
  expect(t.fixture.unexpected).toEqual([]);
});
