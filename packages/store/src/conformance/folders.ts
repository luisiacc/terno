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
  /** runs pending rebuilds to the end, two rows a slice (what the backend does with yields between) */
  const drain = async (store: MailStore) => {
    const touched = new Set<number>();
    for (let r = await store.folders.rebuild(2); ; r = await store.folders.rebuild(2)) {
      for (const t of r.touched) touched.add(t);
      if (!r.more) return [...touched];
    }
  };

  describe(`folders (plan 65): ${name}`, () => {
    it("Gmail: a user label is membership at once, listed or not: listing it later rewrites nothing; system labels never are", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      await ingest(store, [msg({ accountId: g!, providerMsgId: "g1", gmailLabels: ["INBOX", "UNREAD", "Label_1", "CATEGORY_UPDATES"] })]);
      const t = await threadOf(store, "g1");
      // not listed yet: a folder reads through the list, so nothing, and no count
      expect(await ids(store, g!, "Label_1")).toEqual([]);
      expect(await unread(store)).toEqual({});
      // listed: there at once, with nothing rewritten (Codex R1: the list never rebuilds Gmail memberships)
      expect(await store.folders.replace(g!, [{ key: "Label_1", path: ["Clientes"], selectable: true }, { key: "INBOX", path: ["x"], selectable: true }, { key: "CATEGORY_UPDATES", path: ["y"], selectable: true }])).toEqual({ changed: true, touched: [] });
      expect(await ids(store, g!, "Label_1")).toEqual([t]);
      expect(await ids(store, g!, "INBOX")).toEqual([]);
      expect(await ids(store, g!, "CATEGORY_UPDATES")).toEqual([]);
      await store.folders.replace(g!, [{ key: "Label_1", path: ["Clientes"], selectable: true }]);
      expect(await unread(store)).toEqual({ [folderRef(g!, "Label_1")]: 1 });
      expect(await store.folders.list()).toEqual([{ accountId: g, key: "Label_1", path: ["Clientes"], selectable: true }]);
      // the same list again writes nothing
      expect(await store.folders.replace(g!, [{ key: "Label_1", path: ["Clientes"], selectable: true }])).toEqual({ changed: false, touched: [] });
    });

    it("Gmail: labels that change alone (flags the same) move the thread between folders", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      await store.folders.replace(g!, [{ key: "Label_1", path: ["A"], selectable: true }, { key: "Label_2", path: ["B"], selectable: true }]);
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

    it("IMAP: listing a mailbox that already has locations brings its threads in (a sliced rebuild); unlisting takes them out", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      await ingest(store, [msg({ accountId: m!, providerMsgId: "i1", locations: [loc("Old", 1)] })]);
      const t = await threadOf(store, "i1");
      expect(await ids(store, m!, "Old")).toEqual([]);
      // Codex R5: the list changes at once; the memberships come with the rebuild, a slice at a time
      expect(await store.folders.replace(m!, [{ key: "Old", path: ["Old"], selectable: true }])).toEqual({ changed: true, touched: [] });
      expect(await drain(store)).toEqual([t]);
      expect(await ids(store, m!, "Old")).toEqual([t]);
      // unlisted: nothing rewritten (Codex R1), and it reads as nothing
      expect(await store.folders.replace(m!, [])).toEqual({ changed: true, touched: [] });
      expect(await ids(store, m!, "Old")).toEqual([]);
      expect(await unread(store)).toEqual({});
      // listed again after its mail moved out: the rows it left are rewritten, not shown
      await store.providerStore(m!).locations.remove((await store.debug.snapshot()).messages[0]!.id, "Old");
      expect(await store.folders.replace(m!, [{ key: "Old", path: ["Old"], selectable: true }])).toEqual({ changed: true, touched: [] });
      expect(await drain(store)).toEqual([t]);
      expect(await ids(store, m!, "Old")).toEqual([]);
    });

    it("Codex R7: a rebuild cancelled by unlisting, then relisted after a location changed, sees the change", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      const r = await ingest(store, Array.from({ length: 6 }, (_, i) => msg({ accountId: m!, providerMsgId: `i${i}`, locations: i < 5 ? [loc("Big", i + 1)] : [loc("INBOX", 1)] })));
      const big = [{ key: "Big", path: ["Big"], selectable: true }];
      await store.folders.replace(m!, big);
      // into its second phase (the locations), then unlisted
      for (let i = 0; i < 2; i++) await store.folders.rebuild(2);
      await store.folders.replace(m!, []);
      await store.providerStore(m!).locations.upsert(r.inserted[5]!, "Big", 1, 6, []);
      await store.folders.replace(m!, big);
      await drain(store);
      expect(await ids(store, m!, "Big")).toHaveLength(6);
    });

    it("Codex R15: the account's messages with no location, a window of ids at a time", async () => {
      const store = await fresh();
      const [g, m] = await withAccounts(store);
      const r = await ingest(store, Array.from({ length: 6 }, (_, i) => msg({ accountId: m!, providerMsgId: `i${i}`, locations: [loc("A", i + 1)] })));
      await ingest(store, [msg({ accountId: g!, providerMsgId: "other" })]);
      const locations = store.providerStore(m!).locations;
      await locations.remove(r.inserted[1]!, "A");
      await locations.remove(r.inserted[4]!, "A");
      const found: number[] = [];
      for (let after = 0, more = true; more; after += 2) {
        const w = await locations.unlocated(after, 2);
        found.push(...w.ids);
        more = w.more;
      }
      expect(found).toEqual([r.inserted[1]!, r.inserted[4]!]);
    });

    it("Codex R14: a list in another order is no change; a rename changes that folder alone; a new one, and one gone", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      const a = { key: "Label_a", path: ["Alfa"], selectable: true };
      const b = { key: "Label_b", path: ["Beta"], selectable: true };
      expect((await store.folders.replace(g!, [a, b])).changed).toBe(true);
      expect((await store.folders.replace(g!, [b, a])).changed).toBe(false);
      expect((await store.folders.replace(g!, [b, { ...a, path: ["Zeta"] }])).changed).toBe(true);
      const list = async () => (await store.folders.list()).map((f) => `${f.key}:${f.path.join("/")}`).sort();
      expect(await list()).toEqual(["Label_a:Zeta", "Label_b:Beta"]);
      await store.folders.replace(g!, [{ key: "Label_c", path: ["Gamma"], selectable: false }, b]);
      expect(await list()).toEqual(["Label_b:Beta", "Label_c:Gamma"]);
      expect((await store.folders.list()).find((f) => f.key === "Label_c")!.selectable).toBe(false);
    });

    it("Codex R12: the Unread filter's order stays exact as threads are read, unread, added, and read by the hundred", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      await store.folders.replace(g!, [{ key: "Label_1", path: ["A"], selectable: true }]);
      const r = await ingest(store, Array.from({ length: 80 }, (_, i) => msg({ accountId: g!, providerMsgId: `g${i}`, date: 1_800_000_000_000 + (i % 40) * 1000, gmailLabels: ["Label_1"] })));
      const exact = async () => (await store.threads.list({ view: "all", accountId: g!, folder: "Label_1", limit: 500, now: NOW })).items.filter((t) => t.unread).map((t) => t.id);
      const paged = async () => {
        const out: number[] = [];
        for (let page = await store.threads.list({ view: "all", accountId: g!, folder: "Label_1", filter: "unread", limit: 7, now: NOW }); ; ) {
          out.push(...page.items.map((t) => t.id));
          if (!page.nextCursor) return out;
          page = await store.threads.list({ view: "all", accountId: g!, folder: "Label_1", filter: "unread", limit: 7, cursor: page.nextCursor, now: NOW });
        }
      };
      expect(await paged()).toEqual(await exact());
      const threads = [...new Set(await Promise.all(r.inserted.map(async (_, i) => threadOf(store, `g${i}`))))];
      // a few at a time: placed in the kept order
      await store.threads.act({ threadIds: [threads[3]!, threads[50]!], action: "markRead", signal: null, now: NOW });
      expect(await paged()).toEqual(await exact());
      await store.threads.act({ threadIds: [threads[3]!], action: "markUnread", signal: null, now: NOW });
      await ingest(store, [msg({ accountId: g!, providerMsgId: "newest", date: 1_800_000_100_000, gmailLabels: ["Label_1"] })]);
      expect(await paged()).toEqual(await exact());
      // many at once: built again
      await store.threads.act({ threadIds: threads.slice(0, 70), action: "markRead", signal: null, now: NOW });
      expect(await paged()).toEqual(await exact());
      expect((await exact()).length).toBe(11);
    });

    it("Codex R12: a location removed mid-rebuild, after its slice was read ahead, brings no membership back", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      const r = await ingest(store, Array.from({ length: 5 }, (_, i) => msg({ accountId: m!, providerMsgId: `i${i}`, locations: [loc("Big", i + 1)] })));
      await store.folders.replace(m!, [{ key: "Big", path: ["Big"], selectable: true }]);
      // into its second phase, its first two locations done
      for (let i = 0; i < 2; i++) await store.folders.rebuild(2);
      await store.providerStore(m!).locations.remove(r.inserted[4]!, "Big");
      await drain(store);
      expect(await ids(store, m!, "Big")).toHaveLength(4);
      expect(await unread(store)).toEqual({ [folderRef(m!, "Big")]: 4 });
    });

    it("Codex R5: a rebuild goes a slice at a time and survives a reopen mid-way", async () => {
      let store = await fresh();
      const [, m] = await withAccounts(store);
      await ingest(store, Array.from({ length: 7 }, (_, i) => msg({ accountId: m!, providerMsgId: `i${i}`, locations: [loc("Big", i + 1)] })));
      await store.folders.replace(m!, [{ key: "Big", path: ["Big"], selectable: true }]);
      // a slice, then a quit
      expect((await store.folders.rebuild(2)).more).toBe(true);
      expect((await store.folders.rebuild(2)).more).toBe(true);
      store = await harness.reopen(store);
      open.push(store);
      await drain(store);
      expect(await ids(store, m!, "Big")).toHaveLength(7);
      expect(await store.folders.rebuild(2)).toEqual({ more: false, touched: [] });
    });

    it("pages walk a folder by date with the cursor, filtered or not; a kept thread stays only while it's in the folder", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      await store.folders.replace(g!, [{ key: "Label_1", path: ["A"], selectable: true }]);
      await ingest(store, Array.from({ length: 7 }, (_, i) => msg({ accountId: g!, providerMsgId: `g${i}`, date: 1_800_000_000_000 + i * 1000, isRead: i % 2 === 0, gmailLabels: i === 3 ? ["INBOX"] : ["Label_1"] })));
      const all = await ids(store, g!, "Label_1");
      expect(all).toHaveLength(6);
      const page1 = await store.threads.list({ view: "all", accountId: g!, folder: "Label_1", limit: 4, now: NOW });
      const page2 = await store.threads.list({ view: "all", accountId: g!, folder: "Label_1", limit: 4, cursor: page1.nextCursor!, now: NOW });
      expect([...page1.items, ...page2.items].map((t) => t.id)).toEqual(all);
      expect(page2.nextCursor).toBeNull();
      const dates = page1.items.map((t) => t.lastDate);
      expect(dates).toEqual(dates.toSorted((a, b) => b - a));
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

    it("Codex R2: a kept thread of another account with a folder of the same key never joins the page", async () => {
      const store = await fresh();
      const [a, b] = await withAccounts(store, 3).then((ids) => [ids[0], ids[2]]);
      for (const id of [a!, b!]) await store.folders.replace(id, [{ key: "Label_1", path: ["Same"], selectable: true }]);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "a1", gmailLabels: ["Label_1"] }), msg({ accountId: b!, providerMsgId: "b1", isRead: true, gmailLabels: ["Label_1"] })]);
      const theirs = await threadOf(store, "b1");
      expect(await ids(store, a!, "Label_1", { filter: "unread", keepIds: [theirs] })).toEqual([await threadOf(store, "a1")]);
    });

    it("selection scopes: a folder's thread ids in key order and its count; an unlisted one has none", async () => {
      const store = await fresh();
      const [g] = await withAccounts(store);
      await store.folders.replace(g!, [{ key: "Label_1", path: ["A"], selectable: true }]);
      await ingest(store, Array.from({ length: 5 }, (_, i) => msg({ accountId: g!, providerMsgId: `g${i}`, gmailLabels: i < 3 ? ["Label_1"] : ["Label_2"] })));
      const members = [...(await ids(store, g!, "Label_1"))].sort((a, b) => a - b);
      expect(await store.threads.scopeIds({ view: "all", accountId: g!, folder: "Label_1", limit: 10 })).toEqual(members);
      expect(await store.threads.scopeIds({ view: "all", accountId: g!, folder: "Label_1", after: members[0], limit: 10 })).toEqual(members.slice(1));
      expect(await store.threads.scopeCount({ view: "all", accountId: g!, folder: "Label_1", limit: 100 })).toBe(3);
      expect(await store.threads.scopeIds({ view: "all", accountId: g!, folder: "Label_2", limit: 10 })).toEqual([]);
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
