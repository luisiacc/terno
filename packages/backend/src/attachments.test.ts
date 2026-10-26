import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import { demoRegistry, ProviderError, type SendPayload } from "@terno/mail/portable";
import { Backend, plaintextCipher } from "./backend";
import { hydrateSendAttachments } from "./attachments";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-assets-"));
  const b = new Backend({ dbPath: join(dir, "mail.db"), cipher: plaintextCipher, version: "test", providers: demoRegistry, demoAi: true, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  b.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  const a = createAccount(sqlDb(b.store), { displayName: "Synthetic", kind: "gmail", email: "a@test.com", color: "indigo" }).id;
  const other = createAccount(sqlDb(b.store), { displayName: "Synthetic", kind: "gmail", email: "b@test.com", color: "indigo" }).id;
  close.push(async () => { client.close(); await b.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { b, client, a, other };
}
const payload: SendPayload = { from: { name: "", email: "a@test.com" }, to: [{ name: "", email: "r@test.com" }], cc: [], bcc: [], text: "exact", subject: "files", messageId: "synthetic@test", inReplyTo: null, references: [], providerThreadId: null };

it("RPC chunks are canonical, ordered, idempotent before seal and account bound after restart", async () => {
  const { b, client, a, other } = setup();
  const ref = await client.call("attachments.create", { accountId: a, filename: "..\\..\\résumé.bin", mime: "application/octet-stream", size: 3 });
  const req = { accountId: a, assetId: ref.assetId, index: 0, dataBase64: "AP+A" };
  await expect(client.call("attachments.append", { ...req, index: 1 })).rejects.toThrow();
  await expect(client.call("attachments.append", { ...req, dataBase64: "AP+A!" })).rejects.toThrow();
  await client.call("attachments.append", req);
  await client.call("attachments.append", req);
  await client.call("attachments.seal", { accountId: a, assetId: ref.assetId });
  await expect(client.call("attachments.append", req)).rejects.toThrow();
  await expect(client.call("attachments.read", { accountId: other, assetId: ref.assetId, index: 0 })).rejects.toThrow();
  const hydrated = await hydrateSendAttachments(b.store, a, { ...payload, attachments: [ref] }, async () => {});
  expect(hydrated.attachments?.[0]).toMatchObject({ filename: "résumé.bin", dataBase64: "AP+A" });
  expect(ref).not.toHaveProperty("dataBase64");
});

it("missing, incomplete, foreign and read-failed assets are definitive pre-submission errors", async () => {
  const { b, client, a, other } = setup();
  const ref = await client.call("attachments.create", { accountId: a, filename: "empty", mime: "text/plain", size: 0 });
  for (const p of [{ account: a, ref }, { account: other, ref }, { account: a, ref: { ...ref, assetId: crypto.randomUUID() } }]) {
    await expect(hydrateSendAttachments(b.store, p.account, { ...payload, attachments: [p.ref] }, async () => {})).rejects.toMatchObject({ retryable: false, ambiguous: false });
  }
  await b.store.attachments.seal(a, ref.assetId);
  const read = vi.spyOn(b.store.attachments, "info").mockRejectedValueOnce(new Error("synthetic disk failure"));
  await expect(hydrateSendAttachments(b.store, a, { ...payload, attachments: [ref] }, async () => {})).rejects.toBeInstanceOf(ProviderError);
  read.mockRestore();
  expect((await hydrateSendAttachments(b.store, a, { ...payload, attachments: [ref] }, async () => {})).attachments?.[0]?.dataBase64).toBe("");
});

it("queue RPC cannot silently omit an existing draft's attachments", async () => {
  const { b, client, a } = setup();
  const ref = await b.store.attachments.create({ accountId: a, filename: "empty", mime: "text/plain", size: 0, now: 0 });
  await b.store.attachments.seal(a, ref.assetId);
  const d = (await client.call("drafts.save", { accountId: a, bodyText: "keep", attachments: [ref] }))!;
  await expect(client.call("compose.send", { accountId: a, to: payload.to, subject: "files", bodyText: "keep", draftId: d.id, draftRevision: d.revision })).rejects.toThrow();
  expect(await b.store.drafts.list()).toHaveLength(1);
  expect(await b.store.ops.recent(20)).toHaveLength(0);
});
