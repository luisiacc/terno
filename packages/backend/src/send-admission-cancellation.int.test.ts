import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RPC_VERSION, RpcClient, type RpcMessage } from "@terno/core/rpc";
import { openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { createRegistry, parseRaw } from "@terno/mail";
import type { MailStore } from "@terno/store";
import { IDBFactory } from "fake-indexeddb";
import { SMTPServer } from "smtp-server";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((r) => setImmediate(r)) };

async function exactContent(raw: string) {
  const parsed = await parseRaw(raw);
  expect(parsed.text).toBe("Exact original body");
  expect(parsed.html).toBeNull();
  expect(parsed.from).toEqual({ name: "Original Author", email: "author@example.test" });
  expect(parsed.to).toEqual([{ name: "Recipient", email: "accepted@example.test" }]);
  expect(parsed.subject).toBe("Original subject");
  expect(parsed.attachments).toHaveLength(1);
  expect(parsed.attachments[0]).toMatchObject({ filename: "exact.bin", mime: "application/octet-stream", size: 5 });
  expect(parsed.attachments[0]!.bytes).toEqual(new Uint8Array([0, 255, 128, 13, 10]));
}

for (const adapter of ["SQL", "IDB"] as const) it.each([false, true])(`${adapter}: consumed draft admission survives lost ACK and terminal refusal=%s without touching a neighbor`, async (refused) => {
  const received: { raw: string; recipients: string[]; from: string }[] = [];
  let envelopes = 0;
  const smtp = new SMTPServer({ disabledCommands: ["STARTTLS"], authOptional: true, onAuth: (_a, _s, cb) => cb(null, { user: "synthetic" }),
    onMailFrom(_a, _s, cb) { envelopes++; cb(); },
    onRcptTo(a, _s, cb) { cb(a.address === "refused@example.test" ? Object.assign(new Error("Synthetic refusal"), { responseCode: 550 }) : undefined); },
    onData(stream, session, cb) {
      const chunks: Buffer[] = []; let size = 0;
      stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) stream.destroy(new Error("Synthetic fixture bound")); else chunks.push(chunk); });
      stream.on("error", cb);
      stream.on("end", () => { received.push({ raw: Buffer.concat(chunks).toString(), recipients: session.envelope.rcptTo.map((r) => r.address), from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "" }); cb(); });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => smtp.close(r)));
  const dir = mkdtempSync(join(tmpdir(), "terno-send-admission-")), name = crypto.randomUUID(), factory = new IDBFactory();
  cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  const open = () => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")))) : IdbMailStore.open({ name, factory, platform, instantSearch: false });
  const connect = (store: MailStore) => {
    const backend = new Backend({ store, dbPath: ":memory:", version: "test", platform, cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false, iconTransport: null });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "admission", origin: "renderer" });
    const client = new RpcClient(c);
    cleanup.push(async () => { client.close(); if (store.isOpen) await backend.stop(); });
    return { backend, client };
  };
  const first = connect(await open()); await first.backend.ready;
  const { account } = await first.backend.store.accounts.create({ kind: "imap", email: "author@example.test", displayName: "Original Author", color: "indigo", now: 1, secret: { key: "password", blob: await plaintextCipher.encrypt("synthetic") }, providerConfig: {
    imap: { host: "127.0.0.1", port: 1, secure: false, user: "synthetic" }, smtp: { host: "127.0.0.1", port: (smtp.server.address() as { port: number }).port, secure: false, user: "synthetic" }, appendToSent: false,
  } });
  const ref = await first.client.call("attachments.create", { accountId: account.id, filename: "exact.bin", mime: "application/octet-stream", size: 5 });
  await first.client.call("attachments.append", { accountId: account.id, assetId: ref.assetId, index: 0, dataBase64: "AP+ADQo=" });
  await first.client.call("attachments.seal", { accountId: account.id, assetId: ref.assetId });
  const fields = { accountId: account.id, to: [{ name: "Recipient", email: refused ? "refused@example.test" : "accepted@example.test" }], subject: "Original subject", bodyText: "Exact original body", attachments: [ref] };
  const draft = (await first.client.call("drafts.save", fields))!;
  const neighbor = (await first.client.call("drafts.save", { accountId: account.id, to: [{ name: "", email: "neighbor@example.test" }], subject: "Neighbor", bodyText: "Neighbor body" }))!;
  const params = { ...fields, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision };
  await expect(first.client.call("compose.send", { ...params, draftRevision: draft.revision + 1 })).rejects.toMatchObject({ code: "STALE", details: { reason: "draftRevision" } });
  expect(await first.client.call("drafts.list", {})).toEqual(expect.arrayContaining([draft, neighbor]));
  expect(await first.client.call("ops.list", {})).toEqual([]);

  const [wire, server] = createMemoryTransportPair(); first.backend.connect(server, { clientId: "lost-ack", origin: "renderer" });
  cleanup.push(async () => { wire.close(); });
  const replies: RpcMessage[] = [], sent: RpcMessage[] = [];
  wire.onMessage((m) => replies.push(m));
  const transmit = server.send.bind(server);
  vi.spyOn(server, "send").mockImplementation((m) => { sent.push(m); if (!(m.t === "res" && m.ok)) transmit(m); });
  const request = { v: RPC_VERSION, t: "req" as const, id: 46, m: "compose.send", p: params };
  wire.send(request); wire.send(request);
  await expect.poll(() => sent.filter((m) => m.t === "res").length).toBe(2);
  expect(sent.filter((m) => m.t === "res" && m.ok)).toHaveLength(1);
  expect(replies.filter((m) => m.t === "res")).toEqual([expect.objectContaining({ id: 46, ok: false, e: expect.objectContaining({ code: "STALE" }) })]);
  const queued = (await first.client.call("ops.list", {}))[0]!;
  expect(queued.state).toBe("queued"); expect(envelopes).toBe(0);
  const original = (await first.backend.store.ops.get(queued.id))!;
  wire.send(request);
  await expect.poll(() => sent.filter((m) => m.t === "res").length).toBe(3);
  expect(await first.client.call("drafts.list", {})).toEqual([neighbor]);
  await first.backend.runWorker();
  expect((await first.backend.store.ops.get(queued.id))?.state).toBe(refused ? "failed" : "succeeded");
  expect(envelopes).toBe(1); expect(received).toHaveLength(refused ? 0 : 1);
  if (!refused) {
    expect(received[0]).toMatchObject({ from: "author@example.test", recipients: ["accepted@example.test"] });
    await exactContent(received[0]!.raw);
    const mutations = await Promise.allSettled([
      exactContent(received[0]!.raw.replace("Exact original body", "Exact original body appended")),
      exactContent(received[0]!.raw.replace("application/octet-stream", "text/x-corrupted")),
    ]);
    expect(mutations.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  }
  wire.send(request);
  await expect.poll(() => sent.filter((m) => m.t === "res").length).toBe(4);
  expect(sent.filter((m) => m.t === "res" && m.ok)).toHaveLength(1);
  await first.backend.stop();
  const second = connect(await open()); await second.backend.ready;
  await expect(second.client.call("compose.send", params)).rejects.toMatchObject({ code: "STALE", details: { reason: "draftMissing" } });
  expect((await second.backend.store.ops.get(queued.id))?.payload_json).toBe(original.payload_json);
  expect(await second.client.call("drafts.list", {})).toEqual([neighbor]);
  await second.client.call("compose.send", { accountId: account.id, to: neighbor.to, subject: neighbor.subject, bodyText: neighbor.bodyText, draftId: neighbor.id, draftGeneration: neighbor.generation });
  await second.backend.runWorker(); await second.backend.runWorker();
  expect(envelopes).toBe(2); expect(received).toHaveLength(refused ? 1 : 2);
  expect(received.at(-1)).toMatchObject({ recipients: ["neighbor@example.test"] });
  expect(received.at(-1)!.raw).toContain("Neighbor body");
  expect(await second.client.call("drafts.list", {})).toEqual([]);
});
