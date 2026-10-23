/**
 * Categorization budgets (plan 02 §10) on the 50k-message perf mailbox:
 * classification per thread, train/untrain, model size and load time,
 * rebuild, and the ingestion throughput cost of classifying at import.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { CategorizerModel, encodeFeatures, extractFeatures, FEATURES_V, type TrainExample } from "@unica/core";
import { addToCategory, createCategory, ownAddresses, rootMessages, seedDataset, type IncomingMessage } from "@unica/db";
import { demoRegistry } from "@unica/mail";
import { generateDataset } from "@unica/mock-data";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";

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

function open(path: string) {
  return new Backend({ dbPath: path, version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unica-catperf-"));
  backend = open(join(dir, "base.db"));
  accountIds = seedDataset(backend.db, generateDataset({ threads: 20_000, accounts: 8, seed: 5, now: NOW, bodyScale: 3 }), { now: NOW }).accountIds;
  // 20 categories: the 5 seeded ones plus 15 the user filled by hand
  const threads = backend.db.all<{ id: number }>("SELECT id FROM threads ORDER BY id").map((r) => r.id);
  for (let k = 0; k < 15; k++) {
    const id = createCategory(backend.db, `Proyecto ${k}`, "slate").id;
    addToCategory(backend.db, { categoryId: id, threadIds: threads.filter((_, i) => (i * 7 + k * 13) % 97 === 0), addedBy: "user", now: NOW - k * 86_400_000 });
  }
}, 600_000);

afterAll(async () => {
  report("categorize.json", "Categorization", { threads: 20_000, categories: 20 }, stats);
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

it("rebuilds the model from 20k threads within 2 s (sliced: 8 ms slices)", async () => {
  const t = performance.now();
  await backend.categorizer.rebuild();
  const took = performance.now() - t;
  const m = backend.categorizer.model!;
  stats.push({ name: `rebuild (sliced): ${m.backgroundSize} background threads, ${m.featureCount} features`, budgetMs: 2000, p50: took, p95: took, max: took, iterations: 1 });
  expect(m.categoryIds).toHaveLength(20);
  expect(took).toBeLessThanOrEqual(2000 * BUDGET_MULTIPLIER);
});

it("classifies a thread against 20 categories in ≤ 50 µs p95 (featurizing its 2 KB body: ≤ 150 µs end to end)", () => {
  if (!backend.categorizer.ready) backend.categorizer.rebuildSync();
  const db = backend.db;
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

it("trains and untrains one example in ≤ 200 µs", () => {
  if (!backend.categorizer.ready) backend.categorizer.rebuildSync();
  const db = backend.db;
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
  const loads: number[] = [];
  for (let i = 0; i < 22; i++) {
    // startup loads into a quiet heap: don't bill the previous iteration's garbage to this one
    gc();
    const blob = bytes.slice();
    const t = performance.now();
    CategorizerModel.deserialize(blob);
    loads.push(performance.now() - t);
  }
  stats.push({ name: `model heap, 20 categories / ${features} features / 10k background threads: ${mb.toFixed(1)} MB (snapshot ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB)`, budgetMs: 30, p50: mb, p95: mb, max: mb, iterations: 1 });
  const load = percentiles("load the model from its snapshot, ms", 30, loads.slice(2));
  expect(mb).toBeLessThanOrEqual(30);
  expect(load.p95).toBeLessThanOrEqual(30 * BUDGET_MULTIPLIER);
});

/** The backend load test's 14k-message import, ingested into copies of the perf mailbox with the engine off and on. */
async function importAB(label: string, shape: (m: IncomingMessage) => IncomingMessage, rounds: number) {
  if (!backend.categorizer.ready) backend.categorizer.rebuildSync();
  backend.categorizer.persist();
  backend.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const extra = generateDataset({ threads: 8_000, accounts: 8, seed: 99, now: NOW, bodyScale: 3 }).messages.map((m) =>
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
    for (const s of ["", "-wal"]) if (existsSync(join(dir, `base.db${s}`))) copyFileSync(join(dir, `base.db${s}`), path + s);
    const b = open(path);
    try {
      expect(b.categorizer.ready).toBe(true);
      b.db.run("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('app', ?)", JSON.stringify({ autoCategorize: mode }));
      const t = performance.now();
      await b.ingestSliced(extra);
      return { took: performance.now() - t, decided: b.db.get<{ c: number }>("SELECT count(*) AS c FROM cls_decisions")!.c };
    } finally {
      await b.stop();
      for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
    }
  };
  const off: number[] = [];
  const on: number[] = [];
  let decided = 0;
  for (let round = 0; round < rounds; round++) {
    off.push((await time("off", round)).took);
    const r = await time("auto", round);
    on.push(r.took);
    decided = r.decided;
  }
  const ratio = Math.min(...on) / Math.min(...off);
  stats.push({
    name: `${label}: ${extra.length} msgs, off ${(Math.min(...off) / 1000).toFixed(2)} s, auto ${(Math.min(...on) / 1000).toFixed(2)} s (+${((ratio - 1) * 100).toFixed(1)}%), ${decided} decisions`,
    budgetMs: 0,
    p50: ratio,
    p95: ratio,
    max: ratio,
    iterations: rounds,
  });
  return { ratio, decided };
}

it("classifying at import costs ≤ 10% of ingestion throughput (the load test's 14k-message import)", async () => {
  const { ratio, decided } = await importAB("import as synced", (m) => m, 3);
  expect(decided).toBeGreaterThan(50);
  expect(ratio).toBeLessThanOrEqual(1.1);
}, 600_000);

it("worst case: every imported message is new inbox mail", async () => {
  const { ratio, decided } = await importAB("import, all new inbox mail", (m) => ({ ...m, date: NOW - 3_600_000 + (m.date % 3_000_000), inInbox: !m.isSent && !m.isSpam }), 2);
  expect(decided).toBeGreaterThan(1000);
  // every thread is featurized, scored and most get a decision: reported, bounded loosely
  expect(ratio).toBeLessThanOrEqual(1.5);
}, 600_000);
