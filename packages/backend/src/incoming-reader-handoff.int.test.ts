import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { Backend, plaintextCipher } from "./backend";
import { incomingGmailFixture } from "./incoming-gmail-fixture";

it("hands the admitted native raw reader directly to physical tracking without an unlock/reacquire", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terno-native-handoff-"));
  const plain = Array(12).fill("synthetic ".repeat(350)).join("\r\n"), source = `From: sender@example.test\r\nSubject: Synthetic\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n`;
  const wire = new TextEncoder().encode(JSON.stringify({ id: "m", threadId: "t", labelIds: ["INBOX"], raw: Buffer.from(source).toString("base64url") }));
  let controller!: ReadableStreamDefaultController<Uint8Array>, raw!: () => void;
  const requested = new Promise<void>((resolve) => { raw = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(next) { controller = next; next.enqueue(wire); } });
  const response = new Response(body), getReader = body.getReader.bind(body);
  let acquisitions = 0, releases = 0;
  const readerSpies: { mockRestore(): void }[] = [];
  const reading = vi.spyOn(body, "getReader").mockImplementation(() => {
    acquisitions++;
    const reader = getReader();
    const release = reader.releaseLock.bind(reader);
    readerSpies.push(vi.spyOn(reader, "releaseLock").mockImplementation(() => { releases++; release(); }));
    return reader;
  });
  const fixture = incomingGmailFixture({ ids: ["m"], raw: () => { raw(); return response; } });
  const providers: ProviderRegistry = { create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }), async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); } };
  const backend = new Backend({ dbPath: join(directory, "synthetic.db"), providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let work: Promise<void> | undefined;
  try {
    await backend.ready;
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
    fixture.accounts.set("synthetic", account.email);
    work = backend.syncAccount(account.id); await requested;
    // Native acquisition happens in the managed transport before the raw response is admitted.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquisitions, "one native ownership acquisition must survive admission").toBe(1);
    expect(releases, "admission must not manufacture native reader release errors before handoff").toBe(0);
    expect(backend.net.googlePending()).toBe(1);
    controller.close(); await work;
    const message = (await backend.store.debug.snapshot()).messages[0]!;
    expect(message.bodyText === `${plain.replaceAll("\r\n", "\n")}\n`).toBe(true);
    expect((await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor).toEqual({ historyId: "10" });
    expect(backend.net.googlePending()).toBe(0); expect(acquisitions).toBe(1); expect(releases).toBe(0);
    expect(fixture.requests.filter(({ url }) => url.searchParams.get("format") === "raw")).toHaveLength(1);
    expect(fixture.requests.filter(({ url }) => url.searchParams.get("format") === "minimal")).toHaveLength(1); expect(fixture.unexpected).toEqual([]);
  } finally { try { controller.close(); } catch { /* already physically closed */ } await work; try { await backend.stop(); } finally { reading.mockRestore(); for (const spy of readerSpies) spy.mockRestore(); fixture.transport.mockRestore(); rmSync(directory, { recursive: true, force: true }); } }
});

it("separates completed native control-reader retirement from the next provider work slice", async () => {
  const { nodePlatform } = await import("@terno/db");
  const directory = mkdtempSync(join(tmpdir(), "terno-control-retirement-"));
  let active = false, turns = 0, atRelease = -1, atLabels = -1;
  const fixture = incomingGmailFixture({ ids: [], raw: () => { throw new Error("Unexpected raw route"); }, profile(email) { active = true; turns = 0; return { historyId: "10", emailAddress: email }; }, observe(url) { if (url.pathname.endsWith("/labels")) atLabels = turns; } });
  const release = ReadableStreamDefaultReader.prototype.releaseLock;
  const spy = vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock").mockImplementation(function (this: ReadableStreamDefaultReader<Uint8Array>) { if (active && atRelease < 0) atRelease = turns; return release.call(this); });
  const providers: ProviderRegistry = { create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }), async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); } };
  const backend = new Backend({ dbPath: join(directory, "synthetic.db"), platform: { ...nodePlatform, async yield() { turns++; await nodePlatform.yield(); } }, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  try {
    await backend.ready;
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 }); fixture.accounts.set("synthetic", account.email);
    await backend.syncAccount(account.id);
    expect(atRelease, "actual native retirement has its own cooperative work turn").toBeGreaterThan(0);
    expect(atLabels, "subsequent provider work follows a separate turn").toBeGreaterThan(atRelease);
    expect(backend.net.googlePending()).toBe(0); expect(fixture.unexpected).toEqual([]);
  } finally { await backend.stop(); spy.mockRestore(); fixture.transport.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});
