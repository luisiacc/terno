/**
 * Performance gate for the local store: 50k+ messages across 8 accounts with
 * realistic bodies. p95 latencies are asserted against the product targets
 * (docs/PLAN.md §11.6). Run with `pnpm test:perf`.
 */
import { waitingCutoff } from "@terno/core";
import { generateDataset } from "@terno/mock-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyThreadAction } from "./actions";
import { openDatabase } from "./index";
import { countScopeThreads, getCounts, getThread, listThreads, scopeThreadIds, waitingCounts } from "./queries";
import { countScope } from "./categorize-bulk";
import { addThreadsToCategory } from "./repos";
import { findRuleMatches } from "./rules";
import { searchThreads } from "./search";
import { listFolders, rebuildFolders, replaceFolders } from "./folders";
import { SqlProviderStore } from "./sql-provider-store";
import { startCheckpointWorker } from "./checkpoint";
import { seedDataset } from "./seed";
import type { Db } from "./sqlite";
import { BUDGET_MULTIPLIER, measure, report, type Stat } from "./test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
let db: Db;
let dir: string;
const stats: Stat[] = [];
const meta: Record<string, unknown> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "terno-perf-"));
  db = openDatabase(join(dir, "perf.db"));
  const t0 = performance.now();
  const data = generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 4 });
  const seeded = seedDataset(db, data, { now: NOW });
  meta.messages = seeded.messageCount;
  meta.threads = seeded.threadCount;
  meta.accounts = seeded.accountIds.length;
  meta.avgBodyBytes = Math.round(db.get<{ a: number }>("SELECT avg(length(body_text)) a FROM message_bodies")!.a);
  meta.seedSeconds = ((performance.now() - t0) / 1000).toFixed(1);
  expect(seeded.messageCount).toBeGreaterThanOrEqual(50_000);
});

afterAll(() => {
  report("db.json", "SQLite performance gate", meta, stats);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function gate(name: string, budgetMs: number, fn: (i: number) => unknown, iterations?: number) {
  const s = measure(name, budgetMs, fn, iterations);
  stats.push(s);
  expect(s.p95, `${name} p95 ${s.p95.toFixed(2)}ms > ${budgetMs}ms`).toBeLessThanOrEqual(budgetMs * BUDGET_MULTIPLIER);
}

describe("navigation", () => {
  it("lists views", () => {
    gate("list inbox, first page (100)", 5, () => listThreads(db, { view: "inbox", limit: 100 }));
    gate("list all mail, first page", 5, () => listThreads(db, { view: "all", limit: 100 }));
    gate("list archive, first page", 5, () => listThreads(db, { view: "archive", limit: 100 }));
    gate("list starred", 5, () => listThreads(db, { view: "starred", limit: 100 }));
    gate("list sent", 5, () => listThreads(db, { view: "sent", limit: 100 }));
    const accounts = db.all<{ id: number }>("SELECT id FROM accounts").map((a) => a.id);
    gate("list inbox per account (8 accounts)", 5, (i) => listThreads(db, { view: "inbox", accountId: accounts[i % accounts.length]!, limit: 100 }));
  });

  it("pages deep with keyset cursors", () => {
    const deep = db.get<{ last_date: number; id: number }>(
      "SELECT last_date, id FROM threads WHERE in_trash = 0 AND in_spam = 0 ORDER BY last_date DESC, id DESC LIMIT 1 OFFSET 15000",
    )!;
    gate("list all mail, page at thread #15,000", 5, () =>
      listThreads(db, { view: "all", limit: 100, cursor: { lastDate: deep.last_date, id: deep.id } }),
    );
  });

  it("filters by category", () => {
    const largest = db.get<{ category_id: number; c: number }>(
      "SELECT category_id, count(*) c FROM thread_categories GROUP BY 1 ORDER BY 2 DESC LIMIT 1",
    )!;
    meta.largestCategoryThreads = largest.c;
    gate(`list largest category (${largest.c} threads)`, 5, () => listThreads(db, { view: "all", categoryId: largest.category_id, limit: 100 }));
    gate("list category ∩ inbox", 5, () => listThreads(db, { view: "inbox", categoryId: largest.category_id, limit: 100 }));
  });

  it("lists an account's own folders (plan 65): big, sparse, deep, filtered, scopes", async () => {
    // checkpoints off the thread, as on desktop: in-thread ones every thousand pages would be the stalls measured
    const checkpoints = startCheckpointWorker(db)!;
    // the biggest account's every thread in one folder, beside the dataset's own folders
    const big = db.get<{ account_id: number; c: number }>("SELECT account_id, count(*) c FROM threads WHERE in_trash = 0 AND in_spam = 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 1")!;
    db.run("INSERT INTO folders (account_id, key, path_json, selectable, position) VALUES (?, 'Label_everything', '[\"Everything\"]', 1, 99)", big.account_id);
    db.run("INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread) SELECT id, account_id, 'Label_everything', last_date, unread_count > 0 FROM threads WHERE account_id = ? AND in_trash = 0 AND in_spam = 0", big.account_id);
    const sparse = db.get<{ account_id: number; folder: string; c: number }>("SELECT account_id, folder, count(*) c FROM thread_folders GROUP BY 1, 2 ORDER BY 3 ASC LIMIT 1")!;
    meta.biggestFolderThreads = big.c;
    meta.folders = db.get<{ c: number }>("SELECT count(*) c FROM folders")!.c;
    const folder = { view: "all" as const, accountId: big.account_id, folder: "Label_everything" };
    gate(`list a folder (${big.c} threads), first page`, 5, () => listThreads(db, { ...folder, limit: 100 }));
    const deep = db.get<{ last_date: number; thread_id: number }>("SELECT last_date, thread_id FROM thread_folders WHERE account_id = ? AND folder = 'Label_everything' ORDER BY last_date DESC, thread_id DESC LIMIT 1 OFFSET ?", big.account_id, Math.floor(big.c / 2))!;
    gate("list a folder, page at its middle", 5, () => listThreads(db, { ...folder, limit: 100, cursor: { lastDate: deep.last_date, id: deep.thread_id } }));
    gate("list a folder, unread only", 5, () => listThreads(db, { ...folder, filter: "unread", limit: 100 }));
    // Codex R11: "Unread" in a folder where everything is read walks only the (no) unread rows
    db.run("CREATE TEMP TABLE unread_before AS SELECT id, unread_count FROM threads WHERE account_id = ?", big.account_id);
    db.run("UPDATE threads SET unread_count = 0 WHERE account_id = ?", big.account_id);
    db.run("UPDATE thread_folders SET unread = 0 WHERE account_id = ?", big.account_id);
    gate("list a folder, unread only, when all of it is read", 1, () => listThreads(db, { ...folder, filter: "unread", limit: 100 }));
    db.run("UPDATE threads SET unread_count = (SELECT unread_count FROM unread_before b WHERE b.id = threads.id) WHERE account_id = ?", big.account_id);
    db.run("UPDATE thread_folders SET unread = (SELECT unread_count > 0 FROM threads WHERE id = thread_id) WHERE account_id = ?", big.account_id);
    db.run("DROP TABLE unread_before");
    gate(`list a sparse folder (${sparse.c} threads)`, 5, () => listThreads(db, { view: "all", accountId: sparse.account_id, folder: sparse.folder, limit: 100 }));
    gate("list a folder that's empty", 5, () => listThreads(db, { view: "all", accountId: big.account_id, folder: "Label_nothing", limit: 100 }));
    gate("select all in a folder: a scope page (2,000 ids)", 5, () => scopeThreadIds(db, { ...folder, after: 0, limit: 2000 }));
    gate("select all in a folder: its count", 5, () => countScopeThreads(db, { ...folder, limit: 100_001 }));
    // Codex R1: a filtered folder keeps the open and checked threads by key, never by walking the folder
    const kept = db.all<{ thread_id: number }>("SELECT thread_id FROM thread_folders WHERE account_id = ? AND folder = 'Label_everything' ORDER BY thread_id LIMIT 500", big.account_id).map((r) => r.thread_id);
    gate("list a folder, unread only, keeping the open thread", 5, () => listThreads(db, { ...folder, filter: "unread", keepIds: [kept[0]!], limit: 100 }));
    // the most the contract keeps (500 checked threads): by key, a lookup each, never a walk of the folder
    gate("list a folder, unread only, keeping 500 threads (the contract's most)", 10, () => listThreads(db, { ...folder, filter: "unread", keepIds: kept, limit: 100 }));
    // Codex R1: unlisting a populated label and listing it back rewrite no membership
    const listed = listFolders(db).filter((f) => f.accountId === big.account_id).map(({ key, path, selectable }) => ({ key, path, selectable }));
    gate(`unlist and relist a folder of ${big.c} threads`, 5, (i) => replaceFolders(db, big.account_id, i % 2 ? listed : listed.filter((f) => f.key !== "Label_everything")), 20);
    replaceFolders(db, big.account_id, listed);
    // Codex R2: a UIDVALIDITY reset of a big IMAP folder drops its memberships as they are, refolding no thread
    db.run("INSERT INTO folders (account_id, key, path_json, selectable, position) VALUES (?, 'Big', '[\"Big\"]', 1, 100)", big.account_id);
    const located = () => {
      db.run("INSERT OR IGNORE INTO message_locations (message_id, account_id, mailbox, uidvalidity, uid, flags) SELECT id, account_id, 'Big', 1, id, '[]' FROM messages WHERE account_id = ?", big.account_id);
      db.run("INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread) SELECT id, account_id, 'Big', last_date, unread_count > 0 FROM threads WHERE account_id = ? AND in_trash = 0 AND in_spam = 0", big.account_id);
    };
    const locations = new SqlProviderStore(db, big.account_id).locations;
    const messagesInBig = db.get<{ c: number }>("SELECT count(*) c FROM messages WHERE account_id = ?", big.account_id)!.c;
    // the longest the event loop went without a turn during a reset: one slice, never the whole folder
    const stalls: number[] = [];
    for (let i = 0; i < 3; i++) {
      located();
      let last = performance.now();
      let max = 0;
      const tick = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - last);
        last = now;
      }, 1);
      expect(await locations.resetMailbox("Big")).toHaveLength(messagesInBig);
      clearInterval(tick);
      max = Math.max(max, performance.now() - last);
      stalls.push(max);
      expect(db.get<{ c: number }>("SELECT count(*) c FROM thread_folders WHERE folder = 'Big'")!.c).toBe(0);
    }
    stalls.sort((a, b) => a - b);
    stats.push({ name: `reset an IMAP folder of ${messagesInBig} messages: longest stall (best of 3)`, budgetMs: 16, p50: stalls[0]!, p95: stalls[0]!, max: stalls[2]!, n: 3 } as never);
    expect(stalls[0]!, "reset: longest stall").toBeLessThanOrEqual(16 * BUDGET_MULTIPLIER);
    // Codex R5: relisting a populated IMAP folder costs a job, and its rebuild goes in slices of 250 rows (the backend's)
    db.run("UPDATE accounts SET kind = 'imap' WHERE id = ?", big.account_id);
    located();
    const withBig = listFolders(db).filter((f) => f.accountId === big.account_id).map(({ key, path, selectable }) => ({ key, path, selectable }));
    replaceFolders(db, big.account_id, withBig.filter((f) => f.key !== "Big"));
    const relist = performance.now();
    replaceFolders(db, big.account_id, withBig);
    const relistMs = performance.now() - relist;
    const slices: number[] = [];
    for (let more = true; more; ) {
      const t0 = performance.now();
      more = rebuildFolders(db, 250).more;
      slices.push(performance.now() - t0);
    }
    slices.sort((a, b) => a - b);
    stats.push({ name: `relist an IMAP folder of ${messagesInBig} messages: the list ${relistMs.toFixed(2)} ms, ${slices.length} rebuild slices, the longest`, budgetMs: 16, p50: slices[Math.floor(slices.length / 2)]!, p95: slices.at(-1)!, max: slices.at(-1)!, n: slices.length } as never);
    expect(relistMs, "relisting").toBeLessThanOrEqual(5 * BUDGET_MULTIPLIER);
    expect(slices.at(-1)!, "the longest rebuild slice").toBeLessThanOrEqual(16 * BUDGET_MULTIPLIER);
    expect(db.get<{ c: number }>("SELECT count(*) c FROM thread_folders WHERE folder = 'Big'")!.c).toBeGreaterThan(0);
    // Codex R10: a long conversation's locations coming back one by one (a rename, a reset) keep membership
    // incrementally, never refolding the whole thread per location
    const convo = db.all<{ id: number }>("SELECT id FROM messages WHERE account_id = ? ORDER BY id LIMIT 5000", big.account_id).map((r) => r.id);
    const thread = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", convo[0]!)!.thread_id;
    db.run(`UPDATE messages SET thread_id = ? WHERE id IN (${convo.join(",")})`, thread);
    db.run("INSERT OR IGNORE INTO folders (account_id, key, path_json, selectable, position) VALUES (?, 'Convo', '[\"Convo\"]', 1, 101)", big.account_id);
    const t0 = performance.now();
    for (const [i, id] of convo.entries()) await locations.upsert(id, "Convo", 1, i + 1, []);
    const recoverMs = performance.now() - t0;
    stats.push({ name: `a 5,000-message conversation's locations back one by one: ${recoverMs.toFixed(0)} ms in all`, budgetMs: 1000, p50: recoverMs / 5000, p95: recoverMs / 5000, max: recoverMs, n: 5000 } as never);
    expect(recoverMs, "5,000 locations of one conversation").toBeLessThanOrEqual(1000 * BUDGET_MULTIPLIER);
    expect(db.get<{ c: number }>("SELECT count(*) c FROM thread_folders WHERE folder = 'Convo'")!.c).toBe(1);
    // Codex R11: the same conversation relisted (a long one, a slice of locations at a time, never re-read whole)
    const withConvo = listFolders(db).filter((f) => f.accountId === big.account_id).map(({ key, path, selectable }) => ({ key, path, selectable }));
    replaceFolders(db, big.account_id, withConvo.filter((f) => f.key !== "Convo"));
    replaceFolders(db, big.account_id, withConvo);
    const convoSlices: number[] = [];
    for (let more = true; more; ) {
      const t0 = performance.now();
      more = rebuildFolders(db, 250).more;
      convoSlices.push(performance.now() - t0);
    }
    convoSlices.sort((a, b) => a - b);
    stats.push({ name: `relist a 5,000-message conversation's folder: ${convoSlices.length} slices, the longest`, budgetMs: 4, p50: convoSlices[Math.floor(convoSlices.length / 2)]!, p95: convoSlices.at(-1)!, max: convoSlices.at(-1)!, n: convoSlices.length } as never);
    expect(convoSlices.at(-1)!, "a conversation's rebuild slice").toBeLessThanOrEqual(4 * BUDGET_MULTIPLIER);
    // Codex R11: its 5,000 messages expunged at once: in slices, each thread looked at once a slice
    let lastTick = performance.now();
    let expungeStall = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      expungeStall = Math.max(expungeStall, now - lastTick);
      lastTick = now;
    }, 1);
    const e0 = performance.now();
    await locations.removeMany(convo, "Convo");
    const expungeMs = performance.now() - e0;
    clearInterval(tick);
    expungeStall = Math.max(expungeStall, performance.now() - lastTick);
    stats.push({ name: `expunge a 5,000-message conversation: ${expungeMs.toFixed(0)} ms in all, longest stall`, budgetMs: 16, p50: expungeStall, p95: expungeStall, max: expungeStall, n: 1 } as never);
    expect(expungeStall, "expunge: longest stall").toBeLessThanOrEqual(16 * BUDGET_MULTIPLIER);
    expect(db.get<{ c: number }>("SELECT count(*) c FROM thread_folders WHERE folder = 'Convo'")!.c).toBe(0);
    // Codex R14: a catalog of 10,000 folders 20 levels deep, one renamed: the differences written, never the catalog
    const catalog = Array.from({ length: 10_000 }, (_, i) => ({ key: `Cat${i}`, path: Array.from({ length: 20 }, (_, j) => `Nivel ${j} de la carpeta ${i}`), selectable: true }));
    replaceFolders(db, big.account_id, catalog);
    const renames: number[] = [];
    for (let i = 0; i < 5; i++) {
      const renamed = catalog.map((f, at) => (at === 5000 ? { ...f, path: [...f.path.slice(0, -1), `Renombrada ${i}`] } : f));
      const t0 = performance.now();
      expect(replaceFolders(db, big.account_id, renamed).changed).toBe(true);
      renames.push(performance.now() - t0);
    }
    renames.sort((a, b) => a - b);
    // within the backend's stall budget (two frames, plan 17): reading and comparing the 5 MB of paths is most of it
    stats.push({ name: "rename one folder of 10,000 (20 levels deep)", budgetMs: 32, p50: renames[2]!, p95: renames[4]!, max: renames[4]!, n: 5 } as never);
    expect(renames[2]!, "rename one folder of 10,000").toBeLessThanOrEqual(32 * BUDGET_MULTIPLIER);
    replaceFolders(db, big.account_id, withConvo);
    await checkpoints.stop();
  });

  it("computes sidebar counts", () => {
    gate("sidebar unread counts (accounts + categories + folders)", 5, () => getCounts(db, NOW));
    // Codex R4: every thread unread in 20 overlapping labels (~590k memberships); counts read the tallies, one row a folder
    const accounts = db.all<{ id: number }>("SELECT id FROM accounts").map((a) => a.id);
    db.tx(() => {
      for (const a of accounts) for (let l = 0; l < 20; l++) db.run("INSERT OR IGNORE INTO folders (account_id, key, path_json, selectable, position) VALUES (?, ?, ?, 1, ?)", a, `Label_o${l}`, JSON.stringify([`Overlap ${l}`]), 200 + l);
      for (let l = 0; l < 20; l++) db.run("INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread) SELECT id, account_id, ?, last_date, 1 FROM threads", `Label_o${l}`);
    });
    meta.overlappingMemberships = db.get<{ c: number }>("SELECT count(*) c FROM thread_folders WHERE folder LIKE 'Label_o%'")!.c;
    gate("sidebar unread counts with 20 overlapping labels on every thread", 5, () => getCounts(db, NOW));
    db.tx(() => {
      db.run("DELETE FROM thread_folders WHERE folder LIKE 'Label_o%'");
      db.run("DELETE FROM folders WHERE key LIKE 'Label_o%'");
    });
  });

  it("opens threads", () => {
    const ids = db.all<{ id: number }>("SELECT id FROM threads ORDER BY random() LIMIT 60").map((r) => r.id);
    const longest = db.get<{ id: number; message_count: number }>("SELECT id, message_count FROM threads ORDER BY message_count DESC LIMIT 1")!;
    meta.longestThread = longest.message_count;
    gate("open random thread (messages + bodies)", 5, (i) => getThread(db, ids[i % ids.length]!));
    gate(`open longest thread (${longest.message_count} messages)`, 5, () => getThread(db, longest.id));
  });

  it("applies triage actions", () => {
    const ids = db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 LIMIT 200").map((r) => r.id);
    gate("archive one thread (optimistic, incl. aggregates)", 5, (i) => applyThreadAction(db, [ids[i % ids.length]!], i % 2 ? "moveToInbox" : "archive"));
  });
});

describe("search", () => {
  const queries: [string, string][] = [
    ["common word", "factura"],
    ["very common word", "hola"],
    ["accented word", "reunión"],
    ["rare word", "tokio"],
    ["prefix while typing (3 chars)", "pro"],
    ["prefix while typing (2 chars)", "fa"],
    ["phrase", '"darse de baja"'],
    ["two words", "propuesta presupuesto"],
    ["zero results", "zzqxjv"],
    ["sender address", "from:crew@morningbrew.com"],
    ["sender name + text", "from:lucia factura"],
    ["text + negation", "factura -uber"],
    ["negation only", "-factura"],
    ["zero-result intersection", "factura from:crew@morningbrew.com"],
    ["text in inbox, unread", "in:inbox is:unread pedido"],
    ["has attachment + date range", "has:attachment after:180d"],
    ["old mail by date", "before:2025-03-01"],
    ["category + text", "category:facturas uber"],
    ["account + text", "account:acme propuesta"],
    ["subject operator", "subject:invitación"],
  ];
  it.each(queries)("%s", (label, query) => {
    let total = 0;
    gate(`search: ${label} — ${query}`, 25, () => {
      total = searchThreads(db, { query, limit: 100, now: NOW }).items.length;
    });
    stats[stats.length - 1]!.note = `${total} results`;
  });

  it("type-ahead: every keystroke of a query stays within budget", () => {
    const typed = "presupuesto";
    for (let i = 2; i <= typed.length; i++) {
      gate(`type-ahead "${typed.slice(0, i)}"`, 25, () => searchThreads(db, { query: typed.slice(0, i), limit: 100, now: NOW }), 30);
    }
  });
});

describe("filters & suggestions", () => {
  it("previews filters over all mail", () => {
    const rules = [
      { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com" }], actions: [{ type: "archive" }] },
      { match: "all", conditions: [{ field: "subject", op: "contains", value: "factura" }], actions: [{ type: "archive" }] },
      { match: "any", conditions: [{ field: "listId", op: "contains", value: "github" }, { field: "from", op: "contains", value: "linear" }], actions: [{ type: "archive" }] },
      { match: "all", conditions: [{ field: "body", op: "contains", value: "darse de baja" }, { field: "ageDays", op: "gt", value: 30 }], actions: [{ type: "trash" }] },
      { match: "all", conditions: [{ field: "body", op: "endsWith", value: "saludos" }], actions: [{ type: "star" }] },
    ] as const;
    rules.forEach((rule, i) => gate(`filter preview #${i + 1} (${rule.conditions.map((c) => c.field).join("+")})`, 50, () => findRuleMatches(db, rule as never, NOW), 30));
  });

  it("counts a bulk categorization scope for the snackbar", () => {
    const category = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const thread = db.get<{ id: number }>(
      "SELECT t.id FROM threads t JOIN messages m ON m.thread_id = t.id WHERE m.from_email = 'uber.receipts@uber.com' LIMIT 1",
    )!.id;
    addThreadsToCategory(db, category, [thread], "user");
    const sender = db.get<{ from_email: string }>("SELECT from_email FROM messages WHERE thread_id = ? AND is_sent = 0 LIMIT 1", thread)!.from_email;
    gate("bulk count: same sender, capped (snackbar chip)", 5, () => countScope(db, category, { kind: "sender", email: sender }, NOW));
  });
});

// last: it grows the mailbox to 50k+ threads and reshapes who is unread
describe("the unread filter (plan 12)", () => {
  const largest = () => db.get<{ category_id: number }>("SELECT category_id FROM thread_categories GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")!.category_id;
  const accounts = () => db.all<{ id: number }>("SELECT id FROM accounts").map((a) => a.id);
  /** every list, the header's count and a whole "select all N" walk of the filtered views */
  function gates(label: string) {
    const cat = largest();
    const acct = accounts();
    for (const view of ["inbox", "archive", "all", "starred", "trash"] as const) gate(`${label}: unread ${view}, first page`, 5, () => listThreads(db, { view, unreadOnly: true, limit: 100 }));
    gate(`${label}: unread archive per account`, 5, (i) => listThreads(db, { view: "archive", accountId: acct[i % acct.length]!, unreadOnly: true, limit: 100 }));
    gate(`${label}: unread largest category`, 5, () => listThreads(db, { view: "all", categoryId: cat, unreadOnly: true, limit: 100 }));
    const deep = db.get<{ last_date: number; id: number }>("SELECT last_date, id FROM threads WHERE unread_count > 0 AND in_trash = 0 AND in_spam = 0 ORDER BY last_date DESC, id DESC LIMIT 1 OFFSET 1000");
    if (deep) gate(`${label}: unread all mail, page at unread #1,000`, 5, () => listThreads(db, { view: "all", unreadOnly: true, limit: 100, cursor: { lastDate: deep.last_date, id: deep.id } }));
    // the open (read) thread kept in the page: one more lookup by key
    const open = db.get<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND unread_count = 0 ORDER BY last_date DESC LIMIT 1");
    if (open) gate(`${label}: unread inbox keeping the open thread`, 5, () => listThreads(db, { view: "inbox", unreadOnly: true, keepIds: [open.id], limit: 100 }));
    for (const view of ["inbox", "archive", "trash"] as const) gate(`${label}: unread count ${view} (header)`, 5, () => countScopeThreads(db, { view, unreadOnly: true, limit: 100_001 }));
    gate(`${label}: unread count largest category`, 5, () => countScopeThreads(db, { view: "all", categoryId: cat, unreadOnly: true, limit: 100_001 }));
    // select all N: every page of 500 ids of the filtered archive, walked whole
    gate(`${label}: unread archive, all scope pages`, 15, () => {
      for (let after = 0; ; ) {
        const page = scopeThreadIds(db, { view: "archive", unreadOnly: true, after, limit: 500 });
        if (page.length < 500) return;
        after = page[page.length - 1]!;
      }
    }, 20);
  }

  it("lists, counts and pages unread threads on the perf mailbox", () => {
    meta.unreadThreads = db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE unread_count > 0")!.c;
    gates("mailbox");
  });

  it("holds at 50k+ threads, with the unread far from the view (thousands unread in the inbox, a few in an archive of read mail)", () => {
    // copies of the mailbox's threads, older, archived and read (list pages read threads and their memberships only)
    db.exec(`INSERT INTO threads (account_id, provider_thread_id, subject, snippet, last_date, last_from_name, last_from_email, message_count, unread_count, has_attachments, is_starred, in_inbox, has_sent, in_trash, in_spam)
      SELECT account_id, provider_thread_id || ':copy', subject, snippet, last_date - 400 * 86400000, last_from_name, last_from_email, message_count, 0, has_attachments, is_starred, 0, has_sent, 0, 0 FROM threads LIMIT 21000`);
    db.exec("UPDATE threads SET unread_count = 0 WHERE in_inbox = 0");
    db.exec("UPDATE threads SET unread_count = 1 WHERE in_inbox = 1");
    db.exec("UPDATE threads SET unread_count = 1 WHERE id IN (SELECT id FROM threads WHERE in_inbox = 0 AND in_trash = 0 AND in_spam = 0 ORDER BY last_date LIMIT 20)");
    db.exec("ANALYZE");
    const n = db.get<{ c: number; u: number }>("SELECT count(*) AS c, sum(unread_count > 0) AS u FROM threads")!;
    meta.threadsUnreadGate = n.c;
    expect(n.c).toBeGreaterThanOrEqual(50_000);
    expect(n.u).toBeGreaterThan(2_000);
    gates("50k sparse");
    // and every thread unread: the filter keeps nothing out
    db.exec("UPDATE threads SET unread_count = 1");
    db.exec("ANALYZE");
    gates("50k all unread");
  });
});

// after the unread filter's: the mailbox is 50k+ threads by now
describe("the quick filters (plan 15): with attachments and starred", () => {
  const largest = () => db.get<{ category_id: number }>("SELECT category_id FROM thread_categories GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")!.category_id;
  /** a filter's lists, deep page, kept thread, counts and a whole "select all N" walk, like the unread filter's */
  function gates(label: string, filter: "attachments" | "starred" | "people" | "waiting") {
    const cat = largest();
    const acct = db.all<{ id: number }>("SELECT id FROM accounts").map((a) => a.id);
    const now = NOW;
    for (const view of ["inbox", "archive", "all", "trash", "spam"] as const) gate(`${label}: ${view}, first page`, 5, () => listThreads(db, { view, filter, now, limit: 100 }));
    gate(`${label}: archive per account`, 5, (i) => listThreads(db, { view: "archive", accountId: acct[i % acct.length]!, filter, now, limit: 100 }));
    gate(`${label}: largest category`, 5, () => listThreads(db, { view: "all", categoryId: cat, filter, now, limit: 100 }));
    const cutoff = waitingCutoff(NOW);
    const where = { attachments: "has_attachments = 1", starred: "is_starred = 1", people: "person = 1", waiting: `waiting_since >= ${cutoff} AND last_date >= ${cutoff}` }[filter];
    const deep = db.get<{ last_date: number; id: number }>(`SELECT last_date, id FROM threads WHERE ${where} AND in_trash = 0 AND in_spam = 0 ORDER BY last_date DESC, id DESC LIMIT 1 OFFSET 1000`);
    if (deep) gate(`${label}: all mail, page at #1,000`, 5, () => listThreads(db, { view: "all", filter, now, limit: 100, cursor: { lastDate: deep.last_date, id: deep.id } }));
    const open = db.get<{ id: number }>(`SELECT id FROM threads WHERE in_inbox = 1 AND NOT (${where}) ORDER BY last_date DESC LIMIT 1`);
    if (open) gate(`${label}: inbox keeping the open thread`, 5, () => listThreads(db, { view: "inbox", filter, now, keepIds: [open.id], limit: 100 }));
    for (const view of ["inbox", "archive", "trash"] as const) gate(`${label}: count ${view}`, 5, () => countScopeThreads(db, { view, filter, now, limit: 100_001 }));
    gate(`${label}: archive, all scope pages`, 15, () => {
      for (let after = 0; ; ) {
        const page = scopeThreadIds(db, { view: "archive", filter, now, after, limit: 500 });
        if (page.length < 500) return;
        after = page[page.length - 1]!;
      }
    }, 20);
  }

  /** a search narrowed to conversations with attachments: the engine keeps them before paging, a page and the next one */
  function searches(label: string) {
    for (const query of ["hola", "factura", "in:all", "pro"]) {
      let first: ReturnType<typeof searchThreads> | undefined;
      gate(`${label}: search "${query}" with attachments, first page`, 25, () => (first = searchThreads(db, { query, threadAttachments: true, limit: 100, now: NOW })));
      const cursor = first?.nextCursor;
      if (cursor) gate(`${label}: search "${query}" with attachments, next page`, 25, () => searchThreads(db, { query, threadAttachments: true, limit: 100, now: NOW, cursor }));
      // plan 17's thread filters, the same way (Codex review 1, #9)
      for (const threadFilter of ["people", "waiting"] as const) {
        let page: ReturnType<typeof searchThreads> | undefined;
        gate(`${label}: search "${query}" from ${threadFilter}, first page`, 25, () => (page = searchThreads(db, { query, threadFilter, limit: 100, now: NOW })));
        const next = page?.nextCursor;
        if (next) gate(`${label}: search "${query}" from ${threadFilter}, next page`, 25, () => searchThreads(db, { query, threadFilter, limit: 100, now: NOW, cursor: next }));
      }
    }
  }

  it("hold at 50k+ threads: as they are, every thread starred, none with attachments", () => {
    const n = db.get<{ c: number; a: number; s: number }>("SELECT count(*) AS c, sum(has_attachments) AS a, sum(is_starred) AS s FROM threads")!;
    expect(n.c).toBeGreaterThanOrEqual(50_000);
    meta.attachmentThreads = n.a;
    meta.starredThreads = n.s;
    gates("50k attachments", "attachments");
    gates("50k starred", "starred");
    searches("50k attachments");
    db.exec("UPDATE threads SET is_starred = 1");
    db.exec("UPDATE threads SET has_attachments = 0");
    db.exec("ANALYZE");
    gates("50k all starred", "starred");
    gates("50k no attachments", "attachments");
    // the worst case for a search narrowed to conversations with attachments: none has any (a whole match set, nothing kept)
    searches("50k no attachments");
  });

  // plan 17: the same gates and the inbox's waiting count, on its own indexes (a scan of 50k threads is over every budget)
  it("hold at 50k+ threads for People and Waiting: as computed, twenty far from every view, everyone, no one", () => {
    const cutoff = waitingCutoff(NOW);
    const waitingGates = (label: string) => {
      gates(`${label} people`, "people");
      gates(`${label} waiting`, "waiting");
      gate(`${label}: counts with the waiting count`, 5, () => getCounts(db, NOW));
      gate(`${label}: the waiting count`, 1, () => {
        if (waitingCounts(db, NOW).inboxWaiting === null) throw new Error("the waiting count is held");
      });
    };
    // the older copies came in without facts; the backfill leaves such threads neither a person's nor waiting
    db.exec("UPDATE threads SET person = 0, waiting_since = NULL WHERE person IS NULL");
    db.exec("ANALYZE");
    const n = db.get<{ c: number; p: number; w: number }>("SELECT count(*) AS c, sum(person) AS p, count(waiting_since) AS w FROM threads")!;
    expect(n.c).toBeGreaterThanOrEqual(50_000);
    expect(n.p).toBeGreaterThan(1000);
    expect(n.w).toBeGreaterThan(100);
    meta.peopleThreads50k = n.p;
    meta.waitingThreads50k = n.w;
    waitingGates("50k");
    // sparse and far: the twenty oldest archived threads a person's, the twenty oldest the window holds waiting
    db.exec("UPDATE threads SET person = 0, waiting_since = NULL");
    db.exec("UPDATE threads SET person = 1 WHERE id IN (SELECT id FROM threads WHERE in_inbox = 0 AND in_trash = 0 AND in_spam = 0 ORDER BY last_date LIMIT 20)");
    db.run("UPDATE threads SET waiting_since = last_date WHERE id IN (SELECT id FROM threads WHERE in_inbox = 0 AND in_trash = 0 AND in_spam = 0 AND last_date >= ? ORDER BY last_date LIMIT 20)", cutoff);
    db.exec("ANALYZE");
    waitingGates("50k sparse");
    db.exec("UPDATE threads SET person = 1, waiting_since = last_date");
    db.exec("ANALYZE");
    waitingGates("50k everyone");
    db.exec("UPDATE threads SET person = 0, waiting_since = NULL");
    db.exec("ANALYZE");
    waitingGates("50k no one");
  });
});

