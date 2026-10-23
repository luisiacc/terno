/**
 * Interactive latency under background load: list/search/open RPCs through the
 * real envelope while a large import and a bulk filter run in time slices.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@unica/core/rpc";
import { seedDataset, type IncomingMessage, sqlDb, type SqlMailStore } from "@unica/db";
import { demoRegistry } from "@unica/mail";
import { generateDataset } from "@unica/mock-data";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
let backend: Backend;
let client: RpcClient;
let dir: string;
let accountIds: number[];
const stats: Stat[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "unica-bperf-"));
  backend = new Backend({ dbPath: join(dir, "sqlDb(b.store)"), version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, instantSearch: true });
  accountIds = seedDataset(sqlDb(backend.store), generateDataset({ threads: 20_000, accounts: 8, seed: 5, now: NOW, bodyScale: 3 }), { now: NOW }).accountIds;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  client = new RpcClient(c);
  // the instant index builds in the background after startup; idle numbers are taken once it is current
  expect(await (backend.store as SqlMailStore).instant!.settled()).toBe(true);
}, 120_000);

afterAll(async () => {
  report("backend.json", "Backend RPC latency", { threads: 20_000, accounts: 8 }, stats);
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

function percentile(samples: number[], p: number) {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
}

it("idle: RPC round trip adds little over the query itself", async () => {
  const run = async (label: string, budget: number, fn: () => Promise<unknown>) => {
    for (let i = 0; i < 5; i++) await fn();
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      await fn();
      samples.push(performance.now() - t);
    }
    const s: Stat = { name: label, budgetMs: budget, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples), iterations: 60 };
    stats.push(s);
    expect(s.p95).toBeLessThanOrEqual(budget * BUDGET_MULTIPLIER);
  };
  await run("rpc: list inbox (100 rows)", 3, () => client.call("threads.list", { view: "inbox" }));
  const ids = (await client.call("threads.list", { view: "inbox" })).items.map((t) => t.id);
  let i = 0;
  await run("rpc: open thread", 2, () => client.call("threads.get", { threadId: ids[i++ % ids.length]! }));
  await run("rpc: search 'factura'", 25, () => client.call("threads.search", { query: "factura" }));
  // type-ahead end to end (handler yield, parse, resolve, instant engine, hydrate 100 rows, envelope)
  const typed = "presupuesto";
  for (let i = 1; i <= typed.length; i++) {
    await run(`rpc: type-ahead search "${typed.slice(0, i)}"`, 5, () => client.call("threads.search", { query: typed.slice(0, i) }));
    expect((await client.call("threads.search", { query: typed.slice(0, i) })).strategy).toMatch(/^instant/);
  }
  await run("rpc: sidebar counts", 5, () => client.call("counts.get", {}));
  // boot path: settings now carry AI profiles and owner identity, which must not slow the first paint
  await run("rpc: app.bootstrap", 8, () => client.call("app.bootstrap", {}));
  const boot = await client.call("app.bootstrap", {});
  const settingsBytes = JSON.stringify(boot.settings).length;
  stats.push({ name: `wire size of bootstrap settings: ${settingsBytes} bytes`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(settingsBytes).toBeLessThan(2_000);
  // payload budget: a page of 100 rows must stay small on the wire
  const bytes = JSON.stringify(await client.call("threads.list", { view: "inbox" })).length;
  stats.push({ name: `wire size of a 100-row page: ${bytes} bytes`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(bytes).toBeLessThan(60_000);
});

it("under load: interactive RPCs stay responsive during a 15k-message import + bulk filter", async () => {
  const extra = generateDataset({ threads: 8_000, accounts: 8, seed: 99, now: NOW, bodyScale: 3 }).messages.map(
    (m): IncomingMessage => ({ ...m, providerMsgId: `bg-${m.providerMsgId}`, rfcMessageId: `bg-${m.rfcMessageId}`, references: m.references.map((r) => `bg-${r}`), inReplyTo: m.inReplyTo ? `bg-${m.inReplyTo}` : null, accountId: accountIds[m.accountIndex]! }),
  );
  const filter = await client.call("filters.save", {
    name: "bulk",
    enabled: false,
    source: "manual",
    rule: { match: "any", conditions: [{ field: "subject", op: "contains", value: "factura" }, { field: "fromDomain", op: "endsWith", value: ".com" }], actions: [{ type: "markRead" }] },
  });
  const ids = (await client.call("threads.list", { view: "all" })).items.map((t) => t.id);
  let done = false;
  const list: number[] = [];
  const search: number[] = [];
  const open: number[] = [];
  // sampling starts right after submission: a stall while jobs start up is measured too
  const started = performance.now();
  const background = Promise.all([backend.ingestSliced(extra), client.call("filters.apply", { id: filter.id })]).then(() => {
    done = true;
  });
  let k = 0;
  while (!done) {
    let t = performance.now();
    await client.call("threads.list", { view: "inbox" });
    list.push(performance.now() - t);
    t = performance.now();
    await client.call("threads.search", { query: ["reunión", "factura", "pedido", "propuesta"][k % 4]! });
    search.push(performance.now() - t);
    t = performance.now();
    await client.call("threads.get", { threadId: ids[k++ % ids.length]! });
    open.push(performance.now() - t);
  }
  await background;
  const total = performance.now() - started;
  const add = (name: string, budget: number, xs: number[]) => {
    const s: Stat = { name, budgetMs: budget, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: Math.max(...xs), iterations: xs.length };
    stats.push(s);
    return s;
  };
  const sl = add("during import: list inbox", 20, list);
  const ss = add("during import: search", 45, search);
  const so = add("during import: open thread", 20, open);
  stats.push({ name: `background work took ${(total / 1000).toFixed(1)}s for ${extra.length} msgs + bulk filter`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(list.length).toBeGreaterThan(30); // interactive calls actually interleaved
  expect(sl.p95).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
  expect(ss.p95).toBeLessThanOrEqual(45 * BUDGET_MULTIPLIER);
  expect(so.p95).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
});
