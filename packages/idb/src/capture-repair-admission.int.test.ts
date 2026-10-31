import { nodeBodyPreparationFactory } from "../../db/src/node-driver";
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import type { CaptureLocator } from "@terno/core";
import type { IncomingMessage } from "@terno/store";
import type { ProviderRegistry, SyncSink } from "../../mail/src/types";
import { parseRaw } from "../../mail/src/mime";
import { Backend, plaintextCipher } from "../../backend/src/backend";
import { IdbMailStore } from "./store";
import * as opStorage from "./op-storage";
import { afterEach, expect, it, vi } from "vitest";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });
function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }
const incoming = (accountId: number, kind: "gmail" | "imap"): IncomingMessage => ({ accountId, providerMsgId: "p", providerThreadId: null, rfcMessageId: "p@example.test", inReplyTo: null, references: [], from: { name: "", email: "sender@example.test" }, to: [], cc: [], bcc: [], subject: "Exact cached source", date: 1, snippet: "", bodyText: "Cached body", bodyHtml: "<p>Cached HTML</p>", bodyState: "full", listId: null, isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: true, size: 2, attachments: [{ filename: "old.bin", mime: "application/octet-stream", size: 2, bytes: new Uint8Array([9, 8]) }], ...(kind === "imap" && { locations: [{ mailbox: "Projects", uidvalidity: 10, uid: 2, flags: [] }] }) });

async function fixture(kind: "gmail" | "imap", blocked = true, partial = false) {
  const unexpected: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { unexpected.push("Unexpected request during local admission control"); throw new Error(unexpected.at(-1)); });
  const dir = mkdtempSync(join(tmpdir(), "terno-repair-admission-")), factory = new IDBFactory(), name = crypto.randomUUID();
  const platform = { bodyPreparation: nodeBodyPreparationFactory, uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  let action: ((sink: SyncSink) => Promise<void>) | undefined;
  let lastSink: SyncSink | undefined;
  const providers: ProviderRegistry = { create: () => ({ async verify() {}, async close() {}, async execute() { throw new Error("Unexpected mutation"); }, async sync(sink) { lastSink = sink; await action?.(sink); } }), async verifyImap() {}, async connectGmail() { throw new Error("Unexpected consent"); } };
  const open = async () => new Backend({ store: await IdbMailStore.open({ factory, name, platform, instantSearch: false }), platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, iconTransport: null });
  let backend = await open(); await backend.ready;
  const { account } = await backend.store.accounts.create({ kind, email: "synthetic@example.test", displayName: "Synthetic", color: "blue", providerConfig: { demo: true }, now: 1 });
  const sibling = await backend.store.accounts.create({ kind: "imap", email: "sibling@example.test", displayName: "Sibling", color: "blue", now: 1 });
  const source = { ...incoming(account.id, kind), ...(partial && { bodyState: "partial" as const }) };
  await backend.ingestSliced([source, { ...incoming(sibling.account.id, "imap"), providerMsgId: "sibling", rfcMessageId: "sibling@example.test" }], false);
  const id = (await backend.store.providerStore(account.id).messageByProviderId("p"))!.id;
  const locator: CaptureLocator = kind === "gmail" ? { kind, providerId: "p" } : { kind, messageId: id, mailbox: "Projects", uidvalidity: 10, uid: 2 };
  await backend.store.attachments.retry(account.id, id);
  if (blocked) await backend.store.captureRepairs.block(account.id, locator, kind === "gmail" ? "mime-parts" : "mime-depth", 0);
  const clients: RpcClient[] = [], runs: Promise<unknown>[] = [], releases: (() => void)[] = [];
  cleanup.push(async () => { for (const release of releases) release(); await Promise.allSettled(runs); for (const client of clients) client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); expect(unexpected).toEqual([]); });
  return { account, id, locator, source,
    get backend() { return backend; }, get sink() { return lastSink!; },
    setAction(next: typeof action) { action = next; },
    gate() { const result = gate(); releases.push(result.release); return result; },
    observe(run: Promise<unknown>) { runs.push(run); return Promise.allSettled([run]); },
    rpc() { const [local, remote] = createMemoryTransportPair(); backend.connect(remote, { clientId: "admission", origin: "renderer" }); const client = new RpcClient(local); clients.push(client); return client; },
    async view() {
      const snapshot = await backend.store.debug.snapshot();
      const assets = await backend.store.attachments.current(account.id, { id });
      return { messages: snapshot.messages, ops: snapshot.ops, assets, bytes: await Promise.all(assets.map((a) => backend.store.attachments.read(account.id, a.assetId!, 0))), repairs: await backend.store.captureRepairs.list(account.id) };
    },
    async reopen() { action = undefined; await backend.stop(); backend = await open(); await backend.ready; },
  };
}

it.each(["ingest", "body", "publication", "retry", "retirement", "attachments"] as const)("R3 captured credential generation fences %s after real async IDB preparation", async (mode) => {
  const t = await fixture(mode === "body" ? "imap" : "gmail", mode !== "publication", mode === "ingest");
  const completion = mode === "ingest" || mode === "body";
  if (completion) {
    const row = (await t.backend.store.captureRepairs.get(t.account.id, t.locator))!;
    await t.backend.store.captureRepairs.retry(t.account.id, row.key, row.revision);
    await t.backend.store.filters.save({ name: "Repaired body star", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "Repaired" }], actions: [{ type: "star" }] } }, 1);
  }
  const before = await t.view(), oldGeneration = t.backend.credentialsOf(t.account.id);
  const accountRead = t.gate(), accountRelease = t.gate(), installed = t.gate(), prepared = t.gate(), release = t.gate();
  const get = t.backend.store.accounts.get.bind(t.backend.store.accounts); let captureRead = true;
  vi.spyOn(t.backend.store.accounts, "get").mockImplementation(async (id) => { const value = await get(id); if (captureRead && id === t.account.id) { captureRead = false; accountRead.release(); await accountRelease.promise; } return value; });
  const signing = t.observe(t.backend.signedIn(t.account.id, () => installed.release()));
  await accountRead.promise;
  const realPrepare = opStorage.prepareOpWrites; let armed = true, operationCount = 0;
  vi.spyOn(opStorage, "prepareOpWrites").mockImplementation(async (commit, host) => {
    const plans = await realPrepare(commit, host);
    if (armed && [...commit.writes.keys()].some((table) => table.spec.name === "capture_repairs")) { armed = false; operationCount = plans.length; prepared.release(); await release.promise; }
    return plans;
  });
  const repair = (await t.backend.store.captureRepairs.get(t.account.id, t.locator));
  const parsed = await parseRaw(`From: sender@example.test\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n${mode === "body" ? "Repaired exact body ".repeat(6000) : "Repaired exact body"}\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=new.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID\r\n--b--\r\n`);
  t.setAction(async (sink) => {
    if (mode === "publication") await sink.blockCapture!(t.locator, "mime-parts", 0);
    else if (mode === "retirement") await sink.retireCapture!(t.locator);
    else if (mode === "body") await sink.setBody(t.id, parsed.text, parsed.html, parsed.attachments, { repair: { key: repair!.key, revision: repair!.revision } });
    else if (mode === "ingest") await sink.ingest([{ ...t.source, bodyState: "full", bodyText: parsed.text, bodyHtml: parsed.html, attachments: parsed.attachments, repair: { key: repair!.key, revision: repair!.revision } }]);
  });
  const run = t.observe(mode === "retry" ? t.backend.retryCapture(t.account.id, repair!.key, repair!.revision) : mode === "attachments" ? t.rpc().call("attachments.retry", { accountId: t.account.id, messageId: t.id }) : t.backend.syncAccount(t.account.id));
  await prepared.promise;
  if (completion) expect(operationCount).toBeGreaterThan(0);
  accountRelease.release(); await installed.promise;
  expect(t.backend.credentialsOf(t.account.id)).toBe(oldGeneration + 1);
  release.release(); await run; await signing;
  expect(await t.view()).toEqual(before);
  await t.reopen(); expect(await t.view()).toEqual(before);
});

it("R3 deletion aborts an admitted repaired body before native persistence and cannot affect a replacement account", async () => {
  const t = await fixture("imap"), row = (await t.backend.store.captureRepairs.get(t.account.id, t.locator))!;
  await t.backend.store.captureRepairs.retry(t.account.id, row.key, 0);
  const before = await t.view(), prepared = t.gate(), release = t.gate();
  const realPrepare = opStorage.prepareOpWrites; let armed = true;
  vi.spyOn(opStorage, "prepareOpWrites").mockImplementation(async (commit, host) => { const plans = await realPrepare(commit, host); if (armed && [...commit.writes.keys()].some((table) => table.spec.name === "capture_repairs")) { armed = false; prepared.release(); await release.promise; } return plans; });
  t.setAction((sink) => sink.setBody(t.id, "Repaired old owner", null, [], { repair: { key: row.key, revision: 1 } }));
  const run = t.observe(t.backend.syncAccount(t.account.id)); await prepared.promise;
  const dropped = t.observe(t.backend.dropAccount(t.account.id, { remove: true }));
  expect(t.sink.signal.aborted).toBe(true); release.release(); await run; await dropped;
  expect(await t.view()).toEqual(before);
  await t.backend.store.accounts.remove(t.account.id); t.backend.accountRemoved(t.account.id);
  const replacement = await t.backend.store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Replacement", color: "blue", now: 1 });
  expect(replacement.account.id).toBeGreaterThan(t.account.id);
  await t.reopen(); expect(await t.backend.store.accounts.get(t.account.id)).toBeNull(); expect((await t.view()).repairs.items).toEqual([]);
  expect((await t.view()).messages).toEqual(before.messages.filter((m) => m.accountId !== t.account.id));
});

it("R3 exact retry waits for the existing sync owner and keeps its selected revision", async () => {
  const t = await fixture("gmail"), row = (await t.backend.store.captureRepairs.get(t.account.id, t.locator))!;
  const entered = t.gate(), release = t.gate(), queued = t.gate(); let passes = 0;
  t.setAction(async (sink) => {
    if (++passes === 1) { entered.release(); await release.promise; }
    else expect(sink.captureRetry).toEqual({ locator: t.locator, revision: 1 });
  });
  const running = t.observe(t.backend.syncAccount(t.account.id)); await entered.promise;
  const repairs = t.backend.store.captureRepairs;
  vi.spyOn(t.backend.store, "captureRepairs", "get").mockReturnValue({ ...repairs, retry: async (...args) => { await repairs.retry(...args); queued.release(); } });
  const retry = t.observe(t.backend.retryCapture(t.account.id, row.key, row.revision)); await queued.promise;
  expect(passes).toBe(1); release.release(); await running; await retry;
  expect(passes).toBe(2);
  expect(await repairs.get(t.account.id, t.locator)).toMatchObject({ state: "pending", revision: 1 });
  await t.reopen(); expect(await t.backend.store.captureRepairs.get(t.account.id, t.locator)).toMatchObject({ state: "pending", revision: 1 });
});
