import { afterEach, describe, expect, it } from "vitest";
import { Autocomplete } from "../autocomplete/service";
import { SENT_SIZE_MAX, SENT_TEXT_MAX } from "../autocomplete-source";
import { RevisionError } from "../search";
import type { MailStore } from "../mail-store";
import type { PlatformFiles } from "../platform";
import { ingest, msg, withAccounts } from "./fixtures";

/** Snapshots in memory: what a host's files do, without a disk. */
export function memoryFiles(): PlatformFiles & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    read: async (p) => files.get(p)?.slice() ?? null,
    replace: async (p, b) => void files.set(p, b.slice()),
    remove: async (p) => void files.delete(p),
  };
}

export interface AutocompleteHarness {
  /** a fresh store whose source has a snapshot base (a file path, or a name with files) */
  open(): Promise<MailStore>;
  reopen(store: MailStore): Promise<MailStore>;
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Autocomplete's source and service over a store (plan 18): what each engine
 * serves (headers, removals, spam senders, sent text) and that the service
 * built on it builds, follows commits, restores and resets.
 */
export function defineAutocompleteConformance(name: string, harness: AutocompleteHarness): void {
  const open: MailStore[] = [];
  const services: Autocomplete[] = [];
  const fresh = async () => {
    const s = await harness.open();
    open.push(s);
    return s;
  };
  const service = (store: MailStore, files: PlatformFiles, o: Partial<ConstructorParameters<typeof Autocomplete>[0]> = {}) => {
    const a = new Autocomplete({ source: store.autocomplete, platform: { yield: yieldNow, files }, settleMs: 0, now: () => NOW, ...o });
    services.push(a);
    return a;
  };
  afterEach(async () => {
    for (const a of services.splice(0)) await a.close();
    for (const s of open.splice(0)) if (s.isOpen) await s.close();
  });

  const NOW = Date.UTC(2026, 9, 22);
  const ana = { name: "Ana Martínez", email: "ana@acme.studio" };
  const bob = { name: "Bob Stone", email: "bob@stone.io" };

  describe(`autocomplete conformance: ${name}`, () => {
    it("serves headers in id order under a lease, and only learnable sent text", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "r1", from: bob, to: [{ name: "Me", email: "me0@example.com" }], cc: [ana], date: NOW - 1000 }),
        msg({ accountId: a!, providerMsgId: "s1", from: { name: "Me", email: "me0@example.com" }, to: [ana], isSent: true, inInbox: false, bodyText: "Let me know if you have any questions.", date: NOW - 900 }),
        msg({ accountId: a!, providerMsgId: "s2", from: { name: "Me", email: "me0@example.com" }, to: [bob], isSent: true, inInbox: false, bodyText: "x".repeat(SENT_TEXT_MAX + 5000), date: NOW - 800 }),
        msg({ accountId: a!, providerMsgId: "d1", from: { name: "Me", email: "me0@example.com" }, to: [bob], isSent: true, isDraft: true, inInbox: false, bodyText: "a draft", date: NOW - 700 }),
        msg({ accountId: a!, providerMsgId: "sp", from: { name: "Prize", email: "win@prize.biz" }, isSpam: true, inInbox: false, date: NOW - 600 }),
      ]);
      const lease = await store.autocomplete.beginBuild();
      const all = [];
      for await (const page of lease.messages()) all.push(...page);
      await lease.release();
      expect(all.map((m) => m.id)).toEqual(all.map((m) => m.id).sort((x, y) => x - y));
      expect(all).toHaveLength(5);
      const r1 = all.find((m) => m.from.email === bob.email)!;
      expect(r1).toMatchObject({ sent: false, spam: false, draft: false, hasBody: true, accountId: a });
      expect(r1.cc).toEqual([ana]);
      expect(all.find((m) => m.from.email === "win@prize.biz")!.spam).toBe(true);
      expect(all.filter((m) => m.draft)).toHaveLength(1);
      const sent = (await store.autocomplete.sentAfter(0, 10)).texts;
      // drafts and received mail aren't the user's sent text; huge bodies come cut
      expect(sent.map((s) => s.text.slice(0, 10))).toEqual(["Let me kno", "xxxxxxxxxx"]);
      expect(sent[1]!.text.length).toBe(SENT_TEXT_MAX);
      expect(sent[0]!.to).toEqual([ana]);
      expect((await store.autocomplete.sentAfter(sent[0]!.id, 10)).texts).toHaveLength(1);
      expect((await store.autocomplete.sentTexts([r1.id, sent[1]!.id])).map((s) => s.id)).toEqual([sent[1]!.id]);
    });

    it("changes carry new and removed messages and the senders of conversations marked as spam", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      const start = await store.autocomplete.head();
      await ingest(store, [msg({ accountId: a!, providerMsgId: "n1", from: bob })]);
      const head1 = await store.autocomplete.head();
      const b1 = (await store.autocomplete.changes(start, head1, 100)).flatMap((b) => b.messages);
      expect(b1.map((m) => m.from.email)).toContain(bob.email);
      const id = b1.find((m) => m.from.email === bob.email)!.id;
      const thread = (await store.debug.snapshot()).messages.find((m) => m.id === id)!.threadId;
      await store.threads.act({ threadIds: [thread], action: "spam", signal: null, now: NOW });
      const head2 = await store.autocomplete.head();
      const b2 = await store.autocomplete.changes(head1, head2, 100);
      expect(b2.flatMap((b) => b.spamSenders)).toContain(bob.email);
      await store.sync.remove([id]);
      const head3 = await store.autocomplete.head();
      expect((await store.autocomplete.changes(head2, head3, 100)).flatMap((b) => b.removed)).toContain(id);
    });

    it("the service builds, follows commits and sends, restores from its snapshot and resets", async () => {
      const files = memoryFiles();
      let store = await fresh();
      const [a] = await withAccounts(store, 1);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "r1", from: bob, date: NOW - 5000 }),
        ...[1, 2, 3, 4].map((i) => msg({ accountId: a!, providerMsgId: `s${i}`, from: { name: "Me", email: "me0@example.com" }, to: [ana], isSent: true, inInbox: false, bodyText: "Let me know if you have any questions.", date: NOW - 4000 + i })),
      ]);
      let ac = service(store, files);
      ac.setOwn(["me0@example.com"]);
      await ac.warm();
      expect(ac.suggestRecipients("an").items).toEqual([ana]);
      expect(ac.suggestRecipients("b").items).toEqual([bob]);
      // own addresses: hidden unless typed in full
      expect(ac.suggestRecipients("me0").items).toEqual([]);
      await ac.idle();
      expect(ac.suggestText({ before: "Let me know if" })).toBe(" you have any questions.");
      // a commit after warm: caught up after notify
      await ingest(store, [msg({ accountId: a!, providerMsgId: "r2", from: { name: "Carla Ruiz", email: "carla@ruiz.mx" }, date: NOW - 100 })]);
      ac.notify();
      await ac.idle();
      expect(ac.suggestRecipients("carla").items).toEqual([{ name: "Carla Ruiz", email: "carla@ruiz.mx" }]);
      // a send: the recipient is now someone written to, above people who only wrote
      await store.compose.queueSend({ accountId: a!, to: [{ name: "Bea Bustos", email: "bea@bustos.cl" }], cc: [], bcc: [], subject: "Hi", bodyText: "Let me know if you have any questions.", recordReply: false, now: NOW });
      ac.notify();
      await ac.idle();
      expect(ac.suggestRecipients("b").items.map((h) => h.email)).toEqual(["bea@bustos.cl", bob.email]);
      // close writes the snapshots; a reopened store restores instead of building
      await ac.close();
      expect([...files.files.keys()].some((k) => k.endsWith(".contacts"))).toBe(true);
      expect([...files.files.keys()].some((k) => k.endsWith(".phrases"))).toBe(true);
      store = await harness.reopen(store);
      open.push(store);
      ac = service(store, files);
      ac.setOwn(["me0@example.com"]);
      await ac.warm();
      expect(ac.report.contacts.restore).toBeDefined();
      expect(ac.report.contacts.build).toBeUndefined();
      expect(ac.suggestRecipients("b").items.map((h) => h.email)).toEqual(["bea@bustos.cl", bob.email]);
      await ac.idle();
      expect(ac.report.phrases.restore).toBeDefined();
      expect(ac.suggestText({ before: "Let me know if" })).toBe(" you have any questions.");
      // commits while it was closed come through the log
      await ingest(store, [msg({ accountId: a!, providerMsgId: "r3", from: { name: "Dora Díaz", email: "dora@diaz.mx" }, date: NOW - 50 })]);
      ac.notify();
      await ac.idle();
      expect(ac.suggestRecipients("dora").items).toHaveLength(1);
      // body suggestions off: the model and its snapshot go
      await ac.setPhrases(false);
      expect(ac.suggestText({ before: "Let me know if" })).toBeNull();
      expect([...files.files.keys()].some((k) => k.endsWith(".phrases"))).toBe(false);
      // an account removed: both models and snapshots go, a warm session rebuilds
      await ac.reset();
      expect([...files.files.keys()]).toEqual([]);
      await ac.idle();
      expect(ac.suggestRecipients("dora").items).toHaveLength(1);
    });

    it("a snapshot of another database, or a damaged one, is rebuilt", async () => {
      const files = memoryFiles();
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "r1", from: bob })]);
      const ac = service(store, files);
      await ac.warm();
      await ac.close();
      for (const [k, v] of files.files) {
        const bad = v.slice();
        bad[bad.length - 3]! ^= 0xff;
        files.files.set(k, bad);
      }
      const again = service(store, files);
      await again.warm();
      expect(again.report.contacts.build).toBeDefined();
      expect(again.suggestRecipients("bob").items).toEqual([bob]);
    });

    it("a page of empty sent bodies isn't the end; oversized sent mail isn't read (codex review)", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      const me = { name: "Me", email: "me0@example.com" };
      await ingest(store, [
        // more than a page (16) of sent mail with nothing written, then the habit
        ...Array.from({ length: 20 }, (_, i) => msg({ accountId: a!, providerMsgId: `e${i}`, from: me, to: [ana], isSent: true, inInbox: false, bodyText: "", date: NOW - 9000 + i })),
        ...[1, 2, 3, 4].map((i) => msg({ accountId: a!, providerMsgId: `s${i}`, from: me, to: [ana], isSent: true, inInbox: false, bodyText: "Let me know if you have any questions.", date: NOW - 4000 + i })),
        // a forward with a big attachment: never learned from (nor its body read whole)
        msg({ accountId: a!, providerMsgId: "big", from: me, to: [bob], isSent: true, inInbox: false, bodyText: "Quarterly figures enclosed as promised.", size: SENT_SIZE_MAX + 1, date: NOW - 100 }),
      ]);
      let all: string[] = [];
      for (let after = 0; ; ) {
        const page = await store.autocomplete.sentAfter(after, 16);
        if (page.next === null) break;
        all = all.concat(page.texts.map((t) => t.text));
        after = page.next;
      }
      expect(all.filter((t) => t.startsWith("Let me know"))).toHaveLength(4);
      expect(all.some((t) => t.startsWith("Quarterly"))).toBe(false);
      const ac = service(store, memoryFiles());
      await ac.warm();
      await ac.idle();
      expect(ac.suggestText({ before: "Let me know if" })).toBe(" you have any questions.");
    });

    it("a snapshot the log no longer reaches is dropped and rebuilt, once (codex review)", async () => {
      const files = memoryFiles();
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "r1", from: bob })]);
      const first = service(store, files);
      await first.warm();
      await first.close();
      const snapshotAt = await store.autocomplete.head();
      await ingest(store, [msg({ accountId: a!, providerMsgId: "r2", from: ana })]);
      // the log pruned past the snapshot: any replay from it is a gap
      let restoresTried = 0;
      const source = {
        ...store.autocomplete,
        snapshotBase: store.autocomplete.snapshotBase,
        identity: store.autocomplete.identity,
        changes: async (after: typeof snapshotAt, through: typeof snapshotAt, max: number) => {
          if (after.seq <= snapshotAt.seq) {
            restoresTried++;
            throw new RevisionError("gap", "pruned");
          }
          return store.autocomplete.changes(after, through, max);
        },
      };
      const ac = new Autocomplete({ source, platform: { yield: yieldNow, files }, settleMs: 0, now: () => NOW });
      services.push(ac);
      await ac.warm();
      expect(ac.report.contacts.build).toBeDefined();
      expect(ac.suggestRecipients("ana").items).toEqual([ana]);
      expect(restoresTried).toBeLessThanOrEqual(2);
    });

    it("nothing runs before the first warm", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      const files = memoryFiles();
      const ac = service(store, files);
      ac.notify();
      await ingest(store, [msg({ accountId: a!, providerMsgId: "r1", from: bob })]);
      ac.notify();
      await new Promise((r) => setTimeout(r, 30));
      expect(ac.report.state).toBe("cold");
      expect(ac.suggestRecipients("bob")).toEqual({ items: [], ready: false });
    });
  });
}
