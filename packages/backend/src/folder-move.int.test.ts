/**
 * Plan 127: mail moved to an account's own folder on a real IMAP server (imapkit), through the RPCs: one source per
 * message, a kept thread copied, each undo exact, the message's identity kept and no copy lost.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import imapkit from "imapkit";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, rawIdleMail } from "./test/imap-idle-fixture";

const SENDER = "ana@example.test";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function setup(plugins = ["MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"]) {
  const server = imapkit({ plugins, storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" }, Trash: { "special-use": "\\Trash" }, Archive: { "special-use": "\\Archive" } } } } });
  const port = await bounded(server.start(0, "127.0.0.1"), "fixture listen");
  for (const path of ["Recibos", "Familia"]) server.control.createMailbox(path);
  cleanups.push(async () => { await bounded(server.stop(), "fixture stop"); });
  const dir = mkdtempSync(join(tmpdir(), "terno-p127-"));
  const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "p127", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => { client.close(); await bounded(backend.stop(), "backend stop"); rmSync(dir, { recursive: true, force: true }); });
  const account = await client.call("accounts.addImap", {
    email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "127.0.0.1", port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass", verify: false,
  });
  const t = {
    server, backend, client, account,
    sync: () => backend.syncAccount(account.id),
    /** subjects' mailboxes on the server, sorted */
    on(mailbox: string) { return server.control.listMessages(mailbox, { raw: true }).length; },
    threadsIn: async (folder: string) => (await client.call("threads.list", { view: "all", accountId: account.id, folder })).items.map((x) => x.id),
    inbox: async () => (await client.call("threads.list", { view: "inbox", accountId: account.id })).items.map((x) => x.id),
    move: (threadIds: number[], folder: string, from: string | null = null) => client.call("folders.moveThreads", { accountId: account.id, folder, from, threadIds }),
    undo: (undoId: number) => client.call("threads.undo", { undoId }),
    async messageOf(threadId: number) { return (await client.call("threads.get", { threadId })).messages[0]!; },
    locations: async (ids: number[]) => (await backend.store.providerStore(account.id).locations.of(ids)).map((l) => l.mailbox).sort(),
    held: (ids: number[]) => backend.store.providerStore(account.id).locations.unresolved(ids),
    /** runs every queued op, and the sync pass that would follow */
    async settle() { while ((await backend.runWorker()) > 0); },
    ops: async () => (await backend.store.debug.snapshot()).ops.filter((o) => o.state !== "succeeded").map((o) => `${o.kind}:${o.state}`),
  };
  return t;
}

async function oneInInbox(t: Awaited<ReturnType<typeof setup>>, subject = "Recibo") {
  t.server.control.addMessage("INBOX", { raw: rawIdleMail(subject) });
  await t.sync();
  const [thread] = (await t.inbox()).slice(-1);
  return { thread: thread!, message: (await t.messageOf(thread!)).id };
}

it("from the Inbox: moved, not copied, shown at once, and its identity kept; the following archive changes nothing", async () => {
  const t = await setup();
  const { thread, message } = await oneInInbox(t);
  const r = await t.move([thread], "Recibos");
  expect(r).toMatchObject({ affected: 1, kept: 0 });
  // shown there before the server has answered
  expect(await t.threadsIn("Recibos")).toEqual([thread]);
  expect(await t.inbox()).toEqual([]);
  expect(t.on("Recibos")).toBe(0);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos"), t.on("Archive")]).toEqual([0, 1, 0]);
  expect(await t.locations([message])).toEqual(["Recibos"]);
  expect(await t.held([message])).toEqual([]);
  await t.sync();
  expect(await t.threadsIn("Recibos")).toEqual([thread]);
  expect(await t.inbox()).toEqual([]);
  expect((await t.messageOf(thread)).id).toBe(message);
});

it("undo puts it back in the Inbox, out of the folder, on the server too", async () => {
  const t = await setup();
  const { thread, message } = await oneInInbox(t);
  const { undoId } = await t.move([thread], "Recibos");
  await t.settle();
  expect(await t.undo(undoId!)).toEqual({ restored: 1 });
  expect(await t.threadsIn("Recibos")).toEqual([]);
  expect(await t.inbox()).toEqual([thread]);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos"), t.on("Archive")]).toEqual([1, 0, 0]);
  expect(await t.locations([message])).toEqual(["INBOX"]);
  await t.sync();
  expect(await t.inbox()).toEqual([thread]);
  expect(await t.threadsIn("Recibos")).toEqual([]);
});

it("undo before anything reached the server still ends in the Inbox, with nothing left in the folder", async () => {
  const t = await setup();
  const { thread, message } = await oneInInbox(t);
  const { undoId } = await t.move([thread], "Recibos");
  await t.undo(undoId!);
  expect(await t.inbox()).toEqual([thread]);
  expect(await t.threadsIn("Recibos")).toEqual([]);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos"), t.on("Archive")]).toEqual([1, 0, 0]);
  expect(await t.locations([message])).toEqual(["INBOX"]);
  expect(await t.held([message])).toEqual([]);
});

it("kept in the Inbox by a category shown there: copied to the folder, in both after a sync; undo removes only the copy", async () => {
  const t = await setup();
  const { thread, message } = await oneInInbox(t);
  const category = await t.client.call("categories.create", { name: "Facturas", color: "cyan", showInInbox: true });
  await t.client.call("categories.addThreads", { categoryId: category.id, threadIds: [thread], source: "picker" });
  const { undoId, kept } = await t.move([thread], "Recibos");
  expect(kept).toBe(1);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos")]).toEqual([1, 1]);
  await t.sync();
  expect(await t.inbox()).toEqual([thread]);
  expect(await t.threadsIn("Recibos")).toEqual([thread]);
  expect(await t.locations([message])).toEqual(["INBOX", "Recibos"]);
  expect(await t.held([message])).toEqual([]);
  await t.undo(undoId!);
  expect(await t.threadsIn("Recibos")).toEqual([]);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos")]).toEqual([1, 0]);
  expect(await t.locations([message])).toEqual(["INBOX"]);
  expect(await t.held([message])).toEqual([]);
  // the Inbox keeps the message's identity, and the next pass agrees
  await t.sync();
  expect(await t.inbox()).toEqual([thread]);
});

it("archiving a kept thread leaves the folder's copy; undoing that archive doesn't empty the folder", async () => {
  const t = await setup();
  const { thread, message } = await oneInInbox(t);
  const category = await t.client.call("categories.create", { name: "Facturas", color: "cyan", showInInbox: true });
  await t.client.call("categories.addThreads", { categoryId: category.id, threadIds: [thread], source: "picker" });
  await t.move([thread], "Recibos");
  await t.settle();
  const { undoId } = await t.client.call("threads.act", { threadIds: [thread], action: "archive" });
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos"), t.on("Archive")]).toEqual([0, 1, 1]);
  await t.undo(undoId!);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos"), t.on("Archive")]).toEqual([1, 1, 0]);
  expect(await t.locations([message])).toEqual(["INBOX", "Recibos"]);
});

it("filing a copy of mail that's in Archive and a folder: Archive keeps its copy, and undo removes only the new one", async () => {
  const t = await setup();
  const { thread, message } = await oneInInbox(t);
  const category = await t.client.call("categories.create", { name: "Facturas", color: "cyan", showInInbox: true });
  await t.client.call("categories.addThreads", { categoryId: category.id, threadIds: [thread], source: "picker" });
  await t.move([thread], "Recibos");
  await t.settle();
  await t.client.call("threads.act", { threadIds: [thread], action: "archive" });
  await t.settle();
  expect([t.on("Archive"), t.on("Recibos"), t.on("Familia")]).toEqual([1, 1, 0]);
  const { undoId } = await t.move([thread], "Familia");
  await t.settle();
  expect([t.on("Archive"), t.on("Recibos"), t.on("Familia")]).toEqual([1, 1, 1]);
  await t.undo(undoId!);
  await t.settle();
  expect([t.on("Archive"), t.on("Recibos"), t.on("Familia")]).toEqual([1, 1, 0]);
  expect(await t.locations([message])).toEqual(["Archive", "Recibos"]);
});

it("a refused undo (the reminders are full) changes nothing, and its retry works", async () => {
  const t = await setup();
  const { thread } = await oneInInbox(t);
  const past = Date.now() - 1000;
  await t.client.call("reminders.set", { threadIds: [thread], dueAt: past, kind: "always" });
  const { undoId } = await t.move([thread], "Recibos");
  expect((await t.client.call("reminders.list", {})).reminders).toEqual([]);
  const refuse = vi.spyOn(t.backend.reminders, "restore").mockResolvedValueOnce(false);
  await expect(t.undo(undoId!)).rejects.toThrow();
  // still in the folder, not queued to leave it
  expect(await t.threadsIn("Recibos")).toEqual([thread]);
  expect(await t.inbox()).toEqual([]);
  expect((await t.ops()).filter((o) => o.startsWith("leaveFolder"))).toEqual([]);
  refuse.mockRestore();
  expect(await t.undo(undoId!)).toEqual({ restored: 1 });
  expect(await t.threadsIn("Recibos")).toEqual([]);
  expect(await t.inbox()).toEqual([thread]);
  expect((await t.client.call("reminders.list", {})).reminders.map((r) => r.threadId)).toEqual([thread]);
});

it("from one folder to another, and back with undo", async () => {
  const t = await setup();
  t.server.control.addMessage("Familia", { raw: rawIdleMail("Foto") });
  await t.sync();
  const [thread] = await t.threadsIn("Familia");
  const { id: message } = await t.messageOf(thread!);
  const { undoId } = await t.move([thread!], "Recibos", "Familia");
  expect(await t.threadsIn("Familia")).toEqual([]);
  expect(await t.threadsIn("Recibos")).toEqual([thread]);
  await t.settle();
  expect([t.on("Familia"), t.on("Recibos")]).toEqual([0, 1]);
  await t.undo(undoId!);
  expect(await t.threadsIn("Familia")).toEqual([thread]);
  expect(await t.threadsIn("Recibos")).toEqual([]);
  await t.settle();
  expect([t.on("Familia"), t.on("Recibos")]).toEqual([1, 0]);
  expect(await t.locations([message])).toEqual(["Familia"]);
  expect(await t.held([message])).toEqual([]);
});

it("from Archive, and undo goes back there", async () => {
  const t = await setup();
  t.server.control.addMessage("Archive", { raw: rawIdleMail("Viejo") });
  await t.sync();
  const [thread] = (await t.client.call("threads.list", { view: "archive", accountId: t.account.id })).items.map((x) => x.id);
  const { id: message } = await t.messageOf(thread!);
  const { undoId } = await t.move([thread!], "Recibos");
  await t.settle();
  expect([t.on("Archive"), t.on("Recibos")]).toEqual([0, 1]);
  await t.undo(undoId!);
  await t.settle();
  expect([t.on("Archive"), t.on("Recibos")]).toEqual([1, 0]);
  expect(await t.locations([message])).toEqual(["Archive"]);
});

it("a thread already in the folder, in the Inbox too: no second copy in the folder, and it leaves the Inbox", async () => {
  const t = await setup();
  const { thread } = await oneInInbox(t);
  const category = await t.client.call("categories.create", { name: "Facturas", color: "cyan", showInInbox: true });
  await t.client.call("categories.addThreads", { categoryId: category.id, threadIds: [thread], source: "picker" });
  await t.move([thread], "Recibos");
  await t.settle();
  await t.client.call("categories.removeThreads", { categoryId: category.id, threadIds: [thread], reason: "user" });
  await t.move([thread], "Recibos");
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos")]).toEqual([0, 1]);
  expect(await t.inbox()).toEqual([]);
  expect(await t.threadsIn("Recibos")).toEqual([thread]);
});

it("a server without UIDPLUS: refused before anything changes, nothing held, said in plain words, and the thread is safe", async () => {
  const t = await setup(["MOVE", "SPECIAL-USE", "ENABLE", "CONDSTORE"]);
  const { thread, message } = await oneInInbox(t);
  await t.move([thread], "Recibos");
  await t.settle();
  expect(t.on("Recibos")).toBe(0);
  // the folder doesn't claim what never happened
  expect(await t.threadsIn("Recibos")).toEqual([]);
  expect((await t.backend.store.debug.snapshot()).ops.find((o) => o.kind === "moveToFolder")?.state).toBe("failed");
  // the archive that follows does what an archive does on this server; the next pass finds the mail, no copy lost
  await t.sync();
  expect(t.on("INBOX") + t.on("Archive")).toBe(1);
  expect(await t.held([message])).toEqual([]);
});

it("a folder gone from the server fails the move with Terno's words; the mail stays reachable", async () => {
  const t = await setup();
  const { thread, message } = await oneInInbox(t);
  await t.sync();
  await t.move([thread], "Recibos");
  t.server.control.deleteMailbox("Recibos");
  await t.settle();
  expect(await t.threadsIn("Recibos")).toEqual([]);
  expect((await t.locations([message])).length).toBeGreaterThan(0);
  expect((await t.client.call("threads.get", { threadId: thread })).messages[0]!.id).toBe(message);
});

it("a folder that isn't listed, or a thread of another account, changes nothing", async () => {
  const t = await setup();
  const { thread } = await oneInInbox(t);
  await expect(t.move([thread], "Nope")).rejects.toThrow();
  expect(await t.inbox()).toEqual([thread]);
  expect(await t.ops()).toEqual([]);
});

it("a scope moves everything from the sender, kept threads copied, with one undo", async () => {
  const t = await setup();
  for (const s of ["Uno", "Dos", "Tres"]) t.server.control.addMessage("INBOX", { raw: rawIdleMail(s) });
  await t.sync();
  const ids = await t.inbox();
  const r = await t.client.call("folders.moveScope", { accountId: t.account.id, folder: "Recibos", from: null, scope: { kind: "sender", email: SENDER }, filterName: "Ana → Recibos" });
  expect(r.affected).toBe(3);
  expect(await t.inbox()).toEqual([]);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos")]).toEqual([0, 3]);
  await t.undo(r.undoId!);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos")]).toEqual([3, 0]);
  expect(new Set(await t.inbox())).toEqual(new Set(ids));
});

// ── plan 128: a line's filter, on a real server

const SENDER_RULE = (accountId: number, folder: string) => ({ match: "all" as const, conditions: [{ field: "from" as const, op: "equals" as const, value: SENDER }], actions: [{ type: "moveToFolder" as const, accountId, folder }] });

it("a line saves the filter: new mail reaching the server ends in the folder, not in INBOX; undo takes back the filter and the sweep", async () => {
  const t = await setup();
  for (const s of ["Uno", "Dos"]) t.server.control.addMessage("INBOX", { raw: rawIdleMail(s) });
  await t.sync();
  const r = await t.client.call("folders.moveScope", { accountId: t.account.id, folder: "Recibos", from: null, scope: { kind: "sender", email: SENDER }, filterName: "Ana → Recibos" });
  expect(r).toMatchObject({ affected: 2, filterFailed: false });
  expect(r.filter?.filterUndo).not.toBeNull();
  const [saved] = await t.client.call("filters.list", {});
  expect(saved).toMatchObject({ name: "Ana → Recibos", auto: true, rule: { actions: [{ type: "moveToFolder", accountId: t.account.id, folder: "Recibos" }] } });
  await t.settle();

  t.server.control.addMessage("INBOX", { raw: rawIdleMail("Tres") });
  await t.sync();
  // in the folder before the server has answered
  expect(await t.inbox()).toEqual([]);
  expect((await t.threadsIn("Recibos")).length).toBe(3);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos"), t.on("Archive")]).toEqual([0, 3, 0]);
  expect(await t.ops()).toEqual([]);

  await t.client.call("similar.undo", { undoId: r.undoId, filterUndo: r.filter!.filterUndo });
  expect(await t.client.call("filters.list", {})).toEqual([]);
  await t.settle();
  // the sweep's two come back; the one the filter moved on arrival stays where the filter put it
  expect([t.on("INBOX"), t.on("Recibos")]).toEqual([2, 1]);
  // and new mail stays in the Inbox now
  t.server.control.addMessage("INBOX", { raw: rawIdleMail("Cuatro") });
  await t.sync();
  await t.settle();
  expect(t.on("INBOX")).toBe(3);
});

it("new mail in a category shown in the Inbox: a copy in the folder, and it stays in INBOX", async () => {
  const t = await setup();
  const category = await t.client.call("categories.create", { name: "Facturas", color: "cyan", showInInbox: true });
  await t.sync();
  await t.client.call("filters.save", { name: "cat", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "from", op: "equals", value: SENDER }], actions: [{ type: "addCategory", categoryId: category.id }] } });
  await t.client.call("filters.save", { name: "folder", enabled: true, source: "manual", rule: SENDER_RULE(t.account.id, "Recibos") });
  t.server.control.addMessage("INBOX", { raw: rawIdleMail("Recibo") });
  await t.sync();
  const [thread] = await t.inbox();
  expect(await t.threadsIn("Recibos")).toEqual([thread]);
  await t.settle();
  expect([t.on("INBOX"), t.on("Recibos"), t.on("Archive")]).toEqual([1, 1, 0]);
  expect(await t.inbox()).toEqual([thread]);
});

it("filters.save refuses a new folder that isn't listed; one that went away doesn't stop a rename", async () => {
  const t = await setup();
  await t.sync();
  await expect(t.client.call("filters.save", { name: "x", enabled: true, source: "manual", rule: SENDER_RULE(t.account.id, "Nope") })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const saved = await t.client.call("filters.save", { name: "x", enabled: true, source: "manual", rule: SENDER_RULE(t.account.id, "Recibos") });
  // gone from the server, and from the list at the next pass
  await t.backend.store!.folders.replace(t.account.id, (await t.backend.store!.folders.list()).filter((f) => f.accountId === t.account.id && f.key !== "Recibos").map(({ key, path, selectable }) => ({ key, path, selectable })));
  await expect(t.client.call("filters.save", { id: saved.id, name: "y", enabled: true, source: "manual", rule: saved.rule })).resolves.toMatchObject({ name: "y" });
});

it("renaming a folder in Terno takes its filters along; deleting it turns them off", async () => {
  const t = await setup();
  await t.sync();
  const saved = await t.client.call("filters.save", { name: "x", enabled: true, source: "manual", rule: SENDER_RULE(t.account.id, "Recibos") });
  const { renamed } = await t.client.call("folders.rename", { accountId: t.account.id, key: "Recibos", name: "Facturas" });
  expect(renamed[0]!.to).toBe("Facturas");
  let now = (await t.client.call("filters.list", {})).find((f) => f.id === saved.id)!;
  expect(now.rule.actions).toEqual([{ type: "moveToFolder", accountId: t.account.id, folder: "Facturas" }]);
  expect(now.enabled).toBe(true);
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Facturas" });
  now = (await t.client.call("filters.list", {})).find((f) => f.id === saved.id)!;
  expect(now.enabled).toBe(false);
});

it("a backup brings the filter back to the account with that address, whatever its id is now", async () => {
  const t = await setup();
  await t.sync();
  const saved = await t.client.call("filters.save", { name: "x", enabled: true, source: "manual", rule: SENDER_RULE(t.account.id, "Recibos") });
  const backup = JSON.parse(JSON.stringify(await t.client.call("app.export", {}))) as { accounts: { id: number; email: string }[]; filters: { rule: { actions: { accountId: number }[] } }[] };
  const old = 4242;
  backup.accounts.find((a) => a.email === t.account.email)!.id = old;
  backup.filters[0]!.rule.actions[0]!.accountId = old;
  await t.client.call("filters.delete", { id: saved.id });
  await t.client.call("app.import", { data: backup as never });
  const [back] = await t.client.call("filters.list", {});
  expect(back!.rule.actions).toEqual([{ type: "moveToFolder", accountId: t.account.id, folder: "Recibos" }]);
});
