import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import { sqlDb } from "@terno/db";
import imapkit from "imapkit";
import { ImapFlow } from "imapflow";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, rawIdleMail } from "./test/imap-idle-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function setup(folders: Record<string, object>) {
  const server = imapkit({ plugins: ["MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
    storage: { INBOX: {}, "": { separator: "/", folders } } });
  const commands: string[] = [];
  server.script.add({ on: "command", run: true, when(ctx) { commands.push(ctx.command!); return false; } });
  const port = await bounded(server.start(0, "127.0.0.1"), "fixture listen");
  cleanups.push(async () => { await bounded(server.stop(), "fixture stop"); });
  const dir = mkdtempSync(join(tmpdir(), "terno-s15-followup-"));
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
