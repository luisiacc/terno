import { evaluateRule, termsQuery, tokenize, VIEWS, type FilterRule, type RuleMessage, type ThreadAction } from "@unica/core";
import { generateDataset } from "@unica/mock-data";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MailStore, SnapshotMessage, StoreSnapshot } from "../mail-store";
import type { Revision, SearchMessageDoc } from "../search";
import type { Cursor } from "../types";
import { StaleCursorError } from "../search";
import { ingest, msg, seedThroughCommands, threadOf, withAccounts } from "./fixtures";
import { byRecency, VIEW_TEST, type SearchCorpus } from "./oracle";
import { SearchReplica } from "./replica";
import { defineSearchConformance } from "./search";

export interface StoreHarness {
  /** a fresh, empty, migrated store */
  open(): Promise<MailStore>;
  /** closes `store` and opens the same storage again (durability, crash recovery) */
  reopen(store: MailStore): Promise<MailStore>;
  /** a store opened on data written by the previous schema version, and what that data was */
  upgraded?(): Promise<{ store: MailStore; before: StoreSnapshot }>;
  /** the FTS5 planner's strategies are part of the SQL adapters' contract */
  strategies?: boolean;
}

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const DAY = 86_400_000;

function corpusOf(s: StoreSnapshot): SearchCorpus {
  return { messages: s.search.messages, threads: s.search.threads, accounts: s.accounts, categories: s.categories };
}

/**
 * The MailStore contract, adapter-independent: only store commands and
 * debug.snapshot()/verify() are used. Ported from packages/db's suites
 * (threading, derived state, actions, ops, search, rules, pagination,
 * counts, categorization, migrations).
 */
export function defineStoreConformance(name: string, harness: StoreHarness): void {
  const open: MailStore[] = [];
  const fresh = async () => {
    const s = await harness.open();
    open.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of open.splice(0)) if (s.isOpen) await s.close();
  });

  describe(`store conformance: ${name}`, () => {
    describe("threading", () => {
      it("joins replies to their parent via In-Reply-To / References", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "root", rfcMessageId: "<root@x>" })]);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "r1", inReplyTo: "<ROOT@x>", references: ["<root@x>"] })]);
        expect(await threadOf(store, "r1")).toBe(await threadOf(store, "root"));
      });

      it("threads a parent that arrives after its reply (out-of-order sync)", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "child", references: ["parent@x"] })]);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "parent", rfcMessageId: "parent@x" })]);
        expect(await threadOf(store, "parent")).toBe(await threadOf(store, "child"));
        expect((await store.debug.snapshot()).threads).toHaveLength(1);
      });

      it("merges two threads bridged by a later message and keeps both threads' categories", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "x", rfcMessageId: "x@x" }), msg({ accountId: a!, providerMsgId: "y", rfcMessageId: "y@x" })]);
        const [tx, ty] = [await threadOf(store, "x"), await threadOf(store, "y")];
        expect(tx).not.toBe(ty);
        const work = await store.categories.create("Work", "indigo");
        const travel = await store.categories.create("Travel", "cyan");
        await store.categories.add({ categoryId: work.id, threadIds: [tx], addedBy: "user", now: NOW });
        await store.categories.add({ categoryId: travel.id, threadIds: [ty], addedBy: "user", now: NOW });
        await ingest(store, [msg({ accountId: a!, providerMsgId: "bridge", references: ["x@x", "y@x"] })]);
        const merged = await threadOf(store, "bridge");
        expect(await threadOf(store, "x")).toBe(merged);
        expect(await threadOf(store, "y")).toBe(merged);
        const t = (await store.debug.snapshot()).threads.find((x) => x.id === merged)!;
        expect(t.categoryIds.sort((p, q) => p - q)).toEqual([work.id, travel.id]);
        expect(t.messageCount).toBe(3);
        await store.debug.verify();
      });

      it("never merges on subject alone, nor across accounts", async () => {
        const store = await fresh();
        const [a, b] = await withAccounts(store);
        await ingest(store, [
          msg({ accountId: a!, providerMsgId: "s1", subject: "Factura marzo" }),
          msg({ accountId: a!, providerMsgId: "s2", subject: "RE: Factura marzo" }),
          msg({ accountId: a!, providerMsgId: "acct-a", rfcMessageId: "shared@x" }),
          msg({ accountId: b!, providerMsgId: "acct-b", inReplyTo: "shared@x" }),
        ]);
        expect(await threadOf(store, "s1")).not.toBe(await threadOf(store, "s2"));
        expect(await threadOf(store, "acct-a")).not.toBe(await threadOf(store, "acct-b"));
      });

      it("uses the provider thread id (Gmail) when present", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [
          msg({ accountId: a!, providerMsgId: "g1", providerThreadId: "T1" }),
          msg({ accountId: a!, providerMsgId: "g2", providerThreadId: "T1", subject: "unrelated" }),
          msg({ accountId: a!, providerMsgId: "g3", providerThreadId: "T2" }),
        ]);
        expect(await threadOf(store, "g1")).toBe(await threadOf(store, "g2"));
        expect(await threadOf(store, "g3")).not.toBe(await threadOf(store, "g1"));
      });

      it("upserts by provider id: flags refresh, no duplicate rows", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "u", isRead: false })]);
        const r = await ingest(store, [msg({ accountId: a!, providerMsgId: "u", isRead: true })]);
        expect(r.inserted).toEqual([]);
        expect((await store.debug.snapshot()).messages.map((m) => m.isRead)).toEqual([true]);
      });

      it("adopts the optimistic local copy when the server copy of a sent message syncs", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "local:op1", rfcMessageId: "<abc@me>", isSent: true, inInbox: false })]);
        const r = await ingest(store, [msg({ accountId: a!, providerMsgId: "imap-77", rfcMessageId: "abc@me", isSent: true, inInbox: false, isRead: true })]);
        expect(r.inserted).toEqual([]);
        expect((await store.debug.snapshot()).messages.map((m) => m.providerMsgId)).toEqual(["imap-77"]);
      });
    });

    describe("derived thread state", () => {
      it("an archived conversation returns to the inbox when a new reply arrives, keeping its categories", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "root", rfcMessageId: "r@x" })]);
        const t = await threadOf(store, "root");
        const cat = await store.categories.create("Clientes", "emerald");
        await store.categories.add({ categoryId: cat.id, threadIds: [t], addedBy: "user", now: NOW });
        await store.threads.act({ threadIds: [t], action: "archive", signal: null, now: NOW });
        expect((await store.debug.snapshot()).threads[0]!.inInbox).toBe(false);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "reply", inReplyTo: "r@x", date: 1_900_000_000_000 })]);
        expect((await store.debug.snapshot()).threads[0]).toMatchObject({ id: t, inInbox: true, messageCount: 2, lastDate: 1_900_000_000_000, categoryIds: [cat.id] });
      });

      it("never reuses a message id, even after deleting the newest message", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        const first = await ingest(store, [msg({ accountId: a! }), msg({ accountId: a! })]);
        await store.sync.remove([first.inserted[1]!]);
        const next = await ingest(store, [msg({ accountId: a! })]);
        expect(next.inserted[0]).toBeGreaterThan(first.inserted[1]!);
      });

      it("deleting the last message of a thread deletes the thread", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        const r = await ingest(store, [msg({ accountId: a!, providerMsgId: "only" })]);
        expect((await store.sync.remove(r.inserted)).touched).toHaveLength(1);
        expect((await store.debug.snapshot()).threads).toEqual([]);
        await store.debug.verify();
      });

      // after any random sequence of ingests, actions and deletes, thread aggregates equal a from-scratch recomputation
      it("stays consistent with an independent recomputation under random operations", async () => {
        const store = await fresh();
        const accounts = await withAccounts(store, 2);
        let seed = 7;
        const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
        const actions: ThreadAction[] = ["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar"];
        const rfcIds: string[] = [];
        for (let step = 0; step < 400; step++) {
          const r = rand();
          if (r < 0.5 || rfcIds.length === 0) {
            const id = `rnd${step}@x`;
            const parent = rfcIds.length && rand() < 0.6 ? pick(rfcIds) : null;
            await ingest(store, [
              msg({
                accountId: pick(accounts),
                rfcMessageId: id,
                inReplyTo: parent,
                date: 1_700_000_000_000 + Math.floor(rand() * 1e9),
                isRead: rand() < 0.5,
                isSent: rand() < 0.2,
                inInbox: rand() < 0.7,
                isSpam: rand() < 0.05,
                isTrash: rand() < 0.05,
                isStarred: rand() < 0.1,
                hasAttachments: rand() < 0.2,
              }),
            ]);
            rfcIds.push(id);
          } else if (r < 0.9) {
            const threads = (await store.debug.snapshot()).threads.map((t) => t.id);
            if (threads.length) await store.threads.act({ threadIds: [pick(threads), pick(threads)], action: pick(actions), signal: null, now: NOW });
          } else {
            const ids = (await store.debug.snapshot()).messages.map((m) => m.id);
            if (ids.length) await store.sync.remove([pick(ids)]);
          }
        }
        const snap = await store.debug.snapshot();
        const byThread = new Map<number, SnapshotMessage[]>();
        for (const m of snap.messages) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
        expect(snap.threads.length).toBe(byThread.size);
        for (const t of snap.threads) {
          const ms = byThread.get(t.id)!;
          const live = ms.filter((m) => !m.isTrash);
          expect({ messageCount: t.messageCount, unreadCount: t.unreadCount, inInbox: t.inInbox, inTrash: t.inTrash, inSpam: t.inSpam, hasSent: t.hasSent, isStarred: t.isStarred, hasAttachments: t.hasAttachments }).toEqual({
            messageCount: ms.length,
            unreadCount: live.filter((m) => !m.isRead).length,
            inInbox: ms.some((m) => m.inInbox && !m.isTrash && !m.isSpam),
            inTrash: ms.every((m) => m.isTrash),
            inSpam: live.length > 0 && live.every((m) => m.isSpam),
            hasSent: ms.some((m) => m.isSent && !m.isTrash && !m.isSpam),
            isStarred: ms.some((m) => m.isStarred && !m.isTrash),
            hasAttachments: ms.some((m) => m.hasAttachments),
          });
        }
        await store.debug.verify();
      });
    });

    describe("actions", () => {
      it("archive captures only the messages that were in the inbox at action time", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [
          msg({ accountId: a!, providerMsgId: "in1", rfcMessageId: "r@x", inInbox: true }),
          msg({ accountId: a!, providerMsgId: "sent", inReplyTo: "r@x", inInbox: false, isSent: true }),
        ]);
        const t = await threadOf(store, "in1");
        const r = await store.threads.act({ threadIds: [t], action: "archive", signal: null, now: NOW });
        const inboxMsg = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === "in1")!.id;
        expect(r.opIds).toHaveLength(1);
        expect((await store.ops.get(r.opIds[0]!))!).toMatchObject({ account_id: a, kind: "archive", target_json: JSON.stringify({ messageIds: [inboxMsg] }) });
        // a second archive is a no-op: nothing to send to the provider
        expect(await store.threads.act({ threadIds: [t], action: "archive", signal: null, now: NOW })).toEqual({ threadIds: [], opIds: [], before: [] });
      });

      describe("undo puts each message back exactly", () => {
        const state = (m: { id: number; isRead: boolean; isStarred: boolean; inInbox: boolean; isTrash: boolean; isSpam: boolean }) => ({ id: m.id, isRead: m.isRead, isStarred: m.isStarred, inInbox: m.inInbox, isTrash: m.isTrash, isSpam: m.isSpam });
        const states = async (store: MailStore) => (await store.debug.snapshot()).messages.map(state).sort((x, y) => x.id - y.id);

        it("mixed read states: marking read and restoring leaves the read ones read", async () => {
          const store = await fresh();
          const [a] = await withAccounts(store);
          await ingest(store, [
            msg({ accountId: a!, providerMsgId: "a1", rfcMessageId: "a@x", date: 1000, isRead: true }),
            msg({ accountId: a!, providerMsgId: "a2", inReplyTo: "a@x", date: 2000, isRead: false }),
            msg({ accountId: a!, providerMsgId: "b1", rfcMessageId: "b@x", date: 3000, isRead: true }),
          ]);
          const before = await states(store);
          const ts = [await threadOf(store, "a1"), await threadOf(store, "b1")];
          const r = await store.threads.act({ threadIds: ts, action: "markRead", signal: null, now: NOW });
          // only the message that changed is journaled, as it was
          expect(r.before).toEqual(before.filter((m) => !m.isRead));
          const back = await store.threads.restore({ messages: r.before, now: NOW + 1 });
          expect(await states(store)).toEqual(before);
          expect(back.threadIds).toEqual([ts[0]]);
          const ops = (await store.debug.snapshot()).ops;
          // the markRead never reached the provider: its exact opposite cancels it
          expect(ops.filter((o) => o.kind === "markRead" || o.kind === "markUnread")).toEqual([]);
        });

        it("archived then trashed: the undo returns them to the archive, not the inbox, with ops in order", async () => {
          const store = await fresh();
          const [a] = await withAccounts(store);
          await ingest(store, [msg({ accountId: a!, providerMsgId: "arch", inInbox: false }), msg({ accountId: a!, providerMsgId: "inb", inInbox: true })]);
          const before = await states(store);
          const ts = [await threadOf(store, "arch"), await threadOf(store, "inb")];
          const r = await store.threads.act({ threadIds: ts, action: "trash", signal: null, now: NOW });
          expect(r.before).toHaveLength(2);
          await store.threads.restore({ messages: r.before, now: NOW + 1 });
          expect(await states(store)).toEqual(before);
          const snap = await store.debug.snapshot();
          const arch = snap.messages.find((m) => m.providerMsgId === "arch")!.id;
          const inb = snap.messages.find((m) => m.providerMsgId === "inb")!.id;
          expect(snap.threads.find((t) => t.id === ts[0])).toMatchObject({ inInbox: false, inTrash: false });
          // the provider: the trash, then out of it through the inbox; the archived one goes on to the archive
          const restoring = snap.ops.filter((o) => o.kind !== "trash");
          expect(restoring.map((o) => [o.kind, [...o.messageIds].sort()])).toEqual([
            ["moveToInbox", [arch, inb].sort()],
            ["archive", [arch]],
          ]);
        });

        it("starred messages: every one that was starred is starred again, the others aren't", async () => {
          const store = await fresh();
          const [a] = await withAccounts(store);
          await ingest(store, [
            msg({ accountId: a!, providerMsgId: "s1", rfcMessageId: "s@x", date: 1000, isStarred: true }),
            msg({ accountId: a!, providerMsgId: "s2", inReplyTo: "s@x", date: 2000, isStarred: false }),
            msg({ accountId: a!, providerMsgId: "s3", inReplyTo: "s@x", date: 3000, isStarred: true }),
          ]);
          const before = await states(store);
          const t = await threadOf(store, "s1");
          const r = await store.threads.act({ threadIds: [t], action: "unstar", signal: null, now: NOW });
          expect(r.before.map((m) => m.isStarred)).toEqual([true, true]);
          await store.threads.restore({ messages: r.before, now: NOW + 1 });
          expect(await states(store)).toEqual(before);
          expect((await store.debug.snapshot()).threads.find((x) => x.id === t)!.isStarred).toBe(true);
          // a message deleted meanwhile is skipped
          expect(await store.threads.restore({ messages: [{ id: 987_654, isRead: true, isStarred: true, inInbox: true, isTrash: false, isSpam: false }], now: NOW })).toEqual({ threadIds: [], opIds: [] });
        });
      });

      it("markUnread and star act on the latest message only; unstar clears all", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [
          msg({ accountId: a!, providerMsgId: "old", rfcMessageId: "o@x", date: 1000, isRead: true, isStarred: true }),
          msg({ accountId: a!, providerMsgId: "new", inReplyTo: "o@x", date: 2000, isRead: true }),
        ]);
        const t = await threadOf(store, "old");
        const ids = new Map((await store.debug.snapshot()).messages.map((m) => [m.providerMsgId, m.id]));
        const targets = async (action: ThreadAction) => {
          const r = await store.threads.act({ threadIds: [t], action, signal: null, now: NOW });
          return (JSON.parse((await store.ops.get(r.opIds[0]!))!.target_json) as { messageIds: number[] }).messageIds.sort();
        };
        expect(await targets("markUnread")).toEqual([ids.get("new")]);
        expect(await targets("star")).toEqual([ids.get("new")]);
        expect(await targets("unstar")).toEqual([ids.get("old")!, ids.get("new")!].sort());
      });

      it("moveToInbox restores received mail but leaves my sent replies out of the inbox", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [
          msg({ accountId: a!, providerMsgId: "recv", rfcMessageId: "q@x", inInbox: false, isTrash: true }),
          msg({ accountId: a!, providerMsgId: "mine", inReplyTo: "q@x", inInbox: false, isSent: true, isTrash: true }),
        ]);
        const t = await threadOf(store, "recv");
        await store.threads.act({ threadIds: [t], action: "moveToInbox", signal: null, now: NOW });
        const snap = await store.debug.snapshot();
        expect(snap.messages.map((m) => [m.providerMsgId, m.inInbox, m.isTrash]).sort()).toEqual([
          ["mine", false, true],
          ["recv", true, false],
        ]);
        expect(snap.threads[0]).toMatchObject({ inInbox: true, inTrash: false });
      });

      it("explicit user signals are logged only when the action changed something", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "n", from: { name: "News", email: "news@brew.com" } })]);
        const t = await threadOf(store, "n");
        await store.threads.act({ threadIds: [t], action: "archive", signal: "archive", now: NOW });
        await store.threads.act({ threadIds: [t], action: "archive", signal: "archive", now: NOW });
        expect(await store.learning.actionsSince(0)).toEqual([{ action: "archive", fromEmail: "news@brew.com", fromDomain: "brew.com", listId: null, at: NOW }]);
      });

      it("filters act on every matched message, at most once each, and their ops commit with the slice", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        const rule: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "promo" }], actions: [{ type: "star" }] };
        await store.filters.save({ name: "promos", enabled: true, source: "manual", rule }, NOW);
        const r = await ingest(store, [msg({ accountId: a!, rfcMessageId: "s1@x", subject: "Promo 1", date: 1 }), msg({ accountId: a!, inReplyTo: "s1@x", subject: "Re: Promo 1", date: 2 })]);
        expect(r.opIds).toHaveLength(1);
        expect((await store.debug.snapshot()).messages.every((m) => m.isStarred)).toBe(true);
        const f = (await store.filters.list())[0]!;
        const again = await store.filters.applyChunk(f.id, JSON.stringify(f.rule), r.inserted, NOW);
        expect(again).toEqual({ applied: 0, touched: [], opIds: [] });
        await expect(store.filters.applyChunk(f.id, JSON.stringify({ ...f.rule, actions: [] }), r.inserted, NOW)).rejects.toThrow(/changed/);
        // editing the rule forgets what the old definition was applied to
        await store.filters.save({ id: f.id, name: f.name, enabled: true, source: "manual", rule: { ...rule, actions: [{ type: "markRead" }] } }, NOW);
        const edited = (await store.filters.get(f.id))!;
        expect((await store.filters.applyChunk(f.id, JSON.stringify(edited.rule), r.inserted, NOW)).applied).toBe(2);
      });
    });

    describe("ops state machine", () => {
      async function mailbox(n = 2) {
        const store = await fresh();
        const [a, b] = await withAccounts(store);
        const threads: number[] = [];
        for (let i = 0; i < n; i++) {
          const m = msg({ accountId: a!, isRead: false });
          await ingest(store, [m]);
          threads.push(await threadOf(store, m.providerMsgId!));
        }
        const act = async (thread: number, action: ThreadAction, now = 0) => (await store.threads.act({ threadIds: [thread], action, signal: null, now })).opIds[0] ?? null;
        return { store, a: a!, b: b!, threads, act };
      }
      const targetOf = async (store: MailStore, id: string) => (JSON.parse((await store.ops.get(id))!.target_json) as { messageIds?: number[] }).messageIds;

      it("claims in sequence order, retries with exponential backoff, then fails terminally", async () => {
        const { store, threads, act } = await mailbox();
        const first = (await act(threads[0]!, "archive"))!;
        const second = (await act(threads[1]!, "trash"))!;
        expect((await store.ops.claimReady(0, 20)).map((o) => o.id)).toEqual([first, second]);
        await store.ops.complete(second, undefined, 0);
        let now = 0;
        const delays: number[] = [];
        for (let attempt = 1; attempt <= 8; attempt++) {
          const state = await store.ops.fail(first, "ECONNRESET", true, now);
          const op = (await store.ops.get(first))!;
          if (attempt < 8) {
            expect(state).toBe("queued");
            delays.push(op.next_attempt_at - now);
            expect(await store.ops.claimReady(op.next_attempt_at - 1, 20)).toEqual([]);
            now = op.next_attempt_at;
            expect((await store.ops.claimReady(now, 20)).map((o) => o.id)).toEqual([first]);
          } else {
            expect(state).toBe("failed");
          }
        }
        expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
        expect(Math.max(...delays)).toBeLessThanOrEqual(300_000);
      });

      it("an op waiting for the user to sign in again keeps its attempts, schedules nothing, and resumes at once for its account", async () => {
        const { store, a, b, threads, act } = await mailbox(2);
        const first = (await act(threads[0]!, "archive"))!;
        const second = (await act(threads[1]!, "star"))!;
        for (let round = 0; round < 12; round++) {
          const claimed = (await store.ops.claimReady(round * 600_000, 20)).map((o) => o.id);
          expect(claimed, `round ${round}`).toEqual(round === 0 ? [first, second] : []);
          for (const id of claimed) await store.ops.awaitAuth(id, "Vuelve a conectar la cuenta", round * 600_000);
        }
        for (const id of [first, second]) expect(await store.ops.get(id)).toMatchObject({ state: "queued", attempts: 0, last_error: "Vuelve a conectar la cuenta" });
        // nothing to schedule: a timer would spin on it
        expect(await store.ops.nextAttemptAt()).toBeNull();
        expect(await store.ops.resumeAuth(b, 10_000_000)).toEqual([]);
        expect((await store.ops.resumeAuth(a, 10_000_000)).sort()).toEqual([first, second].sort());
        expect((await store.ops.claimReady(10_000_000, 20)).map((o) => o.id)).toEqual([first, second]);
      });

      it("non-retryable failures fail immediately", async () => {
        const { store, threads, act } = await mailbox(1);
        const id = (await act(threads[0]!, "archive"))!;
        await store.ops.claimReady(0, 20);
        expect(await store.ops.fail(id, "Mailbox does not exist", false, 0)).toBe("failed");
      });

      it("cancels a queued flag op exactly undone before sync (read → unread), but not one already attempted or running", async () => {
        const { store, threads, act } = await mailbox(2);
        expect(await act(threads[0]!, "markRead")).toBeTruthy();
        expect(await act(threads[0]!, "markUnread")).toBeNull();
        expect((await store.debug.snapshot()).ops).toEqual([]);
        const star = (await act(threads[1]!, "star"))!;
        await store.ops.claimReady(0, 20);
        expect(await act(threads[1]!, "unstar", 1)).toBeTruthy(); // running: the server may already be starred
        await store.ops.fail(star, "response lost", true, 2);
        expect((await store.debug.snapshot()).ops.map((o) => o.kind)).toEqual(["unstar"]); // the retry yields to the newer intent
      });

      it("a newer op supersedes the overlapping part of an older op waiting in backoff", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "t1" }), msg({ accountId: a!, providerMsgId: "t2" })]);
        const [t1, t2] = [await threadOf(store, "t1"), await threadOf(store, "t2")];
        const ids = new Map((await store.debug.snapshot()).messages.map((m) => [m.threadId, m.id]));
        const older = (await store.threads.act({ threadIds: [t1, t2], action: "markRead", signal: null, now: 0 })).opIds[0]!;
        await store.ops.claimReady(0, 20);
        await store.ops.fail(older, "ETIMEDOUT", true, 0);
        await store.threads.act({ threadIds: [t2], action: "markUnread", signal: null, now: 1 });
        expect(await targetOf(store, older)).toEqual([ids.get(t1)]);
        await store.threads.act({ threadIds: [t1], action: "markUnread", signal: null, now: 2 });
        expect(await store.ops.get(older)).toBeNull();
      });

      it("location ops are never superseded and run in order per message", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "s", isSpam: true, inInbox: false })]);
        const t = await threadOf(store, "s");
        const notSpam = (await store.threads.act({ threadIds: [t], action: "notSpam", signal: null, now: 0 })).opIds[0]!;
        await store.ops.claimReady(0, 20);
        await store.ops.fail(notSpam, "ETIMEDOUT", true, 0);
        const archive = (await store.threads.act({ threadIds: [t], action: "archive", signal: null, now: 1 })).opIds[0]!;
        expect(await store.ops.get(notSpam)).not.toBeNull();
        expect(await store.ops.claimReady(1, 20)).toEqual([]); // archive waits behind notSpam
        const ready = await store.ops.claimReady((await store.ops.get(notSpam))!.next_attempt_at, 20);
        expect(ready.map((o) => o.id)).toEqual([notSpam]);
        await store.ops.complete(notSpam, undefined, 0);
        expect((await store.ops.claimReady(10 ** 13, 20)).map((o) => o.id)).toEqual([archive]);
      });

      it("deleting messages removes them from unsettled ops", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        const r = await ingest(store, [msg({ accountId: a!, providerMsgId: "d1", rfcMessageId: "d@x" }), msg({ accountId: a!, providerMsgId: "d2", inReplyTo: "d@x" })]);
        const op = (await store.threads.act({ threadIds: [await threadOf(store, "d1")], action: "trash", signal: null, now: 0 })).opIds[0]!;
        await store.sync.remove([r.inserted[1]!]);
        expect(await targetOf(store, op)).toEqual([r.inserted[0]]);
        await store.sync.remove([r.inserted[0]!]);
        expect(await store.ops.get(op)).toBeNull();
      });

      it("crash recovery: running sends become unknown (never resent), other running ops requeue, across a reopen", async () => {
        const box = await mailbox(1);
        const { a, threads, act } = box;
        let store = box.store;
        const send = await store.compose.queueSend({ accountId: a, to: [{ name: "", email: "x@y.com" }], cc: [], bcc: [], subject: "hi", bodyText: ".", recordReply: false, now: 0 });
        const archive = (await act(threads[0]!, "archive"))!;
        expect((await store.ops.claimReady(0, 20)).map((o) => o.id).sort()).toEqual([send.opId, archive].sort());
        store = await harness.reopen(store);
        open.push(store);
        expect(await store.ops.recover(1)).toEqual({ requeued: 1, unknown: 1 });
        expect((await store.ops.get(send.opId))!.state).toBe("unknown");
        expect((await store.ops.claimReady(10 ** 13, 20)).map((o) => o.id)).toEqual([archive]);
        // unknown is never claimed again; discarding removes the optimistic copy and its empty thread
        expect((await store.ops.resolveUnknown(send.opId, "discard", 2)).touched).toEqual([send.threadId]);
        expect((await store.debug.snapshot()).threads.map((t) => t.id)).toEqual(threads);
      });

      it("reports messages with unsettled ops per account, and sync doesn't clobber their optimistic state", async () => {
        const { store, a, threads, act } = await mailbox(2);
        const done = (await act(threads[0]!, "archive"))!;
        await act(threads[1]!, "markRead");
        await store.ops.claimReady(0, 20);
        await store.ops.complete(done, undefined, 0);
        const snap = await store.debug.snapshot();
        const pendingMsg = snap.messages.find((m) => m.threadId === threads[1])!.id;
        expect([...(await store.sync.pendingMessageIds(a))]).toEqual([pendingMsg]);
        const settled = snap.messages.find((m) => m.threadId === threads[0])!.id;
        await store.sync.updateFlags(a, [{ messageId: pendingMsg, flags: { isRead: false } }, { messageId: settled, flags: { inInbox: true } }]);
        const after = await store.debug.snapshot();
        expect(after.messages.find((m) => m.id === pendingMsg)!.isRead).toBe(true);
        expect(after.threads.find((t) => t.id === threads[0])!.inInbox).toBe(true);
      });

      it("op completion adopts the provider's ids for a sent message (and its thread)", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        const send = await store.compose.queueSend({ accountId: a!, to: [{ name: "", email: "x@y.com" }], cc: [], bcc: [], subject: "hi", bodyText: ".", recordReply: false, now: 0 });
        await store.ops.claimReady(0, 20);
        const done = await store.ops.complete(send.opId, { providerMsgId: "srv-1", providerThreadId: "T-NEW" }, 1);
        expect(done.touched).toEqual([send.threadId]);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "g-reply", providerThreadId: "T-NEW" })]);
        expect(await threadOf(store, "g-reply")).toBe(send.threadId);
        expect((await store.debug.snapshot()).messages.map((m) => m.providerMsgId).sort()).toEqual(["g-reply", "srv-1"]);
      });
    });

    describe("on the seeded mailbox", () => {
      let store: MailStore;
      let snap: StoreSnapshot;
      beforeAll(async () => {
        store = await harness.open();
        await seedThroughCommands(store, generateDataset({ threads: 2500, accounts: 4, seed: 11, now: NOW }), NOW);
        snap = await store.debug.snapshot();
      }, 120_000);
      afterAll(async () => {
        await store.debug.verify();
        await store.close();
      });

      defineSearchConformance(
        `${name} (threads.search)`,
        async () => ({
          now: NOW,
          corpus: async () => corpusOf(await store.debug.snapshot()),
          search: async (query, scope, cursor, limit) => {
            const page = await store.threads.searchText({ query, ...scope, cursor, limit, now: NOW });
            return { threadIds: page.items.map((t) => t.id), nextCursor: page.nextCursor, strategy: page.strategy };
          },
        }),
        { strategies: harness.strategies },
      );

      it("keyset pagination returns every thread exactly once, in order, for every view, account and category", async () => {
        const docs = snap.search.threads;
        expect(new Set(docs.map((t) => t.lastDate)).size).toBeLessThan(docs.length); // the fixture has ties
        const scopes: { accountId?: number; categoryId?: number }[] = [{}, { accountId: snap.accounts[1]!.id }, { categoryId: snap.categories[0]!.id }];
        for (const view of VIEWS) {
          for (const scope of scopes) {
            const ids: number[] = [];
            let cursor: Cursor | undefined;
            do {
              const page = await store.threads.list({ view, limit: 53, cursor, ...scope });
              ids.push(...page.items.map((t) => t.id));
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
            const expected = docs
              .filter((t) => VIEW_TEST[view](t) && (scope.accountId === undefined || t.accountId === scope.accountId) && (scope.categoryId === undefined || t.categoryIds.includes(scope.categoryId)))
              .sort(byRecency)
              .map((t) => t.threadId);
            expect(ids, `${view} ${JSON.stringify(scope)}`).toEqual(expected);
          }
        }
      });

      it("sidebar counts equal a brute-force count of unread threads", async () => {
        const counts = await store.threads.counts();
        const inbox = snap.threads.filter((t) => t.inInbox && t.unreadCount > 0);
        expect(counts.inboxUnread).toBe(inbox.length);
        for (const [accountId, n] of Object.entries(counts.inboxUnreadByAccount)) expect(n).toBe(inbox.filter((t) => t.accountId === Number(accountId)).length);
        for (const c of snap.categories) {
          const members = snap.threads.filter((t) => t.categoryIds.includes(c.id) && !t.inTrash && !t.inSpam);
          expect(counts.categoryTotal[c.id] ?? 0, c.name).toBe(members.length);
          expect(counts.categoryUnread[c.id] ?? 0, c.name).toBe(members.filter((t) => t.unreadCount > 0).length);
        }
      });

      it("filter rules: matching (SQL compiler or not) agrees with core's evaluator on every message, 120+ generated rules", async () => {
        const toRule = (m: SnapshotMessage): RuleMessage => ({
          accountId: m.accountId,
          fromName: m.fromName,
          fromEmail: m.fromEmail,
          recipients: m.recipients,
          subject: m.subject,
          bodyText: m.bodyText,
          listId: m.listId,
          hasAttachments: m.hasAttachments,
          date: m.date,
        });
        const live = snap.messages.filter((m) => !m.isTrash);
        const range = (await store.filters.messageIdRange())!;
        let nonTrivial = 0;
        for (const rule of generateRules(snap.messages)) {
          const expected = live.filter((m) => evaluateRule(rule, toRule(m), NOW)).map((m) => m.id).sort((p, q) => p - q);
          const actual = (await store.filters.matchWindow(rule, NOW, { from: range.lo, to: range.hi })).sort((p, q) => p - q);
          expect(actual, JSON.stringify(rule)).toEqual(expected);
          if (expected.length > 0 && expected.length < live.length) nonTrivial++;
          const preview = await store.filters.preview(rule, NOW, 5);
          expect(preview.count).toBe(new Set(live.filter((m) => expected.includes(m.id)).map((m) => m.threadId)).size);
        }
        expect(nonTrivial).toBeGreaterThan(60);
      });
    });

    describe("categorization", () => {
      async function setup() {
        const store = await fresh();
        const [acct] = await withAccounts(store, 1);
        const cat = (await store.categories.create("Facturas", "amber")).id;
        const other = (await store.categories.create("Lecturas", "violet")).id;
        const thread = async (over: Partial<Parameters<typeof msg>[0]> = {}) => {
          const m = msg({ accountId: acct!, from: { name: "Uber Receipts", email: "uber.receipts@uber.com" }, subject: "Tu recibo · $10.00", bodyText: "Total $10.00 MXN. Factura 12.", date: NOW - 10 * DAY, ...over });
          await ingest(store, [m]);
          return threadOf(store, m.providerMsgId!);
        };
        const examples = async () => (await store.debug.snapshot()).examples;
        return { store, acct: acct!, cat, other, thread, examples };
      }

      it("explicit adds record a positive example in the same command; filter and auto adds never train", async () => {
        const { store, cat, thread, examples } = await setup();
        const [a, b, c, d] = [await thread(), await thread(), await thread(), await thread()];
        const user = await store.categories.add({ categoryId: cat, threadIds: [a, a], addedBy: "user", now: NOW });
        expect(user.added).toEqual([a]);
        expect(user.deltas.map((x) => x.op)).toEqual(["unbackground", "train"]);
        await store.categories.add({ categoryId: cat, threadIds: [b], addedBy: "agent", now: NOW });
        await store.categories.add({ categoryId: cat, threadIds: [c], addedBy: "filter", now: NOW });
        expect((await store.categories.add({ categoryId: cat, threadIds: [d], addedBy: "auto", now: NOW })).deltas.map((x) => x.op)).toEqual(["unbackground"]);
        expect(await examples()).toEqual([
          { threadId: a, categoryId: cat, label: 1, weight: 1, source: "user", content: true, sender: "uber.receipts@uber.com", batchId: null },
          { threadId: b, categoryId: cat, label: 1, weight: 0.5, source: "agent", content: true, sender: "uber.receipts@uber.com", batchId: null },
        ]);
        expect(await store.categories.add({ categoryId: cat, threadIds: [a], addedBy: "user", now: NOW })).toEqual({ added: [], deltas: [] });
      });

      it("bulk adds weigh half and stop teaching content after 50 per sender and category", async () => {
        const { store, cat, other, thread, examples } = await setup();
        const ids: number[] = [];
        for (let i = 0; i < 53; i++) ids.push(await thread());
        await store.categories.add({ categoryId: cat, threadIds: ids, addedBy: "bulk", now: NOW, batchId: 1 });
        const rows = (await examples()).filter((e) => e.categoryId === cat);
        expect(rows.every((e) => e.weight === 0.5 && e.source === "bulk")).toBe(true);
        expect(rows.filter((e) => e.content)).toHaveLength(50);
        await store.categories.add({ categoryId: other, threadIds: ids.slice(0, 3), addedBy: "bulk", now: NOW });
        expect((await examples()).filter((e) => e.categoryId === other && e.content)).toHaveLength(3);
      });

      it("a user removal is a strong negative and replaces the positive; filing again lifts it", async () => {
        const { store, cat, thread, examples } = await setup();
        const a = await thread();
        await store.categories.add({ categoryId: cat, threadIds: [a], addedBy: "user", now: NOW });
        const r = await store.categories.remove({ categoryId: cat, threadIds: [a, 999_999], reason: "user", now: NOW + 1 });
        expect(r.removed).toEqual([a]);
        expect(r.deltas.map((d) => [d.op, d.op === "train" || d.op === "untrain" ? d.example.label : null])).toEqual([["untrain", 1], ["train", -1], ["background", null]]);
        expect(await examples()).toMatchObject([{ threadId: a, label: -1, weight: 3, source: "removal" }]);
        const back = await store.categories.add({ categoryId: cat, threadIds: [a], addedBy: "user", now: NOW + 2 });
        expect(back.deltas.filter((d) => d.op !== "unbackground").map((d) => d.op)).toEqual(["untrain", "train"]);
        expect(await examples()).toMatchObject([{ threadId: a, label: 1, source: "user" }]);
      });

      it("undo takes back the user's own add without learning a negative", async () => {
        const { store, cat, thread, examples } = await setup();
        const a = await thread();
        await store.categories.add({ categoryId: cat, threadIds: [a], addedBy: "user", now: NOW });
        const r = await store.categories.remove({ categoryId: cat, threadIds: [a], reason: "undo", now: NOW });
        expect(r.deltas.map((d) => d.op)).toEqual(["untrain", "background"]);
        expect(await examples()).toEqual([]);
        expect((await store.debug.snapshot()).memberships).toEqual([]);
      });

      it("batch undo removes exactly the batch's rows and examples, once", async () => {
        const { store, cat, thread, examples } = await setup();
        const [before, a, b] = [await thread(), await thread(), await thread()];
        await store.categories.add({ categoryId: cat, threadIds: [before], addedBy: "user", now: NOW });
        const batch = await store.categories.createBatch(cat, "snackbar", { kind: "sender", email: "uber.receipts@uber.com" }, NOW);
        expect((await store.categories.add({ categoryId: cat, threadIds: [before, a, b], addedBy: "bulk", now: NOW, batchId: batch })).added).toEqual([a, b]);
        const undo = await store.categories.undoBatchPart(batch, await store.categories.batchThreads(batch), NOW + 1);
        await store.categories.finishUndo(batch, NOW + 1);
        expect(undo.removed.sort()).toEqual([a, b].sort());
        expect(undo.deltas.map((d) => d.op)).toEqual(["untrain", "untrain", "background", "background"]);
        expect((await store.debug.snapshot()).memberships.map((m) => m.threadId)).toEqual([before]);
        expect((await examples()).map((e) => e.threadId)).toEqual([before]);
        expect((await store.categories.undoBatchPart(batch, [a, b], NOW + 2)).removed).toEqual([]);
      });

      it("a merge honors the newest explicit decision per category: a removal is not undone by the other half", async () => {
        const { store, acct, cat } = await setup();
        const ana = { name: "Ana", email: "ana@cafealtura.mx" };
        const a = msg({ accountId: acct, rfcMessageId: "ma@x", from: ana });
        const c = msg({ accountId: acct, rfcMessageId: "mc@x", references: ["mb@x"], from: ana });
        await ingest(store, [a, c]);
        const [ta, tc] = [await threadOf(store, a.providerMsgId!), await threadOf(store, c.providerMsgId!)];
        await store.categories.add({ categoryId: cat, threadIds: [tc], addedBy: "user", now: NOW - 10 * DAY });
        await store.categories.add({ categoryId: cat, threadIds: [ta], addedBy: "user", now: NOW - 5 * DAY });
        await store.categories.remove({ categoryId: cat, threadIds: [ta], reason: "user", now: NOW - DAY });
        const r = await ingest(store, [msg({ accountId: acct, rfcMessageId: "mb@x", references: ["ma@x"], from: ana })]);
        const snap = await store.debug.snapshot();
        expect(Math.min(ta, tc)).toBe(ta);
        expect(snap.memberships).toEqual([]);
        expect(snap.examples.map((e) => [e.threadId, e.label])).toEqual([[ta, -1]]);
        expect(r.deltas.map((d) => [d.op, "example" in d ? d.example.label : null])).toEqual([["untrain", 1]]);
      });

      it("a merge keeps the category when the newest decision is a filing", async () => {
        const { store, acct, cat } = await setup();
        const ana = { name: "Ana", email: "ana@cafealtura.mx" };
        const a = msg({ accountId: acct, rfcMessageId: "na@x", from: ana });
        const c = msg({ accountId: acct, rfcMessageId: "nc@x", references: ["nb@x"], from: ana });
        await ingest(store, [a, c]);
        const [ta, tc] = [await threadOf(store, a.providerMsgId!), await threadOf(store, c.providerMsgId!)];
        await store.categories.add({ categoryId: cat, threadIds: [ta], addedBy: "user", now: NOW - 10 * DAY });
        await store.categories.remove({ categoryId: cat, threadIds: [ta], reason: "user", now: NOW - 9 * DAY });
        await store.categories.add({ categoryId: cat, threadIds: [tc], addedBy: "user", now: NOW - DAY });
        const r = await ingest(store, [msg({ accountId: acct, rfcMessageId: "nb@x", references: ["na@x"], from: ana })]);
        const snap = await store.debug.snapshot();
        expect(snap.memberships).toMatchObject([{ threadId: ta, addedBy: "user" }]);
        expect(snap.examples.map((e) => [e.threadId, e.label])).toEqual([[ta, 1]]);
        expect(r.deltas.map((d) => [d.op, "example" in d ? d.example.label : null])).toEqual([["untrain", -1]]);
      });

      it("a command that fails records nothing", async () => {
        const { store, cat, thread, examples } = await setup();
        // e.g. the category was deleted meanwhile
        const a = await thread();
        await expect(store.categories.add({ categoryId: cat + 987_654, threadIds: [a], addedBy: "user", now: NOW })).rejects.toThrow();
        expect(await examples()).toEqual([]);
        expect((await store.debug.snapshot()).memberships).toEqual([]);
      });

      /** A move as the backend runs it: recorded, applied in slices, then trained. */
      const applyAll = async (store: MailStore, batchId: number) => {
        for (const t of await store.categories.movePending(batchId)) await store.categories.applyMoveSlice(batchId, [t], NOW);
      };
      /** Its undo: started, memberships back in slices; returns what those slices removed and restored. */
      const undoAll = async (store: MailStore, batchId: number) => {
        expect(await store.categories.undoMoveBegin(batchId, NOW + 1)).toBe(true);
        const out = { removed: [] as number[], restored: [] as number[] };
        for (const t of await store.categories.movePending(batchId)) {
          const r = await store.categories.undoMoveSlice(batchId, [t], NOW + 1);
          out.removed.push(...r.removed);
          out.restored.push(...r.restored);
        }
        return out;
      };

      it("a move is applied in slices (one unit each) and trained in slices; its undo restores the source", async () => {
        const { store, cat, other, thread } = await setup();
        const [t1, t2] = [await thread(), await thread()];
        await store.categories.add({ categoryId: cat, threadIds: [t1, t2], addedBy: "user", now: NOW });
        const m = await store.categories.beginMove({ to: other, threadIds: [t1, t2], addedBy: "user", now: NOW, source: "dnd" });
        expect(await store.categories.movePhase(m.batchId)).toBe("moving");
        // nothing moved yet; one slice moves exactly its threads
        expect((await store.debug.snapshot()).memberships.map((x) => x.categoryId)).toEqual([cat, cat]);
        const first = await store.categories.applyMoveSlice(m.batchId, [t1], NOW);
        expect(first.touched).toEqual([t1]);
        expect((await store.debug.snapshot()).memberships.map((x) => [x.threadId, x.categoryId]).sort()).toEqual([[t1, other], [t2, cat]].sort());
        await applyAll(store, m.batchId);
        expect((await store.debug.snapshot()).memberships.map((x) => x.categoryId)).toEqual([other, other]);
        const outcome = await store.categories.moveOutcome(m.batchId);
        expect([outcome.added, outcome.moved]).toEqual([[t1, t2].sort((a, b) => a - b), [t1, t2].sort((a, b) => a - b)]);
        expect(await store.categories.movePhase(m.batchId)).toBe("training");
        await store.categories.trainMoveSlice(m.batchId, await store.categories.movePending(m.batchId), NOW);
        expect(await store.categories.movePhase(m.batchId)).toBe("done");
        const undo = await undoAll(store, m.batchId);
        expect([undo.removed.sort(), undo.restored.sort()]).toEqual([[t1, t2].sort(), [t1, t2].sort()]);
        expect(await store.categories.movePhase(m.batchId)).toBe("restoring");
        await store.categories.restoreMoveSlice(m.batchId, await store.categories.movePending(m.batchId));
        const snap = await store.debug.snapshot();
        expect(snap.memberships.map((x) => x.categoryId)).toEqual([cat, cat]);
        expect(snap.examples.map((e) => [e.categoryId, e.label])).toEqual([[cat, 1], [cat, 1]]);
      });

      it("a move is exclusive: every other category is left, each gets a removal example, undo restores every source exactly", async () => {
        const { store, cat, other, thread, examples } = await setup();
        const third = (await store.categories.create("Viajes", "cyan")).id;
        // t1 in cat + other (two batches, two origins), t2 only in the destination already, t3 in cat + the destination
        const [t1, t2, t3] = [await thread(), await thread(), await thread()];
        const bulk = await store.categories.createBatch(cat, "snackbar", { kind: "sender", email: "uber.receipts@uber.com" }, NOW - DAY);
        await store.categories.add({ categoryId: cat, threadIds: [t1, t3], addedBy: "bulk", now: NOW - DAY, batchId: bulk });
        await store.categories.add({ categoryId: other, threadIds: [t1], addedBy: "user", now: NOW - 2 * DAY });
        await store.categories.add({ categoryId: third, threadIds: [t2, t3], addedBy: "user", now: NOW - 3 * DAY });
        const before = await store.debug.snapshot();
        const m = await store.categories.beginMove({ to: third, threadIds: [t1, t2, t3], addedBy: "user", now: NOW, source: "dnd" });
        await applyAll(store, m.batchId);
        expect(await store.categories.moveOutcome(m.batchId)).toEqual({ added: [t1], moved: [t1, t3].sort((a, b) => a - b) });
        const after = (await store.debug.snapshot()).memberships.map((x) => [x.threadId, x.categoryId]).sort((a, b) => a[0]! - b[0]!);
        expect(after).toEqual([[t1, third], [t2, third], [t3, third]].sort((a, b) => a[0]! - b[0]!));
        await store.categories.trainMoveSlice(m.batchId, await store.categories.movePending(m.batchId), NOW);
        const trained = (await examples()).map((e) => [e.threadId, e.categoryId, e.label]).sort();
        // a positive in the destination for the thread it added; a removal example in each category left
        expect(trained).toEqual(
          [
            [t1, third, 1],
            [t1, cat, -1],
            [t1, other, -1],
            [t2, third, 1],
            [t3, cat, -1],
            [t3, third, 1],
          ].sort(),
        );
        const undo = await undoAll(store, m.batchId);
        expect(undo.removed).toEqual([t1]);
        expect(undo.restored).toEqual([t1, t3].sort((a, b) => a - b));
        await store.categories.restoreMoveSlice(m.batchId, await store.categories.movePending(m.batchId));
        const back = await store.debug.snapshot();
        const key = (x: { threadId: number; categoryId: number }) => `${x.threadId}:${x.categoryId}`;
        // every source row with its origin and batch, so undoing the earlier bulk batch still works
        expect([...back.memberships].sort((a, b) => key(a).localeCompare(key(b)))).toEqual([...before.memberships].sort((a, b) => key(a).localeCompare(key(b))));
        expect([...back.examples].sort((a, b) => key(a).localeCompare(key(b)))).toEqual([...before.examples].sort((a, b) => key(a).localeCompare(key(b))));
        expect((await store.categories.undoBatchPart(bulk, await store.categories.batchThreads(bulk), NOW + 2)).removed.sort()).toEqual([t1, t3].sort());
      });

      it("a move older than a day can't be undone any more", async () => {
        const { store, cat, other, thread } = await setup();
        const t = await thread();
        await store.categories.add({ categoryId: cat, threadIds: [t], addedBy: "user", now: NOW });
        const m = await store.categories.beginMove({ to: other, threadIds: [t], addedBy: "user", now: NOW, source: "dnd" });
        await applyAll(store, m.batchId);
        await store.categories.trainMoveSlice(m.batchId, await store.categories.movePending(m.batchId), NOW);
        expect(await store.categories.movePhase(m.batchId)).toBe("done");
        // the next move, two days later, prunes it
        await store.categories.beginMove({ to: cat, threadIds: [t], addedBy: "user", now: NOW + 2 * DAY, source: "dnd" });
        expect(await store.categories.movePhase(m.batchId)).toBe("expired");
        await expect(store.categories.undoMoveBegin(m.batchId, NOW + 2 * DAY)).rejects.toThrow(/ya no se puede deshacer/);
      });

      it("a thread already only in the destination is not moved; a multi-filed one dropped on one of its categories leaves the others", async () => {
        const { store, cat, other, thread } = await setup();
        const [only, multi] = [await thread(), await thread()];
        await store.categories.add({ categoryId: cat, threadIds: [only, multi], addedBy: "user", now: NOW });
        await store.categories.add({ categoryId: other, threadIds: [multi], addedBy: "user", now: NOW });
        const m = await store.categories.beginMove({ to: cat, threadIds: [only, multi], addedBy: "user", now: NOW, source: "dnd" });
        await applyAll(store, m.batchId);
        expect(await store.categories.moveOutcome(m.batchId)).toEqual({ added: [], moved: [multi] });
        expect((await store.debug.snapshot()).memberships.map((x) => [x.threadId, x.categoryId]).sort()).toEqual([[only, cat], [multi, cat]].sort());
      });

      it("a move interrupted by a crash resumes (moving, training, unmoving, restoring) after a reopen and comes back exactly", async () => {
        let store = await fresh();
        const a = (await store.categories.create("A", "rose")).id;
        const b = (await store.categories.create("B", "lime")).id;
        const c = (await store.categories.create("C", "cyan")).id;
        const [acct] = await withAccounts(store, 1);
        const ids: number[] = [];
        for (let i = 0; i < 4; i++) {
          const m = msg({ accountId: acct!, from: { name: "Ana", email: "ana@cafealtura.mx" }, subject: `Pedido ${i}`, bodyText: "Café de Veracruz, pedido semanal.", date: NOW - 10 * DAY });
          await ingest(store, [m]);
          ids.push(await threadOf(store, m.providerMsgId!));
        }
        await store.categories.add({ categoryId: a, threadIds: ids, addedBy: "user", now: NOW - DAY });
        await store.categories.add({ categoryId: b, threadIds: ids.slice(0, 2), addedBy: "user", now: NOW - DAY });
        const before = (await store.debug.snapshot()).memberships;
        const m = await store.categories.beginMove({ to: c, threadIds: ids, addedBy: "user", now: NOW, source: "dnd" });
        await store.categories.applyMoveSlice(m.batchId, ids.slice(0, 2), NOW);
        store = await harness.reopen(store);
        open.push(store);
        expect(await store.categories.unfinishedMoves()).toEqual([{ batchId: m.batchId, phase: "moving" }]);
        expect((await store.categories.movePending(m.batchId)).sort()).toEqual(ids.slice(2).sort());
        await applyAll(store, m.batchId);
        expect((await store.debug.snapshot()).memberships.map((x) => x.categoryId)).toEqual(ids.map(() => c));
        await store.categories.trainMoveSlice(m.batchId, ids.slice(0, 1), NOW);
        store = await harness.reopen(store);
        open.push(store);
        expect(await store.categories.unfinishedMoves()).toEqual([{ batchId: m.batchId, phase: "training" }]);
        expect((await store.categories.movePending(m.batchId)).sort()).toEqual(ids.slice(1).sort());
        await store.categories.trainMoveSlice(m.batchId, await store.categories.movePending(m.batchId), NOW);
        expect(await store.categories.unfinishedMoves()).toEqual([]);
        const removals = (await store.debug.snapshot()).examples.filter((e) => e.label === -1).map((e) => `${e.threadId}:${e.categoryId}`).sort();
        expect(removals).toEqual([...ids.map((t) => `${t}:${a}`), ...ids.slice(0, 2).map((t) => `${t}:${b}`)].sort());
        expect(await store.categories.undoMoveBegin(m.batchId, NOW + 1)).toBe(true);
        await store.categories.undoMoveSlice(m.batchId, ids.slice(0, 1), NOW + 1);
        store = await harness.reopen(store);
        open.push(store);
        expect(await store.categories.unfinishedMoves()).toEqual([{ batchId: m.batchId, phase: "unmoving" }]);
        await store.categories.undoMoveSlice(m.batchId, await store.categories.movePending(m.batchId), NOW + 1);
        expect(await store.categories.unfinishedMoves()).toEqual([{ batchId: m.batchId, phase: "restoring" }]);
        store = await harness.reopen(store);
        open.push(store);
        await store.categories.restoreMoveSlice(m.batchId, await store.categories.movePending(m.batchId));
        expect(await store.categories.movePhase(m.batchId)).toBe("undone");
        const key = (x: { threadId: number; categoryId: number }) => `${x.threadId}:${x.categoryId}`;
        expect((await store.debug.snapshot()).memberships.map(key).sort()).toEqual(before.map(key).sort());
      });

      it("a view's scope ids and count are exactly its list, by account and by category, up to a limit", async () => {
        const { store, acct, cat, thread } = await setup();
        const ts = [await thread(), await thread(), await thread(), await thread({ subject: "otro" })];
        await store.categories.add({ categoryId: cat, threadIds: ts.slice(0, 3), addedBy: "user", now: NOW });
        await store.threads.act({ threadIds: [ts[0]!], action: "archive", signal: null, now: NOW });
        await store.threads.act({ threadIds: [ts[1]!], action: "trash", signal: null, now: NOW });
        const listed = async (p: { view: "inbox" | "all" | "trash"; accountId?: number; categoryId?: number }) => (await store.threads.list({ ...p, limit: 500 })).items.map((t) => t.id).sort((a, b) => a - b);
        for (const p of [{ view: "inbox" as const }, { view: "all" as const, categoryId: cat }, { view: "inbox" as const, accountId: acct }, { view: "trash" as const, categoryId: cat }, { view: "all" as const, accountId: acct + 999 }]) {
          const want = await listed(p);
          expect((await store.threads.scopeIds({ ...p, limit: 1000 })).sort((a, b) => a - b), JSON.stringify(p)).toEqual(want);
          expect(await store.threads.scopeCount({ ...p, limit: 1000 }), JSON.stringify(p)).toBe(want.length);
        }
        expect(await store.threads.scopeIds({ view: "all", limit: 2 })).toHaveLength(2);
        // keyset pages of one walk the whole view, ascending
        const walked: number[] = [];
        for (let after = 0; ; ) {
          const page = await store.threads.scopeIds({ view: "all", categoryId: cat, after, limit: 1 });
          if (page.length === 0) break;
          walked.push(...page);
          after = page[0]!;
        }
        expect(walked).toEqual(await listed({ view: "all", categoryId: cat }));
        expect(await store.threads.scopeCount({ view: "all", limit: 2 })).toBe(2);
      });

      it("bulk scopes: sender scope is received mail only, not filed, not removed, outside spam and trash; counts cap at 1 000", async () => {
        const { store, acct, cat, thread } = await setup();
        const [filed, removed, a, b] = [await thread(), await thread(), await thread(), await thread()];
        await thread({ isSpam: true, inInbox: false });
        await thread({ isTrash: true, inInbox: false });
        await store.categories.add({ categoryId: cat, threadIds: [filed, removed], addedBy: "user", now: NOW });
        await store.categories.remove({ categoryId: cat, threadIds: [removed], reason: "user", now: NOW });
        await ingest(store, [msg({ accountId: acct, from: { name: "Me", email: "me0@example.com" }, isSent: true, to: [{ name: "Uber", email: "uber.receipts@uber.com" }] })]);
        expect((await store.categorize.resolveScope(cat, { kind: "sender", email: "Uber.Receipts@uber.com" }, NOW)).sort()).toEqual([a, b].sort());
        expect(await store.categorize.countScope(cat, { kind: "sender", email: "uber.receipts@uber.com" }, NOW)).toEqual({ count: 2, capped: false });
        expect(await store.categorize.resolveScope(cat, { kind: "sender", email: "me0@example.com" }, NOW)).toEqual([]);
        expect((await store.categorize.resolveScope(cat, { kind: "query", query: termsQuery(["factura"], "Facturas") }, NOW)).sort()).toEqual([a, b].sort());
        for (const query of ["in:trash factura", "in:spam factura"]) expect(await store.categorize.resolveScope(cat, { kind: "query", query }, NOW), query).toEqual([]);
        const many = [];
        for (let i = 0; i < 1003; i++) many.push(msg({ accountId: acct, from: { name: "Morning Brew", email: "crew@morningbrew.com" }, listId: "daily.morningbrew.com" }));
        await ingest(store, many);
        expect(await store.categorize.countScope(cat, { kind: "list", listId: "daily.morningbrew.com" }, NOW)).toEqual({ count: 1000, capped: true });
        expect(await store.categorize.resolveScope(cat, { kind: "list", listId: "Daily.Morningbrew.com" }, NOW)).toHaveLength(1003);
      });
    });

    describe("search outbox", () => {
      async function mailbox() {
        const store = await fresh();
        const [a, b] = await withAccounts(store);
        const replica = await SearchReplica.build(store.feed);
        const inSync = async () => {
          await replica.catchUp(store.feed);
          expect(replica.docs()).toEqual((await store.debug.snapshot()).search);
        };
        return { store, a: a!, b: b!, replica, inSync };
      }
      const batchesSince = async (store: MailStore, from: Revision) => store.feed.changes(from, await store.feed.head(), 1_000);

      it("every command that changes searchable state commits exactly one batch; others commit none", async () => {
        const { store, a, inSync } = await mailbox();
        let head = await store.feed.head();
        const step = async (expected: number, fn: () => Promise<unknown>) => {
          await fn();
          const next = await store.feed.head();
          expect(next.seq - head.seq, String(fn)).toBe(expected);
          head = next;
        };
        await step(1, () => ingest(store, [msg({ accountId: a, providerMsgId: "o1" }), msg({ accountId: a, providerMsgId: "o2" })]));
        const t = await threadOf(store, "o1");
        await step(1, () => store.threads.act({ threadIds: [t], action: "archive", signal: null, now: NOW }));
        await step(0, () => store.threads.act({ threadIds: [t], action: "archive", signal: null, now: NOW }));
        await step(0, () => store.settings.set("app", { theme: "dark" }));
        await step(0, () => store.threads.list({ view: "all", limit: 10 }));
        const cat = await store.categories.create("Viajes", "cyan");
        await step(0, async () => cat);
        await step(1, () => store.categories.add({ categoryId: cat.id, threadIds: [t], addedBy: "user", now: NOW }));
        await inSync();
      });

      it("a command that fails leaves no batch behind (the outbox rolls back with it)", async () => {
        const { store, a, inSync } = await mailbox();
        await ingest(store, [msg({ accountId: a, providerMsgId: "f1" })]);
        const t = await threadOf(store, "f1");
        const head = await store.feed.head();
        await expect(store.categories.add({ categoryId: 987_654, threadIds: [t], addedBy: "user", now: NOW })).rejects.toThrow();
        await expect(store.compose.queueSend({ accountId: 987_654, to: [{ name: "", email: "x@y.com" }], cc: [], bcc: [], subject: "x", bodyText: ".", recordReply: false, now: 0 })).rejects.toThrow();
        expect(await store.feed.head()).toEqual(head);
        await inSync();
      });

      it("bodies, flags, categories and moves reach the feed as absolute projections", async () => {
        const { store, a, replica, inSync } = await mailbox();
        const r = await ingest(store, [msg({ accountId: a, providerMsgId: "b1", bodyText: null, bodyState: "none" })]);
        const t = await threadOf(store, "b1");
        await inSync();
        const from = replica.revision;
        await store.sync.setBody(r.inserted[0]!, "el presupuesto final", null, { now: NOW, classifier: null });
        const [batch] = await batchesSince(store, from);
        expect(batch!.changes).toContainEqual({ kind: "upsertMessage", doc: expect.objectContaining({ messageId: r.inserted[0], body: "el presupuesto final", bodyState: "full" }) });
        await store.sync.updateFlags(a, [{ messageId: r.inserted[0]!, flags: { isRead: true, isStarred: true } }]);
        const [x, y] = [(await store.categories.create("X", "rose")).id, (await store.categories.create("Y", "lime")).id];
        await store.categories.add({ categoryId: x, threadIds: [t], addedBy: "user", now: NOW });
        const m = await store.categories.beginMove({ to: y, threadIds: [t], addedBy: "user", now: NOW, source: "dnd" });
        await store.categories.applyMoveSlice(m.batchId, [t], NOW);
        await store.categories.trainMoveSlice(m.batchId, [t], NOW);
        await inSync();
        expect(replica.threads.get(t)).toMatchObject({ unreadCount: 0, isStarred: true, categoryIds: [y] });
        await store.categories.undoMoveBegin(m.batchId, NOW);
        await store.categories.undoMoveSlice(m.batchId, [t], NOW);
        await store.categories.delete(x);
        await inSync();
        expect(replica.threads.get(t)!.categoryIds).toEqual([]);
      });

      it("a thread merge carries both sides: the dropped thread's tombstone, the survivor and every moved message", async () => {
        const { store, a, replica, inSync } = await mailbox();
        await ingest(store, [msg({ accountId: a, providerMsgId: "mx", rfcMessageId: "mx@x" }), msg({ accountId: a, providerMsgId: "my", rfcMessageId: "my@x" })]);
        const [tx, ty] = [await threadOf(store, "mx"), await threadOf(store, "my")];
        await inSync();
        const from = replica.revision;
        await ingest(store, [msg({ accountId: a, providerMsgId: "bridge", references: ["mx@x", "my@x"] })]);
        const [keep, drop] = [Math.min(tx, ty), Math.max(tx, ty)];
        const changes = (await batchesSince(store, from)).flatMap((b) => b.changes);
        expect(changes).toContainEqual({ kind: "removeThread", threadId: drop });
        expect(changes).toContainEqual({ kind: "upsertThread", doc: expect.objectContaining({ threadId: keep }) });
        const moved = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === (drop === tx ? "mx" : "my"))!.id;
        expect(changes).toContainEqual({ kind: "upsertMessage", doc: expect.objectContaining({ messageId: moved, threadId: keep }) });
        await inSync();
      });

      it("cascades: removing an account tombstones all its messages and threads", async () => {
        const { store, a, b, replica, inSync } = await mailbox();
        await ingest(store, [msg({ accountId: a, providerMsgId: "ca1", rfcMessageId: "ca@x" }), msg({ accountId: a, providerMsgId: "ca2", inReplyTo: "ca@x" }), msg({ accountId: b, providerMsgId: "cb" })]);
        await inSync();
        const doomed = (await store.debug.snapshot()).messages.filter((m) => m.accountId === a);
        const from = replica.revision;
        await store.accounts.remove(a);
        const changes = (await batchesSince(store, from)).flatMap((x) => x.changes);
        for (const m of doomed) expect(changes).toContainEqual({ kind: "removeMessage", messageId: m.id });
        expect(changes).toContainEqual({ kind: "removeThread", threadId: doomed[0]!.threadId });
        await inSync();
        expect([...replica.messages.values()].map((m) => m.accountId)).toEqual([b]);
      });

      it("a replica fed under random operations always equals the store's projection", async () => {
        const { store, a, b, inSync } = await mailbox();
        const cats = [(await store.categories.create("A", "rose")).id, (await store.categories.create("B", "lime")).id];
        let seed = 11;
        const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
        const rfc: string[] = [];
        for (let step = 0; step < 150; step++) {
          const snap = await store.debug.snapshot();
          const threads = snap.threads.map((t) => t.id);
          const r = rand();
          if (r < 0.4 || threads.length === 0) {
            const id = `ro${step}@x`;
            await ingest(store, [msg({ accountId: pick([a, b]), rfcMessageId: id, inReplyTo: rfc.length && rand() < 0.5 ? pick(rfc) : null, bodyText: rand() < 0.3 ? null : `cuerpo ${step}`, bodyState: "full" })]);
            rfc.push(id);
          } else if (r < 0.6) {
            await store.threads.act({ threadIds: [pick(threads)], action: pick(["archive", "trash", "markRead", "star", "moveToInbox"] as const), signal: null, now: NOW });
          } else if (r < 0.75) {
            await store.categories.add({ categoryId: pick(cats), threadIds: [pick(threads)], addedBy: pick(["user", "filter", "bulk"] as const), now: NOW });
          } else if (r < 0.85) {
            await store.categories.remove({ categoryId: pick(cats), threadIds: [pick(threads)], reason: "user", now: NOW });
          } else if (r < 0.93) {
            await store.sync.setBody(pick(snap.messages).id, rand() < 0.2 ? null : `nuevo ${step}`, null, { now: NOW, classifier: null });
          } else {
            await store.sync.remove([pick(snap.messages).id]);
          }
          if (step % 10 === 0) await inSync();
        }
        await inSync();
      });

      it("a build retains the log from its start, so rows written during the scan are repaired", async () => {
        const { store, a } = await mailbox();
        for (let i = 0; i < 5; i++) await ingest(store, [msg({ accountId: a, providerMsgId: `s${i}` })]);
        const build = await store.feed.beginBuild();
        const scanned = new Map<number, SearchMessageDoc>();
        let first = true;
        for await (const page of build.messages()) {
          if (first) {
            // the scan is under way: another write lands
            await ingest(store, [msg({ accountId: a, providerMsgId: "late", subject: "llegó tarde" })]);
            first = false;
          }
          for (const d of page) scanned.set(d.messageId, d);
        }
        const replay = await store.feed.changes(build.from, await store.feed.head(), 100);
        await build.release();
        expect(replay.length).toBeGreaterThan(0);
        for (const b of replay) for (const c of b.changes) if (c.kind === "upsertMessage") scanned.set(c.doc.messageId, c.doc);
        expect([...scanned.values()].sort((x, y) => x.messageId - y.messageId)).toEqual((await store.debug.snapshot()).search.messages);
      });

      it("refuses another epoch, a revision ahead of the head, and batches out of order", async () => {
        const { store, a, replica } = await mailbox();
        await ingest(store, [msg({ accountId: a })]);
        await ingest(store, [msg({ accountId: a })]);
        const head = await store.feed.head();
        await expect(store.feed.changes({ epoch: "someone-else", seq: 0 }, head, 10)).rejects.toMatchObject({ name: "RevisionError", reason: "epoch" });
        await expect(store.feed.changes(head, { ...head, seq: head.seq + 5 }, 10)).rejects.toMatchObject({ name: "RevisionError", reason: "ahead" });
        expect(await store.feed.changes(head, head, 10)).toEqual([]);
        const [first, second] = await store.feed.changes(replica.revision, head, 10);
        expect(() => replica.apply(second!)).toThrow(/gap/);
        expect(replica.apply(first!)).toBe("applied");
        expect(replica.apply(first!)).toBe("duplicate");
        expect(replica.apply(second!)).toBe("applied");
      });

      it("crash recovery: the log and its head survive a reopen and keep growing from there", async () => {
        const box = await mailbox();
        let store = box.store;
        await ingest(store, [msg({ accountId: box.a, providerMsgId: "cr" })]);
        const head = await store.feed.head();
        const log = await store.feed.changes(box.replica.revision, head, 100);
        store = await harness.reopen(store);
        open.push(store);
        expect(await store.feed.head()).toEqual(head);
        expect(await store.feed.changes(box.replica.revision, head, 100)).toEqual(log);
        await ingest(store, [msg({ accountId: box.a, providerMsgId: "cr2" })]);
        expect(await store.feed.head()).toEqual({ ...head, seq: head.seq + 1 });
        await box.replica.catchUp(store.feed);
        expect(box.replica.docs()).toEqual((await store.debug.snapshot()).search);
      });

      it("a write between pages makes the cursor stale: a thread bumped above it can't be skipped silently", async () => {
        const { store, a } = await mailbox();
        for (let i = 0; i < 4; i++) await ingest(store, [msg({ accountId: a, providerMsgId: `fp${i}`, rfcMessageId: `fp${i}@x`, subject: `Factura ${i}`, date: 1_000_000 + i * 1000 })]);
        const first = await store.threads.searchText({ query: "factura", limit: 2, now: NOW });
        expect(first.items.map((t) => t.subject)).toEqual(["Factura 3", "Factura 2"]);
        // a reply bumps the oldest match above the cursor: page 2 at the old revision would omit it
        await ingest(store, [msg({ accountId: a, providerMsgId: "bump", inReplyTo: "fp0@x", subject: "Re: Factura 0", date: 2_000_000 })]);
        await expect(store.threads.searchText({ query: "factura", limit: 2, cursor: first.nextCursor!, now: NOW })).rejects.toBeInstanceOf(StaleCursorError);
        const again = await store.threads.searchText({ query: "factura", limit: 10, now: NOW });
        expect(again.items.map((t) => t.subject)).toEqual(["Factura 0", "Factura 3", "Factura 2", "Factura 1"]);
        // a keyset-only cursor (an older renderer) still pages at the current revision
        const legacy = await store.threads.searchText({ query: "factura", limit: 2, cursor: { lastDate: again.items[1]!.lastDate, id: again.items[1]!.id }, now: NOW });
        expect(legacy.items.map((t) => t.subject)).toEqual(["Factura 2", "Factura 1"]);
      });

      it("searches report the revision they answered at", async () => {
        const { store, a } = await mailbox();
        await ingest(store, [msg({ accountId: a, subject: "Revisión" })]);
        const page = await store.threads.searchText({ query: "revision", limit: 10, now: NOW });
        expect(page.revision).toEqual(await store.feed.head());
        expect(page.complete).toBe(true);
      });
    });

    describe("drafts (v2)", () => {
      const to = [{ name: "Yuki", email: "yuki@example.com", auto: true }];
      it("a new draft is format 2 at revision 1; a reply takes its conversation and mode from the message; everything survives a reopen", async () => {
        let store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "orig", subject: "Propuesta" })]);
        const thread = await threadOf(store, "orig");
        const origId = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === "orig")!.id;
        const fresh1 = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "", bodyText: "hola" }, NOW))!;
        expect(fresh1).toMatchObject({ format: 2, revision: 1, mode: "new", thread_id: null, include_quote: 0, ui_state: "open" });
        const reply = (await store.drafts.save(
          { accountId: a!, to, cc: [], bcc: [{ name: "", email: "jefe@example.com" }], subject: "Re: Propuesta", bodyText: "Sí, va.", quotedText: "> Propuesta", includeQuote: true, inReplyToMessageId: origId, uiState: "collapsed" },
          NOW,
        ))!;
        expect(reply).toMatchObject({ mode: "reply", thread_id: thread, quoted_text: "> Propuesta", include_quote: 1, ui_state: "collapsed" });
        expect(JSON.parse(reply.to_json)).toEqual(to);
        expect(JSON.parse(reply.bcc_json)).toEqual([{ name: "", email: "jefe@example.com" }]);
        store = await harness.reopen(store);
        open.push(store);
        const listed = await store.drafts.list();
        expect(listed.find((d) => d.id === reply.id)).toEqual(reply);
        expect(listed.find((d) => d.id === fresh1.id)).toEqual(fresh1);
      });

      it("an update bumps the revision and keeps what it doesn't mention; an edit from a replaced revision becomes its own draft", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        const d = (await store.drafts.save({ accountId: a!, mode: "forward", forwardOfMessageId: null, to: [], cc: [], subject: "Fwd: x", bodyText: "uno", quotedText: "---- reenviado ----", includeQuote: true }, NOW))!;
        const d2 = (await store.drafts.save({ id: d.id, baseRevision: 1, accountId: a!, to, cc: [], subject: "Fwd: x", bodyText: "uno dos" }, NOW + 1))!;
        expect(d2).toMatchObject({ id: d.id, revision: 2, mode: "forward", quoted_text: "---- reenviado ----", include_quote: 1, body_text: "uno dos" });
        // another writer is at revision 2; an edit made on revision 1 must not overwrite it
        const stale = (await store.drafts.save({ id: d.id, baseRevision: 1, accountId: a!, to: [], cc: [], subject: "Fwd: x", bodyText: "versión vieja" }, NOW + 2))!;
        expect(stale.id).not.toBe(d.id);
        expect(stale).toMatchObject({ revision: 1, format: 2, body_text: "versión vieja" });
        expect((await store.drafts.list()).find((x) => x.id === d.id)!.body_text).toBe("uno dos");
      });

      it("a save for a draft that is gone (sent or discarded) says so instead of bringing it back", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        const d = (await store.drafts.save({ accountId: a!, to, cc: [], subject: "s", bodyText: "b" }, NOW))!;
        await store.drafts.delete(d.id);
        expect(await store.drafts.save({ id: d.id, baseRevision: 1, accountId: a!, to, cc: [], subject: "s", bodyText: "b2" }, NOW)).toBeNull();
        expect(await store.drafts.list()).toEqual([]);
      });

      it("sending a draft deletes it in the same command", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        const d = (await store.drafts.save({ accountId: a!, to, cc: [], subject: "Hola", bodyText: "texto" }, NOW))!;
        await store.compose.queueSend({ accountId: a!, to: [{ name: "Yuki", email: "yuki@example.com" }], cc: [], bcc: [], subject: "Hola", bodyText: "texto", draftId: d.id, recordReply: false, now: NOW });
        expect(await store.drafts.list()).toEqual([]);
      });

      it("a draft is sent once: a second send of the same draft is refused and queues nothing", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        const d = (await store.drafts.save({ accountId: a!, to, cc: [], subject: "Una vez", bodyText: "texto" }, NOW))!;
        const send = { accountId: a!, to: [{ name: "Yuki", email: "yuki@example.com" }], cc: [], bcc: [], subject: "Una vez", bodyText: "texto", draftId: d.id, recordReply: false, now: NOW };
        await store.compose.queueSend(send);
        await expect(store.compose.queueSend(send)).rejects.toThrow(/ya se envió/);
        const sends = (await store.ops.recent(10)).filter((o) => o.kind === "send");
        expect(sends).toHaveLength(1);
      });

      it("a draft whose conversation disappears stays, as an orphan (thread null)", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "gone", subject: "Se irá" })]);
        const m = (await store.debug.snapshot()).messages.find((x) => x.providerMsgId === "gone")!;
        const d = (await store.drafts.save({ accountId: a!, to, cc: [], subject: "Re: Se irá", bodyText: "texto", inReplyToMessageId: m.id }, NOW))!;
        expect(d.thread_id).toBe(m.threadId);
        await store.sync.remove([m.id]);
        expect((await store.debug.snapshot()).threads.find((t) => t.id === m.threadId)).toBeUndefined();
        const after = (await store.drafts.list()).find((x) => x.id === d.id)!;
        expect(after.thread_id).toBeNull();
        expect(after.body_text).toBe("texto");
        // it comes back as a new message, threading ids cleared, so it can be sent
        expect(after).toMatchObject({ mode: "new", in_reply_to_message_id: null, forward_of_message_id: null });
        await store.compose.queueSend({
          accountId: a!,
          to: [{ name: "Yuki", email: "yuki@example.com" }],
          cc: [],
          bcc: [],
          subject: after.subject,
          bodyText: after.body_text,
          inReplyToMessageId: after.in_reply_to_message_id ?? undefined,
          draftId: after.id,
          recordReply: false,
          now: NOW,
        });
        expect(await store.drafts.list()).toEqual([]);
      });

      it("a forward whose original is gone comes back as a new message too", async () => {
        const store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "fwd-src", subject: "Original" })]);
        const m = (await store.debug.snapshot()).messages.find((x) => x.providerMsgId === "fwd-src")!;
        const d = (await store.drafts.save({ accountId: a!, mode: "forward", threadId: m.threadId, forwardOfMessageId: m.id, to: [], cc: [], subject: "Fwd: Original", bodyText: "mira" }, NOW))!;
        await store.sync.remove([m.id]);
        expect((await store.drafts.list()).find((x) => x.id === d.id)).toMatchObject({ mode: "new", thread_id: null, forward_of_message_id: null, body_text: "mira" });
      });
    });

    describe("what settings edit", () => {
      it("an account's name, color, sender name, signature and sync window round-trip, survive a reopen and leave the provider's own config alone", async () => {
        let store = await fresh();
        const [a] = await withAccounts(store, 1);
        expect(await store.accounts.get(a!)).toMatchObject({ displayName: "Account 0", senderName: "Account 0", signature: "", syncWindowDays: null });
        await store.accounts.setProviderConfig(a!, { senderName: "Luis", cursor: { historyId: "42" } });
        const edited = await store.accounts.update(a!, { displayName: "Trabajo", color: "emerald", senderName: "Luis Cordero", signature: "Luis\nAcme Studio", syncWindowDays: 365 });
        expect(edited).toMatchObject({ displayName: "Trabajo", color: "emerald", senderName: "Luis Cordero", signature: "Luis\nAcme Studio", syncWindowDays: 365 });
        store = await harness.reopen(store);
        open.push(store);
        expect((await store.accounts.list())[0]).toMatchObject({ displayName: "Trabajo", color: "emerald", senderName: "Luis Cordero", signature: "Luis\nAcme Studio", syncWindowDays: 365 });
        expect((await store.accounts.config<{ cursor: unknown; senderName: string }>(a!))!.config).toMatchObject({ cursor: { historyId: "42" }, senderName: "Luis Cordero" });
        // the sync cursor and the preferences never overwrite each other, whatever the interleaving
        await Promise.all([store.accounts.setCursor(a!, { historyId: "43" }), store.accounts.update(a!, { signature: "Otra firma" }), store.accounts.setCursor(a!, { historyId: "44" })]);
        expect((await store.accounts.config<{ cursor: unknown; senderName: string }>(a!))!.config).toMatchObject({ cursor: { historyId: "44" }, senderName: "Luis Cordero" });
        expect(await store.accounts.get(a!)).toMatchObject({ signature: "Otra firma", syncWindowDays: 365 });
        await store.accounts.update(a!, { signature: "Luis\nAcme Studio" });
        // null goes back to the general window; an untouched field stays
        expect(await store.accounts.update(a!, { syncWindowDays: null })).toMatchObject({ syncWindowDays: null, signature: "Luis\nAcme Studio", displayName: "Trabajo" });
        expect(await store.accounts.update(9999, { displayName: "x" })).toBeNull();
      });
    });

    describe("portable message references (exports)", () => {
      it("a message's Message-ID and back: the newest copy in that account, any case, with or without <>", async () => {
        const store = await fresh();
        const [a, other] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "m1", rfcMessageId: "<Orig@Example.com>", subject: "Propuesta" })]);
        await ingest(store, [msg({ accountId: other!, providerMsgId: "m2", rfcMessageId: "<orig@example.com>", subject: "Propuesta" })]);
        const snap = await store.debug.snapshot();
        const mine = snap.messages.find((m) => m.providerMsgId === "m1")!;
        expect(await store.drafts.messageRef(mine.id)).toBe("orig@example.com");
        expect(await store.drafts.findMessage(a!, "<ORIG@example.com>")).toEqual({ id: mine.id, threadId: await threadOf(store, "m1") });
        expect(await store.drafts.findMessage(a!, "nobody@example.com")).toBeNull();
        expect(await store.drafts.messageRef(999_999)).toBeNull();
      });
    });

    describe("categories in settings", () => {
      it("reorder sets every position in one unit, keeps unlisted ones after, and survives a reopen", async () => {
        let store = await fresh();
        const ids: number[] = [];
        for (const name of ["Facturas", "Clientes", "Viajes", "Lecturas"]) ids.push((await store.categories.create(name, "indigo")).id);
        const [f, c, v, l] = ids as [number, number, number, number];
        expect((await store.categories.reorder([v, f, 9999])).map((x) => x.name)).toEqual(["Viajes", "Facturas", "Clientes", "Lecturas"]);
        expect((await store.categories.list()).map((x) => x.position)).toEqual([0, 1, 2, 3]);
        await store.categories.reorder([l, c, v, f]);
        await store.categories.update(c, { name: "Clientes VIP", color: "rose" });
        store = await harness.reopen(store);
        open.push(store);
        expect((await store.categories.list()).map((x) => [x.name, x.color])).toEqual([["Lecturas", "indigo"], ["Clientes VIP", "rose"], ["Viajes", "indigo"], ["Facturas", "indigo"]]);
      });
    });

    describe("durability and migrations", () => {
      it("what a command committed survives a reopen", async () => {
        let store = await fresh();
        const [a] = await withAccounts(store);
        await ingest(store, [msg({ accountId: a!, providerMsgId: "keep", subject: "Presupuesto anual" })]);
        const before = await store.debug.snapshot();
        store = await harness.reopen(store);
        open.push(store);
        expect(await store.debug.snapshot()).toEqual(before);
        expect((await store.threads.searchText({ query: "presupuesto", limit: 10, now: NOW })).items).toHaveLength(1);
        await store.debug.verify();
      });

      it.runIf(!!harness.upgraded)("upgrades data written by the previous schema: rows preserved, search consistent", async () => {
        const { store, before } = await harness.upgraded!();
        open.push(store);
        const after = await store.debug.snapshot();
        expect(after.messages).toEqual(before.messages);
        expect(after.threads).toEqual(before.threads);
        expect(after.memberships).toEqual(before.memberships);
        expect(after.examples).toEqual(before.examples);
        expect(after.search).toEqual(before.search);
        await store.debug.verify();
        const word = tokenize(before.messages.find((m) => tokenize(m.bodyText ?? "").length > 3)!.bodyText!)[2]!;
        const hits = await store.threads.searchText({ query: `"${word}"`, limit: 500, now: NOW });
        expect(hits.items.length).toBeGreaterThan(0);
      });
    });
  });
}

/** Rules built from real values in the fixture so they actually match things. */
function generateRules(messages: readonly SnapshotMessage[]): FilterRule[] {
  let seed = 3;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const ops = ["contains", "equals", "startsWith", "endsWith"] as const;
  const rules: FilterRule[] = [];
  for (let i = 0; i < 120; i++) {
    const conditions: FilterRule["conditions"] = [];
    const n = 1 + Math.floor(rand() * 3);
    for (let j = 0; j < n; j++) {
      const m = pick(messages);
      const words = tokenize(m.bodyText ?? "x");
      const start = Math.floor(rand() * Math.max(1, words.length - 2));
      const kind = Math.floor(rand() * 9);
      const negate = rand() < 0.2;
      const op = pick(ops);
      const sub = (s: string) => {
        if (op === "equals") return s;
        if (op === "startsWith") return s.slice(0, Math.max(1, Math.ceil(s.length / 2)));
        if (op === "endsWith") return s.slice(Math.floor(s.length / 2));
        const a = Math.floor(rand() * Math.max(1, s.length - 3));
        return s.slice(a, a + 3 + Math.floor(rand() * 5)) || s;
      };
      switch (kind) {
        case 0:
          conditions.push({ field: "from", op, value: sub(rand() < 0.5 ? m.fromName : m.fromEmail) || "a", negate });
          break;
        case 1:
          conditions.push({ field: "fromDomain", op, value: sub(m.fromEmail.split("@")[1] ?? "x") || "x", negate });
          break;
        case 2:
          conditions.push({ field: "subject", op, value: sub(m.subject).trim() || "re", negate });
          break;
        case 3:
          conditions.push({ field: "body", op, value: words.slice(start, start + 1 + Math.floor(rand() * 3)).join(" ") || "hola", negate });
          break;
        case 4:
          conditions.push({ field: "listId", op, value: sub(m.listId ?? "news.platzi.com") || "news", negate });
          break;
        case 5:
          conditions.push({ field: "recipients", op: "contains", value: sub(m.recipients).trim() || "luis", negate });
          break;
        case 6:
          conditions.push({ field: "hasAttachment", op: "is", value: rand() < 0.5, negate });
          break;
        case 7:
          conditions.push({ field: "ageDays", op: rand() < 0.5 ? "gt" : "lt", value: Math.floor(rand() * 400), negate });
          break;
        default:
          conditions.push({ field: "account", op: "is", value: m.accountId, negate });
      }
    }
    rules.push({ match: rand() < 0.7 ? "all" : "any", conditions, actions: [{ type: "archive" }] });
  }
  // anchored body ops exercise the verification path
  rules.push({ match: "all", conditions: [{ field: "body", op: "startsWith", value: "Hola" }], actions: [{ type: "star" }] });
  rules.push({ match: "all", conditions: [{ field: "body", op: "endsWith", value: "Saludos" }], actions: [{ type: "star" }] });
  const longBody = messages.find((m) => tokenize(m.bodyText ?? "").length > 45)!;
  rules.push({ match: "all", conditions: [{ field: "body", op: "endsWith", value: tokenize(longBody.bodyText!).slice(-40).join(" ") }], actions: [{ type: "star" }] });
  rules.push({ match: "all", conditions: [{ field: "body", op: "equals", value: tokenize(longBody.bodyText!).join(" ").slice(0, 400) }], actions: [{ type: "star" }] });
  return rules;
}
