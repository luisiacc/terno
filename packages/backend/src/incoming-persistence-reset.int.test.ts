import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imapkit from "imapkit";
import { ImapFlow } from "imapflow";
import { expect, it, vi } from "vitest";
import { createRegistry } from "@terno/mail";
import type { MailProvider, ProviderContext } from "@terno/mail/portable";
import type { CaptureLocator } from "@terno/core";
import { openDatabase, SqlMailStore } from "@terno/db";
import { nodePlatform } from "../../db/src/node-driver";
import { IdbMailStore } from "../../idb/src/store";
import * as opStorage from "../../idb/src/op-storage";
import { Backend, plaintextCipher } from "./backend";
import { createNodeIncomingProcessor } from "./incoming-worker";

function gate() { let release!: () => void; return { promise: new Promise<void>((resolve) => { release = resolve; }), get release() { return release; } }; }
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const engine of ["sql", "idb"] as const) for (const action of ["reset", "close"] as const) it(`${engine} ${action} fences an already parsed body through observed persistence retirement`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-persist-reset-")), name = crypto.randomUUID(), entered = gate(), release = gate();
  const server = imapkit({ plugins: ["SPECIAL-USE"], storage: { INBOX: {} } });
  const siblingAbort = new AbortController();
  const port = await server.start(0, "127.0.0.1");
  const text = Array(100).fill("new exact phrase ".repeat(80)).join("\r\n");
  server.control.addMessage("INBOX", { raw: `From: sender@example.test\r\nSubject: Synthetic\r\nMessage-ID: <persistence@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=new.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID\r\n--b--\r\n` });
  let armed = false, staged = false, nativeParts = 0, publications = 0, bodyFetches = 0, terminals = 0;
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (engine === "sql" && armed && staged) { armed = false; entered.release(); await release.promise; } } };
  const db = engine === "sql" ? openDatabase(join(dir, "synthetic.db")) : undefined;
  let store = db ? new SqlMailStore(db, { platform, instantSearch: false }) : await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  const spies: { mockRestore(): void }[] = [];
  const unexpected: string[] = [];
  spies.push(vi.spyOn(globalThis, "fetch").mockImplementation(async () => { unexpected.push("Unexpected HTTP during IMAP persistence"); throw new Error(unexpected.at(-1)); }));
  const fetch = ImapFlow.prototype.fetch;
  spies.push(vi.spyOn(ImapFlow.prototype, "fetch").mockImplementation(async function* (this: ImapFlow, ...args) { if (args[1]?.source) bodyFetches++; for await (const row of fetch.apply(this, args)) yield row; if (args[1]?.source) terminals++; }));
  let provider!: MailProvider, context!: ProviderContext, caller!: AbortSignal, acknowledgedCursor: unknown;
  const registry = createRegistry({ imap: { allowInsecure: true } });
  const processor = createNodeIncomingProcessor(), processing = vi.spyOn(processor, "run");
  const backend = new Backend({ store, platform, incomingProcessor: processor, providers: { ...registry, create(ctx) { context = ctx; provider = registry.create({ ...ctx, async saveCursor(cursor) { await ctx.saveCursor(cursor); acknowledgedCursor = structuredClone(cursor); } }); return { ...provider, sync(sink) { caller = sink.signal; return provider.sync(sink); } }; } }, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let backendStopped = false;
  let work: Promise<unknown> | undefined, closing: Promise<void> | undefined, sibling: Promise<void> | undefined, releaseSibling: (() => void) | undefined;
  try {
    await backend.ready;
    const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "brown", now: 1 });
    await store.accounts.setProviderConfig(account.id, { imap: { host: "127.0.0.1", port, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" } });
    await store.secrets.put(`account:${account.id}:password`, await plaintextCipher.encrypt("testpass"));
    await backend.syncAccount(account.id);
    const message = (await store.debug.snapshot()).messages[0]!, location = (await context.store.locations.of([message.id]))[0]!;
    const locator: CaptureLocator = { kind: "imap", messageId: message.id, mailbox: location.mailbox, uid: location.uid, uidvalidity: location.uidvalidity };
    await store.sync.setBody(message.id, "Exact old cached text", "<p>Exact old cached HTML</p>", { now: 2, classifier: null, attachments: [{ filename: "old.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }] });
    await store.attachments.retry(account.id, message.id);
    await store.captureRepairs.block(account.id, locator, "mime-depth", 0);
    const blocked = (await store.captureRepairs.get(account.id, locator))!;
    await store.captureRepairs.retry(account.id, blocked.key, blocked.revision);
    const view = async () => { const assets = await store.attachments.current(account.id, { id: message.id }); return { messages: (await store.debug.snapshot()).messages, assets, bytes: await Promise.all(assets.map((asset) => store.attachments.read(account.id, asset.assetId!, 0))), repair: await store.captureRepairs.get(account.id, locator), pending: await context.store.pendingBodies(10) }; };
    const before = await view();
    if (db) {
      const run = db.run.bind(db);
      spies.push(vi.spyOn(db, "run").mockImplementation((sql, ...params) => { const result = run(sql, ...params); if (armed && sql.startsWith("INSERT INTO body_parts")) { staged = true; nativeParts++; } return result; }));
    } else {
      const prepare = opStorage.prepareOpWrites;
      spies.push(vi.spyOn(opStorage, "prepareOpWrites").mockImplementation(async (...args) => { const plans = await prepare(...args); if (armed && [...args[0].writes.keys()].some((table) => table.spec.name === "body_heads")) { armed = false; entered.release(); await release.promise; } return plans; }));
      const put = IDBObjectStore.prototype.put;
      spies.push(vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) { if (this.name === "body_parts") nativeParts++; if (this.name === "body_heads") publications++; return put.call(this, value, key); }));
    }
    armed = true; work = backend.syncAccount(account.id);
    await entered.promise;
    expect(nativeParts).toBeGreaterThan(0); expect(processing).toHaveBeenCalledTimes(2); expect(terminals).toBe(2); expect(bodyFetches).toBe(2);
    const cursor = acknowledgedCursor;
    if (action === "reset") provider.reset!(); else closing = provider.close();
    expect(caller.aborted).toBe(false);
    let admitted = false;
    sibling = context.incoming!.promote!(account.id + 100, siblingAbort.signal).then((grant) => { admitted = true; releaseSibling = grant; });
    await turn(); await turn(); expect(admitted, "logical reset is not physical persistence retirement").toBe(false);
    release.release(); await sibling; expect(admitted).toBe(true); releaseSibling!(); await work; await closing;
    expect(JSON.stringify(await view()) === JSON.stringify(before), "captured reset must preserve exact cached body/assets and repair responsibility").toBe(true);
    expect((await store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor).toEqual(cursor);
    if (engine === "idb") expect(publications, "captured reset must be checked after real async preparation and before native publication").toBe(0);
    expect(bodyFetches).toBe(2);
    await backend.stop(); backendStopped = true;
    store = db ? new SqlMailStore(openDatabase(join(dir, "synthetic.db")), { platform, instantSearch: false }) : await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    const reopened = (await store.threads.get(message.threadId))!.messages[0]!;
    expect(reopened.bodyText).toBe("Exact old cached text"); expect(reopened.bodyHtml).toBe("<p>Exact old cached HTML</p>");
    expect(await store.attachments.read(account.id, reopened.attachments[0]!.assetId!, 0)).toBe("AP+A");
    expect(await store.captureRepairs.get(account.id, locator)).toEqual(before.repair);
  } finally { release.release(); siblingAbort.abort(); await Promise.allSettled([work, closing, sibling].filter((p) => p !== undefined)); releaseSibling?.(); try { if (!backendStopped) await backend.stop(); if (store.isOpen) await store.close(); } finally { for (const spy of spies.reverse()) spy.mockRestore(); await server.stop(); rmSync(dir, { recursive: true, force: true }); indexedDB.deleteDatabase(`terno-${name}`); expect(unexpected).toEqual([]); } }
});
