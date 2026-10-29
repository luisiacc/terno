/**
 * Plan 63 on the backend: a similar scope archived, deleted or spammed in
 * slices with one undo; Spam also catches future mail with a filter that
 * Undo takes back (only while unchanged); stars added mid-sweep win.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, RpcError } from "@terno/core/rpc";
import { proposeLearnedFilters, type SimilarScope } from "@terno/core";
import { sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 9, 22, 12);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(o: { similarCap?: number; similarPage?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-similar-"));
  // a tiny slice budget: a few dozen threads already take several slices
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, sliceBudgetMs: 1, ...o });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: `renderer-${Math.random()}`, origin: "renderer" });
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const [acct] = await withAccounts(backend.store, 1);
  let n = 0;
  const thread = async (over: Partial<Parameters<typeof msg>[0]> = {}) => {
    const m = msg({ accountId: acct!, from: { name: "Uber", email: "receipts@uber.com" }, subject: "Your receipt", date: NOW - 86_400_000 + ++n * 1000, ...over });
    await ingest(backend.store, [m]);
    return threadOf(backend.store, m.providerMsgId!);
  };
  return { backend, db: sqlDb(backend.store), client: new RpcClient(c), acct: acct!, thread };
}

const sender: SimilarScope = { kind: "sender", email: "receipts@uber.com" };
const inInbox = (db: ReturnType<typeof sqlDb>, ids: number[]) => ids.map((id) => db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox);

describe("similar.apply", () => {
  it("archives the scope plus the targets, skipping starred ones that aren't targets; one undo brings all back", async () => {
    const { db, client, thread } = await setup();
    const many: number[] = [];
    for (let i = 0; i < 40; i++) many.push(await thread());
    const starred = await thread({ isStarred: true });
    const target = await thread({ isStarred: true });
    const r = await client.call("similar.apply", { threadIds: [target], scope: sender, action: "archive" });
    expect(r).toMatchObject({ affected: 41, skipped: 1, filter: null, filterFailed: false, undoId: expect.any(Number) });
    expect(inInbox(db, [...many, target])).toEqual(Array(41).fill(0));
    expect(inInbox(db, [starred])).toEqual([1]);
    // a sweep never teaches learned filters
    expect(db.get("SELECT count(*) AS c FROM user_actions")).toEqual({ c: 0 });
    await client.call("similar.undo", { undoId: r.undoId, filterUndo: null });
    expect(inInbox(db, [...many, target])).toEqual(Array(41).fill(1));
  });

  it("spam creates the filter once (its learned key silences the proposal); undo deletes it first, then restores", async () => {
    const { backend, db, client, thread } = await setup();
    const a = await thread();
    const b = await thread();
    const first = await client.call("similar.apply", { threadIds: [a], scope: sender, action: "spam", filterName: "Spam: receipts@uber.com" });
    expect(first.filter).toEqual({ id: expect.any(Number), filterUndo: expect.any(Number) });
    const filters = await backend.store.filters.list();
    expect(filters).toEqual([expect.objectContaining({ name: "Spam: receipts@uber.com", enabled: true, rule: { match: "all", conditions: [{ field: "from", op: "equals", value: "receipts@uber.com" }], actions: [{ type: "spam" }] } })]);
    const actions = Array.from({ length: 6 }, (_, i) => ({ action: "spam" as const, fromEmail: "receipts@uber.com", fromDomain: "uber.com", listId: null, at: NOW - i }));
    expect(proposeLearnedFilters(actions, { now: NOW, excludedKeys: await backend.store.learning.excludedKeys() })).toEqual([]);
    // the same scope again (another thread): the filter is reused, not duplicated, and nothing to undo there
    const c = await thread();
    const again = await client.call("similar.apply", { threadIds: [c], scope: sender, action: "spam" });
    expect(again.filter).toEqual({ id: first.filter!.id, filterUndo: null });
    expect(await backend.store.filters.list()).toHaveLength(1);
    await client.call("similar.undo", { undoId: first.undoId, filterUndo: first.filter!.filterUndo });
    expect(await backend.store.filters.list()).toEqual([]);
    expect(db.all<{ in_spam: number }>("SELECT in_spam FROM threads WHERE id IN (?, ?)", a, b).map((r) => r.in_spam)).toEqual([0, 0]);
  });

  it("concurrent applies make one filter; a disabled identical filter is enabled and Undo disables it again; an edited one is left alone", async () => {
    const { backend, client, thread } = await setup();
    const a = await thread();
    const [x, y] = await Promise.all([
      client.call("similar.apply", { threadIds: [a], scope: sender, action: "spam" }),
      client.call("similar.always", { scope: sender, action: "spam" }),
    ]);
    expect(await backend.store.filters.list()).toHaveLength(1);
    expect([x.filter!.filterUndo, y.filterUndo].filter((u) => u !== null)).toHaveLength(1);
    const f = (await backend.store.filters.list())[0]!;
    await backend.store.filters.save({ ...f, enabled: false }, NOW);
    const on = await client.call("similar.always", { scope: sender, action: "spam" });
    expect(on.filter.enabled).toBe(true);
    await client.call("similar.undo", { undoId: null, filterUndo: on.filterUndo });
    expect((await backend.store.filters.get(f.id))!.enabled).toBe(false);
    // edited after it was made: Undo keeps it
    const domain = await client.call("similar.always", { scope: { kind: "domain", domain: "uber.com" }, action: "archive" });
    await backend.store.filters.save({ ...domain.filter, name: "Mine now" }, NOW);
    await client.call("similar.undo", { undoId: null, filterUndo: domain.filterUndo });
    expect(await backend.store.filters.get(domain.filter.id)).toMatchObject({ name: "Mine now" });
  });

  it("a thread starred while the sweep runs stays (re-read per slice)", async () => {
    const { backend, db, client, thread } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push(await thread());
    const late = ids[ids.length - 1]!; // newest: the last slice (a sweep walks oldest first)
    const act = backend.store.threads.act.bind(backend.store.threads);
    let first = true;
    backend.store.threads.act = async (c) => {
      if (first) {
        first = false;
        db.run("UPDATE threads SET is_starred = 1 WHERE id = ?", late);
      }
      return act(c);
    };
    const r = await client.call("similar.apply", { threadIds: [], scope: sender, action: "archive" });
    expect(r.affected).toBe(59);
    expect(r.skipped).toBe(1);
    expect(inInbox(db, [late])).toEqual([1]);
  });

  it("a failure after some slices still returns their undo; an undo that fails is kept for a retry", async () => {
    const { backend, db, client, thread } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push(await thread());
    const act = backend.store.threads.act.bind(backend.store.threads);
    let calls = 0;
    backend.store.threads.act = async (c) => {
      if (++calls === 3) throw new Error("disk full");
      return act(c);
    };
    const error = await client.call("similar.apply", { threadIds: [], scope: sender, action: "archive" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    const undoId = ((error as RpcError).details as { undoId: number }).undoId;
    expect(undoId).toEqual(expect.any(Number));
    expect(inInbox(db, ids).filter((v) => v === 0).length).toBeGreaterThan(0);
    backend.store.threads.act = act;

    const restore = backend.store.threads.restore.bind(backend.store.threads);
    let failOnce = true;
    backend.store.threads.restore = async (r) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("busy");
      }
      return restore(r);
    };
    await expect(client.call("similar.undo", { undoId, filterUndo: null })).rejects.toThrow();
    await client.call("similar.undo", { undoId, filterUndo: null });
    expect(inInbox(db, ids)).toEqual(Array(60).fill(1));
  });

  it("resolves in pages and refuses a scope past the cap as soon as it passes it, before reading the rest or moving anything", async () => {
    const { backend, db, client, thread } = await setup({ similarCap: 10, similarPage: 4 });
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) ids.push(await thread());
    const pages: (number | null)[] = [];
    const resolvePage = backend.store.similar.resolvePage.bind(backend.store.similar);
    backend.store.similar.resolvePage = (scope, action, targets, before, limit) => {
      pages.push(before);
      return resolvePage(scope, action, targets, before, limit);
    };
    await expect(client.call("similar.apply", { threadIds: [], scope: sender, action: "archive" })).rejects.toThrow();
    // 11 threads need three pages of four messages: never the last five
    expect(pages).toHaveLength(3);
    expect(inInbox(db, ids)).toEqual(Array(30).fill(1));
  });

  it("concurrent sweeps resolve one at a time (their walks never interleave) and all finish", async () => {
    const { backend, db, client, thread } = await setup({ similarPage: 2 });
    const all: number[] = [];
    const senders = Array.from({ length: 9 }, (_, i) => `s${i}@bulk.example`);
    for (const email of senders) for (let i = 0; i < 5; i++) all.push(await thread({ from: { name: email, email } }));
    const order: string[] = [];
    const resolvePage = backend.store.similar.resolvePage.bind(backend.store.similar);
    backend.store.similar.resolvePage = (scope, ...rest) => {
      order.push("email" in scope ? scope.email : "");
      return resolvePage(scope, ...rest);
    };
    const results = await Promise.all(senders.map((email) => client.call("similar.apply", { threadIds: [], scope: { kind: "sender", email }, action: "archive" })));
    expect(results.map((r) => r.affected)).toEqual(Array(9).fill(5));
    expect(inInbox(db, all)).toEqual(Array(all.length).fill(0));
    // each sweep's pages in one run: a sender never comes back after another started
    const runs = order.filter((e, i) => i === 0 || order[i - 1] !== e);
    expect(runs).toHaveLength(9);
  });

  it("a starred-only scope says how many it left out; threads.undo that fails is kept for a retry", async () => {
    const { backend, db, client, thread } = await setup();
    const starred: number[] = [];
    for (let i = 0; i < 12; i++) starred.push(await thread({ isStarred: true }));
    const r = await client.call("similar.apply", { threadIds: [], scope: sender, action: "archive" });
    expect(r).toMatchObject({ affected: 0, skipped: 12, undoId: null });
    expect(inInbox(db, starred)).toEqual(Array(12).fill(1));

    const acted = await client.call("threads.act", { threadIds: starred.slice(0, 3), action: "archive" });
    const restore = backend.store.threads.restore.bind(backend.store.threads);
    let failOnce = true;
    backend.store.threads.restore = async (x) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("busy");
      }
      return restore(x);
    };
    await expect(client.call("threads.undo", { undoId: acted.undoId! })).rejects.toThrow("busy");
    await client.call("threads.undo", { undoId: acted.undoId! });
    expect(inInbox(db, starred)).toEqual(Array(12).fill(1));
  });

  it("threads unstarred between pages move and stop counting as skipped; those still starred are all counted", async () => {
    // 2,001 starred threads read in the first page, unstarred before their second message is read; 5 more stay starred
    const { backend, db, client, acct } = await setup({ similarPage: 2006 });
    const from = { name: "Uber", email: "receipts@uber.com" };
    await ingest(backend.store, Array.from({ length: 2001 }, (_, i) => msg({ accountId: acct, providerThreadId: `x${i}`, from, isStarred: true, date: NOW - 3_000_000 + i })));
    await ingest(backend.store, Array.from({ length: 5 }, (_, i) => msg({ accountId: acct, providerThreadId: `s${i}`, from, isStarred: true, date: NOW - 900_000 + i })));
    await ingest(backend.store, Array.from({ length: 2001 }, (_, i) => msg({ accountId: acct, providerThreadId: `x${i}`, from, date: NOW - 800_000 + i })));
    const unstarred = db.all<{ id: number }>("SELECT id FROM threads WHERE provider_thread_id LIKE 'x%'").map((r) => r.id);
    const resolvePage = backend.store.similar.resolvePage.bind(backend.store.similar);
    backend.store.similar.resolvePage = async (scope, action, targets, cursor, limit) => {
      // between the first page and the second
      if (cursor !== null) db.run(`UPDATE threads SET is_starred = 0 WHERE id IN (${unstarred.join(",")})`);
      return resolvePage(scope, action, targets, cursor, limit);
    };
    const r = await client.call("similar.apply", { threadIds: [], scope: sender, action: "archive" });
    expect(r).toMatchObject({ affected: 2001, skipped: 5 });
  });
});
