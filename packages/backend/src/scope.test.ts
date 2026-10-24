/**
 * "Select all N" on the backend: a scope (a view or a search) resolved once,
 * applied in slices with one op per account per slice, progress events,
 * an undo of exactly what changed, no learning signal, and agents kept out.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type Events } from "@unica/core/rpc";
import { createCategory, seedDataset, sqlDb } from "@unica/db";
import { demoRegistry } from "@unica/mail";
import { generateDataset } from "@unica/mock-data";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 9, 22, 12);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(threads = 900) {
  const dir = mkdtempSync(join(tmpdir(), "unica-scope-"));
  // a tiny slice budget: a few hundred threads already take many slices
  const backend = new Backend({ dbPath: join(dir, "unica.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, sliceBudgetMs: 1 });
  const connect = (origin: "renderer" | "mcp") => {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: `${origin}-${Math.random()}`, origin });
    return new RpcClient(c);
  };
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const { accountIds } = seedDataset(sqlDb(backend.store), generateDataset({ threads, accounts: 3, seed: 11, now: NOW }), { now: NOW });
  // the seed's own pending ops don't count here
  sqlDb(backend.store).exec("DELETE FROM ops");
  return { backend, db: sqlDb(backend.store), client: connect("renderer"), agent: connect("mcp"), accountIds };
}

/** Counts store commands: a slice is one `store.threads.act`. */
function countActs(backend: Backend) {
  const calls: number[] = [];
  const act = backend.store.threads.act.bind(backend.store.threads);
  backend.store.threads.act = (c) => {
    calls.push(c.threadIds.length);
    return act(c);
  };
  return calls;
}

const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

describe("scope actions", () => {
  it("archives every thread of a view in slices, one op per account per slice, each op only its account's messages", async () => {
    const { backend, db, client } = setup();
    const inbox = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1"));
    expect(inbox.length).toBeGreaterThan(150);
    const calls = countActs(backend);
    const r = await client.call("threads.actScope", { scope: { kind: "view", view: "inbox" }, action: "archive" });
    expect(r).toMatchObject({ affected: inbox.length, total: inbox.length, undoId: expect.any(Number) });
    expect(db.get("SELECT count(*) AS c FROM threads WHERE in_inbox = 1")).toEqual({ c: 0 });
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(inbox.length);
    const ops = db.all<{ account_id: number; target_json: string }>("SELECT account_id, target_json FROM ops WHERE kind = 'archive'");
    // no slice queues two ops for one account
    expect(ops.length).toBeLessThanOrEqual(calls.length * 3);
    const accountOf = new Map(db.all<{ id: number; account_id: number }>("SELECT id, account_id FROM messages").map((m) => [m.id, m.account_id]));
    const targeted: number[] = [];
    for (const op of ops) {
      const { messageIds } = JSON.parse(op.target_json) as { messageIds: number[] };
      expect(new Set(messageIds.map((m) => accountOf.get(m)))).toEqual(new Set([op.account_id]));
      targeted.push(...messageIds);
    }
    // exactly the inbox messages the archive moved, each once
    expect(targeted.length).toBe(new Set(targeted).size);
    expect(targeted.length).toBeGreaterThanOrEqual(inbox.length);
  });

  it("narrows to an account or a category, and to a search, exactly like the list shows them", async () => {
    const { db, client, accountIds } = setup(400);
    const a = accountIds[1]!;
    const cat = createCategory(db, "Proyecto", "rose").id;
    const some = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 ORDER BY id LIMIT 40"));
    await client.call("categories.addThreads", { categoryId: cat, threadIds: some });
    expect(await client.call("threads.scopeCount", { scope: { kind: "view", view: "inbox", accountId: a } })).toEqual({ count: db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE in_inbox = 1 AND account_id = ?", a)!.c, capped: false });
    expect((await client.call("threads.scopeCount", { scope: { kind: "view", view: "all", categoryId: cat } })).count).toBe(40);

    // a search: the scope is every result of the query, across its pages
    const all: number[] = [];
    let cursor: Parameters<typeof client.call<"threads.search">>[1]["cursor"];
    do {
      const page = await client.call("threads.search", { query: "in:inbox factura", cursor, limit: 50 });
      all.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all.length).toBeGreaterThan(0);
    const r = await client.call("threads.actScope", { scope: { kind: "search", query: "in:inbox factura" }, action: "markRead" });
    expect(r.total).toBe(all.length);
    expect(db.get<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE id IN (${all.join(",")}) AND unread_count > 0`)!.c).toBe(0);
  });

  it("a view scope is counted and enumerated from the indexes, never by hydrating list pages", async () => {
    const { backend, db, client } = setup(600);
    const cat = createCategory(db, "Grande", "rose").id;
    const all = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_trash = 0 AND in_spam = 0"));
    await client.call("categories.addThreads", { categoryId: cat, threadIds: all });
    let pages = 0;
    const list = backend.store.threads.list.bind(backend.store.threads);
    backend.store.threads.list = (p) => (pages++, list(p));
    const scope = { kind: "view" as const, view: "all" as const, categoryId: cat };
    expect(await client.call("threads.scopeCount", { scope })).toEqual({ count: all.length, capped: false });
    const r = await client.call("threads.actScope", { scope, action: "star" });
    expect(r.total).toBe(all.length);
    expect(pages).toBe(0);
    expect(db.get("SELECT count(*) AS c FROM threads WHERE in_trash = 0 AND in_spam = 0 AND is_starred = 0")).toEqual({ c: 0 });
  });

  it("undo takes back exactly the threads the action changed, once", async () => {
    const { db, client } = setup(300);
    const inbox = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1"));
    const wasUnread = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND unread_count > 0"));
    expect(wasUnread.length).toBeGreaterThan(0);
    expect(wasUnread.length).toBeLessThan(inbox.length);
    const r = await client.call("threads.actScope", { scope: { kind: "view", view: "inbox" }, action: "markRead" });
    expect(r.affected).toBe(wasUnread.length);
    expect(await client.call("threads.undoScope", { undoId: r.undoId! })).toEqual({ restored: wasUnread.length });
    // the threads that were already read stay read
    expect(ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND unread_count > 0"))).toEqual(wasUnread);
    await expect(client.call("threads.undoScope", { undoId: r.undoId! })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an archive's undo brings back the archived threads; a restore from Papelera goes back to Papelera", async () => {
    const { db, client } = setup(300);
    const inbox = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1"));
    const r = await client.call("threads.actScope", { scope: { kind: "view", view: "inbox" }, action: "archive" });
    await client.call("threads.undoScope", { undoId: r.undoId! });
    expect(ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1"))).toEqual(inbox);

    const trash = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_trash = 1"));
    expect(trash.length).toBeGreaterThan(0);
    const back = await client.call("threads.actScope", { scope: { kind: "view", view: "trash" }, action: "moveToInbox" });
    expect(db.get("SELECT count(*) AS c FROM threads WHERE in_trash = 1")).toEqual({ c: 0 });
    await client.call("threads.undoScope", { undoId: back.undoId! });
    expect(ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_trash = 1"))).toEqual(trash);
  });

  it("reports progress for its job: from 0 to the total, in order", async () => {
    const { client } = setup();
    const events: Events["bulkProgress"][] = [];
    client.on("bulkProgress", (e) => events.push(e));
    const r = await client.call("threads.actScope", { scope: { kind: "view", view: "inbox" }, action: "archive", jobId: "job-1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((e) => e.jobId === "job-1" && e.total === r.total)).toBe(true);
    expect([events[0]!.done, events.at(-1)!.done]).toEqual([0, r.total]);
    const done = events.map((e) => e.done);
    expect(done).toEqual(done.toSorted((a, b) => a - b));
  });

  it("a scope sweep is never a learning signal; the user's own picks are, an agent's are not", async () => {
    const { db, client, agent } = setup(300);
    await client.call("threads.actScope", { scope: { kind: "view", view: "inbox" }, action: "archive" });
    expect(db.get("SELECT count(*) AS c FROM user_actions")).toEqual({ c: 0 });
    const archived = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 0 AND in_trash = 0 AND in_spam = 0 LIMIT 5"));
    await client.call("threads.act", { threadIds: archived.slice(0, 2), action: "trash" });
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM user_actions")!.c).toBe(2);
    await agent.call("threads.act", { threadIds: archived.slice(2), action: "trash" });
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM user_actions")!.c).toBe(2);
  });

  it("agents can't act on scopes: they name the threads they mean", async () => {
    const { agent } = setup(50);
    const scope = { kind: "view" as const, view: "inbox" as const };
    await expect(agent.call("threads.actScope", { scope, action: "trash" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.call("threads.undoScope", { undoId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.call("threads.scopeCount", { scope })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.call("categories.addScope", { categoryId: 1, scope })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("files a whole scope into a category as one undoable batch", async () => {
    const { db, client } = setup(300);
    const cat = createCategory(db, "Todo", "lime").id;
    const inbox = db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE in_inbox = 1")!.c;
    const r = await client.call("categories.addScope", { categoryId: cat, scope: { kind: "view", view: "inbox" } });
    expect(r.added).toBe(inbox);
    expect(db.get("SELECT count(*) AS c FROM thread_categories WHERE category_id = ?", cat)).toEqual({ c: inbox });
    expect(db.get("SELECT DISTINCT added_by FROM thread_categories WHERE category_id = ?", cat)).toEqual({ added_by: "bulk" });
    await client.call("categorize.undo", { batchId: r.batchId! });
    expect(db.get("SELECT count(*) AS c FROM thread_categories WHERE category_id = ?", cat)).toEqual({ c: 0 });
  });

  it("threads.act above 200 ids runs in slices too", async () => {
    const { backend, db, client } = setup(600);
    const some = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE is_starred = 0 LIMIT 400"));
    expect(some).toHaveLength(400);
    const calls = countActs(backend);
    expect(await client.call("threads.act", { threadIds: some, action: "star" })).toEqual({ affected: 400 });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(400);
    expect(await client.call("threads.act", { threadIds: some.slice(0, 10), action: "star" })).toEqual({ affected: 0 });
  });
});
