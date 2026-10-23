/**
 * Instant search gates at the 51k-message perf mailbox (plan 03 §8, the
 * 03/04 reconciliation): the background build (time, memory, event-loop
 * stalls), every keystroke of type-ahead cold and warm, phrases including
 * the rarely-adjacent ones the FTS5 doclist settles, the store's whole search
 * path, incremental apply, snapshots and compaction. Budgets are p95 unless
 * stated, scaled only by PERF_BUDGET_MULTIPLIER.
 */
import { parseSearch, resolveSearch } from "@unica/core";
import { generateDataset } from "@unica/mock-data";
import type { Revision, SearchMessageDoc } from "@unica/store";
import { InstantSearchEngine } from "@unica/store/instant";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodePlatform, openDatabase } from "./index";
import { ftsTermMessages, loadScope } from "./search";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, measure, measureAsync, report, type Stat } from "./test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const MiB = 1024 * 1024;
const gc = (globalThis as { gc?: () => void }).gc;
let dir: string;
let path: string;
let store: SqlMailStore;
let engine: InstantSearchEngine;
let head: Revision;
const stats: Stat[] = [];
const meta: Record<string, unknown> = {};

/** heap + array buffers after full collections (array buffers are freed lazily: settle, then collect again) */
const heap = async () => {
  for (let i = 0; i < 3; i++) {
    gc?.();
    await new Promise((r) => setTimeout(r, 50));
  }
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
const note = (name: string, value: number, unit = "ms") =>
  stats.push({ name: name.startsWith("build attempt") ? name : `${name}: ${value.toFixed(unit === "ms" ? 1 : 2)} ${unit}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });

function gate(s: Stat): Stat {
  stats.push(s);
  expect(s.p95, `${s.name} p95 ${s.p95.toFixed(3)}ms > ${s.budgetMs}ms`).toBeLessThanOrEqual(s.budgetMs * BUDGET_MULTIPLIER);
  return s;
}

function samplesStat(name: string, budgetMs: number, samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { name, budgetMs, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]!, iterations: s.length };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "unica-instant-perf-"));
  path = join(dir, "perf.db");
  const seed = new SqlMailStore(openDatabase(path));
  const seeded = await seed.dev.seed(generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 4 }), { now: NOW });
  meta.messages = seeded.messageCount;
  meta.threads = seeded.threadCount;
  expect(seeded.messageCount).toBeGreaterThanOrEqual(50_000);
  await seed.close();
});

afterAll(async () => {
  report("instant.json", "Instant search (51k messages)", meta, stats);
  await store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("build", () => {
  it("builds off the interactive path: time and memory reported, no event-loop stall > 16 ms, ≤ 64 MiB", async () => {
    // A stall our code causes repeats on every build; one from another process preempting this one
    // doesn't. Gate the best of up to three fresh builds and report every attempt (and the load).
    const attempts: number[] = [];
    let before = 0;
    let wall = 0;
    for (let attempt = 0; attempt < 3 && !(attempts.length && Math.min(...attempts) <= 16 * BUDGET_MULTIPLIER); attempt++) {
      if (store) await store.close();
      rmSync(`${path}.search`, { force: true });
      before = await heap();
      const lag = monitorEventLoopDelay({ resolution: 1 });
      const started = performance.now();
      // opening the database is synchronous startup work, not the background build
      store = new SqlMailStore(openDatabase(path), { instantSearch: true, platform: nodePlatform });
      lag.enable();
      expect(await store.instant!.settled(300_000)).toBe(true);
      wall = performance.now() - started;
      // the first snapshot follows the build in the background: part of the same window
      for (let i = 0; i < 3000 && !store.instant!.report.snapshot; i++) await new Promise((r) => setTimeout(r, 10));
      lag.disable();
      expect(store.instant!.report.snapshot).toBeDefined();
      attempts.push(lag.max / 1e6);
      note(`build attempt ${attempt + 1}: open → index current ${wall.toFixed(0)} ms, stall max ${(lag.max / 1e6).toFixed(1)} ms, p99 ${(lag.percentile(99) / 1e6).toFixed(1)} ms, load ${loadavg()[0]!.toFixed(1)}`, wall);
    }
    head = await store.feed.head();
    engine = store.instant!.at(head)!;
    expect(engine).toBeTruthy();
    const after = await heap();
    const allocated = engine.allocatedBytes();
    const s = engine.stats();
    meta.terms = s.terms;
    meta.postings = s.postings;
    meta.load = loadavg()[0]!.toFixed(1);
    note("build: open → index current (wall, sliced)", wall);
    note("build + first snapshot: event-loop stall, best attempt's max", Math.min(...attempts));
    note("index memory, engine accounting", allocated / MiB, "MiB");
    if (gc) note("index memory, measured heap + array buffers", (after - before) / MiB, "MiB");
    note("index bytes per message", allocated / s.messages, "B");
    expect(Math.min(...attempts), "event-loop stall during the build").toBeLessThanOrEqual(16 * BUDGET_MULTIPLIER);
    expect(allocated).toBeLessThanOrEqual(64 * MiB);
    if (gc) expect(after - before).toBeLessThanOrEqual(64 * MiB);
  }, 600_000);
});

describe("queries (engine)", () => {
  const q = (text: string, limit = 100) => engine.search({ search: resolveSearch(parseSearch(text, NOW), text, {}, loadScope(store.db)), limit }, head);

  it("type-ahead: every keystroke ≤ 2 ms on a cold cache, ≤ 1 ms warm", () => {
    const typed = "presupuesto";
    const cold: number[][] = Array.from({ length: typed.length }, () => []);
    for (let session = 0; session < 40; session++) {
      engine.dropCaches();
      for (let i = 1; i <= typed.length; i++) {
        const t = performance.now();
        q(typed.slice(0, i));
        cold[i - 1]!.push(performance.now() - t);
      }
    }
    for (let i = 1; i <= typed.length; i++) gate(samplesStat(`instant cold keystroke "${typed.slice(0, i)}"`, 2, cold[i - 1]!));
    for (let i = 1; i <= typed.length; i++) gate(measure(`instant warm keystroke "${typed.slice(0, i)}"`, 1, () => q(typed.slice(0, i))));
  });

  it.each([
    ["common word", "factura"],
    ["very common word", "hola"],
    ["accented word", "reunión"],
    ["rare word", "tokio"],
    ["two words", "propuesta presupuesto"],
    ["word + prefix", "propuesta pre"],
    ["zero results", "zzqxjv"],
    ["sender address", "from:crew@morningbrew.com"],
    ["sender name + text", "from:lucia factura"],
    ["text + negation", "factura -uber"],
    ["field + negation", "to:luis factura -hola"],
    ["negation only", "-factura"],
    ["text in inbox, unread", "in:inbox is:unread pedido"],
    ["has attachment + date range", "has:attachment after:180d"],
    ["old mail by date", "before:2025-03-01"],
    ["category + text", "category:facturas uber"],
    ["account + text", "account:acme propuesta"],
  ])("%s ≤ 1 ms warm", (label, text) => {
    const s = gate(measure(`instant: ${label} — ${text}`, 1, () => q(text)));
    s.note = engine.lastStrategy;
  });

  it.each([['"darse de baja"'], ['"de la"'], ['"hola equipo"'], ['"baja darse"'], ['"propuesta de presupuesto"'], ['subject:"re factura"']])("phrase %s ≤ 5 ms", (text) => {
    const s = gate(measure(`instant phrase ${text}`, 5, () => q(text)));
    s.note = engine.lastStrategy;
  });
});

describe("the store's search path", () => {
  it("type-ahead through threads.searchText (resolve + engine + hydrate) ≤ 5 ms per keystroke", async () => {
    const typed = "presupuesto";
    for (let i = 1; i <= typed.length; i++) {
      const s = gate(await measureAsync(`store search keystroke "${typed.slice(0, i)}"`, 5, () => store.threads.searchText({ query: typed.slice(0, i), limit: 100, now: NOW })));
      const page = await store.threads.searchText({ query: typed.slice(0, i), limit: 100, now: NOW });
      expect(page.strategy).toMatch(/^instant/);
      s.note = `${page.items.length} rows`;
    }
  });
});

describe("updates, snapshots, compaction", () => {
  it("incremental apply ≤ 0.2 ms per message; snapshot written and restored", async () => {
    const packLag = monitorEventLoopDelay({ resolution: 1 });
    packLag.enable();
    const t0 = performance.now();
    const bytes = await engine.snapshot();
    note("snapshot: pack + checksum (sliced)", performance.now() - t0);
    packLag.disable();
    note("snapshot: event-loop stall, max (the synchronous copy)", packLag.max / 1e6);
    note("snapshot size", bytes.length / MiB, "MiB");
    const lag = monitorEventLoopDelay({ resolution: 1 });
    lag.enable();
    const copy = new InstantSearchEngine({ yield: nodePlatform.yield, identity: store.instant!["o"].identity, phrases: (term) => ftsTermMessages(store.db, term) });
    const r0 = performance.now();
    expect(await copy.restore(bytes, true)).toBe(true);
    note("snapshot restore (decode + maps, sliced)", performance.now() - r0);
    lag.disable();
    note("snapshot restore: event-loop stall, max", lag.max / 1e6);
    await store.instant!.close();
    note("snapshot file on close", statSync(`${path}.search`).size / MiB, "MiB");
    if (store.instant!.report.snapshot) note("snapshot write in the background (wall: pack, checksum, write, rename)", store.instant!.report.snapshot.ms);

    // a separate copy takes new mail one message per batch, as sync delivers it
    const extra = generateDataset({ threads: 400, accounts: 8, seed: 77, now: NOW, bodyScale: 4 }).messages;
    let rev = copy.revision!;
    let id = 50_000_000;
    const samples: number[] = [];
    for (const m of extra) {
      const doc: SearchMessageDoc = {
        messageId: id++,
        threadId: 50_000_000 + samples.length,
        accountId: 1,
        date: m.date,
        subject: m.subject,
        fromText: `${m.from.name} ${m.from.email}`,
        fromEmail: m.from.email,
        recipients: m.to.map((a) => `${a.name} ${a.email}`).join(", "),
        body: m.bodyText,
        hasAttachments: m.hasAttachments,
        bodyState: "full",
      };
      const to = { epoch: rev.epoch, seq: rev.seq + 1 };
      const changes = [
        { kind: "upsertMessage" as const, doc },
        { kind: "upsertThread" as const, doc: { threadId: doc.threadId, accountId: 1, lastDate: m.date, inInbox: true, hasSent: false, inTrash: false, inSpam: false, isStarred: false, unreadCount: 1, categoryIds: [] } },
      ];
      const t = performance.now();
      await copy.apply({ from: rev, to, changes });
      samples.push(performance.now() - t);
      rev = to;
    }
    gate(samplesStat("instant: apply one new message (+ its thread)", 0.2, samples));

    const c0 = performance.now();
    const compacted = await copy.compacted();
    note("compaction (from the forward index, sliced)", performance.now() - c0);
    expect(compacted.stats().messages).toBe(copy.stats().messages);
  }, 300_000);
});
