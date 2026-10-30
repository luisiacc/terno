import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import { sqlDb } from "@terno/db";
import imapkit from "imapkit";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, rawIdleMail } from "./test/imap-idle-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function setup(folders: Record<string, object>, syncWindowDays?: number) {
  const server = imapkit({ plugins: ["MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
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
  cleanups.push(async () => { client.close(); await bounded(backend.stop(), "backend stop"); rmSync(dir, { recursive: true, force: true }); });
  if (syncWindowDays) await first.client.call("settings.update", { syncWindowDays });
  const account = await first.client.call("accounts.addImap", {
    email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "127.0.0.1", port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass", verify: false,
  });
  return { server, commands, account, ...first, async reopen() { client.close(); await bounded(backend.stop(), "backend stop"); return open(); } };
}

it("follows a renamed localized role and retains exact custom-folder identity through reopen", async () => {
  const t = await setup({ Enviados: { "special-use": "\\Trash" }, "Proyectos": {} });
  const bytes = rawIdleMail("Folder identity", "Exact bytes");
  const old = t.server.control.addMessage("Proyectos", { raw: bytes });
  const otherBytes = rawIdleMail("Other folder", "Other bytes");
  const other = t.server.control.addMessage("INBOX", { raw: otherBytes });
  expect(other.uid).toBe(old.uid);
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "all", accountId: t.account.id, folder: "Proyectos" })).items[0]!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  t.server.control.createMailbox("Clientes");
  t.server.control.renameMailbox("Proyectos", "Clientes/Contratos &AOk-");
  t.server.control.renameMailbox("Enviados", "Enviados nuevos");
  await t.backend.syncAccount(t.account.id);
  const reopened = await t.reopen();
  await reopened.backend.syncAccount(t.account.id);
  const folders = (await reopened.client.call("app.bootstrap", {})).folders.filter((f) => f.accountId === t.account.id);
  expect(folders.find((f) => f.key === "Clientes/Contratos é")).toMatchObject({ path: ["Clientes", "Contratos é"], selectable: true });
  expect((await reopened.client.call("threads.list", { view: "all", accountId: t.account.id, folder: "Clientes/Contratos é" })).items.map((x) => x.id)).toEqual([thread.id]);
  expect(await reopened.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual([expect.objectContaining({ mailbox: "Clientes/Contratos é", uidvalidity: old.uidvalidity, uid: old.uid })]);
  expect(t.server.control.getMessage("Clientes/Contratos &AOk-", old.uid, { raw: true }).raw).toEqual(Buffer.from(bytes));
  expect(t.server.control.getMessage("INBOX", other.uid, { raw: true }).raw).toEqual(Buffer.from(otherBytes));
});

it("ignores a nonselectable special-use parent when a selectable duplicate role exists", async () => {
  const t = await setup({ A: { flags: ["\\Noselect"], "special-use": "\\Trash", folders: { Child: {} } }, Papelera: { "special-use": "\\Trash" } });
  const bytes = rawIdleMail("To trash", "Exact bytes");
  t.server.control.addMessage("INBOX", { raw: bytes });
  await t.backend.syncAccount(t.account.id);
  const folders = (await t.client.call("app.bootstrap", {})).folders.filter((f) => f.accountId === t.account.id);
  expect(folders.find((f) => f.key === "A")).toMatchObject({ path: ["A"], selectable: false });
  expect(folders.find((f) => f.key === "A/Child")).toMatchObject({ path: ["A", "Child"], selectable: true });
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items[0]!;
  await t.client.call("threads.act", { threadIds: [thread.id], action: "trash" });
  await t.backend.runWorker();
  expect((await t.client.call("ops.list", {})).find((op) => op.kind === "trash")?.state).toBe("succeeded");
  expect(t.server.control.listMessages("Papelera", { raw: true })[0]!.raw).toEqual(Buffer.from(bytes));
});

it("refreshes a renamed special-use destination on the next sync", async () => {
  const t = await setup({ Papelera: { "special-use": "\\Trash" } });
  const bytes = rawIdleMail("Rename role", "Exact bytes");
  t.server.control.addMessage("INBOX", { raw: bytes });
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items[0]!;
  t.server.control.renameMailbox("Papelera", "Corbeille");
  await t.backend.syncAccount(t.account.id);
  await t.client.call("threads.act", { threadIds: [thread.id], action: "trash" });
  await t.backend.runWorker();
  expect((await t.client.call("ops.list", {})).find((op) => op.kind === "trash")?.state).toBe("succeeded");
  expect(t.server.control.listMessages("Corbeille", { raw: true })[0]!.raw).toEqual(Buffer.from(bytes));
});

it("keeps cached old mail when a role mailbox is renamed beyond the sync window", async () => {
  const t = await setup({ Enviados: { "special-use": "\\Sent" } }, 3650);
  const date = new Date(Date.now() - 2 * 365 * 86_400_000);
  const bytes = rawIdleMail("Old sent", "Exact old bytes").replace(/^Date: .*$/m, `Date: ${date.toUTCString()}`);
  const original = t.server.control.addMessage("Enviados", { raw: bytes, internaldate: date });
  await t.client.call("settings.update", { syncWindowDays: 3650 });
  await t.backend.syncAccount(t.account.id);
  const message = sqlDb(t.backend.store).get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = ?", "Old sent")!;
  expect(message).toBeDefined();
  await t.client.call("settings.update", { syncWindowDays: 30 });
  t.server.control.renameMailbox("Enviados", "Envoy&AOk-s");
  await t.backend.syncAccount(t.account.id);
  expect((await t.client.call("threads.get", { threadId: message.thread_id })).messages[0]!.id).toBe(message.id);
  expect(await t.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual([expect.objectContaining({ mailbox: "Envoyés", uidvalidity: original.uidvalidity, uid: original.uid })]);
});

it("reconciles unchanged mail when a mailbox gains or loses a role", async () => {
  const t = await setup({ Projects: {} });
  t.server.control.addMessage("Projects", { raw: rawIdleMail("Role changes") });
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "all", accountId: t.account.id, folder: "Projects" })).items[0]!;
  expect((await t.client.call("threads.get", { threadId: thread.id })).thread.inTrash).toBe(false);
  t.server.control.setSpecialUse("Projects", ["\\Trash"]);
  await t.backend.syncAccount(t.account.id);
  expect((await t.client.call("threads.get", { threadId: thread.id })).thread.inTrash).toBe(true);
  const reopened = await t.reopen();
  t.server.control.setSpecialUse("Projects", []);
  await reopened.backend.syncAccount(t.account.id);
  expect((await reopened.client.call("threads.get", { threadId: thread.id })).thread.inTrash).toBe(false);
});

it("does not dispatch or cache a destination when CREATE is refused", async () => {
  const t = await setup({});
  const bytes = rawIdleMail("Refused destination", "Preserve source");
  const original = t.server.control.addMessage("INBOX", { raw: bytes });
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items[0]!;
  t.server.script.add({ on: "command", command: "CREATE", send: "$TAG NO refused\r\n" });
  const start = t.commands.length;
  await t.client.call("threads.act", { threadIds: [thread.id], action: "trash" });
  await t.backend.runWorker();
  expect((await t.client.call("ops.list", {})).find((op) => op.kind === "trash")?.state).toBe("failed");
  expect(t.commands.slice(start)).not.toContain("UID MOVE");
  expect(t.server.control.getMessage("INBOX", original.uid, { raw: true }).raw).toEqual(Buffer.from(bytes));
});

it("does not infer a Sent role from an arbitrary nested leaf", async () => {
  const t = await setup({ Projects: { folders: { Sent: {} } } });
  const bytes = rawIdleMail("Nested custom Sent");
  const item = t.server.control.addMessage("Projects/Sent", { raw: bytes });
  await t.backend.syncAccount(t.account.id);
  const folders = (await t.client.call("app.bootstrap", {})).folders.filter((f) => f.accountId === t.account.id);
  expect(folders.find((f) => f.key === "Projects/Sent")).toMatchObject({ path: ["Projects", "Sent"], selectable: true });
  const thread = (await t.client.call("threads.list", { view: "all", accountId: t.account.id, folder: "Projects/Sent" })).items[0]!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(message.isSent).toBe(false);
  expect(await t.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual([expect.objectContaining({ mailbox: "Projects/Sent", uidvalidity: item.uidvalidity, uid: item.uid })]);
});

it("keeps a queued action away from a recreated folder's reused UID", async () => {
  const t = await setup({ Work: {}, Other: {} });
  const oldBytes = rawIdleMail("Old queued", "Original bytes");
  const otherBytes = rawIdleMail("Other same UID", "Unrelated bytes");
  const old = t.server.control.addMessage("Work", { raw: oldBytes });
  const other = t.server.control.addMessage("Other", { raw: otherBytes });
  expect(other.uid).toBe(old.uid);
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "all", accountId: t.account.id, folder: "Work" })).items[0]!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  await t.client.call("threads.act", { threadIds: [thread.id], action: "markRead" });
  const queued = (await t.client.call("ops.list", {}))[0]!;
  const target = (await t.backend.store.ops.get(queued.id))!.target_json;
  t.server.control.deleteMailbox("Work");
  t.server.control.createMailbox("Work");
  const bytes = rawIdleMail("New replacement", "Replacement bytes");
  const replacement = t.server.control.addMessage("Work", { raw: bytes });
  const reset = t.server.control.resetUidValidity("Work", { uids: "renumber" });
  expect(replacement.uid).toBe(old.uid);
  expect(reset.uidvalidity).not.toBe(old.uidvalidity);
  const start = t.commands.length;
  await t.backend.runWorker();
  expect(t.commands.slice(start)).not.toContain("UID STORE");
  expect((await t.backend.store.ops.get(queued.id))!.target_json).toBe(target);
  expect(t.server.control.getMessage("Work", replacement.uid, { raw: true }).raw).toEqual(Buffer.from(bytes));
  expect(t.server.control.getMessage("Other", other.uid, { raw: true }).raw).toEqual(Buffer.from(otherBytes));
  const reopened = await t.reopen();
  await reopened.backend.syncAccount(t.account.id);
  const newThread = (await reopened.client.call("threads.list", { view: "all", accountId: t.account.id, folder: "Work" })).items[0]!;
  const newMessage = (await reopened.client.call("threads.get", { threadId: newThread.id })).messages[0]!;
  expect(newMessage.id).not.toBe(message.id);
  expect(await reopened.backend.store.providerStore(t.account.id).locations!.of([newMessage.id])).toEqual([expect.objectContaining({ mailbox: "Work", uidvalidity: reset.uidvalidity, uid: replacement.uid })]);
  expect(t.server.control.getMessage("Work", replacement.uid, { raw: true }).raw).toEqual(Buffer.from(bytes));
  expect(t.server.control.getMessage("Other", other.uid, { raw: true }).raw).toEqual(Buffer.from(otherBytes));
});
