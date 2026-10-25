/**
 * "Select all N" on the backend: a scope (a view or a search) resolved once,
 * applied in slices with one op per account per slice, progress events,
 * an undo of exactly what changed, no learning signal, and agents kept out.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type Events } from "@terno/core/rpc";
import { createCategory, seedDataset, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 9, 22, 12);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(threads = 900) {
  const dir = mkdtempSync(join(tmpdir(), "terno-scope-"));
  // a tiny slice budget: a few hundred threads already take many slices
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, sliceBudgetMs: 1 });
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

  it("lets the store catch up between slices (its WAL starts over instead of growing through a long job)", async () => {
    const { backend, client } = setup();
    const order: string[] = [];
    const act = backend.store.threads.act.bind(backend.store.threads);
    backend.store.threads.act = (c) => (order.push("act"), act(c));
    const settle = backend.store.settle!.bind(backend.store);
    backend.store.settle = () => (order.push("settle"), settle());
    await client.call("threads.actScope", { scope: { kind: "view", view: "all" }, action: "markRead" });
    expect(order.filter((x) => x === "act").length).toBeGreaterThan(3);
    // never two slices back to back without it
    expect(order.join(" ")).not.toMatch(/act act/);
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

  it("the unread filter: a filtered view or search scope counts, acts on and undoes the unread threads only", async () => {
    const { db, client } = setup(400);
    const unread = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND unread_count > 0"));
    const read = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND unread_count = 0"));
    expect(unread.length).toBeGreaterThan(10);
    expect(read.length).toBeGreaterThan(10);
    const scope = { kind: "view" as const, view: "inbox" as const, unreadOnly: true };
    expect(await client.call("threads.scopeCount", { scope })).toEqual({ count: unread.length, capped: false });
    const r = await client.call("threads.actScope", { scope, action: "archive" });
    expect(r.total).toBe(unread.length);
    // "archive all" in Entrada · No leídos: the read ones stay in the inbox
    expect(ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1"))).toEqual(read);
    await client.call("threads.undo", { undoId: r.undoId! });
    expect(ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND unread_count > 0"))).toEqual(unread);

    // a search: the filter is ANDed with the query, in the list and in the scope alike
    const search = { query: "in:inbox factura" };
    const shown = (await client.call("threads.search", { ...search, unreadOnly: true, limit: 500 })).items;
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((t) => t.unread)).toBe(true);
    const everything = (await client.call("threads.search", { ...search, limit: 500 })).items;
    expect(everything.length).toBeGreaterThan(shown.length);
    expect((await client.call("threads.scopeCount", { scope: { kind: "search", ...search, unreadOnly: true } })).count).toBe(shown.length);
    const starred = () => ids(db.all<{ id: number }>(`SELECT id FROM threads WHERE is_starred = 1 AND id IN (${everything.map((t) => t.id).join(",")})`));
    const before = new Set(starred());
    const marked = await client.call("threads.actScope", { scope: { kind: "search", ...search, unreadOnly: true }, action: "star" });
    expect(marked.total).toBe(shown.length);
    expect(starred().filter((id) => !before.has(id))).toEqual(ids(shown.filter((t) => !before.has(t.id))));
    expect(starred().every((id) => before.has(id) || shown.some((t) => t.id === id))).toBe(true);
    // a query that asks for read mail matches nothing with the filter on
    expect((await client.call("threads.search", { query: "is:read factura", unreadOnly: true })).items).toEqual([]);
    expect(await client.call("threads.scopeCount", { scope: { kind: "search", query: "is:read factura", unreadOnly: true } })).toEqual({ count: 0, capped: false });
  });

  it("a filtered search that matches nothing (is:read) still stops the search it supersedes", async () => {
    const { backend, client } = setup(100);
    const signals: { readonly aborted: boolean }[] = [];
    const search = backend.store.threads.searchText.bind(backend.store.threads);
    backend.store.threads.searchText = async (p) => {
      signals.push(p.signal!);
      // a slow scan: it runs until it's told to stop
      for (let i = 0; i < 200 && !p.signal?.aborted; i++) await new Promise((r) => setTimeout(r, 5));
      return search(p);
    };
    const first = client.call("threads.search", { query: "presupuesto zzqxjv" }).catch(() => null);
    await expect.poll(() => signals.length).toBe(1);
    expect((await client.call("threads.search", { query: "is:read factura", unreadOnly: true })).items).toEqual([]);
    expect(signals[0]!.aborted).toBe(true);
    await first;
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
    expect(await client.call("threads.undo", { undoId: r.undoId! })).toEqual({ restored: wasUnread.length });
    // the threads that were already read stay read
    expect(ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND unread_count > 0"))).toEqual(wasUnread);
    await expect(client.call("threads.undo", { undoId: r.undoId! })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an archive's undo brings back the archived threads; a restore from Papelera goes back to Papelera", async () => {
    const { db, client } = setup(300);
    const inbox = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1"));
    const r = await client.call("threads.actScope", { scope: { kind: "view", view: "inbox" }, action: "archive" });
    await client.call("threads.undo", { undoId: r.undoId! });
    expect(ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1"))).toEqual(inbox);

    const trash = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_trash = 1"));
    expect(trash.length).toBeGreaterThan(0);
    const back = await client.call("threads.actScope", { scope: { kind: "view", view: "trash" }, action: "moveToInbox" });
    expect(db.get("SELECT count(*) AS c FROM threads WHERE in_trash = 1")).toEqual({ c: 0 });
    await client.call("threads.undo", { undoId: back.undoId! });
    expect(ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_trash = 1"))).toEqual(trash);
  });

  describe("undo restores each message as it was", () => {
    type M = { id: number; is_read: number; is_starred: number; in_inbox: number; is_trash: number; is_spam: number };
    const messages = (db: ReturnType<typeof setup>["db"]) => db.all<M>("SELECT id, is_read, is_starred, in_inbox, is_trash, is_spam FROM messages ORDER BY id");

    it("select all of Archivo → Papelera → Deshacer: back in the archive, not the inbox", async () => {
      const { db, client } = setup(300);
      const before = messages(db);
      const archived = db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE in_inbox = 0 AND in_trash = 0 AND in_spam = 0")!.c;
      expect(archived).toBeGreaterThan(10);
      const r = await client.call("threads.actScope", { scope: { kind: "view", view: "archive" }, action: "trash" });
      expect(r.affected).toBe(archived);
      await client.call("threads.undo", { undoId: r.undoId! });
      expect(messages(db)).toEqual(before);
      expect(db.get("SELECT count(*) AS c FROM threads WHERE in_inbox = 0 AND in_trash = 0 AND in_spam = 0")).toEqual({ c: archived });
    });

    it("a loaded selection with mixed read states: mark read, undo, and only the unread ones are unread again", async () => {
      const { db, client } = setup(300);
      const picked = ids(db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 ORDER BY id LIMIT 60"));
      const mixed = db.all<{ thread_id: number }>(`SELECT thread_id FROM messages WHERE thread_id IN (${picked.join(",")}) GROUP BY thread_id HAVING min(is_read) = 0 AND max(is_read) = 1`);
      expect(mixed.length).toBeGreaterThan(0);
      const before = messages(db);
      const r = await client.call("threads.act", { threadIds: picked, action: "markRead" });
      expect(r.undoId).not.toBeNull();
      await client.call("threads.undo", { undoId: r.undoId! });
      expect(messages(db)).toEqual(before);
    });

    it("starred messages come back starred, one by one", async () => {
      const { db, client } = setup(300);
      const starred = ids(db.all<{ id: number }>("SELECT DISTINCT thread_id AS id FROM messages WHERE is_starred = 1 LIMIT 30"));
      expect(starred.length).toBeGreaterThan(0);
      const before = messages(db);
      const r = await client.call("threads.act", { threadIds: starred, action: "unstar" });
      expect(db.get("SELECT count(*) AS c FROM messages WHERE is_starred = 1 AND thread_id IN (" + starred.join(",") + ")")).toEqual({ c: 0 });
      await client.call("threads.undo", { undoId: r.undoId! });
      expect(messages(db)).toEqual(before);
    });
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
    await expect(agent.call("threads.undo", { undoId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
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
    expect(await client.call("threads.act", { threadIds: some, action: "star" })).toMatchObject({ affected: 400 });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(400);
    expect(await client.call("threads.act", { threadIds: some.slice(0, 10), action: "star" })).toEqual({ affected: 0, undoId: null });
  });
});
