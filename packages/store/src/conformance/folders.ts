import { folderRef } from "@terno/core";
import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { generateDataset } from "@terno/mock-data";
import { ingest, msg, seedThroughCommands, threadOf, withAccounts } from "./fixtures";
import type { StoreHarness } from "./store";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const loc = (mailbox: string, uid: number) => ({ mailbox, uidvalidity: 1, uid, flags: [] as string[] });

/**
 * Plan 65: an account's own folders. Membership is written with what decides it (labels, locations, trash and
 * spam, read state, deletion), never later; Gmail's doesn't wait for the folder list, IMAP's counts listed
 * folders only. Pages, scopes and counts read it in both stores alike.
 */
export function defineFolderConformance(name: string, harness: StoreHarness): void {
  const open: MailStore[] = [];
  const fresh = async () => {
    const s = await harness.open();
    open.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of open.splice(0)) if (s.isOpen) await s.close();
  });
  const ids = async (store: MailStore, accountId: number, folder: string, o: { filter?: "unread"; keepIds?: number[]; limit?: number } = {}) =>
    (await store.threads.list({ view: "all", accountId, folder, limit: o.limit ?? 50, filter: o.filter, keepIds: o.keepIds, now: NOW })).items.map((t) => t.id);
  const unread = async (store: MailStore) => (await store.threads.counts(NOW)).folderUnread ?? {};

  describe(`folders (plan 65): ${name}`, () => {
    it("Gmail: a user label is a folder at once, listed or not; a listed one is counted; system labels never are", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      await ingest(store, [msg({ accountId: g!, providerMsgId: "g1", gmailLabels: ["INBOX", "UNREAD", "Label_1", "CATEGORY_UPDATES"] })]);
      const t = await threadOf(store, "g1");
      expect(await ids(store, g!, "Label_1")).toEqual([t]);
      expect(await ids(store, g!, "INBOX")).toEqual([]);
      expect(await ids(store, g!, "CATEGORY_UPDATES")).toEqual([]);
      // not listed yet: no count
      expect(await unread(store)).toEqual({});
      expect(await store.folders.replace(g!, [{ key: "Label_1", path: ["Clientes"], selectable: true }])).toMatchObject({ changed: true });
      expect(await unread(store)).toEqual({ [folderRef(g!, "Label_1")]: 1 });
      expect(await store.folders.list()).toEqual([{ accountId: g, key: "Label_1", path: ["Clientes"], selectable: true }]);
      // the same list again writes nothing
      expect(await store.folders.replace(g!, [{ key: "Label_1", path: ["Clientes"], selectable: true }])).toEqual({ changed: false, touched: [] });
    });

    it("Gmail: labels that change alone (flags the same) move the thread between folders", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      const r = await ingest(store, [msg({ accountId: g!, providerMsgId: "g1", gmailLabels: ["INBOX", "Label_1"] })]);
      const t = await threadOf(store, "g1");
      await store.sync.updateFlags(g!, [{ messageId: r.inserted[0]!, flags: { inInbox: true }, gmailLabels: ["INBOX", "Label_2"] }]);
      expect(await ids(store, g!, "Label_1")).toEqual([]);
      expect(await ids(store, g!, "Label_2")).toEqual([t]);
    });

    it("trash and spam take a thread out; read state moves its count; deleting its messages ends it", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      await store.folders.replace(g!, [{ key: "Label_1", path: ["Clientes"], selectable: true }]);
      const r = await ingest(store, [msg({ accountId: g!, providerMsgId: "g1", gmailLabels: ["Label_1"] })]);
      const t = await threadOf(store, "g1");
      const ref = folderRef(g!, "Label_1");
      await store.threads.act({ threadIds: [t], action: "markRead", signal: null, now: NOW });
      expect((await unread(store))[ref]).toBeUndefined();
      await store.threads.act({ threadIds: [t], action: "markUnread", signal: null, now: NOW });
      expect((await unread(store))[ref]).toBe(1);
      await store.threads.act({ threadIds: [t], action: "trash", signal: null, now: NOW });
      expect(await ids(store, g!, "Label_1")).toEqual([]);
      expect((await unread(store))[ref]).toBeUndefined();
      await store.threads.act({ threadIds: [t], action: "moveToInbox", signal: null, now: NOW });
      expect(await ids(store, g!, "Label_1")).toEqual([t]);
      await store.threads.act({ threadIds: [t], action: "spam", signal: null, now: NOW });
      expect(await ids(store, g!, "Label_1")).toEqual([]);
      await store.threads.act({ threadIds: [t], action: "notSpam", signal: null, now: NOW });
      expect(await ids(store, g!, "Label_1")).toEqual([t]);
      await store.sync.remove(r.inserted);
      expect(await ids(store, g!, "Label_1")).toEqual([]);
      expect(await unread(store)).toEqual({});
    });

    it("IMAP: a location in a listed folder is membership, written with the location; role mailboxes never are", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      await store.folders.replace(m!, [{ key: "Work", path: ["Work"], selectable: true }]);
      const r = await ingest(store, [msg({ accountId: m!, providerMsgId: "i1", locations: [loc("INBOX", 1)] }), msg({ accountId: m!, providerMsgId: "i2", inInbox: false, locations: [loc("Work", 1)] })]);
      const [t1, t2] = [await threadOf(store, "i1"), await threadOf(store, "i2")];
      expect(await ids(store, m!, "Work")).toEqual([t2]);
      expect(await ids(store, m!, "INBOX")).toEqual([]);
      const locations = store.providerStore(m!).locations;
      // copied into Work (flags unchanged): in, with no flag update at all
      await locations.upsert(r.inserted[0]!, "Work", 1, 2, []);
      expect(new Set(await ids(store, m!, "Work"))).toEqual(new Set([t1, t2]));
      // moved out of Work
      await locations.remove(r.inserted[1]!, "Work");
      expect(await ids(store, m!, "Work")).toEqual([t1]);
      // UIDVALIDITY reset: every location in Work goes, so does membership
      await locations.resetMailbox("Work");
      expect(await ids(store, m!, "Work")).toEqual([]);
    });

    it("IMAP: listing a mailbox that already has locations brings its threads in; unlisting takes them out", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      await ingest(store, [msg({ accountId: m!, providerMsgId: "i1", locations: [loc("Old", 1)] })]);
      const t = await threadOf(store, "i1");
      expect(await ids(store, m!, "Old")).toEqual([]);
      expect(await store.folders.replace(m!, [{ key: "Old", path: ["Old"], selectable: true }])).toEqual({ changed: true, touched: [t] });
      expect(await ids(store, m!, "Old")).toEqual([t]);
      expect(await store.folders.replace(m!, [])).toEqual({ changed: true, touched: [t] });
      expect(await ids(store, m!, "Old")).toEqual([]);
    });

    it("pages walk a folder by date with the cursor, filtered or not; a kept thread stays only while it's in the folder", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      await ingest(store, Array.from({ length: 7 }, (_, i) => msg({ accountId: g!, providerMsgId: `g${i}`, date: 1_800_000_000_000 + i * 1000, isRead: i % 2 === 0, gmailLabels: i === 3 ? ["INBOX"] : ["Label_1"] })));
      const all = await ids(store, g!, "Label_1");
      expect(all).toHaveLength(6);
      const page1 = await store.threads.list({ view: "all", accountId: g!, folder: "Label_1", limit: 4, now: NOW });
      const page2 = await store.threads.list({ view: "all", accountId: g!, folder: "Label_1", limit: 4, cursor: page1.nextCursor!, now: NOW });
      expect([...page1.items, ...page2.items].map((t) => t.id)).toEqual(all);
      expect(page2.nextCursor).toBeNull();
      expect(page1.items.map((t) => t.lastDate)).toEqual([...page1.items.map((t) => t.lastDate)].sort((a, b) => b - a));
      const unreadOnly = await ids(store, g!, "Label_1", { filter: "unread" });
      expect(unreadOnly.length).toBeGreaterThan(0);
      expect(unreadOnly.every((id) => all.includes(id))).toBe(true);
      // a read thread kept on screen by the filter stays, until it leaves the folder
      const read = all.find((id) => !unreadOnly.includes(id))!;
      expect(await ids(store, g!, "Label_1", { filter: "unread", keepIds: [read] })).toContain(read);
      const message = (await store.debug.snapshot()).messages.find((x) => x.threadId === read)!;
      await store.sync.updateFlags(g!, [{ messageId: message.id, flags: {}, gmailLabels: ["INBOX"] }]);
      expect(await ids(store, g!, "Label_1", { filter: "unread", keepIds: [read] })).not.toContain(read);
    });

    it("selection scopes: a folder's thread ids in key order and its count", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      await ingest(store, Array.from({ length: 5 }, (_, i) => msg({ accountId: g!, providerMsgId: `g${i}`, gmailLabels: i < 3 ? ["Label_1"] : ["Label_2"] })));
      const members = [...(await ids(store, g!, "Label_1"))].sort((a, b) => a - b);
      expect(await store.threads.scopeIds({ view: "all", accountId: g!, folder: "Label_1", limit: 10 })).toEqual(members);
      expect(await store.threads.scopeIds({ view: "all", accountId: g!, folder: "Label_1", after: members[0], limit: 10 })).toEqual(members.slice(1));
      expect(await store.threads.scopeCount({ view: "all", accountId: g!, folder: "Label_1", limit: 100 })).toBe(3);
    });

    it("the store's seed and a seed through commands write the dataset's folders and memberships alike", async () => {
      const data = generateDataset({ threads: 600, seed: 9, now: NOW });
      const shape = async (s: MailStore) => {
        const folders = await s.folders.list();
        const members: Record<string, string[]> = {};
        for (const f of folders) if (f.selectable) members[folderRef(f.accountId, f.key)] = (await s.threads.list({ view: "all", accountId: f.accountId, folder: f.key, limit: 500, now: NOW })).items.map((t) => t.subject).sort();
        return { folders: folders.map((f) => [f.accountId, f.key, f.path, f.selectable]), members, unread: (await s.threads.counts(NOW)).folderUnread };
      };
      const a = await fresh();
      await a.dev.seed(data, { now: NOW });
      const b = await fresh();
      await seedThroughCommands(b, data, NOW);
      const seeded = await shape(a);
      expect(seeded).toEqual(await shape(b));
      expect(seeded.folders.some((f) => f[3] === false)).toBe(true);
      expect(Object.values(seeded.members).filter((l) => l.length > 0).length).toBeGreaterThan(3);
    });

    it("an account's removal takes its folders; folders survive a reopen", async () => {
      let store = await fresh();
      const [g, m] = await withAccounts(store);
      await store.folders.replace(g!, [{ key: "Label_1", path: ["A"], selectable: true }, { key: "Label_2", path: ["A", "B"], selectable: true }]);
      await store.folders.replace(m!, [{ key: "Parent", path: ["Parent"], selectable: false }, { key: "Parent/Child", path: ["Parent", "Child"], selectable: true }]);
      store = await harness.reopen(store);
      open.push(store);
      expect((await store.folders.list()).map((f) => [f.accountId, f.key, f.selectable])).toEqual([
        [g, "Label_1", true],
        [g, "Label_2", true],
        [m, "Parent", false],
        [m, "Parent/Child", true],
      ]);
      await store.accounts.remove(g!);
      expect((await store.folders.list()).map((f) => f.accountId)).toEqual([m, m]);
    });
  });
}
