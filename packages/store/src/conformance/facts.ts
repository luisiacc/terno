import { addressKey, threadFacts, waitingCutoff, WAITING_WINDOW_MS, type Address, type FactContext, type FactRow, type ListFilter, type ThreadFacts } from "@terno/core";
import { generateDataset } from "@terno/mock-data";
import { describe, expect, it } from "vitest";
import type { MailStore, StoreSnapshot } from "../mail-store";
import { backfillFacts, ingest, msg, seedThroughCommands, threadOf, withAccounts } from "./fixtures";
import { byRecency, VIEW_TEST } from "./oracle";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const DAY = 86_400_000;
const addr = (email: string, name = ""): Address => ({ name, email });

/**
 * Plan 17's facts by brute force from a snapshot: your addresses (the
 * accounts' and the From of sent, non-draft mail), who you wrote to, and the
 * replies of yours anywhere, then core's threadFacts over each thread's
 * messages. What both stores must agree with.
 */
export function oracleFacts(s: StoreSnapshot): Map<number, ThreadFacts> {
  const own = new Set(s.accounts.map((a) => addressKey(a.email)));
  const written = new Set<string>();
  for (const m of s.messages) {
    if (!m.isSent || m.isDraft) continue;
    own.add(addressKey(m.fromEmail));
    for (const json of [m.toJson, m.ccJson]) for (const a of JSON.parse(json) as Address[]) written.add(addressKey(a.email));
  }
  const failed = new Set(s.ops.filter((o) => o.kind === "send" && o.state === "failed").map((o) => o.messageIds[0]));
  const mine = (m: StoreSnapshot["messages"][number]) => !m.isDraft && !(m.providerMsgId?.startsWith("local:") && failed.has(m.id)) && (m.isSent || own.has(addressKey(m.fromEmail)));
  const answered = new Set<string>();
  for (const m of s.messages) if (mine(m)) for (const r of [...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])]) answered.add(r);
  const ctx: FactContext = { own: (k) => own.has(k), written: (k) => written.has(k), answered: (id) => answered.has(id), failedSend: (id) => failed.has(id) };
  const rows = new Map<number, FactRow[]>();
  for (const m of s.messages) {
    const row: FactRow = {
      id: m.id,
      date: m.date,
      from_email: m.fromEmail,
      to_json: m.toJson,
      cc_json: m.ccJson,
      is_sent: +m.isSent,
      is_draft: +m.isDraft,
      is_trash: +m.isTrash,
      is_spam: +m.isSpam,
      list_id: m.listId,
      is_bulk: +m.isBulk,
      gmail_labels: m.gmailLabels,
      rfc_message_id: m.rfcMessageId,
      provider_msg_id: m.providerMsgId,
    };
    rows.set(m.threadId, [...(rows.get(m.threadId) ?? []), row]);
  }
  return new Map(s.threads.map((t) => [t.id, threadFacts(rows.get(t.id) ?? [], ctx)]));
}

/** A thread's facts as the snapshot has them. */
const factsIn = (s: StoreSnapshot, threadId: number) => {
  const t = s.threads.find((x) => x.id === threadId)!;
  return { person: t.person, waitingSince: t.waitingSince };
};

export function defineFactsConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("People and waiting for your reply (plan 17)", () => {
    const facts = async (store: MailStore, providerMsgId: string) => factsIn(await store.debug.snapshot(), await threadOf(store, providerMsgId));
    const to = (accountEmail: string) => ({ to: [addr(accountEmail, "Me")] });

    it("a person's message to you waits for your reply; your answer ends it; the newest inbound one says who it's from", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      const me = "me0@example.com";
      await ingest(store, [msg({ accountId: a!, providerMsgId: "q", rfcMessageId: "q@x", from: addr("carlos@acme.com", "Carlos"), ...to(me), date: NOW - DAY })]);
      expect(await facts(store, "q")).toEqual({ person: true, waitingSince: NOW - DAY });
      const page = await store.threads.list({ view: "inbox", filter: "waiting", now: NOW, limit: 10 });
      expect(page.items.map((t) => [t.person, t.waitingSince])).toEqual([[true, NOW - DAY]]);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(1);
      // your reply, in the thread
      await ingest(store, [msg({ accountId: a!, providerMsgId: "r", rfcMessageId: "r@x", inReplyTo: "q@x", references: ["q@x"], from: addr(me), to: [addr("carlos@acme.com")], isSent: true, inInbox: false, date: NOW - DAY + 60_000 })]);
      expect(await facts(store, "q")).toEqual({ person: true, waitingSince: null });
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(0);
      expect((await store.threads.list({ view: "inbox", filter: "people", now: NOW, limit: 10 })).items).toHaveLength(1);
    });

    it("newsletters, bulk headers, no-reply addresses and Gmail's promotions are never people; a role address is until you write to it", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "list", from: addr("boletin@xataka.com"), listId: "boletin.xataka.com", ...to("me0@example.com") }),
        msg({ accountId: a!, providerMsgId: "bulk", from: addr("hello@startup.io"), bulk: true, ...to("me0@example.com") }),
        msg({ accountId: a!, providerMsgId: "noreply", from: addr("no-reply@bank.mx"), ...to("me0@example.com") }),
        msg({ accountId: a!, providerMsgId: "promo", from: addr("ana@shop.com"), gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"], ...to("me0@example.com") }),
        msg({ accountId: a!, providerMsgId: "support", from: addr("support+t42@small-shop.com"), ...to("me0@example.com") }),
      ]);
      for (const id of ["list", "bulk", "noreply", "promo", "support"]) expect(await facts(store, id), id).toEqual({ person: false, waitingSince: null });
      // you write to the shop's support (another conversation): its +tagged replies come from a person now
      await ingest(store, [msg({ accountId: a!, providerMsgId: "wrote", from: addr("me0@example.com"), to: [addr("support@small-shop.com")], isSent: true, inInbox: false })]);
      expect((await facts(store, "support")).person).toBe(true);
      // a strong signal stays strong: writing to the bank's no-reply changes nothing
      await ingest(store, [msg({ accountId: a!, providerMsgId: "wrote2", from: addr("me0@example.com"), to: [addr("no-reply@bank.mx")], isSent: true, inInbox: false })]);
      expect((await facts(store, "noreply")).person).toBe(false);
    });

    it("a reply from another account, in another thread, answers; only on Cc never waits; drafts never count", async () => {
      const store = await fresh();
      const [a, b] = await withAccounts(store);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "q", rfcMessageId: "q@x", from: addr("carlos@acme.com"), to: [addr("me0@example.com"), addr("me1@example.com")], date: NOW - DAY }),
        msg({ accountId: a!, providerMsgId: "cc", from: addr("boss@acme.com"), to: [addr("lucia@acme.com")], cc: [addr("me0@example.com")], date: NOW - DAY }),
        msg({ accountId: a!, providerMsgId: "d", rfcMessageId: "d@x", from: addr("ana@friends.com"), ...to("me0@example.com"), date: NOW - DAY }),
      ]);
      expect((await facts(store, "q")).waitingSince).toBe(NOW - DAY);
      expect((await facts(store, "cc")).waitingSince).toBeNull();
      // a draft in the thread, newer: still waiting
      await ingest(store, [msg({ accountId: a!, providerMsgId: "draft", inReplyTo: "d@x", references: ["d@x"], from: addr("me0@example.com"), to: [addr("ana@friends.com")], isDraft: true, inInbox: false, date: NOW })]);
      expect((await facts(store, "d")).waitingSince).toBe(NOW - DAY);
      // answered from account b, which Gmail-threads apart (its own provider thread)
      await ingest(store, [msg({ accountId: b!, providerMsgId: "ans", providerThreadId: "elsewhere", inReplyTo: "q@x", references: ["q@x"], from: addr("me1@example.com"), to: [addr("carlos@acme.com")], isSent: true, inInbox: false, date: NOW - 3600_000 })]);
      expect(await facts(store, "q")).toEqual({ person: true, waitingSince: null });
      // and deleting that reply leaves it waiting again
      const ans = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === "ans")!.id;
      await store.sync.remove([ans]);
      expect((await facts(store, "q")).waitingSince).toBe(NOW - DAY);
    });

    it("a sender with many conversations is recomputed by the backfill in slices, never in the ingest that taught it (Codex review 1, #2)", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      await ingest(store, Array.from({ length: 205 }, (_, i) => msg({ accountId: a!, providerMsgId: `s${i}`, from: addr(i % 2 ? "support+t1@shop.com" : "support@shop.com"), ...to("me0@example.com"), date: NOW - DAY - i })));
      expect(await facts(store, "s0")).toEqual({ person: false, waitingSince: null });
      await ingest(store, [msg({ accountId: a!, providerMsgId: "wrote", from: addr("me0@example.com"), to: [addr("support@shop.com")], isSent: true, inInbox: false, date: NOW - 2 * DAY })]);
      // the ingest left them as they were; the count says it doesn't know yet
      const snap = await store.debug.snapshot();
      expect(snap.threads.filter((t) => t.person === null)).toEqual([]);
      expect((await facts(store, "s0")).person).toBe(false);
      expect(await store.facts.idle()).toBe(false);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBeNull();
      const slices = await backfillFacts(store, 50);
      expect(slices).toBeGreaterThan(3);
      expect(await facts(store, "s0")).toEqual({ person: true, waitingSince: NOW - DAY });
      expect(await facts(store, "s1")).toEqual({ person: true, waitingSince: NOW - DAY - 1 });
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(205);
    });

    it("a draft that comes back sent answers what it replies to, in another thread too (Codex review 1, #4)", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "q", providerThreadId: "tq", rfcMessageId: "q@x", from: addr("carlos@acme.com"), ...to("me0@example.com"), date: NOW - DAY })]);
      const draft = { accountId: a!, providerMsgId: "d", providerThreadId: "td", rfcMessageId: "d@x", inReplyTo: "q@x", references: ["q@x"], from: addr("me0@example.com"), to: [addr("carlos@acme.com")], inInbox: false, date: NOW - 3600_000 };
      await ingest(store, [msg({ ...draft, isDraft: true })]);
      expect((await facts(store, "q")).waitingSince).toBe(NOW - DAY);
      await ingest(store, [msg({ ...draft, isDraft: false, isSent: true })]);
      expect((await facts(store, "q")).waitingSince).toBeNull();
    });

    it("writing to someone Gmail filed under Updates makes them a person (Codex review 1, #5); Gmail's category moves count (#8)", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "upd", from: addr("ana@friends.com"), gmailLabels: ["INBOX", "CATEGORY_UPDATES"], ...to("me0@example.com"), date: NOW - DAY }),
        msg({ accountId: a!, providerMsgId: "promo", from: addr("luis@tienda.mx"), gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"], ...to("me0@example.com"), date: NOW - DAY }),
      ]);
      expect((await facts(store, "upd")).person).toBe(false);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "wrote", from: addr("me0@example.com"), to: [addr("ana@friends.com")], isSent: true, inInbox: false })]);
      expect((await facts(store, "upd")).person).toBe(true);
      // moved to Primary in Gmail, and back
      const promo = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === "promo")!.id;
      expect((await facts(store, "promo")).person).toBe(false);
      await store.sync.updateFlags(a!, [{ messageId: promo, flags: {}, gmailLabels: ["INBOX", "CATEGORY_PERSONAL"] }]);
      expect((await facts(store, "promo")).person).toBe(true);
      await store.sync.updateFlags(a!, [{ messageId: promo, flags: { isRead: true }, gmailLabels: ["CATEGORY_PROMOTIONS"] }]);
      expect((await facts(store, "promo")).person).toBe(false);
      // a read waiting to reach Gmail holds the message's flags, not its category (Codex review 2, #5)
      await store.threads.act({ threadIds: [await threadOf(store, "promo")], action: "markUnread", signal: null, now: NOW });
      await store.sync.updateFlags(a!, [{ messageId: promo, flags: { isRead: true }, gmailLabels: ["INBOX", "CATEGORY_PERSONAL"] }]);
      expect((await facts(store, "promo")).person).toBe(true);
      expect((await store.debug.snapshot()).messages.find((m) => m.id === promo)!.isRead).toBe(false);
    });

    it("trash and spam: a trashed conversation never waits but keeps who it's from; spam is no one", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "t", from: addr("carlos@acme.com"), ...to("me0@example.com"), date: NOW - DAY })]);
      const thread = await threadOf(store, "t");
      await store.threads.act({ threadIds: [thread], action: "trash", signal: null, now: NOW });
      expect(await facts(store, "t")).toEqual({ person: true, waitingSince: null });
      await store.threads.act({ threadIds: [thread], action: "moveToInbox", signal: null, now: NOW });
      expect((await facts(store, "t")).waitingSince).toBe(NOW - DAY);
      await store.threads.act({ threadIds: [thread], action: "spam", signal: null, now: NOW });
      expect(await facts(store, "t")).toEqual({ person: false, waitingSince: null });
    });

    it("a send waits for nothing, but one that failed answered nobody (Codex R8)", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "q", rfcMessageId: "q@x", from: addr("carlos@acme.com"), ...to("me0@example.com"), date: NOW - DAY })]);
      const original = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === "q")!.id;
      const { opId } = await store.compose.queueSend({ accountId: a!, to: [addr("carlos@acme.com")], cc: [], bcc: [], subject: "Re: x", bodyText: "Sí", inReplyToMessageId: original, recordReply: false, now: NOW });
      expect((await facts(store, "q")).waitingSince).toBeNull();
      await store.ops.claimReady(NOW, 10);
      expect(await store.ops.fail(opId, "rejected", false, NOW)).toBe("failed");
      expect((await facts(store, "q")).waitingSince).toBe(NOW - DAY);
    });

    it("the window: 30 days at the caller's clock, in pages, scopes, counts and searches", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "new", subject: "zanahoria nueva", from: addr("carlos@acme.com"), ...to("me0@example.com"), date: NOW - 2 * DAY }),
        msg({ accountId: a!, providerMsgId: "old", subject: "zanahoria vieja", from: addr("lucia@acme.com"), ...to("me0@example.com"), date: NOW - 40 * DAY }),
      ]);
      const ids = async (now: number) => (await store.threads.list({ view: "inbox", filter: "waiting", now, limit: 10 })).items.map((t) => t.subject);
      expect(await ids(NOW)).toEqual(["zanahoria nueva"]);
      expect(await ids(NOW - 15 * DAY)).toEqual(["zanahoria nueva", "zanahoria vieja"]);
      expect(await store.threads.scopeCount({ view: "inbox", filter: "waiting", now: NOW, limit: 100 })).toBe(1);
      expect(await store.threads.scopeIds({ view: "inbox", filter: "waiting", now: NOW, limit: 100 })).toEqual([await threadOf(store, "new")]);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(1);
      expect((await store.threads.counts(NOW + WAITING_WINDOW_MS)).inboxWaiting).toBe(0);
      const search = await store.threads.searchText({ query: "zanahoria", threadFilter: "waiting", limit: 10, now: NOW });
      expect(search.items.map((t) => t.subject)).toEqual(["zanahoria nueva"]);
      expect((await store.threads.searchText({ query: "zanahoria", threadFilter: "people", limit: 10, now: NOW })).items).toHaveLength(2);
    });

    it("a new address of yours rescans every thread; until it has, the count is unknown (Codex R3, R11)", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store);
      // Bob writes to an alias you haven't sent from yet, copying your account: only on Cc, as far as anyone knows
      await ingest(store, [msg({ accountId: a!, providerMsgId: "bob", from: addr("bob@acme.com"), to: [addr("me.alias@other.org")], cc: [addr("me0@example.com")], date: NOW - DAY })]);
      expect((await facts(store, "bob")).waitingSince).toBeNull();
      expect(await store.facts.idle()).toBe(true);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "alias", from: addr("me.alias@other.org"), to: [addr("ana@friends.com")], isSent: true, inInbox: false, date: NOW - 2 * DAY })]);
      expect(await store.facts.idle()).toBe(false);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBeNull();
      await backfillFacts(store, 1);
      expect((await facts(store, "bob")).waitingSince).toBe(NOW - DAY);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(1);
    });

    it("the backfill from the migration's state equals what ingest computes, interrupted after any slice and resumed in a new store, with ingest between slices", async () => {
      let store = await fresh();
      await seedThroughCommands(store, generateDataset({ threads: 400, accounts: 3, seed: 21, now: NOW }), NOW);
      const before = await store.debug.snapshot();
      // what the stores computed is what the definition says
      const oracle = oracleFacts(before);
      for (const t of before.threads) expect({ person: t.person ? 1 : 0, waitingSince: t.waitingSince }, `thread ${t.id}`).toEqual(oracle.get(t.id));
      await store.debug.resetFacts();
      expect(await store.facts.idle()).toBe(false);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBeNull();
      expect((await store.threads.list({ view: "inbox", filter: "people", now: NOW, limit: 10 })).items).toEqual([]);
      let slices = 0;
      const accountId = before.accounts[0]!.id;
      for (;;) {
        const r = await store.facts.backfill({ limit: 37 });
        slices++;
        if (!r.more) break;
        if (slices % 5 === 0) {
          // a kill between slices: a new store on the same data picks up where the last one committed
          store = await reopen(store);
        }
        if (slices === 7) await ingest(store, [msg({ accountId, providerMsgId: "during", from: addr("carlos@acme.com"), to: [addr(before.accounts[0]!.email)], date: NOW - DAY })], NOW);
      }
      expect(slices).toBeGreaterThan(10);
      expect(await store.facts.idle()).toBe(true);
      const after = await store.debug.snapshot();
      const withNew = oracleFacts(after);
      for (const t of after.threads) expect({ person: t.person ? 1 : 0, waitingSince: t.waitingSince }, `thread ${t.id}`).toEqual(withNew.get(t.id));
      for (const t of before.threads) expect(factsIn(after, t.id), `thread ${t.id}`).toEqual(factsIn(before, t.id));
      expect(factsIn(after, await threadOf(store, "during"))).toEqual({ person: true, waitingSince: NOW - DAY });
      // the search projection carries them too (the instant index and the scan answer the filters)
      const docs = new Map(after.search.threads.map((d) => [d.threadId, d]));
      for (const t of after.threads) expect([docs.get(t.id)?.person ?? false, docs.get(t.id)?.waitingSince ?? null]).toEqual([t.person === true, t.waitingSince]);
      await store.close();
    });

    it("pages, scopes and counts of People and Waiting equal the snapshot's, in every view, an account and a category", async () => {
      const store = await fresh();
      await seedThroughCommands(store, generateDataset({ threads: 600, accounts: 3, seed: 12, now: NOW }), NOW);
      const snap = await store.debug.snapshot();
      const docs = snap.search.threads;
      const cutoff = waitingCutoff(NOW);
      const keeps: Record<Extract<ListFilter, "people" | "waiting">, (t: (typeof docs)[number]) => boolean> = {
        people: (t) => t.person === true,
        waiting: (t) => t.waitingSince != null && t.waitingSince >= cutoff,
      };
      expect(docs.some(keeps.people) && docs.some(keeps.waiting)).toBe(true);
      for (const view of ["inbox", "archive", "trash", "spam", "all", "sent", "starred"] as const) {
        for (const scope of [{}, { accountId: snap.accounts[1]!.id }, { categoryId: snap.categories[0]!.id }] as { accountId?: number; categoryId?: number }[]) {
          for (const filter of ["people", "waiting"] as const) {
            const ids: number[] = [];
            let cursor: { lastDate: number; id: number } | undefined;
            do {
              const page = await store.threads.list({ view, limit: 41, cursor, ...scope, filter, now: NOW });
              ids.push(...page.items.map((t) => t.id));
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
            const expected = docs
              .filter((t) => VIEW_TEST[view](t) && (scope.accountId === undefined || t.accountId === scope.accountId) && (scope.categoryId === undefined || t.categoryIds.includes(scope.categoryId)) && keeps[filter](t))
              .sort(byRecency)
              .map((t) => t.threadId);
            const label = `${view} ${JSON.stringify(scope)} ${filter}`;
            expect(ids, label).toEqual(expected);
            expect(await store.threads.scopeCount({ view, ...scope, filter, now: NOW, limit: 100_000 }), label).toBe(expected.length);
            const scoped: number[] = [];
            for (let after = 0; ; ) {
              const page = await store.threads.scopeIds({ view, ...scope, filter, now: NOW, after, limit: 29 });
              scoped.push(...page);
              if (page.length < 29) break;
              after = page[page.length - 1]!;
            }
            expect(scoped, label).toEqual([...expected].sort((x, y) => x - y));
          }
        }
      }
      const counts = await store.threads.counts(NOW);
      const waiting = docs.filter((t) => t.inInbox && keeps.waiting(t));
      expect(counts.inboxWaiting).toBe(waiting.length);
      for (const a of snap.accounts) expect(counts.inboxWaitingByAccount?.[a.id] ?? 0).toBe(waiting.filter((t) => t.accountId === a.id).length);
    });
  });
}
