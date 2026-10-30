import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import { sqlDb } from "@terno/db";
import imapkit from "imapkit";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, rawIdleMail } from "./test/imap-idle-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "IMAP fixture cleanup failed");
});

async function setup(folders: Record<string, object>, syncWindowDays?: number, uidplus = true) {
  const server = imapkit({ plugins: ["MOVE", ...(uidplus ? ["UIDPLUS"] : []), "SPECIAL-USE", "ENABLE", "CONDSTORE"],
    storage: { INBOX: {}, "": { separator: "/", folders } } });
  const commands: string[] = [];
  server.script.add({ on: "command", run: true, when(ctx) { commands.push(ctx.command!); return false; } });
  const port = await server.start(0, "127.0.0.1");
  cleanups.push(async () => { await server.stop(); });
  const dir = mkdtempSync(join(tmpdir(), "terno-s15-"));
  let backend: Backend;
  let client: RpcClient;
  const open = () => {
    backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher,
      providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "s15", origin: "renderer" });
    client = new RpcClient(c);
    return { backend, client };
  };
  const first = open();
  cleanups.push(async () => { try { client.close(); await bounded(backend.stop(), "backend stop"); } finally { rmSync(dir, { recursive: true, force: true }); } });
  if (syncWindowDays) await first.client.call("settings.update", { syncWindowDays });
  const account = await first.client.call("accounts.addImap", {
    email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "127.0.0.1", port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass", verify: false,
  });
  return { server, commands, account, ...first, async reopen() { client.close(); await bounded(backend.stop(), "backend stop"); return open(); } };
}


it("does not acknowledge a queued read while its target is unlocated", async () => {
  const { ImapFlow } = await import("imapflow");
  const t = await setup({ A: {}, Z: {} });
  const bytes = rawIdleMail("Gap target", "Exact gap bytes");
  const old = t.server.control.addMessage("Z", { raw: bytes });
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "all", accountId: t.account.id, folder: "Z" })).items[0]!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  await t.client.call("threads.act", { threadIds: [thread.id], action: "markRead" });
  const op = (await t.client.call("ops.list", {})).find((item) => item.kind === "markRead")!;
  const original = ImapFlow.prototype.status;
  let moved = false;
  const status = vi.spyOn(ImapFlow.prototype, "status").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    const result = await original.apply(this, args);
    if (String(args[0]) === "A" && !moved) {
      moved = true;
      t.server.control.moveMessages("Z", [old.uid], "A");
    }
    return result;
  });
  try { await t.backend.syncAccount(t.account.id); } finally { status.mockRestore(); }
  expect(moved).toBe(true);
  expect(await t.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual([]);
  const destination = t.server.control.listMessages("A", { raw: true })[0]!;
  expect(destination.raw).toEqual(Buffer.from(bytes));
  expect(t.server.control.listMessages("Z")).toEqual([]);
  const reopened = await t.reopen();
  const start = t.commands.length;
  await reopened.backend.runWorker();
  expect(t.commands.slice(start)).not.toContain("UID STORE");
  const retained = await reopened.backend.store.ops.get(op.id);
  expect(retained).not.toBeNull();
  expect(JSON.parse(retained!.target_json)).toEqual({ messageIds: [message.id] });
  expect(retained!.state).not.toBe("succeeded");
  expect(t.server.control.getMessage("A", destination.uid, { raw: true }).flags).not.toContain("\\Seen");
  expect((await reopened.client.call("threads.get", { threadId: thread.id })).messages[0]).toMatchObject({ id: message.id, bodyText: message.bodyText });
});

it.each([false, true])("does not target an equal-envelope different body after reverse arrivals (Message-ID present: %s)", async (hasId) => {
  const { ImapFlow } = await import("imapflow");
  const t = await setup({ A: {}, Z: {} });
  const date = new Date().toUTCString();
  const make = (body: string) => ["From: Ana <ana@example.test>", "To: Test <test@example.test>", "Subject: Equal envelope",
    ...(hasId ? ["Message-ID: <duplicate@example.test>"] : []), `Date: ${date}`,
    "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");
  const firstBytes = make("AAAA");
  const secondBytes = make("BBBB");
  const first = t.server.control.addMessage("Z", { raw: firstBytes });
  const second = t.server.control.addMessage("Z", { raw: secondBytes });
  await t.backend.syncAccount(t.account.id);
  const firstId = await t.backend.store.providerStore(t.account.id).locations!.at("Z", first.uidvalidity, first.uid);
  const secondId = await t.backend.store.providerStore(t.account.id).locations!.at("Z", second.uidvalidity, second.uid);
  expect(firstId).not.toBe(secondId);
  const firstRow = sqlDb(t.backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", firstId)!;
  const before = (await t.client.call("threads.get", { threadId: firstRow.thread_id })).messages.find((m) => m.id === firstId)!;
  expect(before.bodyText).toBe("AAAA\n");
  await t.client.call("threads.act", { threadIds: [firstRow.thread_id], action: "markRead" });
  const queued = (await t.client.call("ops.list", {})).find((item) => item.kind === "markRead")!;
  expect(queued.state).toBe("queued");
  const original = ImapFlow.prototype.status;
  let moved = false;
  const status = vi.spyOn(ImapFlow.prototype, "status").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    const result = await original.apply(this, args);
    if (String(args[0]) === "A" && !moved) {
      moved = true;
      t.server.control.moveMessages("Z", [second.uid], "A");
      t.server.control.moveMessages("Z", [first.uid], "A");
    }
    return result;
  });
  try { await t.backend.syncAccount(t.account.id); } finally { status.mockRestore(); }
  expect(moved).toBe(true);
  const remote = t.server.control.listMessages("A", { raw: true });
  expect(remote.map((m) => m.raw)).toEqual([Buffer.from(secondBytes), Buffer.from(firstBytes)]);
  const reopened = await t.reopen();
  expect((await reopened.client.call("ops.list", {})).find((item) => item.id === queued.id)?.state).toBe("queued");
  await reopened.backend.syncAccount(t.account.id);
  await reopened.backend.runWorker();
  const firstRemote = remote.find((m) => m.raw!.equals(Buffer.from(firstBytes)))!;
  const otherRemote = remote.find((m) => m.raw!.equals(Buffer.from(secondBytes)))!;
  expect(t.server.control.getMessage("A", otherRemote.uid).flags).not.toContain("\\Seen");
  const location = (await reopened.backend.store.providerStore(t.account.id).locations!.of([firstId!]))[0];
  if (location) expect(t.server.control.getMessage("A", location.uid, { raw: true }).raw).toEqual(Buffer.from(firstBytes));
  expect((await reopened.client.call("threads.get", { threadId: firstRow.thread_id })).messages.find((m) => m.id === firstId)).toMatchObject({ bodyText: "AAAA\n" });
});

it("uses a valid MOVE mapping for the exact message and retains it across reopen", async () => {
  const t = await setup({ Trash: { "special-use": "\\Trash" } });
  const bytes = rawIdleMail("Mapped target", "Exact mapped bytes");
  const otherBytes = rawIdleMail("Mapped unrelated", "Exact unrelated bytes");
  const old = t.server.control.addMessage("INBOX", { raw: bytes });
  const other = t.server.control.addMessage("INBOX", { raw: otherBytes });
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items.find((item) => item.subject === "Mapped target")!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  await t.client.call("threads.act", { threadIds: [thread.id], action: "trash" });
  await t.backend.runWorker();
  expect((await t.client.call("ops.list", {})).find((item) => item.kind === "trash")?.state).toBe("succeeded");
  const remote = t.server.control.listMessages("Trash", { raw: true })[0]!;
  expect(remote.raw).toEqual(Buffer.from(bytes));
  expect(t.server.control.getMessage("INBOX", other.uid, { raw: true }).raw).toEqual(Buffer.from(otherBytes));
  expect(t.server.control.listMessages("INBOX", { raw: true }).map((item) => item.uid)).not.toContain(old.uid);
  const locations = await t.backend.store.providerStore(t.account.id).locations!.of([message.id]);
  expect(locations).toEqual([expect.objectContaining({ mailbox: "Trash", uidvalidity: t.server.control.getMailbox("Trash").uidvalidity, uid: remote.uid })]);
  const reopened = await t.reopen();
  expect((await reopened.client.call("threads.get", { threadId: thread.id })).messages[0]).toMatchObject({ id: message.id, bodyText: message.bodyText });
  expect(await reopened.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual(locations);
});

it("does not replay an acknowledged MOVE when UIDPLUS is unavailable", async () => {
  const t = await setup({ Trash: { "special-use": "\\Trash" } }, undefined, false);
  const bytes = rawIdleMail("Unmapped target", "Exact unmapped bytes");
  const old = t.server.control.addMessage("INBOX", { raw: bytes });
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items[0]!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  await t.client.call("threads.act", { threadIds: [thread.id], action: "trash" });
  await t.backend.runWorker();
  expect((await t.client.call("ops.list", {})).find((item) => item.kind === "trash")?.state).toBe("succeeded");
  expect(t.server.control.listMessages("INBOX")).toEqual([]);
  const remote = t.server.control.listMessages("Trash", { raw: true });
  expect(remote).toHaveLength(1);
  expect(remote[0]!.raw).toEqual(Buffer.from(bytes));
  expect(await t.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual([]);
  const moves = t.commands.filter((command) => command === "UID MOVE").length;
  expect(moves).toBe(1);
  const reopened = await t.reopen();
  await reopened.backend.runWorker();
  expect(t.commands.filter((command) => command === "UID MOVE")).toHaveLength(moves);
  await reopened.backend.syncAccount(t.account.id);
  expect((await reopened.client.call("threads.get", { threadId: thread.id })).messages[0]).toMatchObject({ id: message.id, bodyText: message.bodyText });
  expect(await reopened.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual([expect.objectContaining({ mailbox: "Trash", uidvalidity: t.server.control.getMailbox("Trash").uidvalidity, uid: remote[0]!.uid })]);
  expect(old.uidvalidity).toBe(t.server.control.getMailbox("INBOX").uidvalidity);
});
