/**
 * Plan 107: the demo (e2e's mailbox) changes folders in the list the backend keeps, through the same RPCs: a
 * Gmail-like account by label id, an IMAP-like one by path; a rename's move goes out before the list.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { folderRef } from "@terno/core";
import { demoRegistry } from "@terno/mail";
import { ingest, msg } from "@terno/store/conformance";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-p107-demo-"));
  const dbPath = join(dir, "test.db");
  const backend = new Backend({ dbPath, version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "p107-demo", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => { client.close(); await backend.stop().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now();
  const gmail = (await backend.store.accounts.create({ kind: "gmail", email: "acme@example.test", displayName: "Acme Studio", color: "emerald", now })).account.id;
  const imap = (await backend.store.accounts.create({ kind: "imap", email: "free@example.test", displayName: "Freelance", color: "amber", now })).account.id;
  await backend.store.folders.replace(gmail, [{ key: "Label_21", path: ["Proyectos"], selectable: true }, { key: "Label_22", path: ["Proyectos", "Rediseño web"], selectable: true }, { key: "Label_23", path: ["Equipo"], selectable: true }]);
  await backend.store.folders.replace(imap, [{ key: "Facturación", path: ["Facturación"], selectable: false }, { key: "Facturación/2026", path: ["Facturación", "2026"], selectable: true }]);
  const events: string[] = [];
  client.on("foldersRenamed", (r) => events.push(`renamed ${r.map((m) => `${m.from}>${m.to}`).join(",")}`));
  client.on("folders", () => events.push("folders"));
  const keys = async (accountId: number) => (await backend.store.folders.list()).filter((f) => f.accountId === accountId).map((f) => `${f.key}=${f.path.join("/")}`);
  return { backend, client, gmail, imap, events, keys, dbPath };
}

/** an IMAP-like Work (2 unread threads) and Work/Sub (1), the demo's places for them */
async function populated(t: Awaited<ReturnType<typeof setup>>) {
  await t.backend.store.folders.replace(t.imap, [{ key: "Work", path: ["Work"], selectable: true }, { key: "Work/Sub", path: ["Work", "Sub"], selectable: true }]);
  const at = (mailbox: string, uid: number) => ({ mailbox, uidvalidity: 1, uid, flags: [] as string[] });
  await ingest(t.backend.store, [
    msg({ accountId: t.imap, providerMsgId: "w1", rfcMessageId: "w1@test", subject: "First", inInbox: false, isRead: false, locations: [at("Work", 1)] }),
    msg({ accountId: t.imap, providerMsgId: "w2", rfcMessageId: "w2@test", subject: "Second", inInbox: false, isRead: false, locations: [at("Work", 2)] }),
    msg({ accountId: t.imap, providerMsgId: "s1", rfcMessageId: "s1@test", subject: "Below", inInbox: false, locations: [at("Work/Sub", 1)] }),
  ]);
  await t.backend.rebuildFolders();
}

/** the demo's copy of places fails after its first write (a crash would leave the same), until restored */
function cutShort(backend: Backend) {
  const real = backend.store.providerStore.bind(backend.store);
  return vi.spyOn(backend.store, "providerStore").mockImplementation((id) => {
    const store = real(id);
    let n = 0;
    const fail = () => { if (++n > 1) throw new Error("the disk went away"); };
    const { upsert, upsertMany } = store.locations;
    store.locations.upsert = async (...args) => (fail(), upsert.apply(store.locations, args));
    store.locations.upsertMany = async (...args) => (fail(), upsertMany.apply(store.locations, args));
    return store;
  });
}

/** what a folder shows, counts and exports, read through `backend` and `client` */
function reader(backend: Backend, client: RpcClient, accountId: number) {
  return {
    threadsIn: async (folder: string) => new Set((await client.call("threads.list", { view: "all", accountId, folder })).items.map((x) => x.id)),
    unread: async (folder: string) => (await client.call("counts.get", {})).folderUnread?.[folderRef(accountId, folder)],
    count: (key: string) => client.call("folders.count", { accountId, key }),
    total: async (folder: string) => {
      const started = await client.call("folders.exportStart", { accountId, folder, view: null });
      await client.call("folders.exportCancel", { exportId: started.exportId });
      return started.total;
    },
    places: async (mailbox: string) => (await backend.store.providerStore(accountId).locations.inMailbox(mailbox, 1)).length,
  };
}

it("Gmail-like: a new label id under its parent, a rename keeps keys, a delete takes the subtree", async () => {
  const t = await setup();
  expect(await t.client.call("folders.create", { accountId: t.gmail, parent: "Label_21", name: "Marca" })).toEqual({ accountId: t.gmail, key: "Label_24", path: ["Proyectos", "Marca"], selectable: true });
  expect(await t.client.call("folders.rename", { accountId: t.gmail, key: "Label_21", name: "Trabajo" })).toEqual({ renamed: [
    { accountId: t.gmail, from: "Label_21", to: "Label_21" }, { accountId: t.gmail, from: "Label_22", to: "Label_22" }, { accountId: t.gmail, from: "Label_24", to: "Label_24" },
  ] });
  expect(t.events.slice(-2)).toEqual(["renamed Label_21>Label_21,Label_22>Label_22,Label_24>Label_24", "folders"]);
  expect(await t.keys(t.gmail)).toEqual(["Label_21=Trabajo", "Label_22=Trabajo/Rediseño web", "Label_23=Equipo", "Label_24=Trabajo/Marca"]);
  expect(await t.client.call("folders.count", { accountId: t.gmail, key: "Label_21" })).toEqual({ messages: 0, folders: 3 });
  expect(await t.client.call("folders.delete", { accountId: t.gmail, key: "Label_21" })).toEqual({ deleted: ["Label_21", "Label_22", "Label_24"] });
  expect(await t.keys(t.gmail)).toEqual(["Label_23=Equipo"]);
  await expect(t.client.call("folders.create", { accountId: t.gmail, parent: null, name: "equipo" })).rejects.toMatchObject({ i18n: { key: "errors.folder.nameTaken" } });
});

it("IMAP-like: keys are paths, so a rename moves them (and a favorite with them)", async () => {
  const t = await setup();
  await t.client.call("folders.favorite", { accountId: t.imap, folder: "Facturación/2026", view: null, on: true });
  expect(await t.client.call("folders.create", { accountId: t.imap, parent: "Facturación", name: "2027" })).toMatchObject({ key: "Facturación/2027" });
  expect((await t.client.call("folders.rename", { accountId: t.imap, key: "Facturación", name: "Facturas" })).renamed.map((m) => `${m.from}>${m.to}`)).toEqual(["Facturación>Facturas", "Facturación/2026>Facturas/2026", "Facturación/2027>Facturas/2027"]);
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([{ accountId: t.imap, folder: "Facturas/2026", view: null }]);
  await t.client.call("folders.delete", { accountId: t.imap, key: "Facturas/2026" });
  expect((await t.client.call("app.bootstrap", {})).settings.favoriteFolders).toEqual([]);
  expect(await t.keys(t.imap)).toEqual(["Facturas=Facturas", "Facturas/2027=Facturas/2027"]);
});

it("IMAP-like: a renamed folder keeps its mail: counted, exported and through a thread's refresh (Codex code review round 19 #3)", async () => {
  const t = await setup();
  await t.backend.store.folders.replace(t.imap, [{ key: "Work", path: ["Work"], selectable: true }, { key: "Work/Sub", path: ["Work", "Sub"], selectable: true }]);
  const at = (mailbox: string, uid: number) => ({ mailbox, uidvalidity: 1, uid, flags: [] as string[] });
  await ingest(t.backend.store, [
    msg({ accountId: t.imap, providerMsgId: "w1", rfcMessageId: "w1@test", subject: "First", inInbox: false, isRead: false, locations: [at("Work", 1)] }),
    msg({ accountId: t.imap, providerMsgId: "w2", rfcMessageId: "w2@test", subject: "Second", inInbox: false, isRead: false, locations: [at("Work", 2)] }),
    msg({ accountId: t.imap, providerMsgId: "s1", rfcMessageId: "s1@test", subject: "Below", inInbox: false, locations: [at("Work/Sub", 1)] }),
  ]);
  await t.backend.rebuildFolders();
  const threadsIn = async (folder: string) => new Set((await t.client.call("threads.list", { view: "all", accountId: t.imap, folder })).items.map((x) => x.id));
  const work = await threadsIn("Work");
  expect(work.size).toBe(2);
  const unread = async () => (await t.client.call("counts.get", {})).folderUnread?.[folderRef(t.imap, "Job")];
  const total = async (folder: string) => {
    const started = await t.client.call("folders.exportStart", { accountId: t.imap, folder, view: null });
    await t.client.call("folders.exportCancel", { exportId: started.exportId });
    return started.total;
  };
  await t.client.call("folders.rename", { accountId: t.imap, key: "Work", name: "Job" });
  expect(await t.keys(t.imap)).toEqual(["Job=Job", "Job/Sub=Job/Sub"]);
  expect(await t.client.call("folders.count", { accountId: t.imap, key: "Job" })).toEqual({ messages: 3, folders: 2 });
  expect(await total("Job")).toBe(2);
  expect(await total("Job/Sub")).toBe(1);
  // a thread marked read is derived again from its places: still Job's
  await t.client.call("threads.act", { threadIds: [[...work][0]!], action: "markRead" });
  await t.backend.rebuildFolders();
  expect(await threadsIn("Job")).toEqual(work);
  expect(await unread()).toBe(1);
  expect(await t.client.call("folders.count", { accountId: t.imap, key: "Job" })).toEqual({ messages: 3, folders: 2 });
  // a folder made under the old name has none of it
  await t.client.call("folders.create", { accountId: t.imap, parent: null, name: "Work" });
  await t.backend.rebuildFolders();
  expect(await threadsIn("Work")).toEqual(new Set());
  expect(await t.client.call("folders.count", { accountId: t.imap, key: "Work" })).toEqual({ messages: 0, folders: 1 });
  // deleted and made again: the new one has none of the old one's mail
  await t.client.call("folders.delete", { accountId: t.imap, key: "Job/Sub" });
  await t.client.call("folders.create", { accountId: t.imap, parent: "Job", name: "Sub" });
  await t.backend.rebuildFolders();
  expect(await threadsIn("Job/Sub")).toEqual(new Set());
  expect(await t.client.call("folders.count", { accountId: t.imap, key: "Job/Sub" })).toEqual({ messages: 0, folders: 1 });
});

it("Gmail-like: a new label never takes a deleted one's id, so none of its mail (Codex code review round 19 #4)", async () => {
  const t = await setup();
  const made = await t.client.call("folders.create", { accountId: t.gmail, parent: null, name: "Viajes" });
  expect(made.key).toBe("Label_24");
  // the demo keeps a deleted label's mail, labelled as it was
  await ingest(t.backend.store, [msg({ accountId: t.gmail, providerMsgId: "v1", subject: "Billetes", gmailLabels: ["INBOX", "Label_24"] })]);
  expect(await t.client.call("folders.count", { accountId: t.gmail, key: "Label_24" })).toEqual({ messages: 1, folders: 1 });
  await t.client.call("folders.delete", { accountId: t.gmail, key: "Label_24" });
  const next = await t.client.call("folders.create", { accountId: t.gmail, parent: null, name: "Recibos" });
  expect(next.key).not.toBe("Label_24");
  expect((await t.client.call("threads.list", { view: "all", accountId: t.gmail, folder: next.key })).items).toEqual([]);
  expect(await t.client.call("folders.count", { accountId: t.gmail, key: next.key })).toEqual({ messages: 0, folders: 1 });
});

it("IMAP-like: consecutive renames keep the mail, Work → Job → Other (Codex code review round 20 #2)", async () => {
  const t = await setup();
  await populated(t);
  const r = reader(t.backend, t.client, t.imap);
  const work = await r.threadsIn("Work");
  await t.client.call("folders.rename", { accountId: t.imap, key: "Work", name: "Job" });
  await t.client.call("folders.rename", { accountId: t.imap, key: "Job", name: "Other" });
  expect(await t.keys(t.imap)).toEqual(["Other=Other", "Other/Sub=Other/Sub"]);
  expect(await r.count("Other")).toEqual({ messages: 3, folders: 2 });
  expect(await r.total("Other")).toBe(2);
  expect(await r.total("Other/Sub")).toBe(1);
  expect([await r.places("Work"), await r.places("Job"), await r.places("Other"), await r.places("Other/Sub")]).toEqual([0, 0, 2, 1]);
  // a thread's refresh and a pass keep it there
  await t.client.call("threads.act", { threadIds: [[...work][0]!], action: "markRead" });
  await t.backend.syncAccount(t.imap);
  await t.backend.rebuildFolders();
  expect(await r.threadsIn("Other")).toEqual(work);
  expect(await r.unread("Other")).toBe(1);
  // and a third rename, after the pass, too
  await t.client.call("folders.rename", { accountId: t.imap, key: "Other", name: "Work" });
  await t.backend.rebuildFolders();
  expect(await r.threadsIn("Work")).toEqual(work);
  expect(await r.count("Work")).toEqual({ messages: 3, folders: 2 });
});

it("IMAP-like: a rename cut short goes on after a reopen; the old folder keeps its mail meanwhile (Codex code review round 20 #3)", async () => {
  const t = await setup();
  await populated(t);
  const before = reader(t.backend, t.client, t.imap);
  const work = await before.threadsIn("Work");
  // the copy fails after Work's places, before Work/Sub's
  const spy = cutShort(t.backend);
  await expect(t.client.call("folders.rename", { accountId: t.imap, key: "Work", name: "Job" })).rejects.toThrow();
  spy.mockRestore();
  // the backend never stored it: Work is listed and has all of its mail, even through a pass's cleanup
  expect(await t.keys(t.imap)).toEqual(["Work=Work", "Work/Sub=Work/Sub"]);
  expect(await before.count("Work")).toEqual({ messages: 3, folders: 2 });
  await t.backend.stop();
  // reopened: the pass finishes the rename, as a server's would have, and the backend follows it
  const backend = new Backend({ dbPath: t.dbPath, version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "p107-demo-2", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => { client.close(); await backend.stop(); });
  const renamed: string[] = [];
  client.on("foldersRenamed", (m) => renamed.push(...m.map((x) => `${x.from}>${x.to}`)));
  await backend.syncAccount(t.imap);
  await backend.rebuildFolders();
  const r = reader(backend, client, t.imap);
  expect((await backend.store.folders.list()).filter((f) => f.accountId === t.imap).map((f) => f.key)).toEqual(["Job", "Job/Sub"]);
  expect(renamed).toEqual(["Work>Job", "Work/Sub>Job/Sub"]);
  expect(await r.threadsIn("Job")).toEqual(work);
  expect(await r.count("Job")).toEqual({ messages: 3, folders: 2 });
  expect(await r.total("Job")).toBe(2);
  expect(await r.total("Job/Sub")).toBe(1);
  expect([await r.places("Work"), await r.places("Work/Sub"), await r.places("Job"), await r.places("Job/Sub")]).toEqual([0, 0, 2, 1]);
});

it("IMAP-like: a rename cut short and never stored is given up by the next change, the old folder whole (Codex code review round 20 #3)", async () => {
  const t = await setup();
  await populated(t);
  const r = reader(t.backend, t.client, t.imap);
  const spy = cutShort(t.backend);
  await expect(t.client.call("folders.rename", { accountId: t.imap, key: "Work", name: "Job" })).rejects.toThrow();
  spy.mockRestore();
  await t.client.call("folders.create", { accountId: t.imap, parent: null, name: "Job" });
  await t.backend.rebuildFolders();
  expect(await r.count("Work")).toEqual({ messages: 3, folders: 2 });
  expect(await r.count("Job")).toEqual({ messages: 0, folders: 1 });
  expect(await r.places("Job")).toBe(0);
  await t.backend.syncAccount(t.imap);
  expect(new Set(await t.keys(t.imap))).toEqual(new Set(["Job=Job", "Work=Work", "Work/Sub=Work/Sub"]));
  expect(await r.count("Work")).toEqual({ messages: 3, folders: 2 });
});
