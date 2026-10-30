/** app.export: what a browser mailbox can't afford to lose (categories, filters, settings, unsent work), never secrets. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { sqlDb } from "@terno/db";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { seedDemo } from "./demo";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

it("exports categories, filters, settings, drafts and unsent ops, and no secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-export-"));
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await seedDemo(backend.store, { threads: 200, accounts: 2 });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  await backend.setSecret("ai:anthropic:apiKey", "sk-ant-secret-1234");
  await client.call("settings.update", { gmailClientId: "client-1.apps.googleusercontent.com", density: "compact" });
  const { accounts } = await client.call("app.bootstrap", {});
  const thread = (await client.call("threads.list", { view: "inbox", limit: 1 })).items[0]!;
  await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
  await client.call("drafts.save", { accountId: accounts[0]!.id, to: [{ name: "", email: "ana@example.com" }], cc: [], subject: "Borrador", bodyText: "hola" });

  const dump = await client.call("app.export", {});
  expect(dump).toMatchObject({ format: "terno-export", version: 2 });
  expect(dump.categories.length).toBeGreaterThan(0);
  expect(dump.filters.map((f) => f.name)).toContain("Notificaciones de GitHub → Desarrollo");
  expect(dump.settings).toMatchObject({ gmailClientId: "client-1.apps.googleusercontent.com", density: "compact" });
  expect(dump.accounts.map((a) => a.email)).toEqual(accounts.map((a) => a.email));
  expect(dump.drafts).toMatchObject([{ subject: "Borrador", mode: "new", bcc: [], quotedText: "", inReplyTo: null, forwardOf: null }]);
  expect(dump.ops).toMatchObject([{ kind: "archive", state: "queued" }]);
  expect(JSON.stringify(dump)).not.toContain("sk-ant-secret");
  // agents can't take it
  await expect(backend.server.invoke("app.export", {}, { clientId: "agent", origin: "mcp" })).rejects.toBeTruthy();
});

it("exports exact draft attachment bytes, imports with fresh account-owned IDs, and preserves byte-distinct drafts on repeated import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-export-assets-"));
  const make = (name: string) => {
    const b = new Backend({ dbPath: join(dir, name), version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
    cleanups.push(() => b.stop());
    return b;
  };
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  const source = make("source.db"); const target = make("target.db");
  const account = async (b: Backend) => (await b.store.accounts.create({ kind: "gmail", email: "a@test.com", displayName: "A", color: "indigo", now: 0 })).account.id;
  const a = await account(source); const other = await account(target);
  for (const dataBase64 of ["AP+A", "AQID"]) {
    const ref = await source.store.attachments.create({ accountId: a, filename: "same.bin", mime: "application/octet-stream", size: 3, now: 0 });
    await source.store.attachments.append(a, ref.assetId, 0, dataBase64); await source.store.attachments.seal(a, ref.assetId);
    await source.store.drafts.save({ accountId: a, to: [], cc: [], subject: "same draft", bodyText: "same", attachments: [ref] }, 0);
  }
  const invoke = (b: Backend) => { const [c,s] = createMemoryTransportPair(); b.connect(s, { clientId: "r", origin: "renderer" }); return new RpcClient(c); };
  const dump = await invoke(source).call("app.export", {});
  expect(dump.drafts.map((d) => d.attachments?.[0]?.chunks)).toEqual([["AP+A"], ["AQID"]]);
  const dest = invoke(target);
  expect((await dest.call("app.import", { data: dump })).drafts).toBe(2);
  const drafts = await target.store.drafts.list();
  expect(drafts).toHaveLength(2);
  const parts = drafts.map((d) => JSON.parse(d.attachments_json)[0]);
  expect(parts.map((a) => a.assetId)).not.toEqual((await source.store.drafts.list()).map((d) => JSON.parse(d.attachments_json)[0].assetId));
  expect(await Promise.all(parts.map((p) => target.store.attachments.read(other, p.assetId, 0)))).toEqual(["AP+A", "AQID"]);
  expect((await dest.call("app.import", { data: dump })).drafts).toBe(0);
  expect(await target.store.drafts.list()).toHaveLength(2);
  const damaged = structuredClone(dump);
  damaged.drafts[0]!.attachments![0]!.chunks = [];
  await expect(dest.call("app.import", { data: damaged })).rejects.toThrow();
  expect(await target.store.drafts.list()).toHaveLength(2);
  const disconnected = make("disconnected.db");
  await expect(invoke(disconnected).call("app.import", { data: dump })).rejects.toThrow();
  expect(await disconnected.store.drafts.list()).toHaveLength(0);
});

it.each(["", "AP+A"])("repeated attached-draft import at full quota is a reservation-free no-op (%s)", async (dataBase64) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-import-full-"));
  const backend = new Backend({ dbPath: join(dir, "mail.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  const accountId = (await backend.store.accounts.create({ kind: "gmail", email: "a@test.com", displayName: "A", color: "indigo", now: 0 })).account.id;
  const size = dataBase64 ? 3 : 0;
  const ref = await backend.store.attachments.create({ accountId, filename: "same.bin", mime: "application/octet-stream", contentId: "part%25@test", size, now: Date.now() });
  if (size) await backend.store.attachments.append(accountId, ref.assetId, 0, dataBase64);
  await backend.store.attachments.seal(accountId, ref.assetId);
  await backend.store.drafts.save({ accountId, to: [], cc: [], subject: "same", bodyText: "same", attachments: [ref] }, 0);
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "full", origin: "renderer" }); const client = new RpcClient(c);
  const dump = await client.call("app.export", {});
  for (let i = 0; i < 14; i++) await backend.store.attachments.create({ accountId, filename: "reserved", mime: "text/plain", size: 18 * 1024 * 1024, now: Date.now() });
  await backend.store.attachments.create({ accountId, filename: "last", mime: "text/plain", size: 4 * 1024 * 1024 - size - 16 * 1024, now: Date.now() });
  const before = await backend.store.drafts.list();
  const db = sqlDb(backend.store);
  const assets = db.all("SELECT * FROM attachment_assets ORDER BY id");
  const create = vi.spyOn(backend.store.attachments, "create");
  expect((await client.call("app.import", { data: dump })).drafts).toBe(0);
  const canonical = structuredClone(dump);
  canonical.drafts[0]!.attachments![0]!.filename = "../same.bin";
  canonical.drafts[0]!.attachments![0]!.mime = "APPLICATION/OCTET-STREAM";
  expect((await client.call("app.import", { data: canonical })).drafts).toBe(0);
  expect(create).not.toHaveBeenCalled();
  expect(await backend.store.drafts.list()).toEqual(before);
  expect(db.all("SELECT * FROM attachment_assets ORDER BY id")).toEqual(assets);
  client.close();
});

it.each(["long", "unicode", "legacy"])("canonical %s filenames re-import at full quota without rewriting persisted metadata", async (kind) => {
  const backend = new Backend({ dbPath: ":memory:", version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(() => backend.stop());
  const accountId = (await backend.store.accounts.create({ kind: "gmail", email: "a@test.com", displayName: "A", color: "indigo", now: 0 })).account.id;
  let ref = await backend.store.attachments.create({ accountId, filename: kind === "unicode" ? "../résumé 📨. " : "a".repeat(119) + ".b", mime: "application/octet-stream", size: 3, now: Date.now() });
  await backend.store.attachments.append(accountId, ref.assetId, 0, "AP+A"); await backend.store.attachments.seal(accountId, ref.assetId);
  const db = sqlDb(backend.store);
  if (kind === "legacy") {
    // An immutable filename already emitted by the previous truncation policy.
    ref = { ...ref, filename: "a".repeat(119) + "." };
    db.run("UPDATE attachment_assets SET filename = ? WHERE id = ?", ref.filename, ref.assetId);
  }
  await backend.store.drafts.save({ accountId, to: [], cc: [], subject: "same", bodyText: "same", attachments: [ref] }, 0);
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "names", origin: "renderer" }); const client = new RpcClient(c);
  const dump = await client.call("app.export", {});
  for (let left = 256 * 1024 * 1024 - 1027; left >= 1024;) {
    const size = Math.min(18 * 1024 * 1024, left - 1024);
    await backend.store.attachments.create({ accountId, filename: "reserved", mime: "text/plain", size, now: Date.now() });
    left -= size + 1024;
  }
  const before = await backend.store.drafts.list();
  const assets = db.all("SELECT * FROM attachment_assets ORDER BY id");
  const create = vi.spyOn(backend.store.attachments, "create");
  try {
    expect((await client.call("app.import", { data: dump })).drafts).toBe(0);
    expect((await client.call("app.import", { data: dump })).drafts).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(await backend.store.drafts.list()).toEqual(before);
    expect(db.all("SELECT * FROM attachment_assets ORDER BY id")).toEqual(assets);
    expect(await backend.store.attachments.info(accountId, ref.assetId)).toEqual(ref);
    expect(await backend.store.attachments.read(accountId, ref.assetId, 0)).toBe("AP+A");
    expect(ref.filename).toBe(kind === "legacy" ? "a".repeat(119) + "." : kind === "unicode" ? "résumé 📨" : "a".repeat(119));
  } finally { client.close(); create.mockRestore(); }
});

it("a reply-all to 250 people saves, exports and imports back with its body (plan 34: one recipient limit)", async () => {
  const open = async (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `terno-${name}-`));
    const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
    cleanups.push(async () => {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    await seedDemo(backend.store, { threads: 20, accounts: 1 });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    return new RpcClient(c);
  };
  const from = await open("export");
  const { accounts } = await from.call("app.bootstrap", {});
  const many = Array.from({ length: 250 }, (_, i) => ({ name: `Persona ${i}`, email: `p${i}@example.com` }));
  await from.call("drafts.save", { accountId: accounts[0]!.id, to: many, cc: many.slice(0, 10), subject: "Todos", bodyText: "hola a todos" });
  const dump = await from.call("app.export", {});
  expect(dump.drafts[0]!.to).toHaveLength(250);
  const into = await open("import");
  const result = await into.call("app.import", { data: dump });
  expect(result.drafts).toBe(1);
  const imported = (await into.call("drafts.list", {})).find((d) => d.subject === "Todos")!;
  expect(imported.to).toHaveLength(250);
  expect(imported.cc).toHaveLength(10);
  expect(imported.bodyText).toBe("hola a todos");
});

it("backs up cross-account reply baselines and retains distinct contexts on repeated import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-reply-export-"));
  const make = (name: string) => {
    const b = new Backend({ dbPath: join(dir, name), version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
    cleanups.push(() => b.stop());
    return b;
  };
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  const source = make("source.db"), target = make("target.db");
  const setup = async (b: Backend) => {
    const sender = (await b.store.accounts.create({ kind: "gmail", email: "send@example.test", displayName: "Sender", color: "indigo", now: 0 })).account.id;
    const originalAccount = (await b.store.accounts.create({ kind: "gmail", email: "source@example.test", displayName: "Source", color: "indigo", now: 0 })).account.id;
    await b.store.sync.ingest([{ accountId: originalAccount, providerMsgId: "original", providerThreadId: "provider-thread", rfcMessageId: "original@example.test", inReplyTo: null, references: [], from: { name: "Source", email: "other@example.test" }, to: [], cc: [], bcc: [], subject: "Original", date: 1, snippet: "source", bodyText: "source", bodyHtml: null, bodyState: "full", listId: null, isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1 }], { applyFilters: false, now: 1, classifier: null });
    const original = (await b.store.debug.snapshot()).messages[0]!;
    return { sender, originalAccount, original };
  };
  const src = await setup(source); const dst = await setup(target);
  for (const baseline of ["Original", "Another"]) {
    await source.store.drafts.save({ accountId: src.sender, threadId: null, mode: "reply", inReplyToMessageId: src.original.id, replyContext: { subject: baseline, sourceId: src.original.id, sourceAccountId: src.originalAccount, rfcMessageId: "original@example.test" }, to: [], cc: [], subject: "Re: Original", bodyText: "authored", quotedText: "> source", includeQuote: true }, 1);
  }
  const invoke = (b: Backend) => { const [c, s] = createMemoryTransportPair(); b.connect(s, { clientId: "r", origin: "renderer" }); return new RpcClient(c); };
  const dump = await invoke(source).call("app.export", {});
  expect(dump.drafts.map((d) => d.replyContext?.sourceAccountEmail)).toEqual(["source@example.test", "source@example.test"]);
  const client = invoke(target);
  expect((await client.call("app.import", { data: dump })).drafts).toBe(2);
  expect((await client.call("app.import", { data: dump })).drafts).toBe(0);
  const drafts = await target.store.drafts.list();
  expect(drafts).toHaveLength(2);
  expect(drafts.map((d) => JSON.parse(d.reply_context_json!))).toEqual(expect.arrayContaining([
    expect.objectContaining({ subject: "Original", sourceId: dst.original.id, sourceAccountId: dst.originalAccount }),
    expect.objectContaining({ subject: "Another", sourceId: dst.original.id, sourceAccountId: dst.originalAccount }),
  ]));
});
