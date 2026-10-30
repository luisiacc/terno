import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import { AWAITING_IDENTITY, ImapIdentityError } from "@terno/store";
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
  expect(retained).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY });
  expect(retained!.last_error).toContain("errors.imap.identityUnavailable");
  await reopened.backend.runWorker();
  expect(await reopened.backend.store.ops.get(op.id)).toEqual(retained);
  expect(t.server.control.getMessage("A", destination.uid, { raw: true }).flags).not.toContain("\\Seen");
  expect((await reopened.client.call("threads.get", { threadId: thread.id })).messages[0]).toMatchObject({ id: message.id, bodyText: message.bodyText });
});

it.each([{ hasId: false, attachment: false }, { hasId: true, attachment: false }, { hasId: true, attachment: true }])("does not target equal-envelope different bytes after reverse arrivals ($hasId, attachments: $attachment)", async ({ hasId, attachment }) => {
  const { ImapFlow } = await import("imapflow");
  const t = await setup({ A: {}, Z: {} });
  const date = new Date().toUTCString();
  const make = (body: string) => ["From: Ana <ana@example.test>", "To: Test <test@example.test>", "Subject: Equal envelope",
    ...(hasId ? ["Message-ID: <duplicate@example.test>"] : []), `Date: ${date}`,
    ...(attachment ? ["MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="part"', "", "--part", "Content-Type: text/plain", "", "same text", "--part", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="payload.bin"', "Content-Transfer-Encoding: base64", "", Buffer.from(body).toString("base64"), "--part--", ""] : ["Content-Type: text/plain; charset=utf-8", "", body, ""])].join("\r\n");
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
  expect(before.bodyText).toBe(attachment ? "same text" : "AAAA\n");
  if (attachment) expect(await t.backend.store.attachments.read(t.account.id, before.attachments[0]!.assetId!, 0)).toBe("QUFBQQ==");
  await t.client.call("threads.act", { threadIds: [firstRow.thread_id], action: "markRead" });
  const queued = (await t.client.call("ops.list", {})).find((item) => item.kind === "markRead")!;
  const queuedTarget = (await t.backend.store.ops.get(queued.id))!.target_json;
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
  expect(t.server.control.getMessage("A", firstRemote.uid, { raw: true })).toMatchObject({ raw: Buffer.from(firstBytes), flags: [] });
  const otherRemote = remote.find((m) => m.raw!.equals(Buffer.from(secondBytes)))!;
  expect(t.server.control.getMessage("A", otherRemote.uid).flags).not.toContain("\\Seen");
  const retained = await reopened.backend.store.ops.get(queued.id);
  expect(retained).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY, target_json: queuedTarget });
  expect(retained!.last_error).toContain("errors.imap.identityUnavailable");
  const location = (await reopened.backend.store.providerStore(t.account.id).locations!.of([firstId!]))[0];
  if (location) expect(t.server.control.getMessage("A", location.uid, { raw: true }).raw).toEqual(Buffer.from(firstBytes));
  expect((await reopened.client.call("threads.get", { threadId: firstRow.thread_id })).messages.find((m) => m.id === firstId)).toMatchObject({ bodyText: before.bodyText });
  if (attachment) expect(await reopened.backend.store.attachments.read(t.account.id, before.attachments[0]!.assetId!, 0)).toBe("QUFBQQ==");
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
  await reopened.client.call("threads.act", { threadIds: [thread.id], action: "markRead" });
  await reopened.backend.runWorker();
  expect(t.server.control.getMessage("Trash", remote.uid, { raw: true })).toMatchObject({ raw: Buffer.from(bytes), flags: ["\\Seen"] });
  expect(t.server.control.getMessage("INBOX", other.uid, { raw: true })).toMatchObject({ raw: Buffer.from(otherBytes), flags: [] });
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
  expect(await reopened.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual([]);
  expect(await reopened.backend.store.providerStore(t.account.id).locations.unresolved([message.id])).toEqual([message.id]);
  await reopened.client.call("threads.act", { threadIds: [thread.id], action: "markRead" });
  await reopened.backend.runWorker();
  expect((await reopened.client.call("ops.list", {})).find((item) => item.kind === "markRead")).toMatchObject({ state: "queued" });
  expect(t.commands.filter((command) => command === "UID MOVE")).toHaveLength(moves);
  expect(old.uidvalidity).toBe(t.server.control.getMailbox("INBOX").uidvalidity);
});

it.each(["markRead", "star", "trash"] as const)("rechecks an already claimed %s at the mailbox lock boundary", async (action) => {
  const { ImapFlow } = await import("imapflow");
  const t = await setup({ Trash: { "special-use": "\\Trash" } });
  const bytes = rawIdleMail("Claimed target", "Exact claimed bytes");
  const otherBytes = rawIdleMail("Claimed unrelated", "Exact unrelated bytes");
  const old = t.server.control.addMessage("INBOX", { raw: bytes });
  const other = t.server.control.addMessage("INBOX", { raw: otherBytes });
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items.find((item) => item.subject === "Claimed target")!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  await t.client.call("threads.act", { threadIds: [thread.id], action });
  const op = (await t.client.call("ops.list", {})).find((item) => item.kind === action)!;
  const original = ImapFlow.prototype.getMailboxLock;
  let gap = false;
  const lock = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    if (!gap && String(args[0]) === "INBOX") {
      gap = true;
      expect(await t.backend.store.ops.get(op.id)).toMatchObject({ state: "running" });
      await t.backend.store.providerStore(t.account.id).locations.remove(message.id, "INBOX");
    }
    return original.apply(this, args);
  });
  const start = t.commands.length;
  try { await t.backend.runWorker(); } finally { lock.mockRestore(); }
  expect(gap).toBe(true);
  expect(t.commands.slice(start).filter((command) => /^(?:UID )?(?:STORE|MOVE|COPY|EXPUNGE)$/.test(command))).toEqual([]);
  expect(await t.backend.store.ops.get(op.id)).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY, target_json: JSON.stringify({ messageIds: [message.id] }) });
  expect(t.server.control.getMessage("INBOX", old.uid, { raw: true })).toMatchObject({ raw: Buffer.from(bytes), flags: [] });
  expect(t.server.control.getMessage("INBOX", other.uid, { raw: true })).toMatchObject({ raw: Buffer.from(otherBytes), flags: [] });
});

it.each(["missing", "duplicate", "epoch", "range"] as const)("withholds an invalid %s COPYUID result after one acknowledged MOVE", async (fault) => {
  const { ImapFlow } = await import("imapflow");
  const t = await setup({ Trash: { "special-use": "\\Trash" } });
  const bytes = [rawIdleMail("Map one", "Exact first bytes"), rawIdleMail("Map two", "Exact second bytes")];
  for (const raw of bytes) t.server.control.addMessage("INBOX", { raw });
  await t.backend.syncAccount(t.account.id);
  const threads = (await t.client.call("threads.list", { view: "inbox" })).items;
  const messages = (await Promise.all(threads.map((thread) => t.client.call("threads.get", { threadId: thread.id })))).flatMap((detail) => detail.messages);
  await t.client.call("threads.act", { threadIds: threads.map((thread) => thread.id), action: "trash" });
  const original = ImapFlow.prototype.messageMove;
  const altered = vi.spyOn(ImapFlow.prototype, "messageMove").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    const result = await original.apply(this, args);
    expect(result).toBeTruthy();
    if (!result) throw new Error("Expected acknowledged MOVE");
    const pairs = [...result.uidMap!];
    if (fault === "missing") result.uidMap!.delete(pairs[0]![0]);
    else if (fault === "duplicate") result.uidMap!.set(pairs[1]![0], pairs[0]![1]);
    else if (fault === "range") result.uidMap!.set(pairs[0]![0], 0x1_0000_0000);
    else result.uidValidity = BigInt(Number(result.uidValidity) + 100);
    return result;
  });
  try { await t.backend.runWorker(); } finally { altered.mockRestore(); }
  const moves = t.commands.filter((command) => command === "UID MOVE").length;
  expect(moves).toBe(1);
  const reopened = await t.reopen();
  await reopened.backend.syncAccount(t.account.id);
  await reopened.backend.runWorker();
  expect(t.commands.filter((command) => command === "UID MOVE")).toHaveLength(moves);
  const ids = messages.map((message) => message.id);
  expect(await reopened.backend.store.providerStore(t.account.id).locations.of(ids)).toEqual([]);
  expect(new Set(await reopened.backend.store.providerStore(t.account.id).locations.unresolved(ids))).toEqual(new Set(ids));
  expect(t.server.control.listMessages("Trash", { raw: true }).map((message) => message.raw!.toString()).sort()).toEqual([...bytes].sort());
  for (const thread of threads) expect((await reopened.client.call("threads.get", { threadId: thread.id })).messages[0]).toMatchObject({ bodyState: "full" });
});

it("imports distinct first-sync UIDs in different folders without merging equal envelopes", async () => {
  const t = await setup({ A: {}, Z: {} });
  const one = rawIdleMail("First sync twins", "AAAA").replace(/^Message-ID: .*\r\n/m, "");
  const two = one.replace("AAAA", "BBBB");
  const a = t.server.control.addMessage("A", { raw: one });
  const z = t.server.control.addMessage("Z", { raw: two });
  await t.backend.syncAccount(t.account.id);
  const locations = t.backend.store.providerStore(t.account.id).locations;
  const first = await locations.at("A", a.uidvalidity, a.uid);
  const second = await locations.at("Z", z.uidvalidity, z.uid);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(first).not.toBe(second);
  const thread = sqlDb(t.backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id=?", first)!;
  expect((await t.client.call("threads.get", { threadId: thread.thread_id })).messages[0]).toMatchObject({ id: first, bodyText: "AAAA\n" });
  await t.client.call("threads.act", { threadIds: [thread.thread_id], action: "markRead" });
  await t.backend.runWorker();
  expect(t.server.control.getMessage("A", a.uid, { raw: true })).toMatchObject({ raw: Buffer.from(one), flags: ["\\Seen"] });
  expect(t.server.control.getMessage("Z", z.uid, { raw: true })).toMatchObject({ raw: Buffer.from(two), flags: [] });
});


it.each(["markRead", "markUnread", "star", "unstar", "archive", "trash", "spam", "notSpam", "moveToInbox"] as const)("admits every requested target before %s, without mutating its located sibling", async (action) => {
  const t = await setup({ Trash: { "special-use": "\\Trash" }, Archive: { "special-use": "\\Archive" }, Junk: { "special-use": "\\Junk" } });
  const bytes = [rawIdleMail("Located", "located bytes"), rawIdleMail("Unlocated", "unlocated bytes")];
  const mailbox = action === "notSpam" ? "Junk" : action === "moveToInbox" ? "Archive" : "INBOX";
  const flags = action === "markUnread" ? ["\\Seen"] : action === "unstar" ? ["\\Flagged"] : [];
  const remote = bytes.map((raw) => t.server.control.addMessage(mailbox, { raw, flags }));
  await t.backend.syncAccount(t.account.id);
  const threads = sqlDb(t.backend.store).all<{ id: number }>("SELECT id FROM threads");
  const locations = t.backend.store.providerStore(t.account.id).locations;
  const id = (await locations.at(mailbox, remote[1]!.uidvalidity, remote[1]!.uid))!;
  await t.client.call("threads.act", { threadIds: threads.map((thread) => thread.id), action });
  const op = (await t.client.call("ops.list", {})).find((item) => item.kind === action)!;
  const target = (await t.backend.store.ops.get(op.id))!.target_json;
  await locations.remove(id, mailbox);
  const start = t.commands.length;
  await t.backend.runWorker();
  expect(t.commands.slice(start).filter((command) => /^(?:UID )?(?:STORE|MOVE|COPY|EXPUNGE)$/.test(command))).toEqual([]);
  expect(await t.backend.store.ops.get(op.id)).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY, target_json: target });
  for (const [i, message] of remote.entries()) expect(t.server.control.getMessage(mailbox, message.uid, { raw: true })).toMatchObject({ raw: Buffer.from(bytes[i]!), flags });
});

it("keeps a partially issued multi-mailbox MOVE unknown after a later identity refusal", async () => {
  const { ImapFlow } = await import("imapflow");
  const t = await setup({ A: {}, Z: {}, Trash: { "special-use": "\\Trash" } });
  const bytes = [rawIdleMail("First move", "first bytes"), rawIdleMail("Second move", "second bytes")];
  t.server.control.addMessage("A", { raw: bytes[0]! });
  const second = t.server.control.addMessage("Z", { raw: bytes[1]! });
  await t.backend.syncAccount(t.account.id);
  const threads = (await t.client.call("threads.list", { view: "all", accountId: t.account.id })).items;
  const locations = t.backend.store.providerStore(t.account.id).locations;
  const secondId = (await locations.at("Z", second.uidvalidity, second.uid))!;
  await t.client.call("threads.act", { threadIds: threads.map((thread) => thread.id), action: "trash" });
  const op = (await t.client.call("ops.list", {})).find((item) => item.kind === "trash")!;
  const target = (await t.backend.store.ops.get(op.id))!.target_json;
  const original = ImapFlow.prototype.getMailboxLock;
  let fenced = false;
  const lock = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    if (!fenced && String(args[0]) === "Z") {
      fenced = true;
      expect(t.commands.filter((command) => command === "UID MOVE")).toHaveLength(1);
      await locations.fence([secondId]);
    }
    return original.apply(this, args);
  });
  try { await t.backend.runWorker(); } finally { lock.mockRestore(); }
  expect(fenced).toBe(true);
  expect(await t.backend.store.ops.get(op.id)).toMatchObject({ state: "unknown", attempts: 1, target_json: target });
  const reopened = await t.reopen();
  await reopened.backend.runWorker();
  expect(t.commands.filter((command) => command === "UID MOVE")).toHaveLength(1);
  expect(t.server.control.listMessages("Trash", { raw: true }).map((m) => m.raw)).toEqual([Buffer.from(bytes[0]!)]);
  expect(t.server.control.getMessage("Z", second.uid, { raw: true })).toMatchObject({ raw: Buffer.from(bytes[1]!), flags: [] });
});


it("resumes a changed admission on completed sync only when every target is still trusted", async () => {
  const t = await setup({});
  const raw = rawIdleMail("Trusted after admission race", "trusted bytes");
  const remote = t.server.control.addMessage("INBOX", { raw });
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items[0]!;
  await t.client.call("threads.act", { threadIds: [thread.id], action: "markRead" });
  const op = (await t.client.call("ops.list", {})).find((item) => item.kind === "markRead")!;
  const proto = Object.getPrototypeOf(t.backend.store.providerStore(t.account.id).locations);
  const race = vi.spyOn(proto, "dispatch").mockRejectedValueOnce(new ImapIdentityError());
  try { await t.backend.runWorker(); } finally { race.mockRestore(); }
  expect(await t.backend.store.ops.get(op.id)).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY });
  await t.backend.runWorker();
  expect(t.server.control.getMessage("INBOX", remote.uid).flags).toEqual([]);
  await t.backend.syncAccount(t.account.id);
  await t.backend.runWorker();
  expect(await t.backend.store.ops.get(op.id)).toMatchObject({ state: "succeeded", attempts: 1 });
  expect(t.server.control.getMessage("INBOX", remote.uid, { raw: true })).toMatchObject({ raw: Buffer.from(raw), flags: ["\\Seen"] });
});
