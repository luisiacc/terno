import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_ACCOUNT_BYTES, ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, MAX_MIME_BYTES, type AttachmentRef } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { createRegistry, parseRaw } from "@terno/mail";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const to = [{ name: "Recipient", email: "recipient@example.test" }];

async function setup(kind: "gmail" | "imap" = "gmail") {
  const dir = mkdtempSync(join(tmpdir(), "terno-attachment-limits-"));
  let now = 1, mode: "accept" | "401" | "offline" = "accept";
  const routes: string[] = [], unexpected: string[] = [], sends: string[] = [];
  const intercept: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const route = `${req.method} ${req.url}`; routes.push(route);
    if (route === "POST https://oauth2.googleapis.com/token") return Response.json({ access_token: `synthetic-${routes.length}`, token_type: "Bearer", expires_in: 3600 });
    if (route === "GET https://gmail.googleapis.com/gmail/v1/users/me/profile") return Response.json({ emailAddress: "sender@example.test", historyId: "1" });
    if (route === "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      sends.push(await req.clone().text());
      if (mode === "401") { mode = "accept"; return Response.json({ error: { message: "synthetic expired token" } }, { status: 401 }); }
      if (mode === "offline") throw Object.assign(new TypeError("synthetic preconnection refusal"), { cause: { code: "ECONNREFUSED" } });
      return Response.json({ id: "synthetic-sent", threadId: "synthetic-thread" });
    }
    unexpected.push(route); throw new Error(`Unexpected synthetic route: ${route}`);
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(intercept);
  let backend!: Backend, client!: RpcClient;
  const open = async () => {
    backend = new Backend({ dbPath: join(dir, "mail.db"), version: "test", cipher: plaintextCipher, autoSync: false, instantSearch: false, iconTransport: null, providers: createRegistry(), now: () => now });
    const [a, b] = createMemoryTransportPair(); backend.connect(b, { clientId: "limits", origin: "renderer" }); client = new RpcClient(a);
    await backend.ready;
  };
  await open();
  cleanup.push(async () => { client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); expect(unexpected).toEqual([]); });
  const account = async (accountKind = kind) => (await backend.store.accounts.create({ kind: accountKind, email: "sender@example.test", displayName: "Synthetic", color: "indigo", providerConfig: accountKind === "imap" ? { appendToSent: false } : {}, now })).account.id;
  const accountId = await account();
  await backend.store.settings.set("app", { gmailClientId: "synthetic-client" });
  await backend.setSecret(`account:${accountId}:refreshToken`, "synthetic-refresh");
  return { accountId, account, routes, sends, setMode(value: typeof mode) { mode = value; }, setNow(value: number) { now = value; }, get backend() { return backend; }, get client() { return client; }, async reopen() { client.close(); await backend.stop(); await open(); } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function snapshot(t: Fixture) {
  const db = sqlDb(t.backend.store);
  return {
    assets: db.all("SELECT * FROM attachment_assets ORDER BY id"),
    chunks: db.all("SELECT c.*, b.data_base64 FROM attachment_chunks c JOIN attachment_bytes b ON b.chunk_id=c.id ORDER BY c.id"),
    parts: db.all("SELECT * FROM attachments ORDER BY id"),
    links: db.all("SELECT * FROM attachment_links ORDER BY id"),
    ops: db.all("SELECT id,payload_json,state FROM ops ORDER BY id"),
    messages: db.all("SELECT id FROM messages ORDER BY id"),
    copies: db.all("SELECT * FROM send_copies ORDER BY opId"),
  };
}
async function stage(t: Fixture, bytes: Buffer, accountId = t.accountId) {
  const ref = await t.client.call("attachments.create", { accountId, filename: "witness.bin", mime: "application/octet-stream", size: bytes.length });
  for (let offset = 0, index = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK, index++) await t.client.call("attachments.append", { accountId, assetId: ref.assetId, index, dataBase64: bytes.subarray(offset, offset + ATTACHMENT_CHUNK).toString("base64") });
  await t.client.call("attachments.seal", { accountId, assetId: ref.assetId });
  for (let offset = 0, index = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK, index++) expect(await t.client.call("attachments.read", { accountId, assetId: ref.assetId, index })).toEqual({ dataBase64: bytes.subarray(offset, offset + ATTACHMENT_CHUNK).toString("base64") });
  return ref;
}
async function save(t: Fixture, refs: AttachmentRef[], bodyText = "Exact body") {
  return (await t.client.call("drafts.save", { accountId: t.accountId, to, subject: "Limits witness", bodyText, attachments: refs }))!;
}
function params(d: Awaited<ReturnType<typeof save>>, refs = d.attachments) {
  return { accountId: d.accountId, to: d.to, subject: d.subject, bodyText: d.bodyText, attachments: refs, draftId: d.id, draftGeneration: d.generation, draftRevision: d.revision };
}
async function retained(t: Fixture, draft: Awaited<ReturnType<typeof save>>, before: ReturnType<typeof snapshot>) {
  expect((await t.client.call("drafts.list", {})).find((d) => d.id === draft.id)).toEqual(draft);
  expect(snapshot(t)).toEqual(before);
  expect(t.routes).toEqual([]);
}
async function reserve(t: Fixture, bytes: number) {
  while (bytes > 0) {
    const size = Math.min(MAX_ATTACHMENT_BYTES, bytes - 1024);
    expect(size).toBeGreaterThanOrEqual(0);
    await t.client.call("attachments.create", { accountId: t.accountId, filename: "capacity", mime: "application/octet-stream", size });
    bytes -= size + 1024;
  }
}

it("public per-part overflow and aggregate overflow retain the exact draft and every staged byte", async () => {
  const t = await setup(), ref = await stage(t, Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x61)), extra = await stage(t, Buffer.from([0, 255]));
  const draft = await save(t, [ref]), before = snapshot(t);
  await expect(t.client.call("attachments.create", { accountId: t.accountId, filename: "oversized", mime: "application/octet-stream", size: MAX_ATTACHMENT_BYTES + 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await retained(t, draft, before);
  await expect(t.client.call("compose.send", params(draft, [ref, extra]))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await retained(t, draft, before);
  await t.reopen(); await retained(t, draft, before);
});

it("100 distinct sealed parts admit; public 101-part refusal consumes nothing", async () => {
  const t = await setup(), refs: AttachmentRef[] = [];
  for (let i = 0; i < 101; i++) refs.push(await stage(t, Buffer.alloc(0)));
  const draft = await save(t, refs.slice(0, 100)), before = snapshot(t);
  await expect(t.client.call("compose.send", params(draft, refs))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await retained(t, draft, before);
  const { opId } = await t.client.call("compose.send", params(draft));
  await t.backend.runWorker();
  expect((await t.backend.store.ops.get(opId))?.state).toBe("succeeded");
  expect(t.sends).toHaveLength(1);
  expect((await parseRaw(Buffer.from(JSON.parse(t.sends[0]!).raw, "base64url"))).attachments).toHaveLength(100);
  const queued = snapshot(t); await t.reopen(); await t.backend.runWorker(); expect(snapshot(t)).toEqual(queued); expect(t.sends).toHaveLength(1);
});

it("encoded body overflow within decoded attachment limit preserves every byte and revision", async () => {
  const t = await setup(), ref = await stage(t, Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x5a));
  const draft = await save(t, [ref], "x".repeat(1024 * 1024)), before = snapshot(t);
  await expect(t.client.call("compose.send", params(draft))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await retained(t, draft, before); await t.reopen(); await retained(t, draft, before);
});

it("account reservations refuse locally, remain account independent and recover after discard", async () => {
  const t = await setup(), ref = await stage(t, Buffer.from([0, 255, 128])), draft = await save(t, [ref]);
  await reserve(t, ATTACHMENT_ACCOUNT_BYTES - 1027);
  const before = snapshot(t);
  await expect(t.client.call("attachments.create", { accountId: t.accountId, filename: "capacity", mime: "text/plain", size: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await retained(t, draft, before);
  const sibling = await t.account(); const other = await stage(t, Buffer.from([7]), sibling);
  const spare = before.assets.find((a) => a.id !== ref.assetId)!;
  await t.client.call("attachments.discard", { accountId: t.accountId, assetId: String(spare.id) });
  const replacement = await stage(t, Buffer.from([9]));
  expect(replacement.assetId).not.toBe(spare.id);
  await t.reopen();
  expect(await t.client.call("attachments.read", { accountId: sibling, assetId: other.assetId, index: 0 })).toEqual({ dataBase64: "Bw==" });
  expect(await t.client.call("attachments.read", { accountId: t.accountId, assetId: ref.assetId, index: 0 })).toEqual({ dataBase64: "AP+A" });
  expect((await t.client.call("drafts.list", {})).find((d) => d.id === draft.id)).toEqual(draft);
  expect(await t.client.call("ops.list", {})).toEqual([]); expect(t.routes).toEqual([]);
});

it("IMAP wire reservation rolls admission back even with optional Sent copy disabled", async () => {
  const t = await setup("imap"), ref = await stage(t, Buffer.from([1])), draft = await save(t, [ref]);
  await reserve(t, ATTACHMENT_ACCOUNT_BYTES - MAX_MIME_BYTES - 1025 + 1);
  const before = snapshot(t);
  await expect(t.client.call("compose.send", params(draft))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await retained(t, draft, before); await t.reopen(); await retained(t, draft, before);
  const spare = before.assets.find((a) => a.id !== ref.assetId)!;
  await t.client.call("attachments.discard", { accountId: t.accountId, assetId: String(spare.id) });
  const { opId } = await t.client.call("compose.send", params(draft));
  expect((await t.backend.store.ops.get(opId))?.state).toBe("queued");
  expect(snapshot(t).copies).toHaveLength(1); expect(t.routes).toEqual([]);
});

it("interrupted staging resumes one identity; incomplete, removed and expired refs cannot consume a draft", async () => {
  const t = await setup(), good = await stage(t, Buffer.from([4])), draft = await save(t, [good]);
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK + 5, 0x61); bytes.set([0, 255, 128, 13, 10], ATTACHMENT_CHUNK);
  const ref = await t.client.call("attachments.create", { accountId: t.accountId, filename: "resume.bin", mime: "application/octet-stream", size: bytes.length });
  const first = { accountId: t.accountId, assetId: ref.assetId, index: 0, dataBase64: bytes.subarray(0, ATTACHMENT_CHUNK).toString("base64") };
  await t.client.call("attachments.append", first); await t.reopen();
  await t.client.call("attachments.append", first);
  const before = snapshot(t);
  await expect(t.client.call("attachments.append", { ...first, dataBase64: Buffer.alloc(ATTACHMENT_CHUNK, 7).toString("base64") })).rejects.toThrow();
  await expect(t.client.call("attachments.append", { ...first, index: 2 })).rejects.toThrow();
  await expect(t.client.call("compose.send", params(draft, [ref]))).rejects.toThrow(); await retained(t, draft, before);
  await t.client.call("attachments.append", { ...first, index: 1, dataBase64: bytes.subarray(ATTACHMENT_CHUNK).toString("base64") });
  await t.client.call("attachments.seal", { accountId: t.accountId, assetId: ref.assetId });
  const complete = snapshot(t); expect(complete.assets).toHaveLength(2); expect(complete.chunks).toHaveLength(3);
  await t.client.call("attachments.discard", { accountId: t.accountId, assetId: ref.assetId });
  const removed = snapshot(t); await expect(t.client.call("compose.send", params(draft, [ref]))).rejects.toThrow(); await retained(t, draft, removed);
  const orphan = await stage(t, Buffer.from([8]));
  t.setNow(86400001); await stage(t, Buffer.alloc(0));
  expect(await t.client.call("attachments.info", { accountId: t.accountId, assetId: orphan.assetId })).toEqual(orphan);
  t.setNow(86400002); await stage(t, Buffer.alloc(0));
  const expired = snapshot(t); await expect(t.client.call("compose.send", params(draft, [orphan]))).rejects.toThrow(); await retained(t, draft, expired);
});

it.each(["401", "offline"] as const)("queued pins survive expiry and managed Gmail %s recovery without rebinding", async (mode) => {
  const t = await setup(), bytes = Buffer.alloc(ATTACHMENT_CHUNK + 5, 0x41); bytes.set([0, 255, 128, 13, 10], ATTACHMENT_CHUNK);
  const ref = await stage(t, bytes), draft = await save(t, [ref]);
  const { opId } = await t.client.call("compose.send", params(draft));
  const before = snapshot(t), payload = (await t.backend.store.ops.get(opId))!.payload_json;
  await expect(t.client.call("attachments.discard", { accountId: t.accountId, assetId: ref.assetId })).rejects.toThrow();
  t.setNow(172800002); const orphan = await stage(t, Buffer.alloc(0));
  expect(snapshot(t).chunks).toEqual(before.chunks); expect(snapshot(t).links).toEqual(before.links);
  t.setMode(mode); await t.backend.runWorker();
  if (mode === "offline") {
    expect((await t.backend.store.ops.get(opId))?.state).toBe("queued");
    t.setMode("accept"); await t.backend.store.ops.resumeNetwork(t.accountId, 172800002); await t.backend.runWorker();
  }
  expect((await t.backend.store.ops.get(opId))?.state).toBe("succeeded");
  expect(t.sends).toHaveLength(2);
  if (mode === "401") expect(t.sends[1] === t.sends[0]).toBe(true);
  const parsed = await parseRaw(Buffer.from(JSON.parse(t.sends[0]!).raw, "base64url"));
  expect(parsed.to).toEqual(to); expect(Buffer.from(parsed.attachments[0]!.bytes!)).toEqual(bytes);
  const retried = await parseRaw(Buffer.from(JSON.parse(t.sends[1]!).raw, "base64url"));
  expect(retried.to).toEqual(to); expect(retried.subject).toBe("Limits witness"); expect(retried.text).toBe("Exact body");
  expect(retried.messageId).toBe(parsed.messageId); expect(Buffer.from(retried.attachments[0]!.bytes!)).toEqual(bytes);
  const accepted = snapshot(t); await t.reopen(); await t.backend.runWorker();
  expect(snapshot(t)).toEqual(accepted); expect(t.sends).toHaveLength(2);
  expect((await t.backend.store.ops.get(opId))?.payload_json).toBe(payload);
  for (let i = 0; i < 2; i++) expect(await t.client.call("attachments.read", { accountId: t.accountId, assetId: ref.assetId, index: i })).toEqual({ dataBase64: bytes.subarray(i * ATTACHMENT_CHUNK, (i + 1) * ATTACHMENT_CHUNK).toString("base64") });
  expect(accepted.assets.map((a) => a.id).sort()).toEqual([ref.assetId, orphan.assetId].sort());
  expect(accepted.parts).toEqual(before.parts); expect(accepted.links).toEqual(before.links.filter((link) => link.op_id === null));
});

it("snapshot oracles reject duplicate ownership, chunk corruption and operation rebinding", async () => {
  const t = await setup(), ref = await stage(t, Buffer.from([0, 255, 128])), draft = await save(t, [ref]);
  await t.client.call("compose.send", params(draft));
  const expected = snapshot(t);
  for (const key of ["assets", "parts", "links"] as const) {
    const bad = structuredClone(expected); bad[key].push({ ...bad[key][0]! });
    expect(() => expect(bad).toEqual(expected)).toThrowError(/AssertionError|expected/);
  }
  const corrupted = structuredClone(expected); corrupted.chunks[0]!.data_base64 = "AAAA";
  expect(() => expect(corrupted).toEqual(expected)).toThrowError(/AssertionError|expected/);
  const rebound = structuredClone(expected); rebound.ops[0]!.payload_json = "{}";
  expect(() => expect(rebound).toEqual(expected)).toThrowError(/AssertionError|expected/);
});

it("interrupted orphan cleanup cannot reclaim or rebind a queued sibling across reopen", async () => {
  const t = await setup(), pinned = await stage(t, Buffer.from([0, 255, 128]));
  const draft = await save(t, [pinned]), { opId } = await t.client.call("compose.send", params(draft));
  const payload = (await t.backend.store.ops.get(opId))!.payload_json;
  const stale = await stage(t, Buffer.alloc(ATTACHMENT_CHUNK * 9, 0x5a));
  const db = sqlDb(t.backend.store);
  db.exec(`CREATE TRIGGER interrupt_cleanup BEFORE DELETE ON attachment_bytes
    WHEN OLD.chunk_id = '${stale.assetId}:8' BEGIN SELECT RAISE(ABORT, 'synthetic cleanup interruption'); END`);
  t.setNow(86400002);
  await expect(stage(t, Buffer.alloc(0))).rejects.toThrow();
  const interrupted = snapshot(t);
  expect(interrupted.assets.find((a) => a.id === stale.assetId)?.complete).toBe(-1);
  expect(interrupted.chunks.filter((c) => c.asset_id === stale.assetId)).toHaveLength(1);
  expect(await t.client.call("attachments.read", { accountId: t.accountId, assetId: pinned.assetId, index: 0 })).toEqual({ dataBase64: "AP+A" });
  await t.reopen();
  await expect(t.client.call("attachments.info", { accountId: t.accountId, assetId: stale.assetId })).rejects.toThrow();
  await expect(t.client.call("attachments.seal", { accountId: t.accountId, assetId: stale.assetId })).rejects.toThrow();
  sqlDb(t.backend.store).exec("DROP TRIGGER interrupt_cleanup");
  const fresh = await stage(t, Buffer.from([9]));
  expect(fresh.assetId).not.toBe(stale.assetId);
  expect(snapshot(t).assets.map((a) => a.id).sort()).toEqual([pinned.assetId, fresh.assetId].sort());
  await t.backend.runWorker(); expect(t.sends).toHaveLength(1);
  expect((await t.backend.store.ops.get(opId))?.state).toBe("succeeded");
  expect((await t.backend.store.ops.get(opId))?.payload_json).toBe(payload);
  const accepted = snapshot(t); await t.reopen(); await t.backend.runWorker();
  expect(snapshot(t)).toEqual(accepted); expect(t.sends).toHaveLength(1);
  expect(await t.client.call("attachments.read", { accountId: t.accountId, assetId: pinned.assetId, index: 0 })).toEqual({ dataBase64: "AP+A" });
});
