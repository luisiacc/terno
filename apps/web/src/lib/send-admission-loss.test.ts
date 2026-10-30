import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, RpcError, type MethodName, type ParamsOf } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "../../../../packages/backend/src/backend";
import { createRegistry, parseRaw } from "@terno/mail";
import { SMTPServer } from "smtp-server";

const rpc = vi.hoisted(() => ({ call: undefined as undefined | ((method: MethodName, params: unknown) => Promise<unknown>) }));
vi.mock("~/rpc/connection", () => ({ client: { call: (method: MethodName, params: unknown) => rpc.call!(method, params) } }));
vi.mock("~/state/threads", () => ({ invalidateThreads: vi.fn(), loadThread: vi.fn() }));
const { sendDraft } = await import("./compose");
const { createDraft, editDraft, flushDraft, retryDraft, forgetDraft, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { setApp } = await import("~/state/app");

async function fixture(adapter: "SQL" | "IDB") {
  const dir = mkdtempSync(join(tmpdir(), "terno-unsaved-admission-")), name = crypto.randomUUID(), factory = new IDBFactory();
  const open = () => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")))) : IdbMailStore.open({ name, factory, platform: nodePlatform, instantSearch: false });
  const received: string[] = [], envelopes: string[][] = [];
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], onAuth: (_a, _s, cb) => cb(null, { user: "synthetic" }),
    onData(stream, session, cb) { const chunks: Buffer[] = []; let size = 0; stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) stream.destroy(new Error("Fixture bound")); else chunks.push(chunk); }); stream.on("error", cb); stream.on("end", () => { received.push(Buffer.concat(chunks).toString()); envelopes.push(session.envelope.rcptTo.map((r) => r.address)); cb(); }); },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  const connections: { backend: Backend; client: RpcClient }[] = [];
  const connect = async () => {
    const store = await open();
    const backend = new Backend({ dbPath: ":memory:", store, platform: nodePlatform, cipher: plaintextCipher, version: "test", autoSync: false, iconTransport: null, providers: createRegistry({ imap: { allowInsecure: true } }) });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "renderer-loss", origin: "renderer" }); const client = new RpcClient(c);
    connections.push({ backend, client }); await backend.ready;
    return { backend, client, store };
  };
  const first = await connect();
  const { account } = await first.store.accounts.create({ kind: "imap", email: "author@example.test", displayName: "Original", color: "indigo", now: 1, secret: { key: "password", blob: await plaintextCipher.encrypt("synthetic") }, providerConfig: {
    imap: { host: "127.0.0.1", port: 1, secure: false, user: "synthetic" }, smtp: { host: "127.0.0.1", port: (smtp.server.address() as { port: number }).port, secure: false, user: "synthetic" }, appendToSent: false,
  } });
  setApp({ accounts: [account] }); useDrafts.setState({ drafts: {} });
  rpc.call = (method, params) => first.client.call(method, params as never);
  return { ...first, account, received, envelopes, connect, async close() {
    for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
    for (const { backend, client } of connections.reverse()) { client.close(); if (backend.store.isOpen) await backend.stop(); }
    await new Promise<void>((r) => smtp.close(r)); rmSync(dir, { recursive: true, force: true }); rpc.call = undefined;
  } };
}

for (const adapter of ["SQL", "IDB"] as const) it.each([false, true])(`${adapter}: ordinary Send retains one durable admission after lost ACK (autosave=%s)`, async (autosave) => {
  const t = await fixture(adapter), { backend, store, client, account } = t;
  let lose = true;
  const submissions: ParamsOf<"compose.send">[] = [];
  rpc.call = async (method, params) => {
    if (method === "compose.send") submissions.push(params as ParamsOf<"compose.send">);
    const result = await client.call(method, params as never);
    if (method === "compose.send" && lose) { lose = false; throw new RpcError("TIMEOUT", "Synthetic response lost after admission"); }
    return result;
  };
  try {
    const ref = await client.call("attachments.create", { accountId: account.id, filename: "exact.bin", mime: "application/octet-stream", size: 5 });
    await client.call("attachments.append", { accountId: account.id, assetId: ref.assetId, index: 0, dataBase64: "AP+ADQo=" });
    await client.call("attachments.seal", { accountId: account.id, assetId: ref.assetId });
    const key = createDraft({ ...newFields(account.id), toText: "recipient@example.test", ccText: "copy@example.test", bccText: "blind@example.test", subject: "Original", bodyText: "Preserved authored body", attachments: [ref] });
    editDraft(key, {});
    expect(await sendDraft(key)).toBe(false);
    expect(submissions[0]?.draftId).toEqual(expect.any(Number));
    expect(await client.call("ops.list", {})).toHaveLength(1);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "Preserved authored body", sending: false });
    if (autosave) { await flushDraft(key); expect(useDrafts.getState().drafts[key]?.id).not.toBeNull(); }
    expect(await sendDraft(key)).toBe(false);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]?.draftId).toBe(submissions[0]?.draftId);
    const operations = await client.call("ops.list", {});
    expect(operations).toHaveLength(1);
    expect(useDrafts.getState().drafts[key]?.recovery?.state).toBe("missing");
    const payloads = await Promise.all(operations.map(async (op) => JSON.parse((await store.ops.get(op.id))!.payload_json)));
    for (const payload of payloads) expect(payload).toMatchObject({ text: "Preserved authored body", subject: "Original", from: { email: "author@example.test" }, to: [{ email: "recipient@example.test", name: "" }], cc: [{ email: "copy@example.test", name: "" }], bcc: [{ email: "blind@example.test", name: "" }] });
    await backend.runWorker(); expect(t.received).toHaveLength(1);
    const mail = await parseRaw(t.received[0]!);
    expect(mail.text).toBe("Preserved authored body"); expect(mail.from).toEqual({ name: "Original", email: "author@example.test" });
    expect(mail.to).toEqual([{ name: "", email: "recipient@example.test" }]);
    expect(mail.cc).toEqual([{ name: "", email: "copy@example.test" }]); expect(mail.bcc).toEqual([]);
    expect(t.envelopes[0]).toEqual(["recipient@example.test", "copy@example.test", "blind@example.test"]);
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]).toMatchObject({ filename: "exact.bin", mime: "application/octet-stream", size: 5 });
    expect(mail.attachments[0]!.bytes).toEqual(new Uint8Array([0, 255, 128, 13, 10]));
    await backend.stop(); const reopened = await t.connect(); rpc.call = (method, params) => reopened.client.call(method, params as never);
    await reopened.backend.runWorker(); expect(t.received).toHaveLength(1);
    const neighbor = createDraft({ ...newFields(account.id), toText: "recipient@example.test", ccText: "copy@example.test", bccText: "blind@example.test", subject: "Original", bodyText: "Preserved authored body", attachments: [ref] });
    expect(await sendDraft(neighbor)).toBe(true); await reopened.backend.runWorker(); expect(t.received).toHaveLength(2);
    expect(await reopened.client.call("ops.list", {})).toHaveLength(2);
    expect(t.envelopes[1]).toEqual(t.envelopes[0]);
    const nextMail = await parseRaw(t.received[1]!); expect(nextMail.text).toBe(mail.text); expect(nextMail.attachments[0]!.bytes).toEqual(mail.attachments[0]!.bytes);
  } finally { await t.close(); }
});

for (const adapter of ["SQL", "IDB"] as const) {
  it.each(["refused", "lost ACK"] as const)(`${adapter}: first pre-send save %s cannot submit without confirmed identity`, async (fault) => {
    const t = await fixture(adapter);
    let failed = false, sends = 0;
    rpc.call = async (method, params) => {
      if (method === "compose.send") sends++;
      if (method === "drafts.save" && !failed) {
        failed = true;
        if (fault === "lost ACK") await t.client.call(method, params as never);
        throw new RpcError(fault === "lost ACK" ? "TIMEOUT" : "BAD_REQUEST", "Synthetic save not acknowledged");
      }
      return t.client.call(method, params as never);
    };
    try {
      const key = createDraft({ ...newFields(t.account.id), toText: "recipient@example.test", bodyText: "Retain this work" }); editDraft(key, {});
      expect(await sendDraft(key)).toBe(false); expect(sends).toBe(0); expect(await t.client.call("ops.list", {})).toEqual([]);
      expect(useDrafts.getState().drafts[key]).toMatchObject({ id: null, bodyText: "Retain this work", status: "error", sending: false });
      retryDraft(key); await flushDraft(key);
      expect(useDrafts.getState().drafts[key]?.id).toEqual(expect.any(Number));
      expect(await sendDraft(key)).toBe(true); expect(sends).toBe(1);
      await t.backend.runWorker(); expect(t.received).toHaveLength(1);
    } finally { await t.close(); }
  });

  it(`${adapter}: Send waits for an in-flight save and acknowledges the latest revision`, async () => {
    const t = await fixture(adapter);
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), entered = new Promise<void>((r) => { enter = r; });
    let saves = 0, sends = 0;
    rpc.call = async (method, params) => {
      if (method === "drafts.save" && ++saves === 1) { enter(); await gate; }
      if (method === "compose.send") sends++;
      return t.client.call(method, params as never);
    };
    try {
      const key = createDraft({ ...newFields(t.account.id), toText: "recipient@example.test", bodyText: "Earlier" }); editDraft(key, {});
      const saving = flushDraft(key); await entered;
      editDraft(key, { bodyText: "Latest authored body", subject: "Latest subject" });
      const sending = sendDraft(key); expect(sends).toBe(0); release(); await saving;
      expect(await sending).toBe(true); expect(saves).toBe(2); expect(sends).toBe(1);
      const op = (await t.client.call("ops.list", {}))[0]!;
      expect(JSON.parse((await t.store.ops.get(op.id))!.payload_json)).toMatchObject({ text: "Latest authored body", subject: "Latest subject" });
    } finally { release(); await t.close(); }
  });

  it(`${adapter}: pre-dispatch refusal retries the same draft; consumed-draft autosave cannot create a copy`, async () => {
    const t = await fixture(adapter);
    let fail = true, lose = true;
    const identities: number[] = [];
    rpc.call = async (method, params) => {
      if (method === "compose.send") {
        identities.push((params as ParamsOf<"compose.send">).draftId!);
        if (fail) { fail = false; throw new RpcError("BAD_REQUEST", "Synthetic pre-dispatch refusal"); }
      }
      const result = await t.client.call(method, params as never);
      if (method === "compose.send" && lose) { lose = false; throw new RpcError("TIMEOUT", "Synthetic Send ACK loss"); }
      return result;
    };
    try {
      const key = createDraft({ ...newFields(t.account.id), toText: "recipient@example.test", bodyText: "Original" }); editDraft(key, {});
      expect(await sendDraft(key)).toBe(false); expect(await t.client.call("ops.list", {})).toHaveLength(0);
      expect(await sendDraft(key)).toBe(false); expect(identities[1]).toBe(identities[0]);
      editDraft(key, { bodyText: "Retained new edit" }); await flushDraft(key);
      expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "Retained new edit", recovery: { state: "missing" } });
      expect(await sendDraft(key)).toBe(false); expect(identities).toHaveLength(2);
      expect(await t.client.call("drafts.list", {})).toEqual([]); expect(await t.client.call("ops.list", {})).toHaveLength(1);
      await t.backend.runWorker(); expect(t.received).toHaveLength(1);
      expect((await parseRaw(t.received[0]!)).text).toBe("Original\n");
    } finally { await t.close(); }
  });
}
