/**
 * Plan 107: an account's own folders created, renamed and deleted on a real IMAP server (imapkit), end to end through
 * the RPCs: what the server lists after is stored, a renamed folder keeps its mail (and its messages their identity)
 * after the next pass, a deleted one takes the mail that was only there (resumable across a restart), favorites
 * follow, and a change runs alone with the account's provider (no sync, op or other change interleaves).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { FAVORITES_MAX } from "@terno/core";
import { createRegistry, type MailProvider } from "@terno/mail";
import { ImapFlow } from "imapflow";
import imapkit from "imapkit";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, deferred, rawIdleMail } from "./test/imap-idle-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

type Hold = { started: () => void; release: Promise<void> };

async function setup(folders: string[]) {
  const server = imapkit({ plugins: ["MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
    storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" }, Trash: { "special-use": "\\Trash" } } } } });
  const port = await bounded(server.start(0, "127.0.0.1"), "fixture listen");
  // created as the server's own (a nested path in the storage object isn't a real child there)
  for (const path of folders) server.control.createMailbox(path);
  cleanups.push(async () => { await bounded(server.stop(), "fixture stop"); });
  const dir = mkdtempSync(join(tmpdir(), "terno-p107-"));
  const registry = createRegistry({ imap: { allowInsecure: true } });
  /** what reached the provider, in order; a method can be held at its start */
  const calls: string[] = [];
  const holds = new Map<string, Hold>();
  const wrap = (p: MailProvider): MailProvider => {
    const traced = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) => async (...a: A) => {
      calls.push(`${name}:start`);
      const hold = holds.get(name);
      if (hold) { holds.delete(name); hold.started(); await hold.release; }
      try { return await fn(...a); } finally { calls.push(`${name}:end`); }
    };
    return { ...p, sync: traced("sync", p.sync.bind(p)), execute: traced("execute", p.execute.bind(p)),
      createFolder: traced("create", p.createFolder!.bind(p)), renameFolder: traced("rename", p.renameFolder!.bind(p)), deleteFolder: traced("delete", p.deleteFolder!.bind(p)) };
  };
  let backend: Backend;
  let client: RpcClient;
  const events: string[] = [];
  const open = () => {
    backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher,
      providers: { ...registry, create: (ctx) => wrap(registry.create(ctx)) }, autoSync: false });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "p107", origin: "renderer" });
    client = new RpcClient(c);
    client.on("foldersRenamed", (r) => events.push(`renamed ${r.map((m) => `${m.from}>${m.to}`).join(",")}`));
    client.on("folders", (f) => events.push(`folders ${f.map((x) => x.key).join(",")}`));
    return { backend, client };
  };
  const first = open();
  cleanups.push(async () => { client.close(); await bounded(backend.stop(), "backend stop"); rmSync(dir, { recursive: true, force: true }); });
  const account = await first.client.call("accounts.addImap", {
    email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "127.0.0.1", port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass", verify: false,
  });
  const t = {
    server, account, calls, events, ...first,
    /** holds the next call of `name` at its start: resolves once it started; `release()` lets it go on */
    hold(name: string) {
      const started = deferred<void>();
      const release = deferred<void>();
      holds.set(name, { started: () => started.resolve(), release: release.promise });
      return { started: started.promise, release: () => release.resolve() };
    },
    async reopen() { client.close(); await bounded(backend.stop(), "backend stop"); const r = open(); t.backend = r.backend; t.client = r.client; return r; },
    mailboxes: () => server.control.listMailboxes().map((m: { path: string }) => m.path).sort(),
    async threadsIn(folder: string) { return (await t.client.call("threads.list", { view: "all", accountId: account.id, folder })).items.map((x) => x.id); },
    async messageOf(threadId: number) { return (await t.client.call("threads.get", { threadId })).messages[0]!; },
    locations: (ids: number[]) => t.backend.store.providerStore(account.id).locations.of(ids),
    held: (ids: number[]) => t.backend.store.providerStore(account.id).locations.unresolved(ids),
    async ownFolders() { return (await t.client.call("app.bootstrap", {})).folders.filter((f) => f.accountId === account.id).map((f) => f.key); },
  };
  return t;
}

const errorKey = (e: unknown) => (e as { i18n?: { key: string } }).i18n?.key;

it("creates a folder at the top and inside another, on the server's names; a sibling's name in another case, or the separator, is refused", async () => {
  const t = await setup(["Work"]);
  await t.backend.syncAccount(t.account.id);
  expect(await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Travel" })).toEqual({ accountId: t.account.id, key: "Travel", path: ["Travel"], selectable: true });
  expect(await t.client.call("folders.create", { accountId: t.account.id, parent: "Work", name: "Clients" })).toEqual({ accountId: t.account.id, key: "Work/Clients", path: ["Work", "Clients"], selectable: true });
  expect(t.mailboxes()).toEqual(["INBOX", "Sent", "Trash", "Travel", "Work", "Work/Clients"]);
  expect(await t.ownFolders()).toEqual(expect.arrayContaining(["Travel", "Work", "Work/Clients"]));
  expect(t.events.at(-1)).toMatch(/^folders .*Work\/Clients/);
  expect(errorKey(await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "work" }).catch((e: unknown) => e))).toBe("errors.folder.nameTaken");
  expect(errorKey(await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "a/b" }).catch((e: unknown) => e))).toBe("errors.folder.nameSeparator");
  expect(errorKey(await t.client.call("folders.create", { accountId: t.account.id, parent: "Sent", name: "x" }).catch((e: unknown) => e))).toBe("errors.folder.standard");
  expect(t.mailboxes()).toEqual(["INBOX", "Sent", "Trash", "Travel", "Work", "Work/Clients"]);
});

it("renames a folder with its subfolder: the move is announced before the list, favorites follow, and after the next pass the mail is there with the same identity", async () => {
  const t = await setup(["Work", "Work/Sub"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("In work") });
  t.server.control.addMessage("Work/Sub", { raw: rawIdleMail("In sub") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const [c] = await t.threadsIn("Work/Sub");
  const [ma, mc] = [await t.messageOf(a!), await t.messageOf(c!)];
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work/Sub", view: null, on: true });
  t.events.length = 0;
  expect(await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" })).toEqual({ renamed: [{ accountId: t.account.id, from: "Work", to: "Job" }, { accountId: t.account.id, from: "Work/Sub", to: "Job/Sub" }] });
  expect(t.mailboxes()).toEqual(["INBOX", "Job", "Job/Sub", "Sent", "Trash"]);
  expect(t.events[0]).toBe("renamed Work>Job,Work/Sub>Job/Sub");
  expect(t.events[1]).toMatch(/^folders /);
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Job/Sub", view: null }]);
  await t.backend.syncAccount(t.account.id);
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect(await t.threadsIn("Job/Sub")).toEqual([c]);
  expect((await t.locations([ma.id, mc.id])).map((l) => [l.message_id, l.mailbox])).toEqual([[ma.id, "Job"], [mc.id, "Job/Sub"]]);
  // proven by the UIDs under the same UIDVALIDITY: nothing is held, the bodies are the ones stored before
  expect(await t.held([ma.id, mc.id])).toEqual([]);
  expect((await t.messageOf(a!)).bodyText).toBe(ma.bodyText);
});

it("a RENAME the server carried out but whose answer was lost still keeps the mail, with its identity, after a restart (Codex code review round 3 #1)", async () => {
  const t = await setup(["Work", "Keep"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("In work") });
  t.server.control.addMessage("Keep", { raw: rawIdleMail("In keep") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const [k] = await t.threadsIn("Keep");
  const ma = await t.messageOf(a!);
  const original = ImapFlow.prototype.mailboxRename;
  // Work: renamed, then the connection drops before the answer; Keep: the connection drops before it's sent
  const lost = vi.spyOn(ImapFlow.prototype, "mailboxRename").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    if (args[0] === "Work") await original.apply(this, args);
    throw Object.assign(new Error("Connection closed"), { code: "NoConnection" });
  });
  try {
    await expect(t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" })).rejects.toBeTruthy();
    await expect(t.client.call("folders.rename", { accountId: t.account.id, key: "Keep", name: "Kept" })).rejects.toBeTruthy();
  } finally {
    lost.mockRestore();
  }
  expect(t.mailboxes()).toEqual(["INBOX", "Job", "Keep", "Sent", "Trash"]);
  const reopened = await t.reopen();
  await reopened.backend.syncAccount(t.account.id);
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect((await t.locations([ma.id])).map((l) => l.mailbox)).toEqual(["Job"]);
  expect(await t.held([ma.id])).toEqual([]);
  expect(await t.threadsIn("Keep")).toEqual([k]);
  // both settled by the pass: nothing left recorded
  const config = await t.backend.store.accounts.config<{ cursor?: { renamed?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.renamed).toBeUndefined();
});

it("a RENAME whose answer was lost is announced by the next pass, before its list: the view and favorites follow it (Codex code review round 5 #1)", async () => {
  const t = await setup(["Work", "Work/Sub"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("In work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work/Sub", view: null, on: true });
  const original = ImapFlow.prototype.mailboxRename;
  const lost = vi.spyOn(ImapFlow.prototype, "mailboxRename").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    await original.apply(this, args);
    throw Object.assign(new Error("Connection closed"), { code: "NoConnection" });
  });
  try {
    await expect(t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" })).rejects.toBeTruthy();
  } finally {
    lost.mockRestore();
  }
  expect(await t.ownFolders()).toEqual(expect.arrayContaining(["Work", "Work/Sub"]));
  const reopened = await t.reopen();
  t.events.length = 0;
  await reopened.backend.syncAccount(t.account.id);
  expect(t.events[0]).toBe("renamed Work>Job,Work/Sub>Job/Sub");
  expect(t.events[1]).toMatch(/^folders .*Job/);
  expect(t.events.filter((e) => e.startsWith("renamed"))).toHaveLength(1);
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Job", view: null }, { accountId: t.account.id, folder: "Job/Sub", view: null }]);
  expect(await t.threadsIn("Job")).toEqual([a]);
  // announced once: the next pass has nothing to follow
  t.events.length = 0;
  await reopened.backend.syncAccount(t.account.id);
  expect(t.events.filter((e) => e.startsWith("renamed"))).toEqual([]);
});

it("a RENAME the server refuses leaves no record behind (Codex code review round 3 #1)", async () => {
  const t = await setup(["Work"]);
  await t.backend.syncAccount(t.account.id);
  const refused = vi.spyOn(ImapFlow.prototype, "mailboxRename").mockRejectedValue(Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "Not now" }));
  try {
    await expect(t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" })).rejects.toMatchObject({ i18n: { key: "errors.folder.refused" } });
  } finally {
    refused.mockRestore();
  }
  const config = await t.backend.store.accounts.config<{ cursor?: { renamed?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.renamed).toBeUndefined();
});

it("renamed twice before a pass (Work, Job, New), the folder keeps its mail with its identity (Codex code review round 3 #2)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("In work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Job", name: "New" });
  expect(t.mailboxes()).toEqual(["INBOX", "New", "Sent", "Trash"]);
  await t.backend.syncAccount(t.account.id);
  expect(await t.threadsIn("New")).toEqual([a]);
  expect((await t.locations([ma.id])).map((l) => l.mailbox)).toEqual(["New"]);
  expect(await t.held([ma.id])).toEqual([]);
  expect((await t.messageOf(a!)).bodyText).toBe(ma.bodyText);
});

it("deletes a folder and its subfolder: what was only there goes with the next pass, mail also elsewhere stays, favorites go", async () => {
  const t = await setup(["Work", "Work/Sub"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  t.server.control.addMessage("Work/Sub", { raw: rawIdleMail("Only in sub") });
  const both = rawIdleMail("In both");
  t.server.control.addMessage("INBOX", { raw: both });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const [c] = await t.threadsIn("Work/Sub");
  const [b] = (await t.client.call("threads.list", { view: "inbox", accountId: t.account.id })).items.map((x) => x.id);
  const mb = await t.messageOf(b!);
  // the same message in Work too (its place known here, as a copy this app made would be)
  const copy = t.server.control.addMessage("Work", { raw: both });
  await t.backend.store.providerStore(t.account.id).locations.upsert(mb.id, "Work", copy.uidvalidity, copy.uid, []);
  await t.backend.syncAccount(t.account.id);
  expect(new Set(await t.threadsIn("Work"))).toEqual(new Set([a, b]));
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: null, view: "inbox", on: true });
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Work" })).toEqual({ messages: 3, folders: 2 });
  expect(await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" })).toEqual({ deleted: ["Work/Sub", "Work"] });
  expect(t.mailboxes()).toEqual(["INBOX", "Sent", "Trash"]);
  expect(await t.ownFolders()).toEqual([]);
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: null, view: "inbox" }]);
  await t.backend.syncAccount(t.account.id);
  expect((await t.client.call("threads.get", { threadId: a! }).catch(() => null))?.messages ?? []).toEqual([]);
  expect((await t.client.call("threads.get", { threadId: c! }).catch(() => null))?.messages ?? []).toEqual([]);
  expect((await t.locations([mb.id])).map((l) => l.mailbox)).toEqual(["INBOX"]);
  expect(await t.held([mb.id])).toEqual([]);
  expect((await t.messageOf(b!)).id).toBe(mb.id);
});

it("deleting a folder keeps a message under an identity hold, and its other places (the stores never delete a held message)", async () => {
  const t = await setup(["Work"]);
  const both = rawIdleMail("Held in both");
  t.server.control.addMessage("INBOX", { raw: both });
  await t.backend.syncAccount(t.account.id);
  const [b] = (await t.client.call("threads.list", { view: "inbox", accountId: t.account.id })).items.map((x) => x.id);
  const mb = await t.messageOf(b!);
  const copy = t.server.control.addMessage("Work", { raw: both });
  const store = t.backend.store.providerStore(t.account.id).locations;
  await store.upsert(mb.id, "Work", copy.uidvalidity, copy.uid, []);
  await store.fence([mb.id]);
  expect(await t.held([mb.id])).toEqual([mb.id]);
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  await t.backend.syncAccount(t.account.id);
  expect((await t.messageOf(b!)).id).toBe(mb.id);
  expect((await t.locations([mb.id])).map((l) => l.mailbox)).toEqual(["INBOX"]);
});

it("a delete interrupted before its cleanup pass finishes it after a restart", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  // no pass ran (autoSync is off here): the mail is still here, its place written down in the cursor
  expect((await t.locations([ma.id])).map((l) => l.mailbox)).toEqual(["Work"]);
  const reopened = await t.reopen();
  await reopened.backend.syncAccount(t.account.id);
  expect(await t.locations([ma.id])).toEqual([]);
  expect((await reopened.client.call("threads.get", { threadId: a! }).catch(() => null))?.messages ?? []).toEqual([]);
  // nothing left to do: another pass changes nothing
  await reopened.backend.syncAccount(t.account.id);
  expect(t.mailboxes()).toEqual(["INBOX", "Sent", "Trash"]);
});

it("a DELETE the server carried out but whose answer was lost still takes the mail that was only there (Codex code review round 2 #2)", async () => {
  const t = await setup(["Work", "Keep"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  t.server.control.addMessage("Keep", { raw: rawIdleMail("Only in keep") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const [k] = await t.threadsIn("Keep");
  const original = ImapFlow.prototype.mailboxDelete;
  // Work: deleted, then the connection drops before the answer; Keep: the connection drops before it's sent
  const lost = vi.spyOn(ImapFlow.prototype, "mailboxDelete").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    if (args[0] === "Work") await original.apply(this, args);
    throw Object.assign(new Error("Connection closed"), { code: "NoConnection" });
  });
  try {
    await expect(t.client.call("folders.delete", { accountId: t.account.id, key: "Work" })).rejects.toBeTruthy();
    await expect(t.client.call("folders.delete", { accountId: t.account.id, key: "Keep" })).rejects.toBeTruthy();
  } finally {
    lost.mockRestore();
  }
  expect(t.mailboxes()).toEqual(["INBOX", "Keep", "Sent", "Trash"]);
  const reopened = await t.reopen();
  await reopened.backend.syncAccount(t.account.id);
  expect((await reopened.client.call("threads.get", { threadId: a! }).catch(() => null))?.messages ?? []).toEqual([]);
  // still on the server: its mail and its place stay
  expect(await t.threadsIn("Keep")).toEqual([k]);
});

it("a DELETE the server refuses leaves no record behind, and its mail stays", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const refused = vi.spyOn(ImapFlow.prototype, "mailboxDelete").mockRejectedValue(Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "Not now" }));
  try {
    await expect(t.client.call("folders.delete", { accountId: t.account.id, key: "Work" })).rejects.toMatchObject({ i18n: { key: "errors.folder.refused" } });
  } finally {
    refused.mockRestore();
  }
  const config = await t.backend.store.accounts.config<{ cursor?: { deleted?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.deleted).toBeUndefined();
  await t.backend.syncAccount(t.account.id);
  expect(await t.threadsIn("Work")).toEqual([a]);
});

it("mail another app moved out of a folder before it was deleted here keeps its identity (Codex code review round 4 #1)", async () => {
  const t = await setup(["Work"]);
  const moved = t.server.control.addMessage("Work", { raw: rawIdleMail("Moved to inbox") });
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  await t.backend.syncAccount(t.account.id);
  const [m, o] = await Promise.all((await t.threadsIn("Work")).map((id) => t.messageOf(id)));
  const [mm, mo] = m!.subject === "Moved to inbox" ? [m!, o!] : [o!, m!];
  t.server.control.moveMessages("Work", [moved.uid], "INBOX");
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  await t.backend.syncAccount(t.account.id);
  // not proven gone (the Inbox has it): kept, with its id and what's stored for it, never imported again as new
  expect((await t.messageOf(mm.threadId)).id).toBe(mm.id);
  expect((await t.messageOf(mm.threadId)).bodyText).toBe(mm.bodyText);
  const inbox = (await t.client.call("threads.list", { view: "inbox", accountId: t.account.id })).items;
  expect(inbox.filter((x) => x.id !== mm.threadId)).toEqual([]);
  // the one only there is gone
  expect((await t.client.call("threads.get", { threadId: mo.threadId }).catch(() => null))?.messages ?? []).toEqual([]);
  const config = await t.backend.store.accounts.config<{ cursor?: { deleted?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.deleted).toBeUndefined();
});

it("a folder deleted before the pass after its rename takes the mail that was only under its old name (Codex code review round 4 #2)", async () => {
  const t = await setup(["Work", "Work/Sub"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  t.server.control.addMessage("Work/Sub", { raw: rawIdleMail("Only in sub") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const [c] = await t.threadsIn("Work/Sub");
  const [ma, mc] = [await t.messageOf(a!), await t.messageOf(c!)];
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Job" });
  expect(t.mailboxes()).toEqual(["INBOX", "Sent", "Trash"]);
  // carried durably: a restart before the pass still knows Job was Work
  const reopened = await t.reopen();
  await reopened.backend.syncAccount(t.account.id);
  expect(await t.locations([ma.id, mc.id])).toEqual([]);
  expect(await t.held([ma.id, mc.id])).toEqual([]);
  expect((await t.client.call("threads.get", { threadId: a! }).catch(() => null))?.messages ?? []).toEqual([]);
  expect((await t.client.call("threads.get", { threadId: c! }).catch(() => null))?.messages ?? []).toEqual([]);
  const config = await t.backend.store.accounts.config<{ cursor?: { deleted?: unknown; renamed?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.deleted).toBeUndefined();
  expect(config?.config.cursor?.renamed).toBeUndefined();
});

it("a change waits for the running sync pass; a pass asked for during a change waits for it", async () => {
  const t = await setup(["Work"]);
  await t.backend.syncAccount(t.account.id);
  t.calls.length = 0;
  const pass = t.hold("sync");
  const syncing = t.backend.syncAccount(t.account.id);
  await pass.started;
  const creating = t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "A" });
  await new Promise((r) => setTimeout(r, 50));
  expect(t.calls).toEqual(["sync:start"]);
  pass.release();
  await Promise.all([syncing, creating]);
  expect(t.calls).toEqual(["sync:start", "sync:end", "create:start", "create:end"]);

  t.calls.length = 0;
  const change = t.hold("create");
  const second = t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "B" });
  await change.started;
  const later = t.backend.syncAccount(t.account.id);
  await new Promise((r) => setTimeout(r, 50));
  expect(t.calls).toEqual(["create:start"]);
  change.release();
  await Promise.all([second, later]);
  expect(t.calls).toEqual(["create:start", "create:end", "sync:start", "sync:end"]);
});

it("two changes on one account go one after the other", async () => {
  const t = await setup([]);
  await t.backend.syncAccount(t.account.id);
  t.calls.length = 0;
  const first = t.hold("create");
  const one = t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "One" });
  await first.started;
  const two = t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Two" });
  await new Promise((r) => setTimeout(r, 50));
  expect(t.calls).toEqual(["create:start"]);
  first.release();
  await Promise.all([one, two]);
  expect(t.calls).toEqual(["create:start", "create:end", "create:start", "create:end"]);
});

it("the ops worker passes an account by during its change, and a change waits for the op in flight", async () => {
  const t = await setup([]);
  t.server.control.addMessage("INBOX", { raw: rawIdleMail("Star me") });
  await t.backend.syncAccount(t.account.id);
  const [thread] = (await t.client.call("threads.list", { view: "inbox", accountId: t.account.id })).items.map((x) => x.id);
  t.calls.length = 0;
  // during a change: nothing of the account is claimed
  const change = t.hold("create");
  const creating = t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "A" });
  await change.started;
  await t.client.call("threads.act", { threadIds: [thread!], action: "star" });
  expect(await t.backend.runWorker()).toBe(0);
  change.release();
  await creating;
  expect(await t.backend.runWorker()).toBe(1);
  expect(t.calls).toEqual(["create:start", "create:end", "execute:start", "execute:end"]);

  // an op in flight: the change starts after it
  t.calls.length = 0;
  await t.client.call("threads.act", { threadIds: [thread!], action: "unstar" });
  const op = t.hold("execute");
  const working = t.backend.runWorker();
  await op.started;
  const after = t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "B" });
  await new Promise((r) => setTimeout(r, 50));
  expect(t.calls).toEqual(["execute:start"]);
  op.release();
  await Promise.all([working, after]);
  expect(t.calls).toEqual(["execute:start", "execute:end", "create:start", "create:end"]);
});

it("favorites: on once each, an own folder must be listed, the account must exist; removing the account drops its own", async () => {
  const t = await setup(["Work"]);
  await t.backend.syncAccount(t.account.id);
  const on = (folder: string | null, view: "inbox" | null, value = true) => t.client.call("folders.favorite", { accountId: t.account.id, folder, view, on: value });
  await on("Work", null);
  await on("Work", null);
  expect(await on(null, "inbox")).toEqual([{ accountId: t.account.id, folder: "Work", view: null }, { accountId: t.account.id, folder: null, view: "inbox" }]);
  expect(errorKey(await on("Nope", null).catch((e: unknown) => e))).toBe("errors.folder.favoriteUnknown");
  expect(await t.client.call("folders.favorite", { accountId: 999, folder: null, view: "inbox", on: true }).catch((e: unknown) => (e as { code?: string }).code)).toBe("NOT_FOUND");
  // never through settings.update
  await t.client.call("settings.update", { favoriteFolders: [] } as never);
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toHaveLength(2);
  expect(await on("Work", null, false)).toEqual([{ accountId: t.account.id, folder: null, view: "inbox" }]);
  await t.client.call("accounts.remove", { id: t.account.id });
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([]);
});

it("favorites whose folders went in another app don't count toward the limit (Codex code review #8)", async () => {
  const names = Array.from({ length: FAVORITES_MAX }, (_, i) => `F${i}`);
  const t = await setup(names);
  await t.backend.syncAccount(t.account.id);
  for (const name of names) await t.client.call("folders.favorite", { accountId: t.account.id, folder: name, view: null, on: true });
  // deleted on the server by another client: the next pass lists them gone
  for (const name of names) t.server.control.deleteMailbox(name);
  t.server.control.createMailbox("Kept");
  await t.backend.syncAccount(t.account.id);
  expect(await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Kept", view: null, on: true })).toEqual([{ accountId: t.account.id, folder: "Kept", view: null }]);
});
