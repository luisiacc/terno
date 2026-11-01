import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry, customFolders, type ProviderContext } from "@terno/mail";
import { sqlDb } from "@terno/db";
import imapkit from "imapkit";
import { ImapFlow } from "imapflow";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, deferred, rawIdleMail } from "./test/imap-idle-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

async function setup(folders: Record<string, object>, context = (ctx: ProviderContext) => ctx) {
  const server = imapkit({ plugins: ["MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
    storage: { INBOX: {}, "": { separator: "/", folders } } });
  const commands: string[] = [];
  server.script.add({ on: "command", run: true, when(ctx) { commands.push(ctx.command!); return false; } });
  const port = await bounded(server.start(0, "127.0.0.1"), "fixture listen");
  cleanups.push(async () => { await bounded(server.stop(), "fixture stop"); });
  const dir = mkdtempSync(join(tmpdir(), "terno-s15-followup-"));
  let backend: Backend;
  let client: RpcClient;
  const registry = createRegistry({ imap: { allowInsecure: true } });
  const open = () => {
    backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher,
      providers: { ...registry, create: (ctx) => registry.create(context(ctx)) }, autoSync: false });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "s15", origin: "renderer" });
    client = new RpcClient(c);
    return { backend, client };
  };
  const first = open();
  cleanups.push(async () => { client.close(); await bounded(backend.stop(), "backend stop"); rmSync(dir, { recursive: true, force: true }); });
  const account = await first.client.call("accounts.addImap", {
    email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "127.0.0.1", port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass", verify: false,
  });
  return { server, port, commands, account, ...first, async reopen() { client.close(); await bounded(backend.stop(), "backend stop"); return open(); } };
}

function persistedTrash(backend: Backend, accountId: number) {
  const row = sqlDb(backend.store).get<{ provider_config: string }>(
    "SELECT provider_config FROM accounts WHERE id = ?", accountId,
  )!;
  return (JSON.parse(row.provider_config) as { cursor: { roles: { trash?: string } } }).cursor.roles.trash;
}

it.each([false, true])("retains the exact persisted duplicate destination after reopen (sync before action: %s)", async (syncBeforeAction) => {
  const t = await setup({ Zeta: { "special-use": "\\Trash" }, Other: {} });
  const bytes = rawIdleMail("Persisted duplicate destination", "Same foreground body");
  const original = t.server.control.addMessage("INBOX", { raw: bytes });
  const otherBytes = rawIdleMail("Unrelated same-body message", "Same foreground body");
  const other = t.server.control.addMessage("Other", { raw: otherBytes });
  expect(other.uid).toBe(original.uid);
  await t.backend.syncAccount(t.account.id);
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items[0]!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(await t.backend.store.providerStore(t.account.id).locations.of([message.id])).toEqual([
    expect.objectContaining({ mailbox: "INBOX", uidvalidity: original.uidvalidity, uid: original.uid }),
  ]);
  t.server.control.createMailbox("Alpha");
  t.server.control.setSpecialUse("Alpha", ["\\Trash"]);
  await t.backend.syncAccount(t.account.id);
  expect(persistedTrash(t.backend, t.account.id)).toBe("Zeta");
  const reopened = await t.reopen();
  expect(persistedTrash(reopened.backend, t.account.id)).toBe("Zeta");
  const destination = t.server.control.getMailbox("Zeta");
  const start = t.commands.length;
  if (syncBeforeAction) await reopened.backend.syncAccount(t.account.id);
  await reopened.client.call("threads.act", { threadIds: [thread.id], action: "trash" });
  const op = (await reopened.client.call("ops.list", {})).find((item) => item.kind === "trash")!;
  const queuedTarget = (await reopened.backend.store.ops.get(op.id))!.target_json;
  await reopened.backend.runWorker();
  expect((await reopened.client.call("ops.list", {})).find((item) => item.id === op.id)?.state).toBe("succeeded");
  expect((await reopened.backend.store.ops.get(op.id))!.target_json).toBe(queuedTarget);
  expect(t.commands.slice(start)).toContain("LIST");
  expect.soft(t.server.control.listMessages("Zeta", { raw: true }).map((item) => item.raw)).toEqual([Buffer.from(bytes)]);
  expect.soft(t.server.control.listMessages("Alpha")).toEqual([]);
  expect.soft(await reopened.backend.store.providerStore(t.account.id).locations.of([message.id])).toEqual([
    expect.objectContaining({ mailbox: "Zeta", uidvalidity: destination.uidvalidity, uid: destination.uidnext }),
  ]);
  expect((await reopened.client.call("threads.get", { threadId: thread.id })).messages[0]).toMatchObject({ id: message.id, bodyText: message.bodyText });
  expect(t.server.control.getMessage("Other", other.uid, { raw: true }).raw).toEqual(Buffer.from(otherBytes));
});

it.each(["\\Noselect", "\\NonExistent", "\\noselect", "\\nonexistent", "\\NoSeLeCt", "\\NoNeXiStEnT"])("rejects a LIST role candidate with %s before foreground dispatch", async (flag) => {
  const t = await setup({ A: {}, Group: { folders: { Child: {} } }, Zeta: { "special-use": "\\tRaSh" } });
  // The wire flags are deliberate: ImapKit normalizes storage flags before LIST.
  t.server.script.add({ on: "command", command: "LIST", when: (ctx) => !/LIST "" ""/i.test(ctx.data), send:
    `* LIST (\\HasNoChildren ${flag} \\Trash) "/" "A"\r\n` +
    `* LIST (\\HasChildren ${flag}) "/" "Group"\r\n` +
    '* LIST (\\HasNoChildren) "/" "Group/Child"\r\n' +
    '* LIST (\\HasNoChildren) "/" "INBOX"\r\n' +
    '* LIST (\\HasNoChildren \\tRaSh) "/" "Zeta"\r\n$TAG OK LIST completed\r\n',
  });
  const probe = new ImapFlow({ host: "127.0.0.1", port: t.port, secure: false,
    auth: { user: "testuser", pass: "testpass" }, logger: false });
  try {
    await probe.connect();
    const listed = await probe.list();
    expect(listed.map((item) => ({ path: item.path, flags: [...item.flags] }))).toContainEqual(expect.objectContaining({ path: "A", flags: expect.arrayContaining([flag]) }));
    await bounded(probe.logout(), "LIST probe logout");
  } finally { probe.close(); }
  const bytes = rawIdleMail("Eligibility destination", "Preserve exact foreground bytes");
  const original = t.server.control.addMessage("INBOX", { raw: bytes });
  await t.backend.syncAccount(t.account.id);

  const folders = (await t.client.call("app.bootstrap", {})).folders.filter((folder) => folder.accountId === t.account.id);
  if (["\\Noselect", "\\noselect", "\\NoSeLeCt"].includes(flag)) {
    expect.soft(folders.find((folder) => folder.key === "Group")).toMatchObject({ selectable: false, path: ["Group"] });
  } else expect.soft(folders.find((folder) => folder.key === "Group")).toBeUndefined();
  expect(folders.find((folder) => folder.key === "Group/Child")).toMatchObject({ selectable: true, path: ["Group", "Child"] });
  expect.soft(persistedTrash(t.backend, t.account.id)).toBe("Zeta");
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items[0]!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(await t.backend.store.providerStore(t.account.id).locations.of([message.id])).toEqual([
    expect.objectContaining({ mailbox: "INBOX", uidvalidity: original.uidvalidity, uid: original.uid }),
  ]);
  const destination = t.server.control.getMailbox("Zeta");
  await t.client.call("threads.act", { threadIds: [thread.id], action: "trash" });
  await t.backend.runWorker();
  expect.soft((await t.client.call("ops.list", {})).find((op) => op.kind === "trash")?.state).toBe("succeeded");
  expect.soft(t.server.control.listMessages("A")).toEqual([]);
  expect.soft(t.server.control.listMessages("Zeta", { raw: true }).map((item) => item.raw)).toEqual([Buffer.from(bytes)]);
  expect.soft(await t.backend.store.providerStore(t.account.id).locations.of([message.id])).toEqual([
    expect.objectContaining({ mailbox: "Zeta", uidvalidity: destination.uidvalidity, uid: destination.uidnext }),
  ]);
  expect((await t.client.call("threads.get", { threadId: thread.id })).messages[0]).toMatchObject({ id: message.id, bodyText: message.bodyText });
});


it("keeps a concurrent sync's selected role when a reopened foreground cursor read resumes after an older LIST", async () => {
  const entered = deferred<void>();
  const resume = deferred<void>();
  let pauseCursor = false;
  const lists: string[][] = [];
  const list = ImapFlow.prototype.list;
  vi.spyOn(ImapFlow.prototype, "list").mockImplementation(async function (this: ImapFlow, ...args) {
    const result = await list.apply(this, args);
    lists.push(result.map((mailbox) => mailbox.path));
    return result;
  });
  const t = await setup({ Zeta: { "special-use": "\\Trash" } }, (ctx) => ({
    ...ctx,
    async loadCursor<T>() {
      const saved = await ctx.loadCursor<T>();
      if (pauseCursor) {
        pauseCursor = false;
        entered.resolve();
        await resume.promise;
      }
      return saved;
    },
  }));
  const bytes = rawIdleMail("Stale role LIST", "Exact concurrent foreground body");
  const followerBytes = rawIdleMail("Current role follower", "Exact concurrent foreground body");
  const original = t.server.control.addMessage("INBOX", { raw: bytes });
  t.server.control.addMessage("INBOX", { raw: followerBytes });
  await t.backend.syncAccount(t.account.id);
  const inbox = (await t.client.call("threads.list", { view: "inbox" })).items;
  const thread = inbox.find((item) => item.subject === "Stale role LIST")!;
  const follower = inbox.find((item) => item.subject === "Current role follower")!;
  const message = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(await t.backend.store.providerStore(t.account.id).locations.of([message.id])).toEqual([
    expect.objectContaining({ mailbox: "INBOX", uidvalidity: original.uidvalidity, uid: original.uid }),
  ]);
  t.server.control.createMailbox("Alpha");
  t.server.control.setSpecialUse("Alpha", ["\\Trash"]);
  await t.backend.syncAccount(t.account.id);
  expect(persistedTrash(t.backend, t.account.id)).toBe("Zeta");
  const reopened = await t.reopen();
  expect(persistedTrash(reopened.backend, t.account.id)).toBe("Zeta");
  const start = lists.length;
  const commandStart = t.commands.length;
  pauseCursor = true;
  await reopened.client.call("threads.act", { threadIds: [thread.id], action: "trash" });
  const op = (await reopened.client.call("ops.list", {})).find((item) => item.kind === "trash")!;
  const queuedTarget = (await reopened.backend.store.ops.get(op.id))!.target_json;
  const foreground = reopened.backend.runWorker();
  try {
    await bounded(entered.promise, "foreground cursor gate");
    expect(lists.slice(start)).toContainEqual(expect.arrayContaining(["Alpha", "Zeta"]));
    expect(lists.slice(start).flat()).not.toContain("Aardvark");
    t.server.control.renameMailbox("Zeta", "Aardvark");
    await bounded(reopened.backend.syncAccount(t.account.id), "concurrent role sync");
    expect(lists.at(-1)).toEqual(expect.arrayContaining(["Alpha", "Aardvark"]));
    expect(lists.at(-1)).not.toContain("Zeta");
    expect(persistedTrash(reopened.backend, t.account.id)).toBe("Aardvark");
    const destination = t.server.control.getMailbox("Aardvark");
    resume.resolve();
    await bounded(foreground, "foreground completion");
    expect(t.commands.slice(commandStart)).toContain("UID MOVE");
    expect((await reopened.client.call("ops.list", {})).find((item) => item.id === op.id)?.state).toBe("succeeded");
    expect((await reopened.backend.store.ops.get(op.id))!.target_json).toBe(queuedTarget);
    expect.soft(t.server.control.listMessages("Aardvark", { raw: true }).map((item) => item.raw)).toEqual([Buffer.from(bytes)]);
    expect.soft(t.server.control.listMessages("Alpha")).toEqual([]);
    expect.soft(await reopened.backend.store.providerStore(t.account.id).locations.of([message.id])).toEqual([
      expect.objectContaining({ mailbox: "Aardvark", uidvalidity: destination.uidvalidity, uid: destination.uidnext }),
    ]);
    expect((await reopened.client.call("threads.get", { threadId: thread.id })).messages[0]).toMatchObject({ id: message.id, bodyText: message.bodyText });
    // No sync between actions: the next destination witnesses the provider's current cached selection.
    await reopened.client.call("threads.act", { threadIds: [follower.id], action: "trash" });
    await reopened.backend.runWorker();
    expect.soft(t.server.control.listMessages("Aardvark", { raw: true }).map((item) => item.raw)).toEqual([Buffer.from(bytes), Buffer.from(followerBytes)]);
    expect.soft(t.server.control.listMessages("Alpha")).toEqual([]);
    expect(persistedTrash(reopened.backend, t.account.id)).toBe("Aardvark");
  } finally {
    resume.resolve();
    await bounded(foreground, "joined foreground");
  }
});

it.each([false, true])("maps 10,000 deep folders without repeatedly opening each row's flag iterator (leaf flags: %s)", (withLeafFlags) => {
  type Listed = Parameters<typeof customFolders>[0][number];
  let iteratorEntries = 0;
  class CountedFlags extends Set<string> {
    override [Symbol.iterator]() { iteratorEntries++; return super[Symbol.iterator](); }
  }
  const box = (path: string, flags: string[] = []): Listed => ({ path, pathAsListed: path, name: path.split("/").at(-1)!,
    delimiter: "/", flags: new CountedFlags(flags), listed: true, subscribed: true,
    parentPath: "", parent: [] });
  const levels = Array.from({ length: 20 }, (_, i) => `Nivel ${String(i).padStart(2, "0")} de la jerarquía común`);
  const parents = levels.join("/");
  const cases = ["\\Noselect", "\\noselect", "\\NoSeLeCt"];
  const groups = levels.map((_, i) => box(levels.slice(0, i + 1).join("/"), [cases[i % 3]!]));
  const leaves = Array.from({ length: 9980 }, (_, i) => box(`${parents}/Hoja ${i}`, withLeafFlags ? ["\\HasNoChildren", "\\Unmarked"] : []));
  const result = customFolders([
    ...groups, ...leaves, box("Enviados", ["\\sEnT"]), box("Ghost", ["\\NoNeXiStEnT"]),
  ], {});
  expect(result).toHaveLength(10_000);
  expect(result.filter((folder) => !folder.selectable)).toHaveLength(20);
  expect(result).toEqual([
    ...levels.map((_, i) => ({ key: levels.slice(0, i + 1).join("/"), path: levels.slice(0, i + 1), selectable: false })),
    ...Array.from({ length: 9980 }, (_, i) => ({ key: `${parents}/Hoja ${i}`, path: [...levels, `Hoja ${i}`], selectable: true })),
  ]);
  // One role scan plus one eligibility scan per LIST row is enough; this is work, not elapsed time.
  expect(iteratorEntries).toBeLessThanOrEqual(20_004);
});

it("reflects eligibility changes when a LIST entry keeps the same mutable flag Set", () => {
  type Listed = Parameters<typeof customFolders>[0][number];
  const flags = new Set(["\\NoSeLeCt"]);
  const list = [
    { path: "Group", pathAsListed: "Group", name: "Group", delimiter: "/", flags, listed: true, subscribed: true, parentPath: "", parent: [] },
    { path: "Group/Child", pathAsListed: "Group/Child", name: "Child", delimiter: "/", flags: new Set<string>(), listed: true, subscribed: true, parentPath: "Group", parent: ["Group"] },
  ] satisfies Listed[];
  expect(customFolders(list, {})).toEqual([
    { key: "Group", path: ["Group"], selectable: false },
    { key: "Group/Child", path: ["Group", "Child"], selectable: true },
  ]);
  flags.clear();
  expect(customFolders(list, {})).toEqual([
    { key: "Group", path: ["Group"], selectable: true },
    { key: "Group/Child", path: ["Group", "Child"], selectable: true },
  ]);
  flags.add("\\NoNeXiStEnT");
  expect(customFolders(list, {})).toEqual([{ key: "Group/Child", path: ["Group", "Child"], selectable: true }]);
});
