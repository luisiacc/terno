import { evaluateRule, termsQuery, tokenize, VIEWS, type FilterRule, type RuleMessage, type ThreadAction } from "@unica/core";
import { generateDataset } from "@unica/mock-data";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MailStore, SnapshotMessage, StoreSnapshot } from "../mail-store";
import type { Cursor } from "../types";
import { ingest, msg, seedThroughCommands, threadOf, withAccounts } from "./fixtures";
import { byRecency, VIEW_TEST, type SearchCorpus } from "./oracle";
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
        expect(await store.threads.act({ threadIds: [t], action: "archive", signal: null, now: NOW })).toEqual({ threadIds: [], opIds: [] });
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

      it("a move commits memberships at once and trains in slices; its undo restores the source", async () => {
        const { store, cat, other, thread } = await setup();
        const [t1, t2] = [await thread(), await thread()];
        await store.categories.add({ categoryId: cat, threadIds: [t1, t2], addedBy: "user", now: NOW });
        const m = await store.categories.beginMove({ from: cat, to: other, threadIds: [t1, t2], addedBy: "user", now: NOW, source: "dnd" });
        expect([m.added.sort(), m.moved.sort()]).toEqual([[t1, t2].sort(), [t1, t2].sort()]);
        expect((await store.debug.snapshot()).memberships.map((x) => x.categoryId)).toEqual([other, other]);
        expect(await store.categories.movePhase(m.batchId)).toBe("training");
        await store.categories.trainMoveSlice(m.batchId, await store.categories.movePending(m.batchId), NOW);
        expect(await store.categories.movePhase(m.batchId)).toBe("done");
        const undo = await store.categories.undoMoveCommit(m.batchId, NOW + 1);
        expect([undo.removed.sort(), undo.restored.sort()]).toEqual([[t1, t2].sort(), [t1, t2].sort()]);
        await store.categories.restoreMoveSlice(m.batchId, await store.categories.movePending(m.batchId));
        const snap = await store.debug.snapshot();
        expect(snap.memberships.map((x) => x.categoryId)).toEqual([cat, cat]);
        expect(snap.examples.map((e) => [e.categoryId, e.label])).toEqual([[cat, 1], [cat, 1]]);
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
