import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, MAX_MIME_BYTES, type AttachmentRef } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, sqlDb } from "@terno/db";
import { databaseName, IdbMailStore } from "@terno/idb";
import { createRegistry, parseRaw } from "@terno/mail";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

// plan 123: only Terno's own Google clients exist; tests carry a synthetic one
const TEST_GOOGLE = { preferred: "synthetic-client", clients: [{ clientId: "synthetic-client", clientSecret: "" }] };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { try { for (const fn of cleanup.splice(0).reverse()) await fn(); } finally { vi.restoreAllMocks(); } });
const to = [{ name: "Recipient", email: "recipient@example.test" }];
const tables = ["attachment_assets", "attachment_chunks", "attachment_bytes", "attachments", "attachment_links"] as const;
type Rows = Record<(typeof tables)[number], Record<string, unknown>[]>;
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
// a digest stands in for the bytes: deep-comparing 24 MB of base64 at every step was most of this file's time
const digest = (row: Record<string, unknown>) => (typeof row.data_base64 === "string" ? { ...row, data_base64: createHash("sha256").update(row.data_base64).digest("hex") } : row);
const sort = (rows: Record<string, unknown>[]) => rows.map(digest).sort((a, b) => String(a.id ?? a.chunk_id).localeCompare(String(b.id ?? b.chunk_id)));

async function setup(adapter: "sql" | "idb", smtp?: number, owned = cleanup) {
  const dir = mkdtempSync(join(tmpdir(), "terno-size-reopen-"));
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const sends: string[] = [], unexpected: string[] = [];
  let loseResponse = true;
  const intercept: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const route = `${req.method} ${req.url}`;
    if (smtp) { unexpected.push(route); throw new Error(`Unexpected SMTP fixture fetch ${route}`); }
    if (route === "POST https://oauth2.googleapis.com/token") return Response.json({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 3600 });
    if (route === "GET https://gmail.googleapis.com/gmail/v1/users/me/profile") return Response.json({ emailAddress: "sender@example.test", historyId: "1" });
    if (route === "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      sends.push(await req.text());
      if (loseResponse) throw new TypeError("synthetic response lost after complete request");
      return Response.json({ id: "accepted-id", threadId: "accepted-thread" });
    }
    unexpected.push(route); throw new Error(`Unexpected route ${route}`);
  };
  let backend!: Backend, client!: RpcClient;
  const open = async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(intercept);
    const store = adapter === "idb" ? await IdbMailStore.open({ name, factory, platform: nodePlatform, instantSearch: false }) : undefined;
    backend = new Backend({ googleClients: TEST_GOOGLE, store, dbPath: join(dir, "mail.db"), version: "test", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false, instantSearch: false, iconTransport: null, unsubscribeTransport: null, now: () => 1000 });
    const [a, b] = createMemoryTransportPair(); backend.connect(b, { clientId: "size-reopen", origin: "renderer" }); client = new RpcClient(a);
    await backend.ready;
  };
  owned.push(async () => { client?.close(); if (backend) await backend.stop(); rmSync(dir, { recursive: true, force: true }); expect(unexpected).toEqual([]); });
  await open();
  const accountId = (await backend.store.accounts.create({ kind: smtp ? "imap" : "gmail", email: "sender@example.test", displayName: "Synthetic", color: "indigo", now: 1000, providerConfig: smtp ? { imap: { host: "127.0.0.1", port: 1, secure: false, user: "synthetic" }, smtp: { host: "127.0.0.1", port: smtp, secure: false, user: "synthetic" }, appendToSent: false } : {} })).account.id;
  await backend.setSecret(`account:${accountId}:${smtp ? "password" : "refreshToken"}`, "synthetic-secret");
  return {
    accountId, sends, accept() { loseResponse = false; }, get backend() { return backend; }, get client() { return client; },
    async reopen() { client.close(); await backend.stop(); await open(); },
    async rows(): Promise<Rows> {
      if (adapter === "sql") return Object.fromEntries(tables.map((table) => [table, sort(sqlDb(backend.store).all(`SELECT * FROM ${table}`))])) as Rows;
      const db = await request(factory.open(databaseName(name)));
      try {
        const tx = db.transaction([...tables], "readonly");
        const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        const rows = await Promise.all(tables.map(async (table) => [table, sort(await request(tx.objectStore(table).getAll()))]));
        await done; return Object.fromEntries(rows) as Rows;
      } finally { db.close(); }
    },
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function binary(size: number, salt: number) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + (i >>> 8) + salt) % 256;
  return bytes;
}
async function stage(t: Fixture, bytes: Buffer, index: number) {
  const ref = await t.client.call("attachments.create", { accountId: t.accountId, filename: `witness-${index}.bin`, mime: "application/octet-stream", size: bytes.length });
  for (let offset = 0, part = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK, part++) await t.client.call("attachments.append", { accountId: t.accountId, assetId: ref.assetId, index: part, dataBase64: bytes.subarray(offset, offset + ATTACHMENT_CHUNK).toString("base64") });
  await t.client.call("attachments.seal", { accountId: t.accountId, assetId: ref.assetId });
  return ref;
}
async function bytesIntact(t: Fixture, refs: AttachmentRef[], bytes: Buffer[]) {
  for (const [i, ref] of refs.entries()) {
    expect(await t.client.call("attachments.info", { accountId: t.accountId, assetId: ref.assetId })).toEqual(ref);
    for (let offset = 0, part = 0; offset < bytes[i]!.length; offset += ATTACHMENT_CHUNK, part++) expect(await t.client.call("attachments.read", { accountId: t.accountId, assetId: ref.assetId, index: part })).toEqual({ dataBase64: bytes[i]!.subarray(offset, offset + ATTACHMENT_CHUNK).toString("base64") });
  }
}
function unchanged(actual: unknown, expected: unknown) { expect(actual).toEqual(expected); }
function firstQueueAssets(staged: Rows, queued: Rows) {
  expect(staged.attachment_assets).toHaveLength(2); expect(queued.attachments).toHaveLength(2);
  for (const table of ["attachment_assets", "attachment_chunks", "attachment_bytes"] as const) unchanged(queued[table], staged[table]);
}
async function save(t: Fixture, refs: AttachmentRef[], bodyText = "Exact body") {
  return (await t.client.call("drafts.save", { accountId: t.accountId, to, subject: "Recovery witness", bodyText, attachments: refs }))!;
}
async function send(t: Fixture, draft: Awaited<ReturnType<typeof save>>) {
  return t.client.call("compose.send", { accountId: t.accountId, to: draft.to, subject: draft.subject, bodyText: draft.bodyText, attachments: draft.attachments, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision });
}
async function captured(t: Fixture, opId: string) {
  const op = (await t.backend.store.ops.get(opId))!;
  return { id: op.id, payload: op.payload_json, target: op.target_json };
}
async function publication(t: Fixture, opId: string, providerId?: string) {
  const op = (await t.backend.store.ops.get(opId))!, target = JSON.parse(op.target_json) as { messageIds: number[] };
  const snapshot = await t.backend.store.debug.snapshot();
  const message = snapshot.messages.find((m) => m.id === target.messageIds[0])!;
  expect(message).toBeDefined();
  const messages = (await t.client.call("threads.get", { threadId: message.threadId })).messages;
  const publicMessage = messages.find((m) => m.id === message.id)!;
  if (providerId) expect(message.providerMsgId).toBe(providerId);
  return { id: message.id, attachments: publicMessage.attachments };
}
function wireContents(parsed: Awaited<ReturnType<typeof parseRaw>>, bytes: Buffer[], messageId: string) {
  expect(parsed.to).toEqual(to); expect(parsed.cc).toEqual([]); expect(parsed.bcc).toEqual([]);
  expect(parsed.subject).toBe("Recovery witness"); expect(parsed.text).toBe("Exact body");
  expect(messageId.length).toBeGreaterThan(0); expect(parsed.rfcMessageId).toBe(messageId);
  expect(parsed.attachments).toHaveLength(bytes.length);
  for (const [i, part] of parsed.attachments.entries()) { expect(part.filename).toBe(`witness-${i}.bin`); expect(Buffer.from(part.bytes!).equals(bytes[i]!)).toBe(true); }
}
async function wire(raw: Buffer, bytes: Buffer[], messageId: string) { wireContents(await parseRaw(raw), bytes, messageId); }
async function smtpServer(owned = cleanup) {
  const transcript: string[] = [], received: Buffer[] = [], envelopes: string[][] = [];
  let refused = 0;
  // a session joins the transcript once it speaks SMTP: a stranger's knock on the port (another app on this machine
  // probing new ports with an HTTP GET) is no connection Terno made
  const held = new Map<string, string[]>(), spoke = new Set<string>();
  const log = (...args: unknown[]) => {
    const meta = args[0] as { cid?: string; tnx?: string; command?: string } | undefined, line = format(...args);
    // a socket error names its session in the message ("%s %s %s", id, address, error)
    const cid = meta?.cid ?? (meta?.tnx === "error" ? String(args[2]) : undefined);
    if (!cid || spoke.has(cid)) { transcript.push(line); return; }
    const lines = [...(held.get(cid) ?? []), line];
    if (meta?.command === "EHLO" || meta?.command === "HELO") { spoke.add(cid); held.delete(cid); transcript.push(...lines); }
    else held.set(cid, lines);
  };
  const server = new SMTPServer({ size: 1, hidePIPELINING: true, disabledCommands: ["STARTTLS", "PIPELINING"], logger: { debug: log, info() {}, error: log, warn: log },
    onAuth(_auth, _session, cb) { cb(null, { user: "synthetic" }); },
    onMailFrom(_address, _session, cb) {
      if (server.options.size === 1) { refused++; cb(Object.assign(new Error("Message exceeds advertised SIZE 1"), { responseCode: 552 })); } else cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = []; stream.on("data", (chunk: Buffer) => chunks.push(chunk)); stream.on("error", cb);
      stream.on("end", () => { received.push(Buffer.concat(chunks)); envelopes.push(session.envelope.rcptTo.map((r) => r.address)); cb(); });
    },
  });
  owned.push(() => new Promise<void>((resolve) => server.close(resolve)));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: (server.server.address() as { port: number }).port, transcript, received, envelopes, get refused() { return refused; }, accept() { server.options.size = MAX_MIME_BYTES; } };
}

// Both stores keep staged assets through an SMTP refusal, a reopen and a new composition, at several chunks. The size
// limit below is each store's own check; attachment-limits-interruption.int has it end to end.
async function refuseSmtp(adapter: "sql" | "idb", owned: typeof cleanup) {
  const smtp = await smtpServer(owned), t = await setup(adapter, smtp.port, owned);
  const bytes = [binary(ATTACHMENT_CHUNK * 2 + 13, 3), binary(ATTACHMENT_CHUNK + 7, 91)];
  const refs = await Promise.all(bytes.map((b, i) => stage(t, b, i)));
  const draft = await save(t, refs, "Body before correction"), staged = await t.rows();
  await t.reopen(); unchanged(await t.client.call("drafts.list", {}), [draft]); unchanged(await t.rows(), staged); await bytesIntact(t, refs, bytes);
  const corrected = (await t.client.call("drafts.save", { ...draft, bodyText: "Exact body" }))!;
  expect(corrected.id).toBe(draft.id); expect(corrected.revision).toBe(draft.revision + 1);
  const { opId } = await send(t, corrected), queued = await captured(t, opId), message = await publication(t, opId);
  expect(await t.client.call("drafts.list", {})).toEqual([]);
  const queuedRows = await t.rows();
  const oldInventory = [{ opId, messageId: message.id }]; await inventory(t, oldInventory);
  expect(JSON.parse(queued.payload).attachments).toEqual(refs); expect(message.attachments).toMatchObject(refs);
  firstQueueAssets(staged, queuedRows);
  await t.backend.runWorker();
  expect((await t.backend.store.ops.get(opId))?.state).toBe("failed"); expect(smtp.refused).toBe(1);
  expect(smtp.transcript.join("\n")).toContain("SIZE 1"); expect(smtp.transcript.join("\n")).toContain("552 Message exceeds advertised SIZE 1");
  expect(smtp.transcript.join("\n")).toContain("C: MAIL FROM:");
  expect(smtp.received).toEqual([]); expect(smtp.transcript.some((line) => /C: DATA\b/.test(line))).toBe(false);
  unchanged(await captured(t, opId), queued); unchanged(await t.rows(), queuedRows); unchanged(await publication(t, opId), message);
  await inventory(t, oldInventory);
  await expect(t.client.call("ops.resolveUnknown", { opId, resolution: "retry" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  return { smtp, t, bytes, refs, draft, opId, queued, message, queuedRows, oldInventory };
}

async function recoverSmtp(flow: Awaited<ReturnType<typeof refuseSmtp>>) {
  const { smtp, t, bytes, refs, draft, opId, queued, message, queuedRows, oldInventory } = flow;
  smtp.accept(); await t.reopen(); await t.backend.runWorker(); expect(smtp.received).toEqual([]); expect(smtp.refused).toBe(1);
  unchanged(await captured(t, opId), queued); unchanged(await t.rows(), queuedRows);
  await inventory(t, oldInventory);
  const replacement = await save(t, refs), next = await send(t, replacement);
  expect(replacement.id).not.toBe(draft.id); expect(next.opId).not.toBe(opId);
  const acceptedMessage = await publication(t, next.opId); expect(acceptedMessage.id).not.toBe(message.id);
  const replacementOp = await captured(t, next.opId), replacementRows = await t.rows();
  const bothInventory = [...oldInventory, { opId: next.opId, messageId: acceptedMessage.id }]; await inventory(t, bothInventory);
  const newParts = replacementRows.attachments.filter((part) => part.message_id === acceptedMessage.id);
  expect(newParts).toHaveLength(refs.length);
  for (const [i, ref] of refs.entries()) expect(newParts[i]).toMatchObject({ asset_id: ref.assetId, filename: ref.filename, mime: ref.mime, size: ref.size });
  unchanged(replacementRows.attachments.filter((part) => part.message_id !== acceptedMessage.id), queuedRows.attachments);
  const newMessageLinks = refs.map((ref) => ({ ...queuedRows.attachment_links.find((link) => link.asset_id === ref.assetId && link.message_id === message.id)!, id: `${ref.assetId}:message:${acceptedMessage.id}`, message_id: acceptedMessage.id }));
  const newOpLinks = refs.map((ref) => ({ ...queuedRows.attachment_links.find((link) => link.asset_id === ref.assetId && link.op_id === opId)!, id: `${ref.assetId}:op:${next.opId}`, op_id: next.opId }));
  const expectedAccepted = { ...queuedRows, attachments: replacementRows.attachments, attachment_links: sort([...queuedRows.attachment_links, ...newMessageLinks]) };
  unchanged(replacementRows, { ...expectedAccepted, attachment_links: sort([...expectedAccepted.attachment_links, ...newOpLinks]) });
  await t.backend.runWorker(); expect((await t.backend.store.ops.get(next.opId))?.state).toBe("succeeded");
  expect(smtp.received).toHaveLength(1); expect(smtp.envelopes).toEqual([[to[0]!.email]]);
  await wire(smtp.received[0]!, bytes, JSON.parse(replacementOp.payload).messageId);
  unchanged(await publication(t, next.opId, JSON.parse(replacementOp.payload).messageId), acceptedMessage);
  expect((await t.backend.store.ops.get(opId))?.state).toBe("failed"); unchanged(await captured(t, opId), queued);
  acceptedIdentity(await captured(t, next.opId), replacementOp); await inventory(t, bothInventory);
  unchanged(await t.rows(), expectedAccepted);
  await t.reopen(); await t.backend.runWorker(); acceptedIdentity(await captured(t, next.opId), replacementOp); await inventory(t, bothInventory); unchanged(await t.rows(), expectedAccepted); unchanged(await publication(t, next.opId, JSON.parse(replacementOp.payload).messageId), acceptedMessage); await bytesIntact(t, refs, bytes); expect(smtp.received).toHaveLength(1);
}

for (const adapter of ["sql", "idb"] as const) {
  describe(`${adapter}: SMTP SIZE recovery`, { concurrent: false }, () => {
    const owned: typeof cleanup = [];
    let refused: Awaited<ReturnType<typeof refuseSmtp>> | undefined;
    let work: Promise<void> | undefined;
    afterAll(async () => {
      await work?.catch(() => {});
      const errors: unknown[] = [];
      for (const close of owned.splice(0).reverse()) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      vi.restoreAllMocks();
      refused = undefined; work = undefined;
      if (errors.length) throw new AggregateError(errors, "SMTP phase cleanup failed");
    });
    it("preserves staged assets through a permanent SMTP SIZE refusal", async () => {
      work = refuseSmtp(adapter, owned).then((value) => { refused = value; });
      await work;
    });
    it("recovers by explicit new composition using the same staged bytes", async () => {
      expect(refused, "the preceding actual refusal phase must complete").toBeDefined();
      work = recoverSmtp(refused!);
      await work;
    });
  });
}

// The size in the ref is what it reads, so nothing needs staging; without the check, an unknown asset is another refusal.
it.each(["sql", "idb"] as const)("%s: a message whose encoding doesn't fit is refused before the draft goes", async (adapter) => {
  const t = await setup(adapter), draft = await save(t, []);
  const attachments = [{ assetId: "not-staged", filename: "large.bin", mime: "application/octet-stream", size: MAX_ATTACHMENT_BYTES }];
  await expect(t.backend.store.compose.queueSend({ accountId: t.accountId, to, subject: draft.subject, bodyText: "x".repeat(1024 * 1024), attachments, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, now: 1000 }))
    .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("too large") });
  expect(await t.client.call("drafts.list", {})).toEqual([draft]);
  expect(await t.client.call("ops.list", {})).toEqual([]);
});

it("a message at the attachment limit reaches SMTP byte for byte", async () => {
  const smtp = await smtpServer(); smtp.accept();
  const t = await setup("sql", smtp.port), bytes = [binary(MAX_ATTACHMENT_BYTES - ATTACHMENT_CHUNK - 7, 3), binary(ATTACHMENT_CHUNK + 7, 91)];
  const refs = await Promise.all(bytes.map((b, i) => stage(t, b, i)));
  const { opId } = await send(t, await save(t, refs)), queued = await captured(t, opId);
  await t.backend.runWorker();
  expect((await t.backend.store.ops.get(opId))?.state).toBe("succeeded");
  expect(smtp.received).toHaveLength(1);
  await wire(smtp.received[0]!, bytes, JSON.parse(queued.payload).messageId);
}, 60_000); // 18 MB through JavaScript base64 three times: 10 s on a quiet machine

it.each(["sql", "idb"] as const)("%s: managed Gmail unknown survives reopen and only public explicit retry publishes", async (adapter) => {
  const t = await setup(adapter), bytes = [binary(ATTACHMENT_CHUNK + 7, 17), binary(ATTACHMENT_CHUNK * 2 + 13, 43)];
  const refs = await Promise.all(bytes.map((b, i) => stage(t, b, i))), draft = await save(t, refs);
  const staged = await t.rows();
  const { opId } = await send(t, draft), queued = await captured(t, opId), message = await publication(t, opId), rows = await t.rows();
  const expectedInventory = [{ opId, messageId: message.id }]; await inventory(t, expectedInventory);
  expect(JSON.parse(queued.payload).attachments).toEqual(refs); expect(message.attachments).toMatchObject(refs);
  firstQueueAssets(staged, rows);
  await t.backend.runWorker(); expect((await t.backend.store.ops.get(opId))?.state).toBe("unknown"); expect(t.sends).toHaveLength(1);
  unchanged(await captured(t, opId), queued); unchanged(await t.rows(), rows); unchanged(await publication(t, opId), message); await bytesIntact(t, refs, bytes);
  await inventory(t, expectedInventory);
  t.accept(); await t.reopen(); await t.backend.runWorker(); expect(t.sends).toHaveLength(1);
  expect((await t.backend.store.ops.get(opId))?.state).toBe("unknown"); unchanged(await captured(t, opId), queued); unchanged(await t.rows(), rows); unchanged(await publication(t, opId), message); await bytesIntact(t, refs, bytes);
  await inventory(t, expectedInventory);
  await t.client.call("ops.resolveUnknown", { opId, resolution: "retry" }); await t.backend.runWorker();
  expect((await t.backend.store.ops.get(opId))?.state).toBe("succeeded"); expect(t.sends).toHaveLength(2);
  for (const body of t.sends) await wire(Buffer.from(JSON.parse(body).raw, "base64url"), bytes, JSON.parse(queued.payload).messageId);
  acceptedIdentity(await captured(t, opId), queued); await inventory(t, expectedInventory); unchanged(await publication(t, opId, "accepted-id"), message);
  const accepted = await t.rows();
  for (const key of ["attachment_assets", "attachment_chunks", "attachment_bytes", "attachments"] as const) unchanged(accepted[key], rows[key]);
  unchanged(accepted.attachment_links, rows.attachment_links.filter((link) => (link.op_id === null || link.op_id === undefined)));
  await t.reopen(); await t.backend.runWorker(); unchanged(await t.rows(), accepted); acceptedIdentity(await captured(t, opId), queued); await inventory(t, expectedInventory); unchanged(await publication(t, opId, "accepted-id"), message); await bytesIntact(t, refs, bytes); expect(t.sends).toHaveLength(2);
});

function acceptedIdentity(actual: Awaited<ReturnType<typeof captured>>, before: Awaited<ReturnType<typeof captured>>) {
  unchanged(actual, { ...before, target: JSON.stringify({ ...JSON.parse(before.target), submissionAccepted: true }) });
}
async function inventory(t: Fixture, entries: { opId: string; messageId: number }[]) {
  const snapshot = await t.backend.store.debug.snapshot(), ops = snapshot.ops;
  const targets = Object.fromEntries(await Promise.all(ops.map(async (op) => [op.id, JSON.parse((await t.backend.store.ops.get(op.id))!.target_json).messageIds as number[]])));
  unchanged({ ops: ops.map((o) => o.id).sort(), messages: snapshot.messages.map((m) => m.id).sort((a, b) => a - b), targets }, { ops: entries.map((e) => e.opId).sort(), messages: entries.map((e) => e.messageId).sort((a, b) => a - b), targets: Object.fromEntries(entries.map((e) => [e.opId, [e.messageId]])) });
}
