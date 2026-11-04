/**
 * Plans 89–91 on the 50k-message perf mailbox, with one sender that sent a
 * third of it under a numbered subject ("Tu pedido N está en camino") and
 * another third under other subjects.
 *
 * What the user waits for (the snackbar's offers, a pattern checked as it's
 * typed) holds a frame. What runs behind them (the group's move, a pattern
 * filter over all mail, filters at ingest) never stalls the event loop past
 * the slicer's budget, keeps lists fast, and stays within a bounded heap.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { checkPattern } from "@terno/core";
import type { IncomingMessage } from "@terno/store";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { seedDataset, sqlDb, type SqlMailStore } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";
import { sampleAsync, settle, watchLoop, type Sample } from "../../db/src/test/timing";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const SHOP = "pedidos@shop.example";
const FRAME = 16;
const stats: Stat[] = [];
const meta: Record<string, unknown> = {};
let dir: string;
let backend: Backend;
let client: RpcClient;
let target: number;
let account: number;
let category: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terno-offersperf-"));
  backend = new Backend({ dbPath: join(dir, "perf.db"), version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, instantSearch: true });
  await backend.store.ready;
  seedDataset(sqlDb(backend.store), generateDataset({ threads: 20_000, accounts: 8, seed: 86, now: NOW, bodyScale: 3 }), { now: NOW });
  const db = sqlDb(backend.store);
  // a third of all received mail: one shop, one numbered subject; another third: the same shop, other subjects
  db.exec(`UPDATE messages SET from_email = '${SHOP}', from_domain = 'shop.example', from_name = 'Shop', from_name_norm = 'shop',
             subject = 'Tu pedido ' || id || ' está en camino', subject_norm = 'tu pedido ' || id || ' esta en camino' WHERE is_sent = 0 AND thread_id % 3 = 0`);
  db.exec(`UPDATE messages SET from_email = '${SHOP}', from_domain = 'shop.example', from_name = 'Shop', from_name_norm = 'shop',
             subject = 'Factura ' || id, subject_norm = 'factura ' || id WHERE is_sent = 0 AND thread_id % 3 = 1`);
  db.exec("UPDATE threads SET person = 0");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(await (backend.store as SqlMailStore).instant!.settled()).toBe(true);
  meta.messages = db.get<{ c: number }>("SELECT count(*) c FROM messages")!.c;
  meta.shopMessages = db.get<{ c: number }>("SELECT count(*) c FROM messages WHERE from_email = ?", SHOP)!.c;
  target = db.get<{ id: number }>("SELECT thread_id id FROM messages WHERE from_email = ? AND subject LIKE 'Tu pedido%' AND is_sent = 0 ORDER BY id DESC LIMIT 1", SHOP)!.id;
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: "perf", origin: "renderer" });
  client = new RpcClient(c);
  category = (await client.call("categories.create", { name: "Pedidos", color: "amber" })).id;
  account = db.get<{ id: number }>("SELECT account_id id FROM threads WHERE id = ?", target)!.id;
  await backend.store.folders.replace(account, [{ key: "Label_Perf", path: ["Perf"], selectable: true }]);
  await client.call("categories.moveThreads", { to: category, threadIds: [target], source: "dnd" });
}, 600_000);

afterAll(async () => {
  report("offers.json", "Offers and automatic filters (plans 89–91)", meta, stats);
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** The p95 of warm runs, the machine's holds excused as elsewhere. */
async function interactive(name: string, budgetMs: number, fn: () => Promise<unknown>) {
  await fn();
  const samples: Sample[] = [];
  for (let i = 0; i < 15; i++) samples.push(await sampleAsync(fn));
  const ms = settle(samples).ms.sort((a, b) => a - b);
  const p95 = ms[Math.max(0, Math.ceil(ms.length * 0.95) - 1)]!;
  stats.push({ name, budgetMs, p50: ms[Math.floor(ms.length / 2)]!, p95, max: ms[ms.length - 1]!, iterations: ms.length });
  expect(p95, `${name}: p95 ${p95.toFixed(2)} ms`).toBeLessThanOrEqual(budgetMs * BUDGET_MULTIPLIER);
}

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)] ?? 0;

/** Runs background work while a renderer keeps listing; the loop's longest stall, the list's p95 and the heap it kept. */
async function background(name: string, fn: () => Promise<unknown>) {
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: `load-${Math.random()}`, origin: "renderer" });
  const lister = new RpcClient(c);
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  const loop = watchLoop(50 * BUDGET_MULTIPLIER);
  const list: Sample[] = [];
  let done = false;
  const probe = (async () => {
    while (!done) {
      list.push(await sampleAsync(() => lister.call("threads.list", { view: "inbox" })));
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const started = performance.now();
  try {
    await fn();
  } finally {
    done = true;
    await probe;
  }
  const watched = loop.stop();
  const total = performance.now() - started;
  gc();
  const kept = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  const peak = (heapPeak - heapBefore) / 1024 / 1024;
  const listMs = settle(list).ms;
  stats.push({ name: `${name}: ${total.toFixed(0)} ms, stall ${watched.stall.toFixed(1)} ms, list p95 ${p95(listMs).toFixed(1)} ms, heap +${peak.toFixed(1)} MB peak / +${kept.toFixed(1)} MB kept`, budgetMs: 50, p50: 0, p95: watched.stall, max: watched.stall, iterations: list.length });
  return { stall: watched.stall, list: listMs, peak, kept, total };
}

it("interactive: the snackbar's offers after a drag (four scopes, counted) hold a frame, for a sender of a third of the mailbox", async () => {
  expect(meta.shopMessages as number).toBeGreaterThan(15_000);
  await interactive("offers after a move (category)", FRAME, () => client.call("offers.forAction", { threadIds: [target], action: { category } }));
  await interactive("offers after spam", FRAME, () => client.call("offers.forAction", { threadIds: [target], action: "spam" }));
  await interactive("offers after archive", FRAME, () => client.call("offers.forAction", { threadIds: [target], action: "archive" }));
  // plan 127: the same lines after a drop on a folder
  await interactive("offers after a move (folder)", FRAME, () => client.call("offers.forAction", { threadIds: [target], action: { accountId: account, folder: "Label_Perf" } }));
});

it("interactive: a numbered subject nothing else has is counted and swept within a frame (every message of the sender read)", async () => {
  const rare = { kind: "subject", email: SHOP, subject: "Factura 1 vencida" } as const;
  // what any subject nothing has costs from this sender (exact compare, every message read): the numbers may add little to it
  const exact = { kind: "subject", email: SHOP, subject: "Factura vencida" } as const;
  await interactive("count, rare subject without numbers (baseline)", FRAME, () => client.call("categorize.count", { categoryId: category, scope: exact }));
  await interactive("count, rare numbered subject", FRAME, () => client.call("categorize.count", { categoryId: category, scope: rare }));
  await interactive("sweep page, rare numbered subject", 8, () => backend.store.similar.resolvePage(rare, "archive", [], null, 2000));
  await interactive("sweep page, numbered subject", 8, () => backend.store.similar.resolvePage({ kind: "subject", email: SHOP, subject: "Tu pedido 7 está en camino" }, "archive", [], null, 2000));
});

it("interactive: checking a pattern as it's typed (the longest allowed) takes well under a millisecond", async () => {
  const long = `^${"(?:pedido|orden)\\s+#?[0-9]{2,8}\\s*".repeat(12).slice(0, 480)}$`;
  const ms: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    checkPattern(`${long.slice(0, 200 + (i % 280))}`);
    ms.push(performance.now() - t);
  }
  const p = p95(ms);
  stats.push({ name: "pattern check while typing", budgetMs: 2, p50: 0, p95: p, max: Math.max(...ms), iterations: ms.length });
  expect(p, `pattern check p95 ${p.toFixed(3)} ms`).toBeLessThanOrEqual(2 * BUDGET_MULTIPLIER);
});

it("background: the drag's default moves the whole group (thousands) in slices: no stall over 50 ms, lists stay fast, bounded heap", async () => {
  const group = sqlDb(backend.store).get<{ c: number }>("SELECT count(DISTINCT thread_id) c FROM messages WHERE from_email = ? AND subject LIKE 'Tu pedido%'", SHOP)!.c;
  expect(group).toBeGreaterThan(5000);
  let added = 0;
  const r = await background("default group move", async () => {
    added = (await client.call("categorize.apply", { categoryId: category, scope: { kind: "subject", email: SHOP, subject: "Tu pedido 7 está en camino" }, always: true, move: true })).added;
  });
  meta.groupMoved = added;
  expect(added).toBeGreaterThan(5000);
  expect(r.stall, `stall ${r.stall.toFixed(1)} ms`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
  expect(p95(r.list), `list p95 ${p95(r.list).toFixed(1)} ms`).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
  // memory follows the slices, not the mailbox: a few MB of ids and journal rows, nothing kept after
  expect(r.peak, `peak +${r.peak.toFixed(1)} MB`).toBeLessThanOrEqual(64);
  expect(r.kept, `kept +${r.kept.toFixed(1)} MB`).toBeLessThanOrEqual(16);
}, 300_000);

it("background: a pattern filter applied to all mail runs in windows: no stall over 50 ms, lists stay fast, no more heap than a plain filter", async () => {
  // the same apply without a pattern: what any filter keeps (the changed rows' caches, the search index's updates)
  // both file into a category of their own: local work only (a star or a read would queue sync work to the servers, the same for both)
  const plainCat = (await client.call("categories.create", { name: "Plain", color: "cyan" })).id;
  const patternCat = (await client.call("categories.create", { name: "Pattern", color: "rose" })).id;
  const plain = await client.call("filters.save", { name: "plain", enabled: true, source: "manual", rule: { match: "any", conditions: [{ field: "subject", op: "startsWith", value: "factura" }, { field: "subject", op: "contains", value: "pedido" }], actions: [{ type: "addCategory", categoryId: plainCat }] } });
  const base = await background("plain filter over all mail", () => client.call("filters.apply", { id: plain.id }));
  const f = await client.call("filters.save", { name: "pattern", enabled: true, source: "manual", rule: { match: "any", conditions: [{ field: "subject", op: "matches", value: "^factura [0-9]+$|(pedido|orden)\\s+#?[0-9]+|(a|aa)+$" }, { field: "text", op: "contains", value: "propuesta" }], actions: [{ type: "addCategory", categoryId: patternCat }] } });
  let affected = 0;
  const r = await background("pattern filter over all mail", async () => {
    affected = (await client.call("filters.apply", { id: f.id })).affectedThreads;
  });
  meta.patternApplied = affected;
  expect(affected).toBeGreaterThan(5000);
  expect(r.stall, `stall ${r.stall.toFixed(1)} ms`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
  expect(p95(r.list), `list p95 ${p95(r.list).toFixed(1)} ms`).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
  // the pattern's own cost in memory: a bounded cache of compiled patterns, nothing per message
  expect(r.peak, `peak +${r.peak.toFixed(1)} MB vs plain +${base.peak.toFixed(1)} MB`).toBeLessThanOrEqual(base.peak + 16);
  expect(r.kept, `kept +${r.kept.toFixed(1)} MB vs plain +${base.kept.toFixed(1)} MB`).toBeLessThanOrEqual(base.kept + 8);
}, 300_000);

it("background: forty of Terno's filters (patterns and words) at ingest cost at most a fraction more CPU per message, and no stall", async () => {
  const fresh = (prefix: string, n: number): IncomingMessage[] =>
    generateDataset({ threads: n, accounts: 8, seed: prefix.length, now: NOW, bodyScale: 2 }).messages.map((m) => ({
      ...m,
      providerMsgId: `${prefix}-${m.providerMsgId}`,
      rfcMessageId: `${prefix}-${m.rfcMessageId}`,
      references: m.references.map((x) => `${prefix}-${x}`),
      inReplyTo: m.inReplyTo ? `${prefix}-${m.inReplyTo}` : null,
      accountId: sqlDb(backend.store).get<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1")!.id,
    }));
  // the same work twice: without automatic filters, then with forty (subject patterns and word filters)
  const bare = await background("ingest 1,500 threads, no filters", () => backend.ingestSliced(fresh("bare", 1500)));
  for (let i = 0; i < 40; i++) {
    const rule =
      i % 2
        ? { match: "all" as const, conditions: [{ field: "from" as const, op: "equals" as const, value: `shop${i}@example.com` }, { field: "subject" as const, op: "matches" as const, value: `^tu pedido [0-9]+ fase ${i}$` }], actions: [{ type: "addCategory" as const, categoryId: category }] }
        : { match: "all" as const, conditions: [{ field: "text" as const, op: "contains" as const, value: `palabra${i}` }, { field: "from" as const, op: "equals" as const, value: `news${i}@example.com` }], actions: [{ type: "addCategory" as const, categoryId: category }] };
    await client.call("filters.save", { name: `auto ${i}`, enabled: true, source: "manual", rule });
  }
  const filtered = await background("ingest 1,500 threads, 40 filters", () => backend.ingestSliced(fresh("filtered", 1500)));
  meta.ingestBareMs = Math.round(bare.total);
  meta.ingestFilteredMs = Math.round(filtered.total);
  // an import has stalls of its own (measured without filters): the filters add none
  expect(filtered.stall, `stall ${filtered.stall.toFixed(1)} ms vs ${bare.stall.toFixed(1)} ms without filters`).toBeLessThanOrEqual(Math.max(50, bare.stall + 10) * BUDGET_MULTIPLIER);
  // forty indexed rule probes per batch: well under half again the import's own cost
  expect(filtered.total, `with filters ${filtered.total.toFixed(0)} ms vs ${bare.total.toFixed(0)} ms`).toBeLessThanOrEqual(bare.total * 1.5 * BUDGET_MULTIPLIER);
  // the filters' own memory: what the import keeps anyway (rows, the search index) plus little
  expect(filtered.kept, `kept +${filtered.kept.toFixed(1)} MB vs +${bare.kept.toFixed(1)} MB without filters`).toBeLessThanOrEqual(bare.kept + 8);
}, 600_000);

it("background: a folder line moves a sender's mail of one account in slices: no stall over 50 ms, lists stay fast (plan 127)", async () => {
  const before = sqlDb(backend.store).get<{ c: number }>("SELECT count(*) c FROM thread_folders WHERE folder = 'Label_Perf'")!.c;
  let moved = 0;
  const r = await background("folder line move", async () => {
    moved = (await client.call("folders.moveScope", { accountId: account, folder: "Label_Perf", from: null, scope: { kind: "sender", email: SHOP } })).affected;
  });
  meta.folderMoved = moved;
  expect(moved).toBeGreaterThan(100);
  expect(sqlDb(backend.store).get<{ c: number }>("SELECT count(*) c FROM thread_folders WHERE folder = 'Label_Perf'")!.c).toBe(before + moved);
  expect(r.stall, `stall ${r.stall.toFixed(1)} ms`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
  expect(p95(r.list), `list p95 ${p95(r.list).toFixed(1)} ms`).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
}, 300_000);
