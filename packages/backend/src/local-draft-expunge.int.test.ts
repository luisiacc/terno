import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry, parseRaw } from "@terno/mail";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, rawIdleMail } from "./test/imap-idle-fixture";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "A33 cleanup failed");
});

async function setup(uidplus: boolean) {
  const server = imapkit({
    plugins: ["SPECIAL-USE", "ENABLE", ...(uidplus ? ["UIDPLUS"] : [])],
    storage: { INBOX: {}, "": { separator: "/", folders: {
      Drafts: { "special-use": "\\Drafts" }, Sent: { "special-use": "\\Sent" }, Archive: { "special-use": "\\Archive" },
    } } },
  });
  cleanups.push(() => bounded(server.stop(), "IMAP stop"));
  const sendEvents: string[] = [];
  const commands: { command: string; data: string; mailbox: string | null }[] = [];
  let overflow = false;
  const capabilities: string[] = [];
  server.script.add({ on: "response", drop: true, when(ctx) {
    if (/^\* CAPABILITY /i.test(ctx.data)) {
      if (capabilities.length < 32) capabilities.push(ctx.data); else overflow = true;
    }
    return false;
  } });
  server.script.add({ on: "command", run: true, when(ctx) {
    if (ctx.command === "APPEND") sendEvents.push("sent-append");
    if (commands.length < 2000) commands.push({ command: ctx.command!, data: ctx.data.trim(), mailbox: ctx.mailbox });
    else overflow = true;
    return false;
  } });
  const port = await bounded(server.start(0, "127.0.0.1"), "IMAP listen");
  const received: Buffer[] = [];
  const smtp = new SMTPServer({
    authOptional: true, disabledCommands: ["STARTTLS"], logger: false,
    onAuth: (_auth, _session, cb) => cb(null, { user: "testuser" }),
    onData(stream, _session, cb) {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 100_000) stream.destroy(new Error("Unexpected SMTP fixture size"));
        else chunks.push(chunk);
      });
      stream.on("error", cb);
      stream.on("end", () => { received.push(Buffer.concat(chunks)); sendEvents.push("smtp-data"); cb(); });
    },
  });
  await bounded(new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve)), "SMTP listen");
  cleanups.push(() => bounded(new Promise<void>((resolve) => smtp.close(() => resolve())), "SMTP stop"));
  const smtpPort = (smtp.server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "terno-a33-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  function open() {
    const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher,
      providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "a33", origin: "renderer" });
    const client = new RpcClient(c);
    let stopped = false;
    const stop = async () => { if (!stopped) { client.close(); await bounded(backend.stop(), "backend stop"); stopped = true; } };
    cleanups.push(stop);
    return { backend, client, stop };
  }
  const first = open();
  const account = await first.client.call("accounts.addImap", {
    email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "127.0.0.1", port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: smtpPort, secure: false, user: "testuser" },
    password: "testpass",
  });
  const snapshot = (path: string) => ({ path, uidvalidity: server.control.getMailbox(path).uidvalidity,
    messages: server.control.listMessages(path, { raw: true }).map((m) => ({ uid: m.uid, raw: m.raw, flags: [...m.flags].sort() })) });
  const mutations = () => commands.filter((c) => /^(?:UID )?(?:APPEND|STORE|COPY|MOVE|EXPUNGE|CLOSE|CREATE|DELETE)$/.test(c.command));
  return { ...first, open, account, server, commands, capabilities, received, sendEvents, snapshot, mutations, assertBounded: () => expect(overflow).toBe(false) };
}

it.each([false, true])("A33 keeps local drafts off IMAP and preserves Deleted mail (UIDPLUS=%s)", async (uidplus) => {
  const t = await setup(uidplus);
  expect(t.capabilities.length).toBeGreaterThan(0);
  for (const response of t.capabilities) {
    expect(response).not.toMatch(/\bMOVE\b|\bIMAP4rev2\b/i);
    expect(/\bUIDPLUS\b/i.test(response)).toBe(uidplus);
  }
  const ctl = t.server.control;
  ctl.addMessage("Drafts", { raw: rawIdleMail("external-draft", "Other client's draft"), flags: ["\\Draft"] });
  ctl.addMessage("Drafts", { raw: rawIdleMail("deleted-draft", "Already deleted draft"), flags: ["\\Draft", "\\Deleted"] });
  const target = ctl.addMessage("INBOX", { raw: rawIdleMail("archive-control", "Exact archive control") });
  const other = ctl.addMessage("INBOX", { raw: rawIdleMail("unrelated-deleted", "Must survive"), flags: ["\\Deleted"] });
  const draftsBefore = t.snapshot("Drafts");
  const inboxBefore = t.snapshot("INBOX");
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items.find((item) => item.subject === "archive-control")!;
  expect(thread).toBeDefined();
  expect(t.mutations()).toEqual([]);
  const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
  const ref = await t.client.call("attachments.create", { accountId: t.account.id, filename: "exact.bin", mime: "application/octet-stream", size: bytes.length });
  await t.client.call("attachments.append", { accountId: t.account.id, assetId: ref.assetId, index: 0, dataBase64: bytes.toString("base64") });
  await t.client.call("attachments.seal", { accountId: t.account.id, assetId: ref.assetId });
  const fields = { accountId: t.account.id, to: [{ name: "", email: "recipient@example.test" }], subject: "Local draft", bodyText: "v1", attachments: [ref] };
  const saved = (await t.client.call("drafts.save", fields))!;
  const edited = (await t.client.call("drafts.save", { ...fields, id: saved.id, generation: saved.generation, baseRevision: saved.revision, bodyText: "Exact v2 body" }))!;
  expect(edited).toMatchObject({ id: saved.id, generation: saved.generation, revision: saved.revision + 1, bodyText: "Exact v2 body", attachments: [ref] });
  const neighbor = (await t.client.call("drafts.save", { ...fields, subject: "Discard only this", attachments: [] }))!;
  await t.client.call("drafts.delete", { id: neighbor.id, generation: neighbor.generation });
  expect(await t.client.call("drafts.list", {})).toEqual([edited]);
  await t.backend.runWorker();
  expect(t.mutations()).toEqual([]);
  expect(t.received).toEqual([]);
  expect(t.snapshot("Drafts")).toEqual(draftsBefore);
  expect(t.snapshot("INBOX")).toEqual(inboxBefore);
  await t.stop();
  const reopened = t.open();
  expect(await reopened.client.call("drafts.list", {})).toEqual([edited]);
  expect(await reopened.client.call("attachments.read", { accountId: t.account.id, assetId: ref.assetId, index: 0 })).toEqual({ dataBase64: bytes.toString("base64") });
  const send = await reopened.client.call("compose.send", { ...fields, bodyText: edited.bodyText, draftId: edited.id, draftGeneration: edited.generation, draftRevision: edited.revision });
  const payload = (await reopened.backend.store.ops.get(send.opId))!.payload_json;
  expect(JSON.parse(payload)).toMatchObject({ text: "Exact v2 body", attachments: [ref] });
  expect(await reopened.client.call("drafts.list", {})).toEqual([]);
  expect(t.mutations()).toEqual([]);
  await reopened.backend.runWorker();
  expect((await reopened.backend.store.ops.get(send.opId))?.state).toBe("succeeded");
  expect(t.received).toHaveLength(1);
  expect(t.sendEvents).toEqual(["smtp-data", "sent-append"]);
  expect(t.mutations().map((c) => c.command)).toEqual(["APPEND"]);
  expect(t.mutations()[0]!.data).toMatch(/APPEND Sent /);
  const copies = ctl.listMessages("Sent", { raw: true });
  expect(copies).toHaveLength(1);
  expect(copies[0]!.raw).toEqual(t.received[0]);
  const sentBefore = t.snapshot("Sent");
  const parsed = await parseRaw(t.received[0]!);
  expect(parsed.subject).toBe("Local draft");
  expect(parsed.text?.trim()).toBe("Exact v2 body");
  expect(parsed.attachments).toHaveLength(1);
  expect(Buffer.from(parsed.attachments[0]!.bytes!)).toEqual(bytes);
  expect(t.snapshot("Drafts")).toEqual(draftsBefore);
  expect(t.snapshot("INBOX")).toEqual(inboxBefore);
  await reopened.stop();
  const final = t.open();
  expect(await final.client.call("drafts.list", {})).toEqual([]);
  expect((await final.backend.store.ops.get(send.opId))?.payload_json).toBe(payload);
  await final.backend.runWorker();
  expect(t.received).toHaveLength(1);
  expect(t.sendEvents).toEqual(["smtp-data", "sent-append"]);
  expect(t.snapshot("Sent")).toEqual(sentBefore);
  expect((await final.backend.store.ops.get(send.opId))?.state).toBe("succeeded");
  expect(t.snapshot("Drafts")).toEqual(draftsBefore);
  expect(t.snapshot("INBOX")).toEqual(inboxBefore);
  expect(await final.client.call("attachments.read", { accountId: t.account.id, assetId: ref.assetId, index: 0 })).toEqual({ dataBase64: bytes.toString("base64") });
  const start = t.commands.length;
  const action = await final.client.call("threads.act", { threadIds: [thread.id], action: "archive" });
  expect(action.undoId).not.toBeNull();
  await final.backend.runWorker();
  const archive = t.commands.slice(start).filter((c) => /^(?:UID )?(?:STORE|COPY|MOVE|EXPUNGE)$/.test(c.command));
  expect(archive.map((c) => c.command)).toEqual(uidplus ? ["UID COPY", "UID STORE", "UID EXPUNGE"] : []);
  if (uidplus) {
    expect(archive.every((c) => c.mailbox === "INBOX")).toBe(true);
    expect(archive[0]!.data).toMatch(new RegExp(`UID COPY ${target.uid} "?Archive"?$`));
    expect(archive[1]!.data).toMatch(new RegExp(`UID STORE ${target.uid} \\+FLAGS(?:\\.SILENT)? \\(\\\\Deleted\\)$`));
    expect(archive[2]!.data).toMatch(new RegExp(`UID EXPUNGE ${target.uid}$`));
    expect(t.snapshot("INBOX")).toEqual({ ...inboxBefore, messages: inboxBefore.messages.filter((m) => m.uid === other.uid) });
    const archived = ctl.listMessages("Archive", { raw: true });
    expect(archived).toHaveLength(1);
    expect(archived[0]!.raw).toEqual(inboxBefore.messages.find((m) => m.uid === target.uid)!.raw);
    const local = (await final.client.call("threads.get", { threadId: thread.id })).messages[0]!;
    expect(local.bodyText).toBe("Exact archive control\n");
    expect(await final.backend.store.providerStore(t.account.id).locations!.of([local.id])).toEqual([expect.objectContaining({ mailbox: "Archive", uidvalidity: ctl.getMailbox("Archive").uidvalidity, uid: archived[0]!.uid })]);
    expect((await final.client.call("ops.list", {})).filter((op) => op.kind === "archive")).toEqual([expect.objectContaining({ state: "succeeded", attempts: 1 })]);
  } else {
    expect(t.snapshot("INBOX")).toEqual(inboxBefore);
    expect(ctl.listMessages("Archive")).toEqual([]);
    expect(await final.client.call("ops.list", {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "archive", state: "failed", attempts: 1, lastErrorI18n: { key: "errors.imap.unsafeMove" } }),
      expect.objectContaining({ id: send.opId, kind: "send", state: "succeeded" }),
    ]));
  }
  expect(t.snapshot("Drafts")).toEqual(draftsBefore);
  expect(t.snapshot("Sent")).toEqual(sentBefore);
  expect(t.mutations().map((c) => c.command)).toEqual(uidplus ? ["APPEND", "UID COPY", "UID STORE", "UID EXPUNGE"] : ["APPEND"]);
  t.assertBounded();
});
