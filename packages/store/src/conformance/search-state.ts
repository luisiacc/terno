import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { StaleCursorError, type StoreSearchPage } from "../search";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";
import { oracleSearch } from "./oracle";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const DAY = 86_400_000;
const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

/**
 * What a search and a bulk query scope answer as the mailbox changes. It's the part of the contract an index can
 * decide, so IndexedDB runs it a second time with the instant index answering (Codex revision 9 of plan 139): its
 * harness waits for the index and proves which path answered, since an instant store silently scans until caught up.
 */
export function defineSearchStateConformance(name: string, fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe(`search as the mailbox changes: ${name}`, () => {
    it("a search finds mail in every place, Spam and Trash too, and each row says where it lives; in:all doesn't reach Spam or Trash", async () => {
      const store = await fresh();
      const [acct] = await withAccounts(store, 1);
      const one = async (over: Partial<Parameters<typeof msg>[0]>) => {
        const m = msg({ accountId: acct!, subject: "Pepinillo report", ...over });
        await ingest(store, [m]);
        return threadOf(store, m.providerMsgId!);
      };
      const inbox = await one({});
      const archived = await one({ inInbox: false });
      const spam = await one({ isSpam: true, inInbox: false });
      const trash = await one({ isTrash: true, inInbox: false });
      const found = async (query: string) => (await store.threads.searchText({ query, limit: 50, now: NOW })).items;
      const all = await found("pepinillo");
      expect(all.map((t) => t.id).sort((a, b) => a - b)).toEqual([inbox, archived, spam, trash].sort((a, b) => a - b));
      const place = new Map(all.map((t) => [t.id, [t.inInbox, t.inSpam, t.inTrash]]));
      expect(place.get(inbox)).toEqual([true, false, false]);
      expect(place.get(archived)).toEqual([false, false, false]);
      expect(place.get(spam)).toEqual([false, true, false]);
      expect(place.get(trash)).toEqual([false, false, true]);
      expect((await found("in:anywhere pepinillo")).length).toBe(4);
      expect((await found("in:all pepinillo")).map((t) => t.id).sort((a, b) => a - b)).toEqual([inbox, archived].sort((a, b) => a - b));
      expect((await found("in:spam pepinillo")).map((t) => t.id)).toEqual([spam]);
      // the list's summaries carry it too (a view)
      expect((await store.threads.list({ view: "inbox", limit: 10, now: NOW })).items.find((t) => t.id === inbox)).toMatchObject({ inInbox: true, inSpam: false, inTrash: false });
      // trashed spam is in Trash and still spam mail (no sender icon, plan 22); spam on a trashed thread leaves it in Trash
      await store.threads.act({ threadIds: [spam], action: "trash", signal: null, now: NOW });
      await store.threads.act({ threadIds: [trash], action: "spam", signal: null, now: NOW });
      const after = new Map((await found("pepinillo")).map((t) => [t.id, [t.inSpam, t.inTrash, t.hasSpam]]));
      expect(after.get(spam)).toEqual([false, true, true]);
      expect(after.get(trash)).toEqual([false, true, true]);
      expect(after.get(inbox)).toEqual([false, false, false]);
      await store.threads.act({ threadIds: [spam], action: "moveToInbox", signal: null, now: NOW });
      expect((await found("pepinillo")).find((t) => t.id === spam)).toMatchObject({ inInbox: true, inSpam: false, inTrash: false, hasSpam: false });
      await store.threads.act({ threadIds: [spam], action: "trash", signal: null, now: NOW });
      await store.threads.act({ threadIds: [trash], action: "moveToInbox", signal: null, now: NOW });
      await store.threads.act({ threadIds: [trash], action: "trash", signal: null, now: NOW });
      // bulk categorization's query scope still leaves Spam and Trash out
      const cat = (await store.categories.create("Pickles", "amber")).id;
      expect((await store.categorize.resolveScope(cat, { kind: "query", query: "pepinillo" }, NOW)).sort((a, b) => a - b)).toEqual([inbox, archived].sort((a, b) => a - b));
    });

    it("a write between pages makes the cursor stale: a thread bumped above it can't be skipped silently", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      for (let i = 0; i < 4; i++) await ingest(store, [msg({ accountId: a!, providerMsgId: `fp${i}`, rfcMessageId: `fp${i}@x`, subject: `Factura ${i}`, date: 1_000_000 + i * 1000 })]);
      const first = await store.threads.searchText({ query: "factura", limit: 2, now: NOW });
      expect(first.items.map((t) => t.subject)).toEqual(["Factura 3", "Factura 2"]);
      // a reply bumps the oldest match above the cursor: page 2 at the old revision would omit it
      await ingest(store, [msg({ accountId: a!, providerMsgId: "bump", inReplyTo: "fp0@x", subject: "Re: Factura 0", date: 2_000_000 })]);
      await expect(store.threads.searchText({ query: "factura", limit: 2, cursor: first.nextCursor!, now: NOW })).rejects.toBeInstanceOf(StaleCursorError);
      const again = await store.threads.searchText({ query: "factura", limit: 10, now: NOW });
      expect(again.items.map((t) => t.subject)).toEqual(["Factura 0", "Factura 3", "Factura 2", "Factura 1"]);
      // a keyset-only cursor (an older renderer) still pages at the current revision
      const legacy = await store.threads.searchText({ query: "factura", limit: 2, cursor: { lastDate: again.items[1]!.lastDate, id: again.items[1]!.id }, now: NOW });
      expect(legacy.items.map((t) => t.subject)).toEqual(["Factura 2", "Factura 1"]);
    });

    it("searches report the revision they answered at", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, subject: "Revisión" })]);
      const page = await store.threads.searchText({ query: "revision", limit: 10, now: NOW });
      expect(page.revision).toEqual(await store.feed.head());
      expect(page.complete).toBe(true);
    });

    it("every answer follows flags, places, categories, bodies, merges, removals and a reopen, against the brute-force oracle", async () => {
      let store = await fresh();
      const [a, b] = await withAccounts(store);
      const trip = await store.categories.create("Viajes", "cyan");
      const m = (id: string, over: Partial<Parameters<typeof msg>[0]> = {}) => msg({ accountId: a!, providerMsgId: id, rfcMessageId: `${id}@x`, ...over });
      const firstIngest = await ingest(store, [
        m("march", { subject: "Factura marzo", bodyText: "pago pendiente", from: { name: "Ana", email: "ana@acme.test" } }),
        m("april", { subject: "Factura abril", bodyText: "pago hecho", from: { name: "Luz", email: "luz@acme.test" }, hasAttachments: true, attachments: [{ filename: "a.pdf", mime: "application/pdf", size: 3, bytes: new Uint8Array([1, 2, 3]) }] }),
        m("flight", { subject: "Vuelo a Lima", bodyText: "reserva confirmada" }),
        m("empty", { subject: "Sin cuerpo aún", bodyText: null, bodyState: "partial" }),
        m("left", { subject: "Factura huérfana", bodyText: "referencia cruzada" }),
        m("right", { subject: "Vuelo de vuelta", bodyText: "reserva cruzada" }),
        msg({ accountId: b!, providerMsgId: "elsewhere", subject: "Factura otra cuenta", bodyText: "pago ajeno", date: NOW - 60 * DAY }),
      ]);
      const queries = ["factura", "pago", "cruzada", "tardía", '"pago pendiente"', "is:unread", "is:starred", "in:inbox", "in:inbox factura", "in:trash", "in:spam", "in:all factura", "has:attachment", "category:viajes", "from:ana@acme.test", "-factura", "factura -pendiente", "account:me1@example.com", "after:30d"];
      const agree = async (step: string) => {
        const s = await store.debug.snapshot();
        const corpus = { messages: s.search.messages, threads: s.search.threads, accounts: s.accounts, categories: s.categories };
        for (const query of queries) {
          const ids: number[] = [];
          let page: StoreSearchPage | undefined;
          do {
            page = await store.threads.searchText({ query, limit: 2, cursor: page?.nextCursor ?? undefined, now: NOW });
            ids.push(...page.items.map((t) => t.id));
          } while (page.nextCursor);
          expect(ids, `${step}: ${query}`).toEqual(oracleSearch(corpus, query, NOW));
        }
      };
      const act = async (provider: string, action: Parameters<MailStore["threads"]["act"]>[0]["action"]) => {
        await store.threads.act({ threadIds: [await threadOf(store, provider)], action, signal: null, now: NOW });
        await agree(`${action} ${provider}`);
      };
      await agree("ingested");
      await act("march", "markRead");
      await act("march", "star");
      await act("april", "archive");
      await act("april", "moveToInbox");
      await act("flight", "trash");
      await act("flight", "moveToInbox");
      await act("april", "spam");
      await store.categories.add({ categoryId: trip.id, threadIds: [await threadOf(store, "flight")], addedBy: "user", now: NOW });
      await agree("filed");
      await store.categories.remove({ categoryId: trip.id, threadIds: [await threadOf(store, "flight")], reason: "user", now: NOW });
      await agree("removed from the category");
      await store.sync.setBody(firstIngest.inserted[3]!, "respuesta tardía", null, { now: NOW, classifier: null });
      await agree("a body arrived");
      await store.sync.setBody(firstIngest.inserted[3]!, "otra cosa", null, { now: NOW, classifier: null });
      await agree("a body was replaced");
      await ingest(store, [m("bridge", { subject: "Puente", bodyText: "une dos hilos", references: ["left@x", "right@x"] })]);
      await agree("two threads merged");
      await store.sync.remove([firstIngest.inserted[0]!]);
      await agree("a message was removed");
      await store.accounts.remove(b!);
      await agree("an account was removed");
      store = await reopen(store);
      await agree("reopened");
    });

    it("the quick filters narrow a search, page by page, and follow the mail", async () => {
      let store = await fresh();
      const [a] = await withAccounts(store);
      const addr = (email: string) => ({ name: email, email });
      const toMe = { to: [addr("me0@example.com")] };
      const files = [{ filename: "a.pdf", mime: "application/pdf", size: 3, bytes: new Uint8Array([1, 2, 3]) }];
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "person-new", subject: "zanahoria nueva", from: addr("carlos@acme.com"), ...toMe, date: NOW - 2 * DAY }),
        msg({ accountId: a!, providerMsgId: "person-old", subject: "zanahoria vieja", from: addr("lucia@acme.com"), ...toMe, date: NOW - 40 * DAY }),
        ...[1, 2, 3, 4, 5].map((i) => msg({ accountId: a!, providerMsgId: `files-${i}`, subject: `zanahoria adjunta ${i}`, from: addr("carlos@acme.com"), ...toMe, hasAttachments: true, attachments: files, date: NOW - DAY - i })),
        msg({ accountId: a!, providerMsgId: "no-files", subject: "zanahoria sola", from: addr("carlos@acme.com"), ...toMe, date: NOW - 3 * DAY }),
      ]);
      const walk = async (narrow: { threadFilter?: "waiting" | "people"; threadAttachments?: boolean }) => {
        const subjects: string[] = [];
        let cursor: StoreSearchPage["nextCursor"] | undefined;
        do {
          const page = await store.threads.searchText({ query: "zanahoria", ...narrow, limit: 2, cursor: cursor ?? undefined, now: NOW });
          subjects.push(...page.items.map((t) => t.subject));
          cursor = page.nextCursor;
        } while (cursor);
        return subjects;
      };
      const withFiles = [1, 2, 3, 4, 5].map((i) => `zanahoria adjunta ${i}`);
      const waiting = [...withFiles, "zanahoria nueva", "zanahoria sola"];
      expect(await walk({ threadAttachments: true })).toEqual(withFiles);
      expect(await walk({ threadFilter: "waiting" })).toEqual(waiting); // the 30-day window leaves the old one out
      expect(await walk({ threadFilter: "people" })).toHaveLength(8);
      await store.sync.remove([(await store.debug.snapshot()).messages.find((x) => x.providerMsgId === "files-1")!.id]);
      expect(await walk({ threadAttachments: true })).toEqual(withFiles.slice(1));
      // an answer of yours ends the wait on that thread
      await ingest(store, [msg({ accountId: a!, providerMsgId: "answer", subject: "Re: zanahoria sola", inReplyTo: (await store.debug.snapshot()).messages.find((x) => x.providerMsgId === "no-files")!.rfcMessageId, from: addr("me0@example.com"), to: [addr("carlos@acme.com")], isSent: true, inInbox: false, date: NOW - DAY })]);
      expect(await walk({ threadFilter: "waiting" })).not.toContain("zanahoria sola");
      store = await reopen(store);
      expect(await walk({ threadAttachments: true })).toEqual(withFiles.slice(1));
    });

    it("a query scope over 500 matches: scope and count go through all of it, with exclusions, mutations and a reopen", async () => {
      let store = await fresh();
      const [a] = await withAccounts(store, 1);
      const cat = (await store.categories.create("Pickles", "amber")).id;
      const batch = (prefix: string, n: number, subject: string) => Array.from({ length: n }, (_, i) => msg({ accountId: a!, providerMsgId: `${prefix}${i}`, subject: `${subject} ${i}` }));
      await ingest(store, [...batch("m", 640, "Pepinillo"), ...batch("x", 40, "Pepinillo excluido"), ...batch("other", 20, "Zanahoria")]);
      const threads = new Map((await store.debug.snapshot()).messages.map((m) => [m.providerMsgId!, m.threadId]));
      const messageOf = new Map((await store.debug.snapshot()).messages.map((m) => [m.providerMsgId!, m.id]));
      const t = (id: string) => threads.get(id)!;
      const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => t(`m${from + i}`));
      const open = new Set([...range(0, 640), ...Array.from({ length: 40 }, (_, i) => t(`x${i}`))]);
      const without = new Set(open);
      for (let i = 0; i < 40; i++) without.delete(t(`x${i}`));
      const answers = async (step: string) => {
        const check = async (query: string, expected: Set<number>) => {
          expect(sorted(await store.categorize.resolveScope(cat, { kind: "query", query }, NOW)), `${step}: ${query}`).toEqual(sorted([...expected]));
          expect(await store.categorize.countScope(cat, { kind: "query", query }, NOW), `${step}: ${query}`).toEqual({ count: Math.min(expected.size, 1000), capped: expected.size > 1000 });
        };
        await check("pepinillo", open);
        await check("pepinillo -excluido", without);
      };
      const drop = (ids: number[]) => { for (const id of ids) { open.delete(id); without.delete(id); } };
      await answers("in the Inbox, past two pages of 500");
      expect(await store.categorize.resolveScope(cat, { kind: "query", query: "pepinillo" }, NOW, 510)).toHaveLength(510);
      // filed, and removed by the user: neither is offered again
      await store.categories.add({ categoryId: cat, threadIds: range(0, 10), addedBy: "user", now: NOW });
      await store.categories.remove({ categoryId: cat, threadIds: range(5, 10), reason: "user", now: NOW });
      await store.threads.act({ threadIds: range(10, 15), action: "spam", signal: null, now: NOW });
      await store.threads.act({ threadIds: range(15, 20), action: "trash", signal: null, now: NOW });
      drop(range(0, 20));
      await answers("filed, removed, Spam and Trash");
      // archived is still in scope; what comes back from Trash is too; a message that's gone isn't
      await store.threads.act({ threadIds: range(20, 30), action: "archive", signal: null, now: NOW });
      await store.threads.act({ threadIds: range(15, 20), action: "moveToInbox", signal: null, now: NOW });
      for (const id of range(15, 20)) { open.add(id); without.add(id); }
      await store.sync.remove([messageOf.get("m30")!]);
      drop([t("m30")]);
      await answers("moved and removed");
      // past the count's cap, the scope itself still has them all
      const more = await ingest(store, batch("n", 400, "Pepinillo"));
      for (const m of (await store.debug.snapshot()).messages) if (more.inserted.includes(m.id)) { open.add(m.threadId); without.add(m.threadId); }
      expect(open.size).toBeGreaterThan(1000);
      await answers("past the cap");
      store = await reopen(store);
      await answers("reopened");
      await store.debug.verify();
    }, 60_000);
  });
}
