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
import { FAVORITES_MAX, folderRef } from "@terno/core";
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

it("never makes or renames a folder into a name the account would read as a standard folder: nothing is sent, the folder stays (Codex code review round 9 #1)", async () => {
  const t = await setup(["Work"]);
  await t.backend.syncAccount(t.account.id);
  // no archive mailbox here: "Archive" would be taken as the account's by its name, and Work would vanish unmapped
  expect(errorKey(await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Archive" }).catch((e: unknown) => e))).toBe("errors.folder.reservedName");
  expect(errorKey(await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "archive" }).catch((e: unknown) => e))).toBe("errors.folder.reservedName");
  expect(t.mailboxes()).toEqual(["INBOX", "Sent", "Trash", "Work"]);
  expect(await t.ownFolders()).toEqual(["Work"]);
  // nested, it's just a name
  expect((await t.client.call("folders.create", { accountId: t.account.id, parent: "Work", name: "Archive" })).key).toBe("Work/Archive");
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

it("a folder renamed here before a pass read it counts and exports its mail, still under the old path (Codex code review round 5 #2)", async () => {
  const t = await setup(["Work", "Work/Sub"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("In work") });
  t.server.control.addMessage("Work/Sub", { raw: rawIdleMail("In sub") });
  await t.backend.syncAccount(t.account.id);
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  // no pass yet: the threads are carried to the new keys, the locations are still under the old ones
  expect(await t.threadsIn("Job")).toHaveLength(1);
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Job" })).toEqual({ messages: 2, folders: 2 });
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Job/Sub" })).toEqual({ messages: 1, folders: 1 });
  const started = await t.client.call("folders.exportStart", { accountId: t.account.id, folder: "Job", view: null });
  expect(started.total).toBe(1);
  await t.client.call("folders.exportCancel", { exportId: started.exportId });
  // once a pass has read them, the same from the new paths alone
  await t.backend.syncAccount(t.account.id);
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Job" })).toEqual({ messages: 2, folders: 2 });
});

it("a folder renamed here, its old name made again before a pass: each counts and exports its own mail (Codex code review round 6 #2)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("In work") });
  await t.backend.syncAccount(t.account.id);
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  // Job's mail is still cached under Work's path, with the old Work's UIDVALIDITY: Job's, not the new Work's
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Job" })).toEqual({ messages: 1, folders: 1 });
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Work" })).toEqual({ messages: 0, folders: 1 });
  const total = async (folder: string) => {
    const started = await t.client.call("folders.exportStart", { accountId: t.account.id, folder, view: null });
    await t.client.call("folders.exportCancel", { exportId: started.exportId });
    return started.total;
  };
  expect(await total("Job")).toBe(1);
  expect(await total("Work")).toBe(0);
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

it("a RENAME whose answer was lost into a name whose old folder is still listed here is announced by the next pass (Codex code review round 15 #2)", async () => {
  const t = await setup(["Work", "Job"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("In work") });
  t.server.control.addMessage("Job", { raw: rawIdleMail("In the old job") });
  // the old Job is another generation than Work (the fixture numbers both alike)
  t.server.control.resetUidValidity("Job", { uidvalidity: 900 });
  await t.backend.syncAccount(t.account.id);
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
  // another app deletes Job; this one still lists it
  t.server.control.deleteMailbox("Job");
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
  expect(await t.ownFolders()).toEqual(expect.arrayContaining(["Work", "Job"]));
  t.events.length = 0;
  await t.backend.syncAccount(t.account.id);
  expect(t.events[0]).toBe("renamed Work>Job");
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Job", view: null }]);
  // announced once
  t.events.length = 0;
  await t.backend.syncAccount(t.account.id);
  expect(t.events.filter((e) => e.startsWith("renamed"))).toEqual([]);
});

it("a RENAME whose intent was saved but never sent adds nothing to the cached destination's count or export (Codex code review round 17 #2)", async () => {
  const t = await setup(["Work", "Job"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("In work") });
  t.server.control.addMessage("Job", { raw: rawIdleMail("In the old job") });
  t.server.control.resetUidValidity("Job", { uidvalidity: 900 });
  await t.backend.syncAccount(t.account.id);
  // another app deletes Job; this one still lists it
  t.server.control.deleteMailbox("Job");
  // the intent is recorded, then the connection drops before the RENAME is sent
  const lost = vi.spyOn(ImapFlow.prototype, "mailboxRename").mockImplementation(async () => {
    throw Object.assign(new Error("Connection closed"), { code: "NoConnection" });
  });
  try {
    await expect(t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" })).rejects.toBeTruthy();
  } finally {
    lost.mockRestore();
  }
  expect(t.mailboxes()).toEqual(["INBOX", "Sent", "Trash", "Work"]);
  const config = await t.backend.store.accounts.config<{ cursor?: { renamed?: Record<string, unknown> } }>(t.account.id);
  expect(Object.keys(config?.config.cursor?.renamed ?? {})).toEqual(["Job"]);
  // Job counts and exports only its own cached mail; Work keeps its own
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Job" })).toEqual({ messages: 1, folders: 1 });
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Work" })).toEqual({ messages: 1, folders: 1 });
  const started = await t.client.call("folders.exportStart", { accountId: t.account.id, folder: "Job", view: null });
  await t.client.call("folders.exportCancel", { exportId: started.exportId });
  expect(started.total).toBe(1);
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

it("a DELETE the server carried out but whose answer was lost still takes the mail that was only there (Codex code review round 2 #2), and its favorite (round 12 #3)", async () => {
  const t = await setup(["Work", "Keep"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  t.server.control.addMessage("Keep", { raw: rawIdleMail("Only in keep") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const [k] = await t.threadsIn("Keep");
  const favorites = async () => (await t.client.call("app.bootstrap", {})).settings.favoriteFolders;
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Keep", view: null, on: true });
  const keep = { accountId: t.account.id, folder: "Keep", view: null };
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
  const heard: unknown[] = [];
  reopened.client.on("favoriteFolders", (f) => heard.push(f.favorites));
  await reopened.backend.syncAccount(t.account.id);
  expect((await reopened.client.call("threads.get", { threadId: a! }).catch(() => null))?.messages ?? []).toEqual([]);
  // still on the server: its mail and its place stay
  expect(await t.threadsIn("Keep")).toEqual([k]);
  // the pass that shows Work gone takes its favorite, and every window hears it; Keep's stays
  expect(await favorites()).toEqual([keep]);
  expect(heard).toEqual([[keep]]);
  // a Work made again is another folder: it isn't a favorite, after its pass either
  await reopened.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  await reopened.backend.syncAccount(t.account.id);
  expect(await favorites()).toEqual([keep]);
  expect(heard).toEqual([[keep]]);
});

it("a DELETE whose answer came took its favorite already: a Work made again here and favorited keeps it through the cleanup pass (Codex code review round 12 #3)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  await t.backend.syncAccount(t.account.id);
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([]);
  // made again and favorited before the pass that cleans up the deleted one's mail
  await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
  await t.backend.syncAccount(t.account.id);
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Work", view: null }]);
});

it("a DELETE answered but whose LIST after it failed: the next pass takes its favorite, and a Work made again isn't one (Codex code review round 13 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  await t.backend.syncAccount(t.account.id);
  const favorites = async () => (await t.client.call("app.bootstrap", {})).settings.favoriteFolders;
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
  const original = ImapFlow.prototype.list;
  const deleting = ImapFlow.prototype.mailboxDelete;
  let sent = false;
  const answered = vi.spyOn(ImapFlow.prototype, "mailboxDelete").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof deleting>) {
    const r = await deleting.apply(this, args);
    sent = true;
    return r;
  });
  // the DELETE is answered; the LIST after it fails, so the change never hands the backend what went
  const failing = vi.spyOn(ImapFlow.prototype, "list").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    if (sent) { sent = false; throw Object.assign(new Error("Connection closed"), { code: "NoConnection" }); }
    return original.apply(this, args);
  });
  try {
    await expect(t.client.call("folders.delete", { accountId: t.account.id, key: "Work" })).rejects.toBeTruthy();
  } finally {
    failing.mockRestore();
    answered.mockRestore();
  }
  expect(t.mailboxes()).toEqual(["INBOX", "Sent", "Trash"]);
  await t.backend.syncAccount(t.account.id);
  expect(await favorites()).toEqual([]);
  await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  await t.backend.syncAccount(t.account.id);
  expect(await favorites()).toEqual([]);
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

it("mail another app moved from a folder into Drafts before it was deleted here keeps its identity: the cleanup pass reads every mailbox (Codex code review round 21 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.createMailbox("Drafts");
  t.server.control.setSpecialUse("Drafts", ["\\Drafts"]);
  const moved = t.server.control.addMessage("Work", { raw: rawIdleMail("Moved to drafts") });
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  await t.backend.syncAccount(t.account.id);
  const [m, o] = await Promise.all((await t.threadsIn("Work")).map((id) => t.messageOf(id)));
  const [mm, mo] = m!.subject === "Moved to drafts" ? [m!, o!] : [o!, m!];
  // an ordinary pass never reads Drafts: the cleanup pass must, or the moved one looks gone
  t.server.control.moveMessages("Work", [moved.uid], "Drafts");
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  await t.backend.syncAccount(t.account.id);
  expect((await t.messageOf(mm.threadId)).id).toBe(mm.id);
  expect((await t.messageOf(mm.threadId)).bodyText).toBe(mm.bodyText);
  // met there, so not proven gone: held (as a vanished folder's is) until its identity is told apart
  expect(await t.held([mm.id])).toEqual([mm.id]);
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

it("a folder deleted after a rename that changed its UIDVALIDITY takes the mail cached under its old name (Codex code review round 24 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  // a server that gives a renamed mailbox a new UIDVALIDITY
  const original = ImapFlow.prototype.mailboxRename;
  const renumbered = vi.spyOn(ImapFlow.prototype, "mailboxRename").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
    const r = await original.apply(this, args);
    t.server.control.resetUidValidity(String(args[1]), { uidvalidity: 900 });
    return r;
  });
  try {
    await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  } finally {
    renumbered.mockRestore();
  }
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Job" });
  const reopened = await t.reopen();
  await reopened.backend.syncAccount(t.account.id);
  expect(await t.locations([ma.id])).toEqual([]);
  expect(await t.held([ma.id])).toEqual([]);
  expect((await t.client.call("threads.get", { threadId: a! }).catch(() => null))?.messages ?? []).toEqual([]);
  const config = await t.backend.store.accounts.config<{ cursor?: { deleted?: unknown; renamed?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.deleted).toBeUndefined();
  expect(config?.config.cursor?.renamed).toBeUndefined();
});

it("a folder deleted after its rename leaves a mailbox created again under its old name alone (Codex code review round 6 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  // another app creates Work again (a new UIDVALIDITY) and files mail there, then Job goes, all before a pass
  t.server.control.createMailbox("Work");
  t.server.control.addMessage("Work", { raw: rawIdleMail("Fresh in work") });
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Job" });
  await t.backend.syncAccount(t.account.id);
  const fresh = await t.threadsIn("Work");
  expect(fresh).toHaveLength(1);
  const mf = await t.messageOf(fresh[0]!);
  expect(mf.subject).toBe("Fresh in work");
  expect((await t.locations([mf.id])).map((l) => l.mailbox)).toEqual(["Work"]);
  // its state stays: the next pass reads it incrementally, the same message with the same identity
  await t.backend.syncAccount(t.account.id);
  expect(await t.threadsIn("Work")).toEqual(fresh);
  expect((await t.messageOf(fresh[0]!)).id).toBe(mf.id);
  // the deleted folder's own mail isn't found anywhere: it goes
  expect(await t.locations([ma.id])).toEqual([]);
  expect((await t.client.call("threads.get", { threadId: a! }).catch(() => null))?.messages ?? []).toEqual([]);
  const config = await t.backend.store.accounts.config<{ cursor?: { deleted?: unknown; mailboxes: Record<string, unknown> } }>(t.account.id);
  expect(config?.config.cursor?.deleted).toBeUndefined();
  expect(config?.config.cursor?.mailboxes.Work).toBeDefined();
});

it("a folder renamed here keeps its mail with its identity when its old name is made again before the next pass (Codex code review round 7 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved with work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  // Work made again (a new UIDVALIDITY), with mail of its own, before a pass
  await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  t.server.control.addMessage("Work", { raw: rawIdleMail("Fresh in work") });
  await t.backend.syncAccount(t.account.id);
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect((await t.locations([ma.id])).map((l) => l.mailbox)).toEqual(["Job"]);
  expect(await t.held([ma.id])).toEqual([]);
  expect((await t.messageOf(a!)).bodyText).toBe(ma.bodyText);
  const fresh = await t.threadsIn("Work");
  expect(fresh).toHaveLength(1);
  expect((await t.messageOf(fresh[0]!)).subject).toBe("Fresh in work");
  const config = await t.backend.store.accounts.config<{ cursor?: { renamed?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.renamed).toBeUndefined();
  // settled: the next pass changes nothing
  await t.backend.syncAccount(t.account.id);
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect(await t.threadsIn("Work")).toEqual(fresh);
});

it("a folder deleted here and made again before the cleanup pass: the deleted one's mail goes, the new one's stays (Codex code review round 7 #2)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in old work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  t.server.control.createMailbox("Work");
  t.server.control.addMessage("Work", { raw: rawIdleMail("Fresh in work") });
  await t.backend.syncAccount(t.account.id);
  expect(await t.locations([ma.id])).toEqual([]);
  expect(await t.held([ma.id])).toEqual([]);
  expect((await t.client.call("threads.get", { threadId: a! }).catch(() => null))?.messages ?? []).toEqual([]);
  const fresh = await t.threadsIn("Work");
  expect(fresh).toHaveLength(1);
  const mf = await t.messageOf(fresh[0]!);
  expect(mf.subject).toBe("Fresh in work");
  expect((await t.locations([mf.id])).map((l) => l.mailbox)).toEqual(["Work"]);
  const config = await t.backend.store.accounts.config<{ cursor?: { deleted?: unknown; mailboxes: Record<string, unknown> } }>(t.account.id);
  expect(config?.config.cursor?.deleted).toBeUndefined();
  expect(config?.config.cursor?.mailboxes.Work).toBeDefined();
  await t.backend.syncAccount(t.account.id);
  expect(await t.threadsIn("Work")).toEqual(fresh);
  expect((await t.messageOf(fresh[0]!)).id).toBe(mf.id);
});

it("a folder deleted, made again and deleted again before the cleanup pass: both deleted ones' mail goes (Codex code review round 15 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in old work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  await t.backend.syncAccount(t.account.id);
  // the first generation's record kept its own cleanup: nothing held as a vanished folder's
  expect(await t.locations([ma.id])).toEqual([]);
  expect(await t.held([ma.id])).toEqual([]);
  expect((await t.client.call("threads.get", { threadId: a! }).catch(() => null))?.messages ?? []).toEqual([]);
  const config = await t.backend.store.accounts.config<{ cursor?: { deleted?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.deleted).toBeUndefined();
});

it("a second DELETE of a folder made again that the server refuses keeps the first one's cleanup (Codex code review round 15 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in old work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  t.server.control.addMessage("Work", { raw: rawIdleMail("Fresh in work") });
  const refused = vi.spyOn(ImapFlow.prototype, "mailboxDelete").mockRejectedValue(Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "Not now" }));
  try {
    await expect(t.client.call("folders.delete", { accountId: t.account.id, key: "Work" })).rejects.toMatchObject({ i18n: { key: "errors.folder.refused" } });
  } finally {
    refused.mockRestore();
  }
  await t.backend.syncAccount(t.account.id);
  expect(await t.locations([ma.id])).toEqual([]);
  expect(await t.held([ma.id])).toEqual([]);
  const fresh = await t.threadsIn("Work");
  expect(fresh).toHaveLength(1);
  expect((await t.messageOf(fresh[0]!)).subject).toBe("Fresh in work");
});

it("a cursor written before keeps one deletion record a path: it's read, and its generation cleaned up (Codex code review round 15 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Only in old work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  const uidvalidity = (await t.backend.store.accounts.config<{ cursor: { mailboxes: Record<string, { uidvalidity: number }> } }>(t.account.id))!.config.cursor.mailboxes.Work!.uidvalidity;
  // Work deleted elsewhere, the cursor holding the record as a bare UIDVALIDITY (the old shape)
  t.server.control.deleteMailbox("Work");
  const cursor = (await t.backend.store.accounts.config<{ cursor: Record<string, unknown> }>(t.account.id))!.config.cursor;
  await t.backend.store.accounts.setCursor(t.account.id, { ...cursor, deleted: { Work: uidvalidity } });
  await t.backend.syncAccount(t.account.id);
  expect(await t.locations([ma.id])).toEqual([]);
  expect(await t.held([ma.id])).toEqual([]);
  const config = await t.backend.store.accounts.config<{ cursor?: { deleted?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.deleted).toBeUndefined();
});

it("a renamed folder's old name made again before the next pass shows none of the renamed one's mail, however its threads are refreshed (Codex code review round 8 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved with work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  await t.backend.rebuildFolders();
  const unread = async () => (await t.client.call("counts.get", {})).folderUnread ?? {};
  expect(await t.threadsIn("Work")).toEqual([]);
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect((await unread())[folderRef(t.account.id, "Work")]).toBeUndefined();
  expect((await unread())[folderRef(t.account.id, "Job")]).toBe(1);
  // a refresh of the thread derives its folders from its places again: never the new Work's
  await t.client.call("threads.act", { threadIds: [a!], action: "markRead" });
  await t.client.call("threads.act", { threadIds: [a!], action: "markUnread" });
  expect(await t.threadsIn("Work")).toEqual([]);
  // the pass settles it: Job keeps the mail, Work is empty
  await t.backend.syncAccount(t.account.id);
  await t.backend.rebuildFolders();
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect(await t.threadsIn("Work")).toEqual([]);
});

it("a folder renamed here keeps its mail and unread count through a thread update before the next pass; the pass retires the alias (Codex code review round 16 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("First") });
  t.server.control.addMessage("Work", { raw: rawIdleMail("Second") });
  await t.backend.syncAccount(t.account.id);
  const before = await t.threadsIn("Work");
  expect(before).toHaveLength(2);
  const unread = async () => (await t.client.call("counts.get", {})).folderUnread ?? {};
  const job = async () => (await t.client.call("app.bootstrap", {})).folders.find((f) => f.accountId === t.account.id && f.key === "Job");
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  expect((await job())?.aliases).toEqual([{ mailbox: "Work", uidvalidity: expect.any(Number) }]);
  // marked read before a pass: its folders are derived again from its places, still under Work's generation
  await t.client.call("threads.act", { threadIds: [before[0]!], action: "markRead" });
  await t.backend.rebuildFolders();
  expect(new Set(await t.threadsIn("Job"))).toEqual(new Set(before));
  expect((await unread())[folderRef(t.account.id, "Job")]).toBe(1);
  // the pass places the mail under Job and retires the rename, its alias with it
  await t.backend.syncAccount(t.account.id);
  await t.backend.rebuildFolders();
  expect(new Set(await t.threadsIn("Job"))).toEqual(new Set(before));
  expect((await unread())[folderRef(t.account.id, "Job")]).toBe(1);
  expect((await job())?.aliases).toBeUndefined();
  await t.client.call("threads.act", { threadIds: [before[1]!], action: "markRead" });
  expect(new Set(await t.threadsIn("Job"))).toEqual(new Set(before));
  expect((await unread())[folderRef(t.account.id, "Job")]).toBeUndefined();
  expect(await t.held((await Promise.all(before.map((id) => t.messageOf(id)))).map((m) => m.id))).toEqual([]);
});

it("a thread marked read during a rename's carry stays in the renamed folder with its unread state (Codex code review round 18 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("First") });
  t.server.control.addMessage("Work", { raw: rawIdleMail("Second") });
  await t.backend.syncAccount(t.account.id);
  const before = await t.threadsIn("Work");
  expect(before).toHaveLength(2);
  // the carry's turn after its first slice (both rows are in it): another window marks one read then
  let armed = false;
  let acted = false;
  const yieldTurn = t.backend.yieldTurn.bind(t.backend);
  vi.spyOn(t.backend, "yieldTurn").mockImplementation(async () => {
    if (armed && t.calls.includes("rename:end")) {
      armed = false;
      await t.client.call("threads.act", { threadIds: [before[0]!], action: "markRead" });
      acted = true;
    }
    return yieldTurn();
  });
  armed = true;
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  expect(acted).toBe(true);
  await t.backend.rebuildFolders();
  expect(new Set(await t.threadsIn("Job"))).toEqual(new Set(before));
  expect((await t.client.call("counts.get", {})).folderUnread?.[folderRef(t.account.id, "Job")]).toBe(1);
});

it("a folder renamed while its membership is being rebuilt keeps all its mail: the new key is rebuilt from its alias (Codex code review round 23 #1)", async () => {
  const t = await setup(["Work"]);
  for (const s of ["First", "Second", "Third"]) t.server.control.addMessage("Work", { raw: rawIdleMail(s) });
  await t.backend.syncAccount(t.account.id);
  await t.backend.rebuildFolders();
  const before = await t.threadsIn("Work");
  expect(before).toHaveLength(3);
  // Work unlisted and listed again (another pass's view of it): a rebuild job, its old rows cleared, its places not
  // walked yet when the rename comes
  const store = t.backend.store;
  const listed = (await store.folders.list()).filter((f) => f.accountId === t.account.id).map(({ accountId: _a, ...f }) => f);
  await store.folders.replace(t.account.id, listed.filter((f) => f.key !== "Work"));
  await store.folders.replace(t.account.id, listed);
  await store.folders.rebuild(1000);
  expect(await t.threadsIn("Work")).toEqual([]);
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  await t.backend.rebuildFolders();
  expect(new Set(await t.threadsIn("Job"))).toEqual(new Set(before));
  // and its count before any pass
  expect((await t.client.call("folders.count", { accountId: t.account.id, key: "Job" })).messages).toBe(3);
});

it("a folder made again under a renamed one's old name and renamed itself before a pass claims none of the first one's mail (Codex code review round 8 #2)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved with work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Other" });
  expect(t.mailboxes()).toEqual(["INBOX", "Job", "Other", "Sent", "Trash"]);
  const total = async (folder: string) => {
    const started = await t.client.call("folders.exportStart", { accountId: t.account.id, folder, view: null });
    await t.client.call("folders.exportCancel", { exportId: started.exportId });
    return started.total;
  };
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Other" })).toEqual({ messages: 0, folders: 1 });
  expect(await total("Other")).toBe(0);
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Job" })).toEqual({ messages: 1, folders: 1 });
  expect(await total("Job")).toBe(1);
  await t.backend.syncAccount(t.account.id);
  await t.backend.rebuildFolders();
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect(await t.threadsIn("Other")).toEqual([]);
  expect((await t.locations([ma.id])).map((l) => l.mailbox)).toEqual(["Job"]);
  expect(await t.held([ma.id])).toEqual([]);
  const config = await t.backend.store.accounts.config<{ cursor?: { renamed?: unknown } }>(t.account.id);
  expect(config?.config.cursor?.renamed).toBeUndefined();
});

it("a RENAME whose answer was lost is announced by the next pass even when another app made the old name again (Codex code review round 8 #3)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved with work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
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
  // another app makes Work again, with mail of its own, before the pass
  t.server.control.createMailbox("Work");
  t.server.control.addMessage("Work", { raw: rawIdleMail("Fresh in work") });
  const reopened = await t.reopen();
  t.events.length = 0;
  await reopened.backend.syncAccount(t.account.id);
  await reopened.backend.rebuildFolders();
  expect(t.events[0]).toBe("renamed Work>Job");
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Job", view: null }]);
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect((await t.locations([ma.id])).map((l) => l.mailbox)).toEqual(["Job"]);
  expect(await t.held([ma.id])).toEqual([]);
  const fresh = await t.threadsIn("Work");
  expect(fresh).toHaveLength(1);
  expect((await t.messageOf(fresh[0]!)).subject).toBe("Fresh in work");
});

it("a RENAME whose answer was lost never carries the old folder's mail into a new one another app made under its name before the pass (Codex code review round 19 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved with work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
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
  // another app deletes Job (Work's mail with it) and makes a Job of its own
  t.server.control.deleteMailbox("Job");
  t.server.control.createMailbox("Job");
  t.server.control.addMessage("Job", { raw: rawIdleMail("Fresh in job") });
  const reopened = await t.reopen();
  // the new Job can't be read this pass: what the store shows for it is only what the recovery gave it
  const lock = ImapFlow.prototype.getMailboxLock;
  const closed = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof lock>) {
    if (args[0] === "Job") throw Object.assign(new Error("No access"), { responseStatus: "NO", responseText: "No access" });
    return lock.apply(this, args);
  });
  try {
    await reopened.backend.syncAccount(t.account.id);
  } finally {
    closed.mockRestore();
  }
  expect(await t.threadsIn("Job")).toEqual([]);
  expect(await t.client.call("folders.count", { accountId: t.account.id, key: "Job" })).toEqual({ messages: 0, folders: 1 });
  const started = await t.client.call("folders.exportStart", { accountId: t.account.id, folder: "Job", view: null });
  await t.client.call("folders.exportCancel", { exportId: started.exportId });
  expect(started.total).toBe(0);
  // read, the new Job has only its own
  await reopened.backend.syncAccount(t.account.id);
  await reopened.backend.rebuildFolders();
  const job = await t.threadsIn("Job");
  expect(job).toHaveLength(1);
  expect(job).not.toContain(a);
  expect((await t.messageOf(job[0]!)).subject).toBe("Fresh in job");
});

it("a RENAME whose answer was lost waits for the old name's generation: a STATUS that fails keeps its record, and a later pass announces it (Codex code review round 10 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved with work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
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
  t.server.control.createMailbox("Work");
  t.server.control.addMessage("Work", { raw: rawIdleMail("Fresh in work") });
  const reopened = await t.reopen();
  // the first STATUS of Work fails (the pass's generation check); what follows, SELECT included, works
  const status = ImapFlow.prototype.status;
  let failed = false;
  const flaky = vi.spyOn(ImapFlow.prototype, "status").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof status>) {
    if (args[0] === "Work" && !failed) { failed = true; throw Object.assign(new Error("Server unavailable"), { responseStatus: "NO", responseText: "Try again" }); }
    return status.apply(this, args);
  });
  try {
    await reopened.backend.syncAccount(t.account.id);
  } finally {
    flaky.mockRestore();
  }
  expect(failed).toBe(true);
  // the view and favorite haven't been taken to the new Work's mail: nothing was decided
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Work", view: null }]);
  t.events.length = 0;
  await reopened.backend.syncAccount(t.account.id);
  await reopened.backend.rebuildFolders();
  expect(t.events[0]).toBe("renamed Work>Job");
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Job", view: null }]);
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect((await t.locations([ma.id])).map((l) => l.mailbox)).toEqual(["Job"]);
  expect(await t.held([ma.id])).toEqual([]);
  const fresh = await t.threadsIn("Work");
  expect(fresh).toHaveLength(1);
  expect((await t.messageOf(fresh[0]!)).subject).toBe("Fresh in work");
});

it("a RENAME answered but whose LIST after it failed isn't acknowledged: a pass whose STATUS of a Work made again fails waits, and a later one announces it (Codex code review round 14 #1)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved with work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
  const renaming = ImapFlow.prototype.mailboxRename;
  const list = ImapFlow.prototype.list;
  let sent = false;
  const answered = vi.spyOn(ImapFlow.prototype, "mailboxRename").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof renaming>) {
    const r = await renaming.apply(this, args);
    sent = true;
    return r;
  });
  // the RENAME is answered; the LIST after it fails, so the change never hands the backend the move
  const failing = vi.spyOn(ImapFlow.prototype, "list").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof list>) {
    if (sent) { sent = false; throw Object.assign(new Error("Connection closed"), { code: "NoConnection" }); }
    return list.apply(this, args);
  });
  try {
    await expect(t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" })).rejects.toBeTruthy();
  } finally {
    failing.mockRestore();
    answered.mockRestore();
  }
  expect(t.mailboxes()).toEqual(["INBOX", "Job", "Sent", "Trash"]);
  // another app makes Work again, and the pass's STATUS of it fails once
  t.server.control.createMailbox("Work");
  t.server.control.addMessage("Work", { raw: rawIdleMail("Fresh in work") });
  const status = ImapFlow.prototype.status;
  let failed = false;
  const flaky = vi.spyOn(ImapFlow.prototype, "status").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof status>) {
    if (args[0] === "Work" && !failed) { failed = true; throw Object.assign(new Error("Server unavailable"), { responseStatus: "NO", responseText: "Try again" }); }
    return status.apply(this, args);
  });
  try {
    await t.backend.syncAccount(t.account.id);
  } finally {
    flaky.mockRestore();
  }
  expect(failed).toBe(true);
  // nothing was decided: the favorite waits on Work
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Work", view: null }]);
  t.events.length = 0;
  await t.backend.syncAccount(t.account.id);
  await t.backend.rebuildFolders();
  expect(t.events[0]).toBe("renamed Work>Job");
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Job", view: null }]);
  expect(await t.threadsIn("Job")).toEqual([a]);
  const fresh = await t.threadsIn("Work");
  expect(fresh).toHaveLength(1);
  expect((await t.messageOf(fresh[0]!)).subject).toBe("Fresh in work");
});

it("renaming into a name a rename just vacated, before a pass, shows only the moved folder's threads there (Codex code review round 14 #2)", async () => {
  const t = await setup(["Work", "Other"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved with work") });
  t.server.control.addMessage("Other", { raw: rawIdleMail("In other") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const [b] = await t.threadsIn("Other");
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  await t.backend.rebuildFolders();
  expect(await t.threadsIn("Job")).toEqual([a]);
  // Other takes the name Work left, before a pass: Work shows Other's threads, never the old Work's
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Other", name: "Work" });
  await t.backend.rebuildFolders();
  expect(await t.threadsIn("Work")).toEqual([b]);
  expect(await t.threadsIn("Job")).toEqual([a]);
  await t.backend.syncAccount(t.account.id);
  await t.backend.rebuildFolders();
  expect(await t.threadsIn("Work")).toEqual([b]);
  expect(await t.threadsIn("Job")).toEqual([a]);
});

it("a folder made again under a renamed one's old name, then deleted, records its own generation: the renamed one keeps its mail (round 8 audit)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved with work") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  await t.client.call("folders.create", { accountId: t.account.id, parent: null, name: "Work" });
  await t.client.call("folders.delete", { accountId: t.account.id, key: "Work" });
  const config = await t.backend.store.accounts.config<{ cursor?: { deleted?: Record<string, unknown>; renamed?: Record<string, { uidvalidity: number }> } }>(t.account.id);
  // the deletion is the new Work's generation, never the renamed one's
  const job = config?.config.cursor?.renamed?.Job?.uidvalidity;
  expect(job).toBeTypeOf("number");
  const work = config?.config.cursor?.deleted?.Work as { uidvalidity: number }[] | undefined;
  expect(work).toEqual([expect.objectContaining({ uidvalidity: expect.any(Number) })]);
  expect(work?.[0]?.uidvalidity).not.toBe(job);
  await t.backend.syncAccount(t.account.id);
  expect(await t.threadsIn("Job")).toEqual([a]);
  expect((await t.locations([ma.id])).map((l) => l.mailbox)).toEqual(["Job"]);
  expect(await t.held([ma.id])).toEqual([]);
});

it("a folder another app renamed and made again, renamed here before a pass, takes none of the first one's threads with it (round 8 audit)", async () => {
  const t = await setup(["Work"]);
  t.server.control.addMessage("Work", { raw: rawIdleMail("Moved by another app") });
  await t.backend.syncAccount(t.account.id);
  const [a] = await t.threadsIn("Work");
  const ma = await t.messageOf(a!);
  // another app: Work → Job, and Work made again (a new UIDVALIDITY), before a pass
  t.server.control.renameMailbox("Work", "Job");
  t.server.control.createMailbox("Work");
  t.events.length = 0;
  await t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Other" });
  // announced (the view and favorites follow), but what the store showed under Work was the other generation's
  expect(t.events[0]).toBe("renamed Work>Other");
  expect(await t.threadsIn("Other")).toEqual([]);
  await t.backend.syncAccount(t.account.id);
  await t.backend.rebuildFolders();
  expect(await t.threadsIn("Other")).toEqual([]);
  // Job's mail is another app's rename's: kept as a vanished folder's is, never lost
  expect((await t.messageOf(a!)).bodyText).toBe(ma.bodyText);
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
  const on = (folder: string | null, view: "inbox" | null, value = true) => t.client.call("folders.favorite", { accountId: t.account.id, folder, view, on: value }).then((r) => r.favorites);
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

it("a favorite checked against the list before a rename is never written back after the rename moved it (Codex code review round 10 #4)", async () => {
  const t = await setup(["Work"]);
  await t.backend.syncAccount(t.account.id);
  const change = t.hold("rename");
  const renaming = t.client.call("folders.rename", { accountId: t.account.id, key: "Work", name: "Job" });
  await change.started;
  // the favorite reads the list (Work still there), then is slow to go on: the rename gets every chance to finish
  const list = t.backend.store.folders.list.bind(t.backend.store.folders);
  const slow = vi.spyOn(t.backend.store.folders, "list").mockImplementationOnce(async () => {
    const before = await list();
    change.release();
    await Promise.race([renaming, new Promise((r) => setTimeout(r, 200))]);
    return before;
  });
  try {
    await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
    await renaming;
  } finally {
    slow.mockRestore();
  }
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.account.id, folder: "Job", view: null }]);
});

it("a favorite on one account never drops another account's favorite that a rename just moved (Codex code review round 11 #1)", async () => {
  const t = await setup(["Work"]);
  // a second account (the same server's mailboxes) whose Work is a favorite
  const other = await t.client.call("accounts.addImap", {
    email: "other@example.test", displayName: "Other",
    imap: { host: "127.0.0.1", port: (await t.backend.store.accounts.config<{ imap: { port: number } }>(t.account.id))!.config.imap.port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass", verify: false,
  });
  await t.backend.syncAccount(t.account.id);
  await t.backend.syncAccount(other.id);
  await t.client.call("folders.favorite", { accountId: other.id, folder: "Work", view: null, on: true });
  const change = t.hold("rename");
  const renaming = t.client.call("folders.rename", { accountId: other.id, key: "Work", name: "Job" });
  await change.started;
  // the first account's favorite reads the lists (the other's Work still there), then is slow to go on: the other's
  // rename (its own folder list's turn) gets every chance to finish
  const list = t.backend.store.folders.list.bind(t.backend.store.folders);
  const slow = vi.spyOn(t.backend.store.folders, "list").mockImplementationOnce(async () => {
    const before = await list();
    change.release();
    await Promise.race([renaming, new Promise((r) => setTimeout(r, 200))]);
    return before;
  });
  try {
    await t.client.call("folders.favorite", { accountId: t.account.id, folder: null, view: "inbox", on: true });
    await renaming;
  } finally {
    slow.mockRestore();
  }
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: other.id, folder: "Job", view: null }, { accountId: t.account.id, folder: null, view: "inbox" }]);
});

it("every window hears the favorites the backend kept: a delete that fails midway still drops what went (Codex code review round 11 #2)", async () => {
  const t = await setup(["Work", "Work/Sub"]);
  await t.backend.syncAccount(t.account.id);
  // another window, which made none of these changes
  const [c, s] = createMemoryTransportPair();
  t.backend.connect(s, { clientId: "p107-other", origin: "renderer" });
  const window2 = new RpcClient(c);
  const heard: unknown[] = [];
  window2.on("favoriteFolders", (f) => heard.push(f.favorites));
  try {
    await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work", view: null, on: true });
    await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Work/Sub", view: null, on: true });
    const original = ImapFlow.prototype.mailboxDelete;
    // Work/Sub goes, then the server refuses Work
    const refused = vi.spyOn(ImapFlow.prototype, "mailboxDelete").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (args[0] === "Work") throw Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "Not now" });
      return original.apply(this, args);
    });
    try {
      await expect(t.client.call("folders.delete", { accountId: t.account.id, key: "Work" })).rejects.toMatchObject({ i18n: { key: "errors.folder.partialDelete" } });
    } finally {
      refused.mockRestore();
    }
    await new Promise((r) => setTimeout(r, 10));
    const work = { accountId: t.account.id, folder: "Work", view: null };
    expect(heard).toEqual([[work], [work, { accountId: t.account.id, folder: "Work/Sub", view: null }], [work]]);
    expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([work]);
  } finally {
    window2.close();
  }
});

it("a favorite waiting while its account is removed is never saved after the removal's cleanup (Codex code review round 11 #3)", async () => {
  const t = await setup(["Work"]);
  await t.backend.syncAccount(t.account.id);
  // the account's row goes slowly: a favorite asked for meanwhile gets every chance to land
  const remove = t.backend.store.accounts.remove.bind(t.backend.store.accounts);
  const asked: { favorite?: Promise<unknown> } = {};
  const slow = vi.spyOn(t.backend.store.accounts, "remove").mockImplementationOnce(async (id: number) => {
    asked.favorite = t.client.call("folders.favorite", { accountId: t.account.id, folder: null, view: "inbox", on: true }).catch((e: unknown) => e);
    await Promise.race([asked.favorite, new Promise((r) => setTimeout(r, 200))]);
    return remove(id);
  });
  try {
    await t.client.call("accounts.remove", { id: t.account.id });
  } finally {
    slow.mockRestore();
  }
  expect(((await asked.favorite) as { code?: string }).code).toBe("NOT_FOUND");
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
  expect((await t.client.call("folders.favorite", { accountId: t.account.id, folder: "Kept", view: null, on: true })).favorites).toEqual([{ accountId: t.account.id, folder: "Kept", view: null }]);
});
