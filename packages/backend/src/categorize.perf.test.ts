/**
 * Categorization budgets (plan 02 §10) on the 50k-message perf mailbox:
 * classification per thread, train/untrain, model size and load time,
 * rebuild, and the ingestion throughput cost of classifying at import.
 * Reads run on all of it. The slicing gates act on part of it (a slice's bound
 * doesn't follow rows it never touches), enough for many slices.
 */
import { constants, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { CategorizerModel, encodeFeatures, extractFeatures, FEATURES_V, type TrainExample } from "@terno/core";
import { addToCategory, countScope, createAccount, createCategory, ingestMessages, openDatabase, ownAddresses, quickActions, rootMessages, type IncomingMessage, sqlDb, type SqlMailStore } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";
import { copyMailbox, PERF_MAILBOX } from "../../db/src/test/perf-mailbox";
import { SLICE_MAILBOX } from "./test/slice-mailbox";
import { sampleAsync, sampleSync, settle, watchLoop, type LoopReport, type Sample } from "../../db/src/test/timing";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const stats: Stat[] = [];
let dir: string;
let backend: Backend;
let accountIds: number[];

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

function percentiles(name: string, budgetMs: number, samples: number[], note?: string): Stat {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  const stat: Stat = { name, budgetMs, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]!, iterations: s.length, note };
  stats.push(stat);
  return stat;
}

function open(path: string, instantSearch = true) {
  return new Backend({ dbPath: path, version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, instantSearch });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terno-catperf-"));
  accountIds = copyMailbox(PERF_MAILBOX, join(dir, "base.db")).accountIds;
  backend = open(join(dir, "base.db"));
  await backend.store.ready;
  // 20 categories: the 5 seeded ones plus 15 the user filled by hand
  const threads = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM threads ORDER BY id").map((r) => r.id);
  for (let k = 0; k < 15; k++) {
    const id = createCategory(sqlDb(backend.store), `Proyecto ${k}`, "slate").id;
    addToCategory(sqlDb(backend.store), { categoryId: id, threadIds: threads.filter((_, i) => (i * 7 + k * 13) % 97 === 0), addedBy: "user", now: NOW - k * 86_400_000 });
  }
}, 600_000);

afterAll(async () => {
  report("categorize.json", "Categorization", { threads: PERF_MAILBOX.dataset.threads, categories: 20 }, stats);
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

it("rebuilds the model from the whole mailbox within 2 s (sliced: 8 ms slices)", async () => {
  const t = performance.now();
  await backend.categorizer.rebuild();
  const took = performance.now() - t;
  const m = backend.categorizer.model!;
  stats.push({ name: `rebuild (sliced): ${m.backgroundSize} background threads, ${m.featureCount} features`, budgetMs: 2000, p50: took, p95: took, max: took, iterations: 1 });
  expect(m.categoryIds).toHaveLength(20);
  expect(took).toBeLessThanOrEqual(2000 * BUDGET_MULTIPLIER);
});

it("classifies a thread against 20 categories in ≤ 50 µs p95 (featurizing its 2 KB body: ≤ 150 µs end to end)", async () => {
  if (!backend.categorizer.ready) await backend.categorizer.rebuildNow();
  const db = sqlDb(backend.store);
  const model = backend.categorizer.model!;
  const own = ownAddresses(db);
  const ids = db.all<{ id: number }>("SELECT id FROM threads WHERE in_spam = 0 ORDER BY id DESC LIMIT 3000").map((r) => r.id);
  // every body grown to the 2 KB the featurizer reads, with other messages' text (not repeats of itself)
  const all = [...rootMessages(db, ids, own).values()];
  const roots = all.map((r, i) => {
    let body = r.source.bodyText ?? r.source.subject;
    for (let k = 1; body.length < 2048; k++) body += `\n${all[(i + k * 37) % all.length]!.source.bodyText ?? ""}`;
    return { ...r, source: { ...r.source, bodyText: body.slice(0, 2048) } };
  });
  expect(roots.length).toBeGreaterThan(2000);
  const ctx = { ownDomains: own.domains };
  const encoded = roots.map((r) => encodeFeatures(extractFeatures(r.source, ctx)));
  const sample = (fn: (i: number) => unknown) => {
    for (let i = 0; i < 500; i++) fn(i);
    const out: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const t = performance.now();
      fn(i);
      out.push((performance.now() - t) * 1000);
    }
    return out;
  };
  // reported in µs (budget column = µs)
  const classify = percentiles("classify per thread, µs (score 20 categories)", 50, sample((i) => model.score(encoded[i % encoded.length]!)));
  const full = percentiles("featurize 2 KB + classify per thread, µs", 150, sample((i) => model.score(encodeFeatures(extractFeatures(roots[i % roots.length]!.source, ctx)))));
  expect(classify.p95).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
  expect(full.p95).toBeLessThanOrEqual(150 * BUDGET_MULTIPLIER);
});

it("trains and untrains one example in ≤ 200 µs", async () => {
  if (!backend.categorizer.ready) await backend.categorizer.rebuildNow();
  const db = sqlDb(backend.store);
  const own = ownAddresses(db);
  const roots = [...rootMessages(db, db.all<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 600").map((r) => r.id), own).values()];
  const model = backend.categorizer.model!;
  const examples: TrainExample[] = roots.map((r, i) => ({ categoryId: model.categoryIds[i % 20]!, label: 1, weight: 1, at: NOW, content: true, features: encodeFeatures(extractFeatures(r.source, { ownDomains: own.domains })) }));
  const samples: number[] = [];
  for (const ex of examples) {
    const t = performance.now();
    model.train(ex);
    model.untrain(ex);
    samples.push(((performance.now() - t) * 1000) / 2);
  }
  const s = percentiles("train or untrain one example, µs", 200, samples.slice(50));
  expect(s.p95).toBeLessThanOrEqual(200 * BUDGET_MULTIPLIER);
});

it("a 20-category, 100k-feature model stays ≤ 30 MB and loads from its snapshot in ≤ 30 ms", () => {
  // A deterministic synthetic mailbox shaped like real mail: each category has its own
  // vocabulary (2k words) plus a shared one (10k); background mail draws from 60k more words.
  let seed = 7;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const zipf = (n: number) => Math.floor(Math.pow(rand(), 2) * n);
  const thread = (words: () => string) => {
    const tokens = [...new Set(Array.from({ length: 120 }, words))];
    const sender = Math.floor(rand() * 3000);
    return encodeFeatures({ v: FEATURES_V, sender: `s${sender}@x${sender % 400}.com`, list: null, domain: `x${sender % 400}.com`, rawDomain: `x${sender % 400}.com`, name: `sender ${sender}`, tokens, intents: ["amount"] });
  };
  const examples = Array.from({ length: 20 * 400 }, (_, i) => {
    const cat = i % 20;
    return { categoryId: cat + 1, label: 1 as const, weight: 1, at: NOW, content: true, features: thread(() => (rand() < 0.7 ? `b:c${cat}w${zipf(2000)}` : `b:shared${zipf(10_000)}`)) };
  });
  const background = Array.from({ length: 10_000 }, () => thread(() => (rand() < 0.2 ? `b:shared${zipf(10_000)}` : `b:w${Math.floor(rand() * 60_000)}`)));
  gc();
  const before = process.memoryUsage().heapUsed;
  let m: CategorizerModel | null = new CategorizerModel({ decayRef: NOW });
  for (const ex of examples) m.train(ex);
  background.forEach((f, i) => m!.addBackground(i, f));
  gc();
  const mb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  expect(m.featureCount).toBeGreaterThanOrEqual(95_000);
  const bytes = m.serialize();
  const features = m.featureCount;
  m = null;
  stats.push({ name: `model heap, 20 categories / ${features} features / 10k background threads: ${mb.toFixed(1)} MB (snapshot ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB)`, budgetMs: 30, p50: mb, p95: mb, max: mb, iterations: 1 });
  // a batch of 20 loads (after 2 warm-ups); one over budget is loaded again, up to three in all, and the best counts: a
  // regression is slow in every batch, a busy moment of the machine isn't (timing.ts)
  let load: Stat | null = null;
  for (let batch = 1; batch <= 3 && !(load && load.p95 <= 30 * BUDGET_MULTIPLIER); batch++) {
    const loads: Sample[] = [];
    for (let i = 0; i < 22; i++) {
      // startup loads into a quiet heap: don't bill the previous iteration's garbage to this one
      gc();
      const blob = bytes.slice();
      loads.push(sampleSync(() => CategorizerModel.deserialize(blob)));
    }
    // on a busy machine, a load the OS held counts at its CPU time while such loads are rare (timing.ts)
    const s = settle(loads.slice(2)).ms.sort((a, b) => a - b);
    const p95 = s[Math.ceil(0.95 * s.length) - 1]!;
    if (!load || p95 < load.p95) load = { name: `load the model from its snapshot, ms${batch > 1 ? ` (batch ${batch})` : ""}`, budgetMs: 30, p50: s[Math.ceil(0.5 * s.length) - 1]!, p95, max: s.at(-1)!, iterations: s.length };
  }
  stats.push(load!);
  // filing-rate terms settle on the first read after loading
  const loaded = CategorizerModel.deserialize(bytes.slice())!;
  const t = performance.now();
  loaded.score(examples[0]!.features);
  const first = performance.now() - t;
  stats.push({ name: `first score after loading: ${first.toFixed(2)} ms`, budgetMs: 10, p50: first, p95: first, max: first, iterations: 1 });
  expect(first).toBeLessThanOrEqual(10 * BUDGET_MULTIPLIER);
  expect(mb).toBeLessThanOrEqual(30);
  expect(load!.p95, `snapshot load p95 (p50 ${load!.p50.toFixed(1)} ms)`).toBeLessThanOrEqual(30 * BUDGET_MULTIPLIER);
});

it("snackbar counts: sender/domain/list ≤ 5 ms, topic ≤ 25 ms (capped at 1 000), quick actions ≤ 2 ms", async () => {
  if (!backend.categorizer.ready) await backend.categorizer.rebuildNow();
  const db = sqlDb(backend.store);
  const model = backend.categorizer.model!;
  const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
  const lecturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Lecturas'")!.id;
  const run = (name: string, budget: number, fn: () => unknown, iterations = 30) => {
    for (let i = 0; i < 5; i++) fn();
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t = performance.now();
      fn();
      samples.push(performance.now() - t);
    }
    const s = percentiles(name, budget, samples);
    expect(s.p95, name).toBeLessThanOrEqual(budget * BUDGET_MULTIPLIER);
  };
  run("count: same sender (uber.receipts@uber.com)", 5, () => countScope(db, facturas, { kind: "sender", email: "uber.receipts@uber.com" }, NOW));
  run("count: same domain (@github.com)", 5, () => countScope(db, facturas, { kind: "domain", domain: "github.com" }, NOW));
  run("count: same list (daily.morningbrew.com)", 5, () => countScope(db, facturas, { kind: "list", listId: "daily.morningbrew.com" }, NOW));
  // the busiest sender of the 50k mailbox that isn't one of the user's own accounts
  const busiest = db.get<{ from_email: string }>(
    "SELECT from_email FROM messages WHERE is_sent = 0 AND from_email NOT IN (SELECT email FROM accounts) GROUP BY from_email ORDER BY count(*) DESC LIMIT 1",
  )!.from_email;
  run(`count: busiest sender (${busiest})`, 5, () => countScope(db, lecturas, { kind: "sender", email: busiest }, NOW));
  // plan 80: the same subject from them (a rare one walks the whole sender) is bounded like the sender
  const subject = db.get<{ subject: string }>("SELECT subject FROM messages WHERE from_email = ? AND is_sent = 0 LIMIT 1", busiest)!.subject;
  run(`count: busiest sender, same subject`, 5, () => countScope(db, lecturas, { kind: "subject", email: busiest, subject }, NOW));
  run(`count: busiest sender, rare subject`, 5, () => countScope(db, lecturas, { kind: "subject", email: busiest, subject: "nothing has this subject" }, NOW));
  run("count: topic \"factura\" (common word, capped)", 25, () => countScope(db, facturas, { kind: "query", query: '"factura" -category:Facturas' }, NOW));
  run("count: topic \"semana\" \"reunion\" (AND)", 25, () => countScope(db, facturas, { kind: "query", query: '"semana" "reunion" -category:Facturas' }, NOW));
  run("count: topic, rare word", 25, () => countScope(db, facturas, { kind: "query", query: '"cfdi" -category:Facturas' }, NOW));
  const threads = db.all<{ id: number }>("SELECT thread_id AS id FROM messages WHERE from_email = 'uber.receipts@uber.com' LIMIT 50").map((r) => r.id);
  let i = 0;
  run("quickActions for one filed thread", 2, () => quickActions(db, facturas, [threads[i++ % threads.length]!], model));
});

// a scan of the sender's examples per thread shows long before 12,000: the last chunks hold six times what the first do
it("bulk-filing 4,000 threads of one sender stays linear (the content cap is a bounded lookup)", () => {
  const db = openDatabase(join(dir, "bulk.db"));
  try {
    const acct = createAccount(db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(db, "Lecturas", "violet").id;
    const msgs = generateDataset({ threads: 4_000, accounts: 1, seed: 3, now: NOW }).messages.filter((m) => !m.isSent).slice(0, 4_000);
    for (let i = 0; i < msgs.length; i += 1000) {
      ingestMessages(db, msgs.slice(i, i + 1000).map((m, j) => ({ ...m, accountId: acct, from: { name: "Xataka", email: "boletin@xataka.com" }, references: [], inReplyTo: null, providerThreadId: null, rfcMessageId: `bulk-${i + j}@x`, providerMsgId: `bulk-${i + j}` })), NOW);
    }
    const threads = db.all<{ id: number }>("SELECT id FROM threads ORDER BY id").map((r) => r.id);
    expect(threads.length).toBeGreaterThan(3_000);
    const chunkMs: number[] = [];
    for (let i = 0; i < threads.length; i += 100) {
      const t = performance.now();
      addToCategory(db, { categoryId: cat, threadIds: threads.slice(i, i + 100), addedBy: "bulk", now: NOW, batchId: 1 });
      chunkMs.push(performance.now() - t);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const first = mean(chunkMs.slice(1, 11));
    const last = mean(chunkMs.slice(-10));
    const total = chunkMs.reduce((a, b) => a + b, 0);
    stats.push({ name: `bulk filing ${threads.length} same-sender threads: first chunks ${first.toFixed(1)} ms, last ${last.toFixed(1)} ms, total ${(total / 1000).toFixed(2)} s`, budgetMs: 0, p50: last / first, p95: last / first, max: total, iterations: chunkMs.length });
    expect(last).toBeLessThanOrEqual(first * 2 + 2);
    // 4,000 ms was the budget for 12,000: the same rate
    expect(total).toBeLessThanOrEqual((threads.length / 3) * BUDGET_MULTIPLIER);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM cls_examples WHERE content = 1")!.n).toBe(50);
  } finally {
    db.close();
  }
}, 600_000);

it("scoring right after a model change stays fast with 50,000 distinct senders (≤ 1 ms p95)", () => {
  const f = (sender: string, words: string[]) => encodeFeatures({ v: FEATURES_V, sender, list: null, domain: sender.split("@")[1]!, rawDomain: sender.split("@")[1]!, name: "", tokens: words.map((w) => `b:${w}`), intents: [] });
  const m = new CategorizerModel({ decayRef: NOW });
  for (let i = 0; i < 50_000; i++) m.train({ categoryId: (i % 5) + 1, label: 1, weight: 1, at: NOW, content: true, features: f(`s${i}@d${i % 2000}.com`, [`w${i % 300}`, `x${i % 7}`]) });
  for (let i = 0; i < 5000; i++) m.addBackground(i, f(`b${i % 900}@bg${i % 50}.com`, [`w${i % 300}`, `y${i % 11}`]));
  const probe = f("s17@d17.com", ["w17", "x3"]);
  m.score(probe);
  const warm: number[] = [];
  const afterChange: number[] = [];
  for (let i = 0; i < 60; i++) {
    let t = performance.now();
    m.score(probe);
    warm.push(performance.now() - t);
    // a user filing, then a background thread arriving: each invalidates cached aggregates
    if (i % 2) m.train({ categoryId: (i % 5) + 1, label: 1, weight: 1, at: NOW, content: true, features: f(`new${i}@d1.com`, ["w1"]) });
    else m.addBackground(100_000 + i, f(`b${i}@bg1.com`, ["w2"]));
    t = performance.now();
    m.score(probe);
    afterChange.push(performance.now() - t);
  }
  percentiles("score, warm (50k senders), ms", 1, warm);
  const s = percentiles("score right after a model change (50k senders), ms", 1, afterChange);
  expect(s.p95).toBeLessThanOrEqual(1 * BUDGET_MULTIPLIER);
});

/** Runs fn while sampling the event loop (max gap between 1 ms ticks) and a concurrent list RPC. */
async function underLoad(fn: () => Promise<unknown>, on: Backend = backend): Promise<{ stall: number; cpu: number; rpc: number[]; descheduled: number }> {
  const [c, srv] = createMemoryTransportPair();
  on.connect(srv, { clientId: `load-${Math.random()}`, origin: "renderer" });
  const client = new RpcClient(c);
  const loop = watchLoop(50 * BUDGET_MULTIPLIER);
  const rpc: Sample[] = [];
  let done = false;
  const probe = (async () => {
    while (!done) {
      rpc.push(await sampleAsync(() => client.call("threads.list", { view: "inbox" })));
      // a renderer's requests arrive as macrotasks: let slices run between them
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  let watched: LoopReport;
  try {
    await fn();
  } finally {
    done = true;
    await probe;
    watched = loop.stop();
  }
  return { stall: watched.stall, cpu: watched.longest.cpu, rpc: settle(rpc).ms, descheduled: watched.descheduled.length };
}

it("large UI adds, removals and undo are sliced: no long stall, interactive RPCs keep flowing", async () => {
  if (!backend.categorizer.ready) await backend.categorizer.rebuildNow();
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: "big", origin: "renderer" });
  const client = new RpcClient(c);
  const cat = (await client.call("categories.create", { name: "Grande", color: "rose" })).id;
  const ids = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 2500").map((r) => r.id);
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? 0;
  const runs: [string, () => Promise<unknown>][] = [];
  runs.push(["add 2,500 threads (picker)", () => client.call("categories.addThreads", { categoryId: cat, threadIds: ids })]);
  runs.push(["remove 2,500 threads", () => client.call("categories.removeThreads", { categoryId: cat, threadIds: ids })]);
  for (const [name, fn] of runs) {
    const { stall, cpu, rpc } = await underLoad(fn);
    stats.push({ name: `${name}: max event-loop stall ${stall.toFixed(1)} ms (cpu ${cpu.toFixed(1)}), list RPC p95 ${p95(rpc).toFixed(1)} ms (${rpc.length})`, budgetMs: 50, p50: stall, p95: stall, max: stall, iterations: rpc.length });
    expect(stall, `${name} (cpu ${cpu.toFixed(1)} ms of it)`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
    expect(p95(rpc), name).toBeLessThanOrEqual(25 * BUDGET_MULTIPLIER);
  }
  // leave the shared mailbox as the other budgets expect it
  await client.call("categories.delete", { id: cat });
  // A query's scope is one read of the whole mailbox ahead of the slices, whatever it matches: at full size, with a scope that
  // files few so only the read is big, then the rest of the bulk apply's slices where filing everything is quick.
  const sender = sqlDb(backend.store).get<{ email: string; c: number }>("SELECT last_from_email AS email, count(*) AS c FROM threads WHERE in_trash = 0 AND in_spam = 0 GROUP BY 1 HAVING c BETWEEN 50 AND 400 ORDER BY c LIMIT 1")!;
  const few = (await client.call("categories.create", { name: "Pocas", color: "rose" })).id;
  let filed: { batchId: number | null; added: number } = { batchId: null, added: 0 };
  const full = await underLoad(async () => (filed = await client.call("categorize.apply", { categoryId: few, scope: { kind: "query", query: `from:${sender.email}` } })));
  stats.push({ name: `bulk-apply by query at full size: max event-loop stall ${full.stall.toFixed(1)} ms (cpu ${full.cpu.toFixed(1)})`, budgetMs: 50, p50: full.stall, p95: full.stall, max: full.stall, iterations: full.rpc.length });
  expect(filed.added).toBeGreaterThan(0);
  expect(full.stall, `bulk-apply by query at full size (cpu ${full.cpu.toFixed(1)} ms of it)`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
  await client.call("categorize.undo", { batchId: filed.batchId! });
  await client.call("categories.delete", { id: few });
  copyMailbox(SLICE_MAILBOX, join(dir, "slices.db"));
  const small = open(join(dir, "slices.db"), false);
  try {
    await small.store.ready;
    await small.categorizer.rebuildNow();
    const [c2, srv2] = createMemoryTransportPair();
    small.connect(srv2, { clientId: "bulk", origin: "renderer" });
    const bulk = new RpcClient(c2);
    const all = (await bulk.call("categories.create", { name: "Grande", color: "rose" })).id;
    let applied: { batchId: number | null; added: number } = { batchId: null, added: 0 };
    for (const [name, fn] of [
      ["bulk-apply every thread (one batch)", async () => (applied = await bulk.call("categorize.apply", { categoryId: all, scope: { kind: "query", query: "in:all" } }))],
      ["undo that batch", async () => {
        expect(applied.added).toBeGreaterThan(2_000);
        await bulk.call("categorize.undo", { batchId: applied.batchId! });
      }],
    ] as [string, () => Promise<unknown>][]) {
      const { stall, cpu, rpc } = await underLoad(fn, small);
      stats.push({ name: `${name}: max event-loop stall ${stall.toFixed(1)} ms (cpu ${cpu.toFixed(1)}), list RPC p95 ${p95(rpc).toFixed(1)} ms (${rpc.length})`, budgetMs: 50, p50: stall, p95: stall, max: stall, iterations: rpc.length });
      expect(stall, `${name} (cpu ${cpu.toFixed(1)} ms of it)`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
      expect(p95(rpc), name).toBeLessThanOrEqual(25 * BUDGET_MULTIPLIER);
    }
  } finally {
    await small.stop();
  }
}, 600_000);

const MOVED = 2_000;
const IN_TWENTY = 400;

it("recording a move of the largest selection (5,000 threads) holds the loop no longer than a slice's budget", async () => {
  const ids = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM threads WHERE in_trash = 0 AND in_spam = 0 ORDER BY id LIMIT 5000").map((r) => r.id);
  expect(ids).toHaveLength(5000);
  const to = (await backend.store.categories.list())[0]!.id;
  const samples: Sample[] = [];
  for (let i = 0; i < 3; i++) {
    let batchId = 0;
    samples.push(await sampleAsync(async () => (batchId = (await backend.store.categories.beginMove({ to, threadIds: ids, addedBy: "user", now: NOW, source: "dnd" })).batchId)));
    // only what begin wrote: nothing moved
    sqlDb(backend.store).run("DELETE FROM cat_move_threads WHERE batch_id = ?", batchId);
    sqlDb(backend.store).run("DELETE FROM cat_batches WHERE id = ?", batchId);
  }
  const best = Math.min(...settle(samples).ms);
  stats.push({ name: "beginMove of 5,000 threads", budgetMs: 50, p50: best, p95: best, max: best, iterations: samples.length });
  expect(best).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
});

it(`moving ${MOVED} threads, ${IN_TWENTY} of them filed in 20 categories each, and undoing it: sliced, no stall over 50 ms, lists keep flowing, exact`, async () => {
  if (!backend.categorizer.ready) await backend.categorizer.rebuildNow();
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: "move20", origin: "renderer" });
  const client = new RpcClient(c);
  const db = sqlDb(backend.store);
  const sources: number[] = [];
  for (let k = 0; k < 20; k++) sources.push((await client.call("categories.create", { name: `Origen ${k}`, color: "slate" })).id);
  const to = (await client.call("categories.create", { name: "Destino único", color: "cyan" })).id;
  const ids = db.all<{ id: number }>("SELECT id FROM threads WHERE in_trash = 0 AND in_spam = 0 ORDER BY id LIMIT ?", MOVED).map((r) => r.id);
  expect(ids).toHaveLength(MOVED);
  // filed by hand earlier (set up directly: the move is what is measured): every one in the first source, some in all of them
  db.exec("BEGIN");
  db.run("INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at) SELECT value, ?, 'user', 1 FROM json_each(?)", sources[0]!, JSON.stringify(ids));
  for (const cat of sources.slice(1)) db.run("INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at) SELECT value, ?, 'user', 1 FROM json_each(?)", cat, JSON.stringify(ids.slice(0, IN_TWENTY)));
  db.exec("COMMIT");
  const memberships = () => db.all<{ t: number; c: number; by: string; at: number; b: number | null }>(`SELECT thread_id AS t, category_id AS c, added_by AS by, added_at AS at, batch_id AS b FROM thread_categories WHERE category_id IN (${[...sources, to].join(",")}) ORDER BY t, c`);
  const before = memberships();
  expect(before).toHaveLength(MOVED + IN_TWENTY * 19);
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? 0;
  let batchId = 0;
  const results: { name: string; stall: number; cpu: number; list: number }[] = [];
  for (const [name, fn] of [
    [`move ${MOVED} threads`, async () => (batchId = (await client.call("categories.moveThreads", { to, threadIds: ids, source: "dnd" })).batchId)],
    ["undo that move", () => client.call("categorize.undo", { batchId })],
  ] as [string, () => Promise<unknown>][]) {
    const t = performance.now();
    const { stall, cpu, rpc } = await underLoad(fn);
    const took = performance.now() - t;
    results.push({ name, stall, cpu, list: p95(rpc) });
    stats.push({ name: `${name}: ${took.toFixed(0)} ms, max event-loop stall ${stall.toFixed(1)} ms (cpu ${cpu.toFixed(1)}), list RPC p95 ${p95(rpc).toFixed(1)} ms (${rpc.length})`, budgetMs: 50, p50: stall, p95: stall, max: stall, iterations: rpc.length });
    if (name.startsWith("move")) expect(memberships().map((m) => m.c)).toEqual(ids.map(() => to));
    else expect(memberships()).toEqual(before);
  }
  for (const cat of [...sources, to]) await client.call("categories.delete", { id: cat });
  for (const r of results) {
    expect(r.stall, `${r.name} (cpu ${r.cpu.toFixed(1)} ms of it)`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
    expect(r.list, r.name).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
  }
}, 600_000);

const IMPORT_THREADS = 1_000;
const ONCE = 200;
let warmed = false;

/**
 * An import ingested into copies of the perf mailbox with the engine off and on. What's compared is a cost per message,
 * so 1,900 messages say what 14,000 did (+3% and +22% against +1 to 3% and +26%), as long as what a run pays once is left out: each new backend ingests a slice
 * before the clock starts (a loaded model's first scores, the statements' first use), and the file's first run is only
 * the JIT's warm-up (it would be billed to whichever mode ran first).
 */
async function importAB(label: string, shape: (m: IncomingMessage) => IncomingMessage, rounds: number, limit: number) {
  if (!backend.categorizer.ready) await backend.categorizer.rebuildNow();
  // process CPU is measured: the shared mailbox's search index must not be catching up on earlier tests meanwhile
  await (backend.store as SqlMailStore).instant?.idle();
  await backend.categorizer.persist();
  sqlDb(backend.store).exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const extra = generateDataset({ threads: IMPORT_THREADS, accounts: 8, seed: 99, now: NOW, bodyScale: 3 }).messages.map((m) =>
    shape({
      ...m,
      providerMsgId: `bg-${m.providerMsgId}`,
      rfcMessageId: `bg-${m.rfcMessageId}`,
      references: m.references.map((r) => `bg-${r}`),
      inReplyTo: m.inReplyTo ? `bg-${m.inReplyTo}` : null,
      accountId: accountIds[m.accountIndex]!,
    }),
  );
  const time = async (mode: "off" | "auto", round: number) => {
    const path = join(dir, `ab-${mode}-${round}.db`);
    // the WAL too: the checkpoint worker may keep the last frames (the snapshot) out of the main file
    for (const s of ["", "-wal"]) if (existsSync(join(dir, `base.db${s}`))) copyFileSync(join(dir, `base.db${s}`), path + s, constants.COPYFILE_FICLONE);
    // classification's cost alone: a fresh copy would build its search index during the import (gated in instant.perf)
    const b = open(path, false);
    try {
      await b.ready;
      expect(b.categorizer.ready).toBe(true);
      sqlDb(b.store).run("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('app', ?)", JSON.stringify({ autoCategorize: mode }));
      await b.ingestSliced(extra.slice(0, ONCE));
      // CPU time, not wall time: other processes (pnpm test runs the unit project alongside) don't skew it
      const before = sqlDb(b.store).get<{ c: number }>("SELECT count(*) AS c FROM cls_decisions")!.c;
      const cpu = process.cpuUsage();
      await b.ingestSliced(extra.slice(ONCE));
      const used = process.cpuUsage(cpu);
      return { took: (used.user + used.system) / 1000, decided: sqlDb(b.store).get<{ c: number }>("SELECT count(*) AS c FROM cls_decisions")!.c - before };
    } finally {
      await b.stop();
      for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
    }
  };
  const off: number[] = [];
  const on: number[] = [];
  let decided = 0;
  if (!warmed) await time("auto", -1);
  warmed = true;
  // over its limit it goes on, two more pairs at most: a regression is over in every pair, a busy moment in one
  for (let round = 0; round < rounds || (round < rounds + 2 && Math.min(...on) / Math.min(...off) > limit); round++) {
    off.push((await time("off", round)).took);
    const r = await time("auto", round);
    on.push(r.took);
    decided = r.decided;
  }
  const ratio = Math.min(...on) / Math.min(...off);
  stats.push({
    name: `${label}: ${extra.length} msgs, CPU off ${(Math.min(...off) / 1000).toFixed(2)} s, auto ${(Math.min(...on) / 1000).toFixed(2)} s (+${((ratio - 1) * 100).toFixed(1)}%), ${decided} decisions`,
    budgetMs: 0,
    p50: ratio,
    p95: ratio,
    max: ratio,
    iterations: on.length,
  });
  return { ratio, decided };
}


it("classifying at import costs ≤ 10% of ingestion throughput", async () => {
  const { ratio, decided } = await importAB("import as synced", (m) => m, 2, 1.1);
  expect(decided).toBeGreaterThan(10);
  expect(ratio).toBeLessThanOrEqual(1.1);
}, 600_000);

it("worst case: every imported message is new inbox mail", async () => {
  const { ratio, decided } = await importAB("import, all new inbox mail", (m) => ({ ...m, date: NOW - 3_600_000 + (m.date % 3_000_000), inInbox: !m.isSent && !m.isSpam }), 1, 1.5);
  // a good part of them: as the 14,000-message import's more than a thousand held, far more than as synced's few
  expect(decided).toBeGreaterThan(200);
  // every thread is featurized, scored and most get a decision: reported, bounded loosely
  expect(ratio).toBeLessThanOrEqual(1.5);
}, 600_000);

// last: it leaves two scratch categories and the model that holds them
it("a rebuild never stalls the event loop for long, even with 40,000 training examples", async () => {
  if (!backend.categorizer.ready) await backend.categorizer.rebuildNow();
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: "rebuild", origin: "renderer" });
  const client = new RpcClient(c);
  const db = sqlDb(backend.store);
  // 40k+ examples: the largest category's own, again in scratch categories (written directly: the rebuild is what is measured)
  const largest = db.get<{ id: number }>("SELECT category_id AS id FROM cls_examples GROUP BY category_id ORDER BY count(*) DESC LIMIT 1")!.id;
  for (let k = 0; db.get<{ n: number }>("SELECT count(*) AS n FROM cls_examples")!.n <= 40_000; k++) {
    const cat = (await client.call("categories.create", { name: `Más ${k}`, color: "lime" })).id;
    db.run("INSERT INTO cls_examples (thread_id, category_id, label, weight, source, at, sender, content, batch_id, features) SELECT thread_id, ?, label, weight, source, at, sender, content, batch_id, features FROM cls_examples WHERE category_id = ?", cat, largest);
  }
  const examples = db.get<{ n: number }>("SELECT count(*) AS n FROM cls_examples")!.n;
  const { stall, cpu, rpc } = await underLoad(() => backend.categorizer.rebuild());
  const p95 = [...rpc].sort((a, b) => a - b)[Math.ceil(rpc.length * 0.95) - 1] ?? 0;
  stats.push({ name: `rebuild with ${examples} examples: max event-loop stall ${stall.toFixed(1)} ms (cpu ${cpu.toFixed(1)}), list RPC p95 ${p95.toFixed(1)} ms`, budgetMs: 50, p50: stall, p95: stall, max: stall, iterations: rpc.length });
  expect(backend.categorizer.model!.categoryIds.length).toBeGreaterThan(20);
  expect(stall, `cpu ${cpu.toFixed(1)} ms of it`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
}, 600_000);
