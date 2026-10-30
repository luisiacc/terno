import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_CHUNK } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { createGmailProvider, createRegistry, parseRaw, type ProviderRegistry } from "@terno/mail";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { startNetProxy, type NetProxy } from "./test/net-proxy";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function durable(backend: Backend) {
  const db = sqlDb(backend.store);
  return {
    assets: db.all("SELECT id, account_id, filename, mime, size, received, chunks, complete FROM attachment_assets ORDER BY id"),
    parts: db.all("SELECT message_id, filename, mime, size, asset_id FROM attachments ORDER BY id"),
    messageLinks: db.all("SELECT asset_id, message_id FROM attachment_links WHERE message_id IS NOT NULL ORDER BY id"),
  };
}

async function setup(mode: "accept" | "refuse" | "lost") {
  const dir = mkdtempSync(join(tmpdir(), "terno-delivery-"));
  const imap = imapkit({ plugins: ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"], storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" } } } } });
  const imapPort = await imap.start(0, "127.0.0.1");
  const received: { raw: Buffer; recipients: string[] }[] = [];
  let starts = 0;
  let proxy: NetProxy;
  const smtp = new SMTPServer({ disabledCommands: ["STARTTLS"], authOptional: true, closeTimeout: 250,
    onAuth: (_auth, _session, cb) => cb(null, { user: "synthetic" }),
    onData(stream, session, cb) {
      starts++;
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", () => {});
      stream.on("end", () => {
        received.push({ raw: Buffer.concat(chunks), recipients: session.envelope.rcptTo.map((r) => r.address) });
        if (mode === "refuse") cb(Object.assign(new Error("synthetic size refusal"), { responseCode: 552 }));
        else if (mode === "lost") { proxy.resetAll(); cb(); }
        else cb();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  proxy = await startNetProxy((smtp.server.address() as { port: number }).port);
  const port = proxy.port;
  let backend!: Backend, client!: RpcClient;
  const open = () => {
    backend = new Backend({ dbPath: join(dir, "mail.db"), version: "test", cipher: plaintextCipher, autoSync: false, instantSearch: false, iconTransport: null,
      providers: createRegistry({ imap: { allowInsecure: true, timeouts: { smtpSocketMs: 1500 } } }) });
    const [a, b] = createMemoryTransportPair(); backend.connect(b, { clientId: "synthetic", origin: "renderer" }); client = new RpcClient(a);
  };
  open();
  cleanup.push(async () => { client.close(); await backend.stop(); await proxy.close(); await new Promise<void>((resolve) => smtp.close(resolve)); await imap.stop(); rmSync(dir, { recursive: true, force: true }); });
  const account = await client.call("accounts.addImap", { email: "sender@example.test", displayName: "Sender", password: "testpass",
    imap: { host: "127.0.0.1", port: imapPort, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port, secure: false, user: "testuser" } });
  return { account, received, get starts() { return starts; }, accept() { mode = "accept"; }, get client() { return client; }, get backend() { return backend; }, async reopen() { client.close(); await backend.stop(); open(); await backend.ready; } };
}

it.each(["accept", "refuse", "lost"] as const)("preserves a staged attachment through SMTP %s and reopen", async (mode) => {
  const t = await setup(mode), accountId = t.account.id;
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK + 5, 0x61); bytes.set([0, 255, 128, 13, 10], ATTACHMENT_CHUNK);
  const ref = await t.client.call("attachments.create", { accountId, filename: "exact.bin", mime: "application/octet-stream", size: bytes.length });
  const first = { accountId, assetId: ref.assetId, index: 0, dataBase64: bytes.subarray(0, ATTACHMENT_CHUNK).toString("base64") };
  await t.client.call("attachments.append", first);
  await t.reopen();
  await t.client.call("attachments.append", first);
  await t.client.call("attachments.append", { ...first, index: 1, dataBase64: bytes.subarray(ATTACHMENT_CHUNK).toString("base64") });
  await t.client.call("attachments.seal", { accountId, assetId: ref.assetId });
  const to = [{ name: "", email: "to@example.test" }], cc = [{ name: "", email: "cc@example.test" }], bcc = [{ name: "", email: "bcc@example.test" }];
  const draft = (await t.client.call("drafts.save", { accountId, to, cc, bcc, subject: "Attachment", bodyText: "Exact body", attachments: [ref] }))!;
  const { opId } = await t.client.call("compose.send", { accountId, to, cc, bcc, subject: draft.subject, bodyText: "Exact body", attachments: [ref], draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision });
  const payload = (await t.backend.store.ops.get(opId))!.payload_json;
  expect(JSON.parse(payload).attachments).toEqual([ref]);
  const before = durable(t.backend);
  expect(before.assets).toHaveLength(1); expect(before.parts).toHaveLength(1); expect(before.messageLinks).toHaveLength(1);
  await t.backend.runWorker();
  expect(t.starts).toBe(1); expect(t.received).toHaveLength(1);
  expect(t.received[0]!.recipients).toEqual(["to@example.test", "cc@example.test", "bcc@example.test"]);
  const parsed = await parseRaw(t.received[0]!.raw);
  expect(parsed.subject).toBe("Attachment"); expect(parsed.text?.trim()).toBe("Exact body");
  expect(parsed.attachments).toHaveLength(1); expect(Buffer.from(parsed.attachments[0]!.bytes!)).toEqual(bytes);
  expect((await t.backend.store.ops.get(opId))?.state).toBe(mode === "accept" ? "succeeded" : mode === "refuse" ? "failed" : "unknown");
  await t.reopen(); await t.backend.runWorker();
  expect(t.starts).toBe(1); expect(t.received).toHaveLength(1);
  expect((await t.backend.store.ops.get(opId))?.payload_json).toBe(payload);
  expect(durable(t.backend)).toEqual(before);
  expect(sqlDb(t.backend.store).get<{ count: number }>("SELECT count(*) AS count FROM attachment_assets WHERE account_id = ?", accountId)?.count).toBe(1);
  expect(await t.client.call("attachments.read", { accountId, assetId: ref.assetId, index: 1 })).toEqual({ dataBase64: bytes.subarray(ATTACHMENT_CHUNK).toString("base64") });
  if (mode === "lost") {
    t.accept();
    await t.client.call("ops.resolveUnknown", { opId, resolution: "retry" });
    await t.backend.runWorker();
    expect(t.starts).toBe(2); expect(t.received).toHaveLength(2);
    expect(t.received[1]!.recipients).toEqual(t.received[0]!.recipients);
    expect(t.received[1]!.raw).toEqual(t.received[0]!.raw);
    expect((await t.backend.store.ops.get(opId))?.state).toBe("succeeded");
    await t.reopen(); await t.backend.runWorker();
    expect(t.starts).toBe(2);
    expect(durable(t.backend)).toEqual(before);
    expect(sqlDb(t.backend.store).get<{ count: number }>("SELECT count(*) AS count FROM attachment_assets WHERE account_id = ?", accountId)?.count).toBe(1);
  }
});


it.each(["accept", "refuse", "lost"] as const)("sends exact staged bytes through managed Gmail %s across reopen", async (mode) => {
  const requests: Buffer[] = [];
  let starts = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/gmail/messages/send") starts++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") res.end(JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }));
    else if (req.url === "/gmail/profile") res.end(JSON.stringify({ emailAddress: "synthetic@example.test", historyId: "1" }));
    else if (req.url === "/gmail/messages/send") {
      requests.push(Buffer.concat(chunks));
      if (mode === "lost") req.socket.destroy();
      else if (mode === "refuse") { res.statusCode = 400; res.end(JSON.stringify({ error: { message: "synthetic refusal" } })); }
      else res.end(JSON.stringify({ id: "sent-synthetic", threadId: "thread-synthetic" }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "terno-gmail-delivery-"));
  const providers: ProviderRegistry = { create: (ctx) => createGmailProvider(ctx, { endpoints: { token: `${origin}/token`, api: `${origin}/gmail` } }), async verifyImap() {}, async connectGmail() { throw new Error("unused"); } };
  let backend!: Backend, client!: RpcClient;
  const open = () => { backend = new Backend({ dbPath: join(dir, "mail.db"), providers, version: "test", cipher: plaintextCipher, autoSync: false, instantSearch: false, iconTransport: null });
    const [a, b] = createMemoryTransportPair(); backend.connect(b, { clientId: "synthetic", origin: "renderer" }); client = new RpcClient(a); };
  open();
  cleanup.push(async () => { client.close(); await backend.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: {}, now: 1 });
  await backend.store.settings.set("app", { gmailClientId: "synthetic-client" }); await backend.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
  await (await backend.provider(account.id))!.verify();
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const ref = await client.call("attachments.create", { accountId: account.id, filename: "exact.bin", mime: "application/octet-stream", size: bytes.length });
  await client.call("attachments.append", { accountId: account.id, assetId: ref.assetId, index: 0, dataBase64: bytes.toString("base64") });
  await client.call("attachments.seal", { accountId: account.id, assetId: ref.assetId });
  const to = [{ name: "", email: "to@example.test" }], bcc = [{ name: "", email: "bcc@example.test" }];
  const draft = (await client.call("drafts.save", { accountId: account.id, to, bcc, subject: "Gmail attachment", bodyText: "Exact body", attachments: [ref] }))!;
  const { opId } = await client.call("compose.send", { accountId: account.id, to, bcc, subject: draft.subject, bodyText: "Exact body", attachments: [ref], draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision });
  const payload = (await backend.store.ops.get(opId))!.payload_json;
  const before = durable(backend);
  expect(before.assets).toHaveLength(1); expect(before.parts).toHaveLength(1); expect(before.messageLinks).toHaveLength(1);
  await backend.runWorker();
  expect(starts).toBe(1); expect(requests).toHaveLength(1);
  const wire = Buffer.from((JSON.parse(requests[0]!.toString()) as { raw: string }).raw, "base64url");
  const parsed = await parseRaw(wire);
  expect(parsed.to.map((a) => a.email)).toEqual(["to@example.test"]); expect(parsed.bcc.map((a) => a.email)).toEqual(["bcc@example.test"]);
  expect(parsed.subject).toBe("Gmail attachment"); expect(Buffer.from(parsed.attachments[0]!.bytes!)).toEqual(bytes);
  expect((await backend.store.ops.get(opId))?.state).toBe(mode === "accept" ? "succeeded" : mode === "refuse" ? "failed" : "unknown");
  client.close(); await backend.stop(); open(); await backend.ready; await backend.runWorker();
  expect(starts).toBe(1); expect(requests).toHaveLength(1); expect((await backend.store.ops.get(opId))?.payload_json).toBe(payload);
  expect(durable(backend)).toEqual(before);
  expect(sqlDb(backend.store).get<{ count: number }>("SELECT count(*) AS count FROM attachment_assets WHERE account_id = ?", account.id)?.count).toBe(1);
  expect(await client.call("attachments.read", { accountId: account.id, assetId: ref.assetId, index: 0 })).toEqual({ dataBase64: bytes.toString("base64") });
});

it("refuses an encoded-budget overflow before queueing and retains the draft and asset", async () => {
  const t = await setup("accept"), accountId = t.account.id;
  const size = 18 * 1024 * 1024;
  const ref = await t.client.call("attachments.create", { accountId, filename: "large.bin", mime: "application/octet-stream", size });
  const chunk = Buffer.alloc(ATTACHMENT_CHUNK, 0x5a).toString("base64");
  for (let index = 0; index < size / ATTACHMENT_CHUNK; index++) await t.client.call("attachments.append", { accountId, assetId: ref.assetId, index, dataBase64: chunk });
  await t.client.call("attachments.seal", { accountId, assetId: ref.assetId });
  const to = [{ name: "", email: "to@example.test" }], bodyText = "x".repeat(1024 * 1024);
  const draft = (await t.client.call("drafts.save", { accountId, to, subject: "Retain", bodyText, attachments: [ref] }))!;
  await expect(t.client.call("compose.send", { accountId, to, subject: draft.subject, bodyText, attachments: [ref], draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision })).rejects.toThrow();
  expect((await t.client.call("drafts.list", {})).find((d) => d.id === draft.id)).toMatchObject({ generation: draft.generation, revision: draft.revision, attachments: [ref], bodyText });
  expect(await t.client.call("ops.list", {})).toEqual([]);
  expect(t.starts).toBe(0);
  await t.reopen();
  expect((await t.client.call("drafts.list", {})).find((d) => d.id === draft.id)).toMatchObject({ generation: draft.generation, revision: draft.revision, attachments: [ref] });
  expect(await t.client.call("attachments.read", { accountId, assetId: ref.assetId, index: 0 })).toEqual({ dataBase64: chunk });
  expect(sqlDb(t.backend.store).get<{ count: number }>("SELECT count(*) AS count FROM attachment_assets WHERE account_id = ?", accountId)?.count).toBe(1);
});
