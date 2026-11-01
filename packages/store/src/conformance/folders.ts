import { folderRef } from "@terno/core";
import { afterEach, describe, expect, it } from "vitest";
import { AWAITING_IDENTITY, type FolderPlace } from "../types";
import type { MailStore } from "../mail-store";
import { generateDataset } from "@terno/mock-data";
import { ingest, msg, seedThroughCommands, threadOf, withAccounts } from "./fixtures";
import type { StoreHarness } from "./store";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const loc = (mailbox: string, uid: number) => ({ mailbox, uidvalidity: 1, uid, flags: [] as string[] });

/**
 * Plan 68: an account's own folders. Membership is written with what decides it (labels, locations, trash and
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
  /** a folder count to its end, `limit` rows a slice (what the backend does with yields between); `calls`: how many it took */
  const counted = async (store: MailStore, accountId: number, keys: readonly FolderPlace[], limit: number) => {
    let messages = 0;
    let calls = 0;
    for (let after: Parameters<MailStore["folders"]["count"]>[2] = null; ; ) {
      const r = await store.folders.count(accountId, keys, after, limit);
      calls++;
      if (r.restarted) messages = 0;
      messages += r.messages;
      if (!r.next) return { messages, calls };
      after = r.next;
    }
  };
  const count = async (store: MailStore, accountId: number, keys: readonly FolderPlace[]) => {
    const whole = (await counted(store, accountId, keys, 10_000)).messages;
    // the same however it's sliced
    expect((await counted(store, accountId, keys, 1)).messages).toBe(whole);
    expect((await counted(store, accountId, keys, 2)).messages).toBe(whole);
    return whole;
  };
  /** runs pending rebuilds to the end, two rows a slice (what the backend does with yields between) */
  const drain = async (store: MailStore) => {
    const touched = new Set<number>();
    for (let r = await store.folders.rebuild(2); ; r = await store.folders.rebuild(2)) {
      for (const t of r.touched) touched.add(t);
      if (!r.more) return [...touched];
    }
  };

  describe(`folders (plan 68): ${name}`, () => {
    it("IMAP identity review: local sent Message-ID never adopts unrelated remote bytes", async () => {
      let store = await fresh();
      const [, account] = await withAccounts(store);
      const local = msg({ accountId: account!, providerMsgId: "local:sent", rfcMessageId: "collision@test", subject: "Our sent mail", bodyText: "our exact bytes", isSent: true, locations: [] });
      const { inserted: [id] } = await ingest(store, [local]);
      const thread = await threadOf(store, "local:sent");
      const action = await store.threads.act({ threadIds: [thread], action: "star", signal: null, now: NOW });
      expect(action.opIds).toHaveLength(1);
      const target = (await store.ops.get(action.opIds[0]!))!.target_json;
      const incoming = msg({ accountId: account!, providerMsgId: "collision@test", rfcMessageId: "collision@test", subject: "Unrelated incoming", bodyText: "different exact bytes", locations: [loc("INBOX", 17)] });
      const result = await ingest(store, [incoming]);
      expect(result.inserted).toHaveLength(1);
      expect(result.inserted[0]).not.toBe(id);
      store = await harness.reopen(store); open.push(store);
      expect((await store.threads.get(thread))!.messages.find((m) => m.id === id)).toMatchObject({ bodyText: local.bodyText });
      expect(await store.providerStore(account!).locations.of([id!])).toEqual([]);
      expect((await store.ops.get(action.opIds[0]!))!.target_json).toBe(target);
      let issued = false;
      await expect(store.providerStore(account!).locations.dispatch([id!], [], async () => { issued = true; })).rejects.toThrow("IMAP identity unavailable");
      expect(issued).toBe(false);
    });

    it("IMAP identity review: a newer same-locator fence survives mapped completion", async () => {
      let store = await fresh();
      const [, account] = await withAccounts(store);
      const { inserted: [id] } = await ingest(store, [msg({ accountId: account!, locations: [loc("A", 1), loc("C", 2)] })]);
      const locations = store.providerStore(account!).locations;
      const before = await locations.of([id!]);
      const owner = await locations.dispatch([id!], before, async (token) => token!, [id!]);
      await locations.fence([id!]);
      await expect(locations.mappedMove(before.filter((l) => l.mailbox === "A"), "B", 2, [{ messageId: id!, uid: 10 }], false, before, owner)).rejects.toThrow("IMAP identity unavailable");
      store = await harness.reopen(store); open.push(store);
      expect(await store.providerStore(account!).locations.unresolved([id!])).toEqual([id!]);
      expect(await store.providerStore(account!).locations.of([id!])).toEqual(before);
    });

    it("IMAP identity review: failed later admission releases only its own undispatched holds", async () => {
      let store = await fresh();
      const [, account] = await withAccounts(store);
      const { inserted: ids } = await ingest(store, Array.from({ length: 129 }, (_, i) => msg({ accountId: account!, locations: [loc("A", i + 1)] })));
      const locations = store.providerStore(account!).locations;
      const before = await locations.of(ids);
      const stale = before.map((l, i) => i === 128 ? { ...l, uid: 999 } : l);
      let issued = false;
      await expect(locations.dispatch(ids, stale, async () => { issued = true; }, ids)).rejects.toThrow("IMAP identity unavailable");
      expect(issued).toBe(false);
      store = await harness.reopen(store); open.push(store);
      expect(await store.providerStore(account!).locations.unresolved(ids)).toEqual([]);
      await expect(store.providerStore(account!).locations.dispatch(ids, before, async () => "usable")).resolves.toBe("usable");
    });

    it("IMAP identity: a command the server refused releases only its own admission's holds (2026-11 audit)", async () => {
      let store = await fresh();
      const [, account] = await withAccounts(store);
      const { inserted: ids } = await ingest(store, Array.from({ length: 3 }, (_, i) => msg({ accountId: account!, locations: [loc("A", i + 1)] })));
      const locations = store.providerStore(account!).locations;
      const before = await locations.of(ids);
      const owner = await locations.dispatch(ids, before, async (token) => token!, ids);
      expect(await locations.unresolved(ids)).toEqual(ids);
      // another admission's refusal releases nothing of this one
      await locations.refused(ids, "someone-else");
      expect(await locations.unresolved(ids)).toEqual(ids);
      await locations.refused(ids, owner);
      store = await harness.reopen(store); open.push(store);
      expect(await store.providerStore(account!).locations.unresolved(ids)).toEqual([]);
      await expect(store.providerStore(account!).locations.dispatch(ids, before, async () => "usable")).resolves.toBe("usable");
    });

    it("IMAP identity: holds reject stale adoption, hydration, flags and automatic asset deletion", async () => {
      let store = await fresh();
      const [, account] = await withAccounts(store);
      const original = msg({ accountId: account!, providerMsgId: "held-assets", bodyText: "exact body", locations: [loc("A", 1)], attachments: [{ filename: "bytes.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }] });
      const { inserted: [id] } = await ingest(store, [original]);
      const thread = await threadOf(store, "held-assets");
      const attachment = (await store.threads.get(thread))!.messages[0]!.attachments[0]!;
      const locations = store.providerStore(account!).locations;
      await locations.removeMany([id!], "A");
      await locations.upsert(id!, "B", 2, 99, ["\\Seen"]);
      expect(await locations.of([id!])).toEqual([]);
      await store.sync.setBody(id!, "WRONG body", null, { now: NOW, classifier: null, attachments: [] });
      await store.sync.updateFlags(account!, [{ messageId: id!, flags: { isRead: true } }]);
      await ingest(store, [{ ...original, bodyText: "WRONG ingest", locations: [loc("B", 99)], attachments: [] }]);
      await store.sync.remove([id!]);
      store = await harness.reopen(store); open.push(store);
      expect((await store.threads.get(thread))!.messages[0]).toMatchObject({ id, bodyText: "exact body", isRead: false });
      expect(await store.attachments.read(account!, attachment.assetId!, 0)).toBe("AP+A");
      expect((await store.storage.threads(0, 50)).find((row) => row.id === thread)?.kept).toBe(true);
    });

    it("IMAP identity: every target and every captured locator must match before dispatch", async () => {
      const store = await fresh();
      const [, account] = await withAccounts(store);
      const { inserted: [first, second] } = await ingest(store, [msg({ accountId: account!, locations: [loc("A", 1)] }), msg({ accountId: account!, locations: [loc("A", 2)] })]);
      const locations = store.providerStore(account!).locations;
      const captured = await locations.of([first!, second!]);
      let issued = 0;
      const start = async () => { issued++; };
      await locations.dispatch([first!, second!], captured, start);
      await locations.upsert(first!, "A", 1, 8, []);
      await expect(locations.dispatch([first!, second!], captured, start)).rejects.toThrow("IMAP identity unavailable");
      await locations.remove(second!, "A");
      await expect(locations.dispatch([first!, second!], await locations.of([first!, second!]), start)).rejects.toThrow("IMAP identity unavailable");
      expect(issued).toBe(1);
    });

    it("IMAP identity: parking keeps W02 intent, refunds dispatch and ignores network/auth resumes", async () => {
      let store = await fresh();
      const [, account] = await withAccounts(store);
      const { inserted: [id] } = await ingest(store, [msg({ accountId: account!, providerMsgId: "parked-identity", locations: [loc("A", 1)] })]);
      await store.sync.beginObservation(account!, { authoritativeFlags: true });
      const thread = await threadOf(store, "parked-identity");
      const action = await store.threads.act({ threadIds: [thread], action: "markRead", signal: null, now: NOW });
      const [claimed] = await store.ops.claimReady(NOW, 20);
      await store.providerStore(account!).locations.remove(id!, "A");
      await store.ops.fail(claimed!.id, "identity guidance", true, NOW, { identity: true, keepAttempt: true });
      store = await harness.reopen(store); open.push(store);
      await store.ops.recover(NOW + 1);
      await store.ops.resumeNetwork(account!, NOW + 2);
      await store.ops.resumeAuth(account!, NOW + 3);
      await store.providerStore(account!).locations.resumeResolved();
      expect(await store.ops.claimReady(NOW + 86400000, 20)).toEqual([]);
      expect(await store.ops.nextAttemptAt()).toBeNull();
      const op = await store.ops.get(action.opIds[0]!);
      expect(op).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY, target_json: JSON.stringify({ messageIds: [id] }) });
      const observation = await store.sync.beginObservation(account!, { authoritativeFlags: true });
      await store.sync.updateFlags(account!, [{ messageId: id!, expectedProviderMsgId: "parked-identity", flags: { isRead: false } }], observation!);
      expect((await store.threads.get(thread))!.messages[0]!.isRead).toBe(true);
    });

    it("IMAP identity: a mapping cannot release a hold created by losing another copy", async () => {
      let store = await fresh();
      const [, account] = await withAccounts(store);
      const { inserted: [id] } = await ingest(store, [msg({ accountId: account!, locations: [loc("A", 1), loc("C", 2)] })]);
      const locations = store.providerStore(account!).locations;
      const before = await locations.of([id!]);
      const owner = await locations.dispatch([id!], before, async (token) => token!, [id!]);
      await locations.remove(id!, "C");
      await expect(locations.mappedMove(before.filter((l) => l.mailbox === "A"), "B", 2, [{ messageId: id!, uid: 10 }], false, before, owner)).rejects.toThrow("IMAP identity unavailable");
      store = await harness.reopen(store); open.push(store);
      expect(await store.providerStore(account!).locations.unresolved([id!])).toEqual([id!]);
      expect(await store.providerStore(account!).locations.of([id!])).toEqual(before.filter((l) => l.mailbox === "A"));
    });

    it("IMAP identity: a stale second mapping rolls back the first binding and all holds", async () => {
      let store = await fresh();
      const [, account] = await withAccounts(store);
      const { inserted: [first, second] } = await ingest(store, [msg({ accountId: account!, locations: [loc("A", 1)] }), msg({ accountId: account!, locations: [loc("A", 2)] })]);
      let locations = store.providerStore(account!).locations;
      const before = await locations.of([first!, second!]);
      const owner = await locations.dispatch([first!, second!], before, async (token) => token!, [first!, second!]);
      await expect(locations.mappedMove([before[0]!, { ...before[1]!, uid: 999 }], "B", 2, [{ messageId: first!, uid: 10 }, { messageId: second!, uid: 11 }], false, before, owner)).rejects.toThrow();
      store = await harness.reopen(store); open.push(store); locations = store.providerStore(account!).locations;
      expect(await locations.of([first!, second!])).toEqual(before);
      expect(await locations.unresolved([first!, second!])).toEqual([first!, second!]);
      await locations.mappedMove(before, "B", 2, [{ messageId: first!, uid: 10 }, { messageId: second!, uid: 11 }], false, before, owner);
      expect(await locations.unresolved([first!, second!])).toEqual([]);
      await expect(locations.dispatch([first!, second!], await locations.of([first!, second!]), async () => "mapped")).resolves.toBe("mapped");
    });

    it("IMAP identity: a removed locator durably retains its body and claimed intent", async () => {
      let store = await fresh();
      const [, account] = await withAccounts(store);
      const result = await ingest(store, [msg({ accountId: account!, providerMsgId: "identity-held", bodyText: "exact retained body", locations: [loc("A", 1)] })]);
      const id = result.inserted[0]!;
      const thread = await threadOf(store, "identity-held");
      const action = await store.threads.act({ threadIds: [thread], action: "markRead", signal: null, now: NOW });
      await store.ops.claimReady(NOW, 20);
      await store.providerStore(account!).locations.remove(id, "A");
      await store.sync.remove([id]);
      expect((await store.threads.get(thread))?.messages[0]?.bodyText).toBe("exact retained body");
      expect(JSON.parse((await store.ops.get(action.opIds[0]!))!.target_json)).toEqual({ messageIds: [id] });
      store = await harness.reopen(store);
      open.push(store);
      expect(await store.providerStore(account!).locations.unresolved([id])).toEqual([id]);
      let dispatched = false;
      await expect(store.providerStore(account!).locations.dispatch([id], [], async () => { dispatched = true; })).rejects.toThrow("IMAP identity unavailable");
      expect(dispatched).toBe(false);
      expect((await store.threads.get(thread))?.messages[0]?.bodyText).toBe("exact retained body");
    });

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

    it("Codex R19: an envelope's ID-less twins, under any key, oldest first; never one with a Message-ID or another account's", async () => {
      const store = await fresh();
      const [, m, other] = await withAccounts(store, 3);
      const e = { subject: "Gemelo", from: { name: "", email: "ana@example.test" }, date: 1_800_000_000_000, size: 321, rfcMessageId: null };
      const r = await ingest(store, [
        msg({ accountId: m!, providerMsgId: "nomid:x", ...e }),
        msg({ accountId: m!, providerMsgId: "nomid:x#Z:1:7", ...e }),
        msg({ accountId: m!, providerMsgId: "with-id", ...e, rfcMessageId: "<a@b>" }),
        msg({ accountId: m!, providerMsgId: "other-size", ...e, size: 322 }),
        msg({ accountId: other!, providerMsgId: "nomid:x", ...e }),
      ]);
      const locations = store.providerStore(m!).locations;
      const envelope = { subject: "Gemelo", fromEmail: "ana@example.test", date: e.date, size: 321 };
      expect(await locations.twins(envelope, 0, 50)).toEqual([r.inserted[0]!, r.inserted[1]!]);
      // paged: above an id, at most a limit
      expect(await locations.twins(envelope, 0, 1)).toEqual([r.inserted[0]!]);
      expect(await locations.twins(envelope, r.inserted[0]!, 50)).toEqual([r.inserted[1]!]);
      // Codex R26: with a Message-ID, those carrying it
      const withId = (await store.debug.snapshot()).messages.find((x) => x.id === r.inserted[2]!)!.rfcMessageId;
      expect(await locations.twins({ ...envelope, rfcMessageId: withId }, 0, 50)).toEqual([r.inserted[2]!]);
    });

    it("Codex R28: twins stay exact through changes that keep a bucket's size (one out, another in)", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      const base = { from: { name: "", email: "ana@example.test" }, date: 1_800_000_000_000, size: 100, rfcMessageId: "<churn@x>" };
      const r = await ingest(store, [msg({ accountId: m!, providerMsgId: "a", subject: "A", ...base }), msg({ accountId: m!, providerMsgId: "b", subject: "B", ...base })]);
      const locations = store.providerStore(m!).locations;
      const rfc = (await store.debug.snapshot()).messages.find((x) => x.id === r.inserted[0])!.rfcMessageId;
      const b = { subject: "B", fromEmail: "ana@example.test", date: base.date, size: base.size, rfcMessageId: rfc };
      expect(await locations.twins(b, 0, 50)).toEqual([r.inserted[1]!]);
      await store.sync.remove([r.inserted[0]!]);
      const added = await ingest(store, [msg({ accountId: m!, providerMsgId: "b2", subject: "B", ...base })]);
      expect(await locations.twins(b, 0, 50)).toEqual([r.inserted[1]!, added.inserted[0]!]);
      // and ID-less ones
      const idless = { ...base, rfcMessageId: null };
      const n = await ingest(store, [msg({ accountId: m!, providerMsgId: "n1", subject: "N", ...idless }), msg({ accountId: m!, providerMsgId: "n2", subject: "N", ...idless })]);
      const e = { subject: "N", fromEmail: "ana@example.test", date: base.date, size: base.size };
      expect(await locations.twins(e, 0, 50)).toEqual(n.inserted);
      await store.sync.remove([n.inserted[0]!]);
      const n3 = await ingest(store, [msg({ accountId: m!, providerMsgId: "n3", subject: "N", ...idless })]);
      expect(await locations.twins(e, 0, 50)).toEqual([n.inserted[1]!, n3.inserted[0]!]);
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

    it("plan 107: a folder subtree's messages are counted once each: Gmail by label (outside trash and spam), IMAP by location", async () => {
      const store = await fresh();
      const [g, m] = await withAccounts(store);
      await store.folders.replace(g!, [{ key: "Label_1", path: ["A"], selectable: true }, { key: "Label_2", path: ["A", "B"], selectable: true }, { key: "Label_3", path: ["C"], selectable: true }]);
      await ingest(store, [
        msg({ accountId: g!, providerMsgId: "g1", rfcMessageId: "g1@test", gmailLabels: ["Label_1"] }),
        // in both: once
        msg({ accountId: g!, providerMsgId: "g2", gmailLabels: ["Label_1", "Label_2"] }),
        // the same conversation as g1: one in trash, one with no label, neither counts
        msg({ accountId: g!, providerMsgId: "g3", inReplyTo: "g1@test", references: ["g1@test"], subject: "Re: x", gmailLabels: ["Label_1"], isTrash: true, inInbox: false }),
        msg({ accountId: g!, providerMsgId: "g4", inReplyTo: "g1@test", references: ["g1@test"], subject: "Re: x", gmailLabels: ["INBOX"] }),
        msg({ accountId: g!, providerMsgId: "g5", gmailLabels: ["Label_3"] }),
      ]);
      expect(await count(store, g!, ["Label_1", "Label_2"])).toBe(2);
      expect(await count(store, g!, ["Label_2"])).toBe(1);
      expect(await count(store, g!, ["Label_3"])).toBe(1);
      expect(await count(store, g!, [])).toBe(0);
      await store.folders.replace(m!, [{ key: "Work", path: ["Work"], selectable: true }, { key: "Work/Sub", path: ["Work", "Sub"], selectable: true }]);
      await ingest(store, [
        msg({ accountId: m!, providerMsgId: "i1", inInbox: false, locations: [loc("Work", 1)] }),
        msg({ accountId: m!, providerMsgId: "i2", inInbox: false, locations: [loc("Work", 2), loc("Work/Sub", 1)] }),
        msg({ accountId: m!, providerMsgId: "i3", locations: [loc("INBOX", 1)] }),
      ]);
      expect(await count(store, m!, ["Work", "Work/Sub"])).toBe(2);
      expect(await count(store, m!, ["Work/Sub"])).toBe(1);
      // another account's folder of the same key isn't this one's
      expect(await count(store, g!, ["Work"])).toBe(0);
    });

    it("plan 107: a path made again after a rename here: each UIDVALIDITY counts in its own folder, however sliced (Codex code review round 6 #2)", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      await store.folders.replace(m!, [{ key: "Job", path: ["Job"], selectable: true }, { key: "Work", path: ["Work"], selectable: true }]);
      const at = (mailbox: string, uidvalidity: number, uid: number) => ({ ...loc(mailbox, uid), uidvalidity });
      // Job's mail still under Work's old UIDVALIDITY (7), the new Work's under 9 (and one at a later 12, then 3)
      await ingest(store, [
        ...Array.from({ length: 3 }, (_, i) => msg({ accountId: m!, providerMsgId: `old${i}`, inInbox: false, locations: [at("Work", 7, i + 1)] })),
        msg({ accountId: m!, providerMsgId: "both", inInbox: false, locations: [at("Work", 7, 9), at("Job", 4, 1)] }),
        ...Array.from({ length: 2 }, (_, i) => msg({ accountId: m!, providerMsgId: `new${i}`, inInbox: false, locations: [at("Work", 9, i + 1)] })),
        msg({ accountId: m!, providerMsgId: "later", inInbox: false, locations: [at("Work", 12, 1)] }),
        msg({ accountId: m!, providerMsgId: "early", inInbox: false, locations: [at("Work", 3, 1)] }),
      ]);
      expect(await count(store, m!, ["Job", { mailbox: "Work", uidvalidity: 7 }])).toBe(4);
      expect(await count(store, m!, [{ mailbox: "Work", except: [7] }])).toBe(4);
      expect(await count(store, m!, [{ mailbox: "Work", except: [3, 7, 12] }])).toBe(2);
      // the whole path, as before
      expect(await count(store, m!, ["Work"])).toBe(8);
      // both folders at once: each message once
      expect(await count(store, m!, ["Job", { mailbox: "Work", except: [7] }, { mailbox: "Work", uidvalidity: 7 }])).toBe(8);
    });

    it("plan 107: a count over overlapping sublabels of one long conversation looks at each thread and message once, a slice at a time (Codex code review round 4 #3)", async () => {
      const store = await fresh();
      const [g, m] = await withAccounts(store);
      const keys = Array.from({ length: 6 }, (_, i) => `Label_${i + 1}`);
      await store.folders.replace(g!, keys.map((key, i) => ({ key, path: ["A", ...(i ? [`S${i}`] : [])], selectable: true })));
      const n = 40;
      await ingest(store, [
        msg({ accountId: g!, providerMsgId: "c0", rfcMessageId: "c0@test", subject: "long", gmailLabels: keys }),
        ...Array.from({ length: n - 1 }, (_, i) => msg({ accountId: g!, providerMsgId: `c${i + 1}`, inReplyTo: "c0@test", references: ["c0@test"], subject: "Re: long", gmailLabels: i % 2 ? keys : [keys[i % keys.length]!] })),
        msg({ accountId: g!, providerMsgId: "other", gmailLabels: [keys[3]!] }),
      ]);
      const limit = 5;
      const r = await counted(store, g!, keys, limit);
      expect(r.messages).toBe(n + 1);
      // the conversation's messages and the threads' rows once each: no folder after the first reads it again
      // (six reads of the conversation would be over 48 calls)
      expect(r.calls).toBeLessThanOrEqual(Math.ceil((n + 2 + keys.length) / limit) + keys.length * 2);
      // IMAP: a message placed in two of them, once, sliced
      await store.folders.replace(m!, [{ key: "Work", path: ["Work"], selectable: true }, { key: "Work/Sub", path: ["Work", "Sub"], selectable: true }]);
      await ingest(store, Array.from({ length: 7 }, (_, i) => msg({ accountId: m!, providerMsgId: `i${i}`, inInbox: false, locations: i % 2 ? [loc("Work", i + 1), loc("Work/Sub", i + 1)] : [loc("Work/Sub", i + 1)] })));
      expect(await count(store, m!, ["Work", "Work/Sub"])).toBe(7);
      expect(await count(store, m!, ["Work"])).toBe(3);
    });

    it("plan 107: a thread merged into one a count already passed is counted again, once: in the same label or an earlier one (Codex code review round 19 #2)", async () => {
      for (const across of [false, true]) {
        const store = await fresh();
        const [g] = await withAccounts(store, 1);
        await store.folders.replace(g!, [{ key: "Label_x", path: ["X"], selectable: true }, { key: "Label_w", path: ["X", "W"], selectable: true }]);
        // across: a's thread is the first label's, b's and c's the second's; else all of them the second's
        const first = across ? ["Label_x"] : ["Label_w"];
        await ingest(store, [
          msg({ accountId: g!, providerMsgId: "a1", rfcMessageId: "a1@test", gmailLabels: first }),
          msg({ accountId: g!, providerMsgId: "b1", rfcMessageId: "b1@test", gmailLabels: ["Label_w"] }),
          msg({ accountId: g!, providerMsgId: "b2", rfcMessageId: "b2@test", inReplyTo: "b1@test", references: ["b1@test"], gmailLabels: ["Label_w"] }),
          msg({ accountId: g!, providerMsgId: "c1", rfcMessageId: "c1@test", gmailLabels: ["Label_w"] }),
        ]);
        const keys = ["Label_x", "Label_w"];
        let messages = 0;
        let restarted = false;
        let merged = false;
        let calls = 0;
        for (let after: Parameters<MailStore["folders"]["count"]>[2] = null; ; ) {
          const r = await store.folders.count(g!, keys, after, 1);
          if (r.restarted) { restarted = true; messages = 0; }
          messages += r.messages;
          if (!r.next) break;
          after = r.next;
          // once a's thread is passed (the first label read, or the second's walk past it), a reply to a1 and b2 merges
          // b's thread into a's, the lower id
          const passed = across ? after.key >= 1 : !after.places && after.key === 1 && (after.after[0] ?? 0) > 0;
          if (!merged && passed) {
            merged = true;
            await ingest(store, [msg({ accountId: g!, providerMsgId: "bridge", rfcMessageId: "bridge@test", inReplyTo: "b2@test", references: ["a1@test", "b2@test"], gmailLabels: ["Label_w"] })]);
            expect(new Set((await store.debug.snapshot()).messages.map((m) => m.threadId)).size).toBe(2);
          }
          expect(++calls).toBeLessThan(100);
        }
        expect(merged).toBe(true);
        // a1, b1, b2, c1 and the bridge, each once
        expect(messages).toBe(5);
        expect(restarted).toBe(true);
        expect(await count(store, g!, keys)).toBe(5);
        // a count with no merge during it never starts over
        let again = false;
        for (let after: Parameters<MailStore["folders"]["count"]>[2] = null; ; ) {
          const r = await store.folders.count(g!, keys, after, 1);
          if (r.restarted) again = true;
          if (!r.next) break;
          after = r.next;
        }
        expect(again).toBe(false);
      }
    });

    it("plan 107: a renamed IMAP folder's threads are carried to its new key in slices, once each, with their unread count", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      await store.folders.replace(m!, [{ key: "Old", path: ["Old"], selectable: true }]);
      await ingest(store, [1, 2, 3, 4, 5].map((i) => msg({ accountId: m!, providerMsgId: `c${i}`, subject: `s${i}`, inInbox: false, locations: [loc("Old", i)] })));
      const members = async (key: string) => (await store.threads.list({ view: "all", accountId: m!, folder: key, limit: 50 })).items.map((t) => t.id).sort((a, b) => a - b);
      const before = await members("Old");
      expect(before).toHaveLength(5);
      // the rename's listing, then the carry two at a time
      await store.folders.replace(m!, [{ key: "New", path: ["New"], selectable: true }]);
      let after: number | null = 0;
      let slices = 0;
      while (after !== null) {
        after = (await store.folders.carry(m!, "Old", "New", after, 2)).next;
        slices++;
      }
      expect(slices).toBe(3);
      expect(await members("New")).toEqual(before);
      // carried again: nothing doubles
      await store.folders.carry(m!, "Old", "New", 0, 10);
      expect(await members("New")).toEqual(before);
      // its unread count comes along (all five are unread)
      expect((await store.threads.counts(0)).folderUnread?.[`${m!}:New`]).toBe(5);
    });

    it("plan 107: a rename into a key another rename just vacated clears what it left there first, in slices (Codex code review round 14 #2)", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      const folder = (key: string) => ({ key, path: [key], selectable: true });
      await store.folders.replace(m!, [folder("Work"), folder("Other")]);
      await ingest(store, [
        ...[1, 2, 3].map((i) => msg({ accountId: m!, providerMsgId: `w${i}`, subject: `w${i}`, inInbox: false, locations: [loc("Work", i)] })),
        msg({ accountId: m!, providerMsgId: "o1", subject: "o1", inInbox: false, locations: [loc("Other", 1)] }),
      ]);
      const members = async (key: string) => (await store.threads.list({ view: "all", accountId: m!, folder: key, limit: 50 })).items.map((t) => t.id).sort((a, b) => a - b);
      const work = await members("Work");
      const other = await members("Other");
      // Work → Job before a pass: Work's rows stay under its key, unlisted
      await store.folders.carry(m!, "Work", "Job", 0, 10);
      await store.folders.replace(m!, [folder("Job"), folder("Other")], ["Job"]);
      // Other → Work: what Work left goes two at a time, then Other's are carried
      const slices: boolean[] = [];
      for (let more = true; more; ) slices.push((more = (await store.folders.clear(m!, "Work", 2)).more));
      expect(slices).toEqual([true, false]);
      await store.folders.carry(m!, "Other", "Work", 0, 10);
      await store.folders.replace(m!, [folder("Job"), folder("Work")], ["Work"]);
      expect(await members("Work")).toEqual(other);
      expect(await members("Job")).toEqual(work);
      expect((await store.threads.counts(0)).folderUnread?.[`${m!}:Work`]).toBe(1);
      // nothing left: one call says so
      expect(await store.folders.clear(m!, "Other", 2)).toEqual({ more: false });
      expect(await members("Work")).toEqual(other);
    });

    it("plan 107: a mailbox deleted on its server forgets its locations with no identity hold (a reset holds them)", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      await store.folders.replace(m!, [{ key: "Gone", path: ["Gone"], selectable: true }, { key: "Reset", path: ["Reset"], selectable: true }]);
      const r = await ingest(store, [
        msg({ accountId: m!, providerMsgId: "i1", inInbox: false, locations: [loc("Gone", 1), loc("Keep", 1)] }),
        msg({ accountId: m!, providerMsgId: "i2", inInbox: false, locations: [loc("Reset", 1)] }),
      ]);
      const [kept, reset] = r.inserted as [number, number];
      const locations = store.providerStore(m!).locations;
      expect(await locations.resetMailbox("Gone", { deleted: true })).toEqual([kept]);
      expect(await locations.unresolved([kept])).toEqual([]);
      expect((await locations.of([kept])).map((l) => l.mailbox)).toEqual(["Keep"]);
      expect(await ids(store, m!, "Gone")).toEqual([]);
      expect(await locations.resetMailbox("Reset")).toEqual([reset]);
      expect(await locations.unresolved([reset])).toEqual([reset]);
    });

    it("plan 107: a deleted mailbox's places at a path that holds a new one go with no identity hold, the new one's stay (Codex code review round 6 #1)", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      await store.folders.replace(m!, [{ key: "Work", path: ["Work"], selectable: true }]);
      const r = await ingest(store, [
        msg({ accountId: m!, providerMsgId: "old", inInbox: false, locations: [loc("Work", 1), loc("Keep", 1)] }),
        msg({ accountId: m!, providerMsgId: "new", inInbox: false, locations: [{ ...loc("Work", 1), uidvalidity: 2 }] }),
      ]);
      const [old, fresh2] = r.inserted as [number, number];
      const locations = store.providerStore(m!).locations;
      await locations.removeMany([old], "Work", { deleted: true });
      expect(await locations.unresolved([old])).toEqual([]);
      expect((await locations.of([old])).map((l) => l.mailbox)).toEqual(["Keep"]);
      expect((await locations.of([fresh2])).map((l) => [l.mailbox, l.uidvalidity])).toEqual([["Work", 2]]);
      expect(await ids(store, m!, "Work")).toEqual([await threadOf(store, "new")]);
    });

    it("plan 107: a path's generations another folder holds (`except`) make no membership there, however it's derived (Codex code review round 8 #1)", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      const work = { key: "Work", path: ["Work"], selectable: true };
      await store.folders.replace(m!, [work]);
      // the old Work's (UIDVALIDITY 1), renamed to Job here
      const r = await ingest(store, [
        msg({ accountId: m!, providerMsgId: "old", inInbox: false, locations: [loc("Work", 1)] }),
        msg({ accountId: m!, providerMsgId: "new", locations: [loc("INBOX", 1)] }),
      ]);
      const [old, made] = r.inserted as [number, number];
      const [tOld, tNew] = [await threadOf(store, "old"), await threadOf(store, "new")];
      await store.folders.carry(m!, "Work", "Job", 0, 10);
      // the rename's listing, Work made again (2) before a pass: Job keeps the rows carried to it, Work leaves the old
      // generation out and is derived again
      expect(await store.folders.replace(m!, [{ ...work, except: [1] }, { key: "Job", path: ["Job"], selectable: true }], ["Job"])).toEqual({ changed: true, touched: [] });
      const locations = store.providerStore(m!).locations;
      await locations.upsert(made, "Work", 2, 1, []);
      expect((await store.folders.list()).filter((f) => f.accountId === m).map((f) => [f.key, f.except])).toEqual([["Work", [1]], ["Job", undefined]]);
      await drain(store);
      expect(await ids(store, m!, "Work")).toEqual([tNew]);
      expect(await ids(store, m!, "Job")).toEqual([tOld]);
      expect((await unread(store))[folderRef(m!, "Work")]).toBe(1);
      // a refresh of the thread (read state)
      await store.threads.act({ threadIds: [tOld], action: "markRead", signal: null, now: NOW });
      await store.threads.act({ threadIds: [tOld], action: "markUnread", signal: null, now: NOW });
      expect(await ids(store, m!, "Work")).toEqual([tNew]);
      // a location write under the left-out generation, and its removal while the new one's stays
      await locations.upsert(old, "Work", 1, 5, []);
      expect(await ids(store, m!, "Work")).toEqual([tNew]);
      // the same message met under the new generation is Work's; back under the old one it isn't
      await locations.upsert(old, "Work", 2, 9, []);
      expect(new Set(await ids(store, m!, "Work"))).toEqual(new Set([tOld, tNew]));
      await locations.upsert(old, "Work", 1, 5, []);
      expect(await ids(store, m!, "Work")).toEqual([tNew]);
      await locations.removeMany([old], "Work", { deleted: true });
      expect(await ids(store, m!, "Work")).toEqual([tNew]);
      expect((await locations.of([made])).map((l) => [l.mailbox, l.uidvalidity])).toContainEqual(["Work", 2]);
      // a listing that leaves nothing out any more derives it again from what's there
      await locations.upsert(old, "Work", 1, 5, []);
      await store.folders.replace(m!, [work, { key: "Job", path: ["Job"], selectable: true }]);
      await drain(store);
      expect(new Set(await ids(store, m!, "Work"))).toEqual(new Set([tOld, tNew]));
      // survives a reopen
      const again = await harness.reopen(store);
      open.push(again);
      await again.folders.replace(m!, [{ ...work, except: [1] }, { key: "Job", path: ["Job"], selectable: true }]);
      await drain(again);
      expect(await ids(again, m!, "Work")).toEqual([tNew]);
      expect((await again.folders.list()).find((f) => f.key === "Work")?.except).toEqual([1]);
    });

    it("plan 107: a pending rename's alias (old path and generation) keeps the renamed folder's threads, however they're derived (Codex code review round 16 #1)", async () => {
      const store = await fresh();
      const [, m] = await withAccounts(store);
      const job = { key: "Job", path: ["Job"], selectable: true };
      await store.folders.replace(m!, [{ key: "Work", path: ["Work"], selectable: true }]);
      await ingest(store, [
        msg({ accountId: m!, providerMsgId: "moved", inInbox: false, locations: [loc("Work", 1)] }),
        msg({ accountId: m!, providerMsgId: "other", inInbox: false, locations: [{ mailbox: "Work", uidvalidity: 2, uid: 1, flags: [] }] }),
      ]);
      const [moved, other] = [await threadOf(store, "moved"), await threadOf(store, "other")];
      // Work → Job here, no pass yet: the threads carried, the locations still under Work's generation 1
      await store.folders.carry(m!, "Work", "Job", 0, 10);
      await store.folders.replace(m!, [{ ...job, aliases: [{ mailbox: "Work", uidvalidity: 1 }] }], ["Job"]);
      expect((await store.folders.list()).filter((f) => f.accountId === m).map((f) => [f.key, f.aliases])).toEqual([["Job", [{ mailbox: "Work", uidvalidity: 1 }]]]);
      // a thread update (mark read, then unread) derives its folders again: Job keeps it, with its unread count
      await store.threads.act({ threadIds: [moved], action: "markRead", signal: null, now: NOW });
      expect(await ids(store, m!, "Job")).toContain(moved);
      expect((await unread(store))[folderRef(m!, "Job")]).toBe(1);
      await store.threads.act({ threadIds: [moved], action: "markUnread", signal: null, now: NOW });
      expect((await unread(store))[folderRef(m!, "Job")]).toBe(2);
      // another generation cached under the old path is never Job's
      await store.threads.act({ threadIds: [other], action: "markRead", signal: null, now: NOW });
      await store.threads.act({ threadIds: [other], action: "markUnread", signal: null, now: NOW });
      // (carried by the slice above: the alias derives only its own generation, so `other` goes once it's refreshed)
      expect(await ids(store, m!, "Job")).toEqual([moved]);
      // a rebuild of Job (its listing regenerated) derives it from the alias's places too
      await store.folders.replace(m!, [{ ...job, except: [7], aliases: [{ mailbox: "Work", uidvalidity: 1 }] }]);
      await drain(store);
      expect(await ids(store, m!, "Job")).toEqual([moved]);
      expect((await unread(store))[folderRef(m!, "Job")]).toBe(1);
      // survives a reopen
      const again = await harness.reopen(store);
      open.push(again);
      await again.threads.act({ threadIds: [moved], action: "markRead", signal: null, now: NOW });
      expect(await ids(again, m!, "Job")).toEqual([moved]);
      expect((await again.folders.list()).find((f) => f.key === "Job")?.aliases).toEqual([{ mailbox: "Work", uidvalidity: 1 }]);
      // the pass places it under Job and retires the rename: its own place keeps it, the alias is gone
      await again.providerStore(m!).locations.upsert((await again.threads.get(moved))!.messages[0]!.id, "Job", 1, 1, []);
      await again.folders.replace(m!, [job]);
      await again.threads.act({ threadIds: [moved], action: "markUnread", signal: null, now: NOW });
      expect(await ids(again, m!, "Job")).toEqual([moved]);
      expect((await unread(again))[folderRef(m!, "Job")]).toBe(1);
      expect((await again.folders.list()).find((f) => f.key === "Job")?.aliases).toBeUndefined();
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
