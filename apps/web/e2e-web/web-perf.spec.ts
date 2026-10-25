import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Web perf budgets (plan 04 §8) in Chromium on real OPFS (a persistent
 * profile), at 10k and 50k messages. Timings are taken in the page, through
 * the real MessagePort RPC (structured clone included), so they are what
 * the renderer waits for. Run alone: `pnpm test:web-perf`. The storage
 * adapter is WEB_PERF_STORAGE (default: the registry's choice, OPFS SQLite).
 */
const MULTIPLIER = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const STORAGE = process.env.WEB_PERF_STORAGE ?? "";
/** WEB_PERF_DURABLE=1: searches on the durable path only (FTS5 on SQLite, the exact scan on IndexedDB), the fallback the instant index stands in front of */
const DURABLE = process.env.WEB_PERF_DURABLE === "1";
const ITERATIONS = 40;

interface Stat {
  name: string;
  budgetMs: number;
  p50: number;
  p95: number;
  max: number;
  n: number;
  note?: string;
}

/** plan 04 §8, per adapter (IndexedDB loads its tables into memory on open and scans rules over all mail) */
/**
 * Beyond §8: `durable` is a search on the durable path alone (FTS5's one-character prefix on SQLite, the
 * exact scan on IndexedDB), `durableKeystroke` the last keystroke → its results while that path answers,
 * `afterOpen` the first interactions right after a reload (no settling), `concurrent` an interaction while
 * a durable search or an import runs (`importSearch` a search during an import, which on IndexedDB may be
 * the scan), `ingest` the import's minimum throughput (messages/s), `jKey` keydown → selection committed.
 */
const SHARED = { rpc: 3, keystroke: 100, afterOpen: 100, concurrent: 100, ingest: 1000, jKey: 16, action: 16 };
const BUDGETS = {
  opfs: {
    "10k": { ...SHARED, repeatVisit: 600, list: 2, view: 4, search: 10, preview: 50, durable: 60, durableKeystroke: 100, importSearch: 100, firstSearch: 150 },
    "50k": { ...SHARED, repeatVisit: 700, list: 2, view: 6, search: 25, preview: 50, durable: 60, durableKeystroke: 150, importSearch: 100, firstSearch: 150 },
  },
  // IndexedDB has no FTS: whenever the index isn't current (right after open, during an import, while it builds) the exact scan answers
  idb: {
    "10k": { ...SHARED, repeatVisit: 600, list: 2, view: 4, search: 10, preview: 150, durable: 400, durableKeystroke: 1500, importSearch: 600, firstSearch: 600 },
    "50k": { ...SHARED, repeatVisit: 900, list: 2, view: 4, search: 25, preview: 600, durable: 1500, durableKeystroke: 3000, importSearch: 2500, firstSearch: 2500 },
  },
} as const;
const ADAPTER = STORAGE === "idb" ? "idb" : "opfs";

const SIZES = [
  // demo threads → messages (8 accounts): 5,700 → ~10.1k, 28,400 → ~50.1k
  { label: "10k", threads: 5700, budgets: BUDGETS[ADAPTER]["10k"] },
  { label: "50k", threads: 28_400, budgets: BUDGETS[ADAPTER]["50k"] },
] as const;

const SEARCHES = ["factura", "reunion", "propu", "p", "from:github is:unread", "presupuesto has:attachment", '"hola equipo"', "-hola factura"];

function stat(name: string, budgetMs: number, samples: number[], note?: string): Stat {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { name, budgetMs, p50: q(0.5), p95: q(0.95), max: s.at(-1)!, n: s.length, note };
}

/** Times an RPC from the page, end to end (n samples after warmup). */
async function rpc(page: Page, method: string, params: unknown, n = ITERATIONS): Promise<number[]> {
  return page.evaluate(
    async ({ method, params, n }) => {
      const call = (window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<unknown> }).call.bind(window.__ternoWeb!.client);
      for (let i = 0; i < 5; i++) await call(method, params);
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        await call(method, params);
        out.push(performance.now() - t);
      }
      return out;
    },
    { method, params, n },
  );
}

type Call = [method: string, params: unknown];

/** a few different RPCs, each timed */
async function rpcBatch(page: Page, calls: Call[]): Promise<number[]> {
  return page.evaluate(async (calls) => {
    const c = window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<unknown> };
    const out: number[] = [];
    for (const [m, p] of calls) {
      const t = performance.now();
      await c.call(m, p);
      out.push(performance.now() - t);
    }
    return out;
  }, calls);
}

/** times `probe` repeatedly while `method` runs (at least 5 samples) */
async function whileRunning(page: Page, method: string, params: unknown, probe: Call): Promise<number[]> {
  return page.evaluate(
    async ({ method, params, probe }) => {
      const c = window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<unknown> };
      let running = true;
      const slow = c.call(method, params).finally(() => (running = false));
      const out: number[] = [];
      while (running || out.length < 5) {
        const t = performance.now();
        await c.call(probe[0], probe[1]);
        out.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 5));
      }
      await slow;
      return out;
    },
    { method, params, probe },
  );
}

async function whileImporting(page: Page, threads: number) {
  return page.evaluate(async (threads) => {
    const w = window.__ternoWeb!;
    const c = w.client as unknown as { call(m: string, p: unknown): Promise<{ items?: { id: number }[]; strategy?: string }> };
    const thread = (await c.call("threads.list", { view: "inbox", limit: 5 })).items![2]!.id;
    let running = true;
    const job = w.importMail(threads, Date.now() % 1_000_000).finally(() => (running = false));
    const out = { list: [] as number[], open: [] as number[], search: [] as number[], strategies: new Set<string>() };
    const time = async (into: number[], m: string, p: unknown) => {
      const t = performance.now();
      const r = await c.call(m, p);
      into.push(performance.now() - t);
      return r;
    };
    while (running || out.list.length < 5) {
      await time(out.list, "threads.list", { view: "inbox", limit: 100 });
      await time(out.open, "threads.get", { threadId: thread });
      const r = await time(out.search, "threads.search", { query: "factura", limit: 100 });
      out.strategies.add(String(r.strategy).split(":")[0]);
      await new Promise((r) => setTimeout(r, 20));
    }
    const done = await job;
    return { ...out, strategies: [...out.strategies], messages: done.messages, ms: done.ms };
  }, threads);
}

/** holds j over the list: keydown → the row's selection committed, per press */
async function holdJ(page: Page, presses: number): Promise<number[]> {
  // Lumen (a new install's design) mounts the field only while search is open
  if (await page.getByTestId("search-input").isVisible()) await page.getByTestId("search-input").fill("");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => {
    const w = window as unknown as { __j: { t0: number; commit: number[] } };
    w.__j = { t0: 0, commit: [] };
    document.addEventListener("keydown", (e) => e.key === "j" && (w.__j.t0 = performance.now()), { capture: true });
    new MutationObserver((records) => {
      if (records.some((r) => r.attributeName === "aria-selected" && (r.target as Element).getAttribute("aria-selected") === "true")) w.__j.commit.push(performance.now() - w.__j.t0);
    }).observe(document.querySelector("[role=listbox]")!, { attributes: true, subtree: true, attributeFilter: ["aria-selected"] });
  });
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("j");
    await page.waitForFunction((n) => (window as unknown as { __j: { commit: number[] } }).__j.commit.length >= n, i + 1, { polling: "raf" });
  }
  return page.evaluate(() => (window as unknown as { __j: { commit: number[] } }).__j.commit);
}

let importRate = "";

const mailboxUrl = (size: (typeof SIZES)[number]) => `/?mailbox=perf-${size.label}&demo=${size.threads}&accounts=8${STORAGE ? `&storage=${STORAGE}` : ""}${DURABLE ? "&instant=0" : ""}`;

/** Navigation start → the first thread row in the DOM, recorded by the page itself. */
async function firstRowMs(page: Page): Promise<number> {
  await page.waitForFunction(() => (window as unknown as { __firstRow?: number }).__firstRow !== undefined, null, { timeout: 120_000, polling: 50 });
  return page.evaluate(() => (window as unknown as { __firstRow: number }).__firstRow);
}

async function installProbes(context: BrowserContext) {
  await context.addInitScript(() => {
    const seen = () => {
      if (document.querySelector("[data-testid=thread-row]")) {
        (window as unknown as { __firstRow?: number }).__firstRow ??= performance.now();
        return true;
      }
      return false;
    };
    new MutationObserver((_m, observer) => seen() && observer.disconnect()).observe(document, { childList: true, subtree: true });
  });
}

/** Waits until the instant index answers (or reports why it doesn't): the steady state the budgets describe. */
async function waitForInstant(page: Page): Promise<string> {
  let strategy = "";
  // the steady state: after open the backend loads (or rebuilds) its categorization model in background slices
  await page.waitForTimeout(4000);
  if (DURABLE) return "durable";
  for (let i = 0; i < 240; i++) {
    strategy = await page.evaluate(async () => {
      const r = (await (window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<{ strategy: string }> }).call("threads.search", { query: "factura", limit: 100 })) as { strategy: string };
      return r.strategy;
    });
    if (strategy.startsWith("instant")) return strategy;
    await page.waitForTimeout(500);
  }
  return strategy;
}

const results: { size: string; storage: string; load: number[]; seedMs: number | null; threads: number; stats: Stat[]; cache: unknown }[] = [];

test.afterAll(() => {
  const dir = join(process.cwd(), "..", "..", "test-results", "perf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `web-perf${STORAGE ? `-${STORAGE}` : ""}${DURABLE ? "-durable" : ""}.json`), JSON.stringify({ multiplier: MULTIPLIER, results }, null, 2));
  for (const r of results) {
    console.log(`\nweb-perf ${r.size} (${r.storage}, ${r.threads} demo threads, seed ${r.seedMs ?? "reused"} ms, load ${r.load.map((l) => l.toFixed(1)).join(" ")})`);
    for (const s of r.stats) console.log(`${s.name.padEnd(48)} ${s.p50.toFixed(2).padStart(8)} ${s.p95.toFixed(2).padStart(8)} ${s.max.toFixed(2).padStart(8)}  ≤ ${s.budgetMs} ms ${s.p95 <= s.budgetMs * MULTIPLIER ? "✓" : "✗"}${s.note ? `  ${s.note}` : ""}`);
    console.log(`cache: ${JSON.stringify(r.cache)}`);
  }
});

test("cold first visit: the shell is interactive within 1.5 s", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const t = Date.now();
  await page.goto(`/?demo=0&mailbox=perf-cold${STORAGE ? `&storage=${STORAGE}` : ""}`);
  await page.locator("[data-ready]").waitFor();
  const ms = await page.evaluate(() => performance.now());
  results.push({ size: "cold", storage: STORAGE || "default", load: loadavg(), seedMs: null, threads: 0, stats: [stat("cold first visit → shell interactive", 1500, [ms], `wall ${Date.now() - t} ms`)], cache: null });
  expect(ms).toBeLessThanOrEqual(1500 * MULTIPLIER);
  await context.close();
});

for (const size of SIZES) {
  test(`${size.label} messages on ${STORAGE || "the default storage"}: repeat visit, lists, views, search, actions, preview`, async () => {
    test.setTimeout(1_800_000);
    const dir = mkdtempSync(join(tmpdir(), "terno-web-perf-"));
    const context = await chromium.launchPersistentContext(dir, { viewport: { width: 1440, height: 900 }, locale: "es-MX", timezoneId: "America/Mexico_City", reducedMotion: "reduce", baseURL: test.info().project.use.baseURL });
    try {
      await installProbes(context);
      const page = context.pages()[0] ?? (await context.newPage());
      const seedStarted = Date.now();
      await page.goto(mailboxUrl(size));
      await page.getByTestId("thread-row").first().waitFor({ timeout: 1_200_000 });
      const info = await page.evaluate(() => window.__ternoWeb!);
      const seedMs = info.timings.seed ?? null;
      const strategy = await waitForInstant(page);
      // the snapshot is written after a build; give it a moment, then measure a real repeat visit
      await page.waitForTimeout(1500);
      const stats: Stat[] = [];
      const visits: number[] = [];
      const afterOpen: number[] = [];
      const firstSearch: number[] = [];
      for (let i = 0; i < 5; i++) {
        await page.reload();
        visits.push(await firstRowMs(page));
        // what a user does first, while the backend is still starting its background work
        const [list, counts, search, inbox] = await rpcBatch(page, [["threads.list", { view: "all", limit: 100 }], ["counts.get", {}], ["threads.search", { query: "factura", limit: 100 }], ["threads.list", { view: "inbox", limit: 100 }]]);
        afterOpen.push(list!, counts!, inbox!);
        firstSearch.push(search!);
      }
      stats.push(stat("repeat visit → first mail painted", size.budgets.repeatVisit, visits, `seeded in ${Math.round((Date.now() - seedStarted) / 1000)} s`));
      stats.push(stat("first lists and counts after open (RPC)", size.budgets.afterOpen, afterOpen));
      stats.push(stat("first search after open (RPC)", size.budgets.firstSearch, firstSearch));
      await waitForInstant(page);

      const counts = (await page.evaluate(async () => (window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<unknown> }).call("app.bootstrap", {}))) as { categories: { id: number }[]; accounts: { id: number }[] };
      const firstPage = (await page.evaluate(async () => (window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<unknown> }).call("threads.list", { view: "all", limit: 100 }))) as { items: { id: number }[]; nextCursor: unknown };
      let cursor: unknown = firstPage.nextCursor;
      for (let i = 0; i < 30 && cursor; i++) {
        const p = (await page.evaluate(async (c) => (window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<unknown> }).call("threads.list", { view: "all", limit: 100, cursor: c }), cursor)) as { nextCursor: unknown };
        cursor = p.nextCursor ?? cursor;
        if (!p.nextCursor) break;
      }
      stats.push(stat("list inbox, first page (100 rows, RPC)", size.budgets.list, await rpc(page, "threads.list", { view: "inbox", limit: 100 })));
      stats.push(stat("list all, deep keyset page (RPC)", size.budgets.list, await rpc(page, "threads.list", { view: "all", limit: 100, cursor })));
      stats.push(stat("category view (RPC)", size.budgets.view, await rpc(page, "threads.list", { view: "all", categoryId: counts.categories[0]!.id, limit: 100 })));
      stats.push(stat("sidebar counts (RPC)", size.budgets.view, await rpc(page, "counts.get", {})));
      stats.push(stat("open thread (RPC)", size.budgets.view, await rpc(page, "threads.get", { threadId: firstPage.items[3]!.id })));
      // every number here includes the RPC round trip and the structured clone of the answer; the transport with a tiny one:
      stats.push(stat("RPC round trip (owner identity)", size.budgets.rpc, await rpc(page, "identity.get", {})));

      const before = await page.evaluate(() => window.__ternoWeb!.cacheStatus());
      const strategies = new Set<string>();
      for (const query of SEARCHES) {
        const samples = await rpc(page, "threads.search", { query, limit: 100 }, 25);
        const r = (await page.evaluate(async (q) => (window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<{ strategy: string }> }).call("threads.search", { query: q, limit: 100 }), query)) as { strategy: string };
        strategies.add(r.strategy.split(":")[0]!);
        // the durable path alone: FTS5's one-character prefix and IndexedDB's exact scan have their own (finite) budgets
        const durable = DURABLE && (query.length === 1 || STORAGE === "idb");
        stats.push(stat(`search ${query} (RPC)`, durable ? size.budgets.durable : size.budgets.search, samples, r.strategy));
      }
      const after = await page.evaluate(() => window.__ternoWeb!.cacheStatus());
      if (DURABLE) {
        // the index is unavailable: lists keep answering while a search that reads every message runs
        stats.push(stat("list while a durable search runs (RPC)", size.budgets.concurrent, await whileRunning(page, "threads.search", { query: "presupuesto zzqxjv", limit: 100 }, ["threads.list", { view: "inbox", limit: 100 }])));
      }

      // a user action: archive and restore, each one store command with its op (a durable commit each)
      const target = firstPage.items[0]!.id;
      const actions = await page.evaluate(
        async ({ id, n }) => {
          const c = window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<unknown> };
          const out: number[] = [];
          for (let i = 0; i < n; i++) {
            const t = performance.now();
            await c.call("threads.act", { threadIds: [id], action: i % 2 ? "moveToInbox" : "archive" });
            out.push(performance.now() - t);
          }
          return out;
        },
        { id: target, n: 20 },
      );
      stats.push(stat("user action commit (archive / restore, RPC)", size.budgets.action, actions));
      stats.push(
        stat(
          "filter preview over all mail (RPC)",
          size.budgets.preview,
          await rpc(page, "filters.preview", { rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "factura" }], actions: [{ type: "archive" }] } }, 15),
        ),
      );

      // the renderer: keystroke → results rendered (as the desktop UI perf gate measures it); "/" opens Lumen's field first
      if (!(await page.getByTestId("search-input").isVisible())) {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press("/");
      }
      await page.evaluate(() => {
        const w = window as unknown as { __search: { started: Map<string, number>; done: Map<string, number> } };
        w.__search = { started: new Map(), done: new Map() };
        document.querySelector("[data-testid=search-input]")!.addEventListener("input", (e) => w.__search.started.set((e.target as HTMLInputElement).value.trim(), performance.now()));
        const list = document.querySelector("[data-testid=thread-list]")!;
        new MutationObserver(() => {
          const key = list.getAttribute("data-results-for");
          if (!key) return;
          const q = (JSON.parse(key) as unknown[]).at(-1) as string;
          const t0 = w.__search.started.get(q);
          if (t0 !== undefined && !w.__search.done.has(q)) w.__search.done.set(q, performance.now() - t0);
        }).observe(list, { attributes: true, attributeFilter: ["data-results-for"] });
      });
      for (const q of ["presupuest", "reunion eq", "factura ub", "propuesta "]) {
        await page.getByTestId("search-input").click();
        await page.keyboard.type(q, { delay: 110 });
        await expect(page.getByTestId("search-stats")).toBeVisible();
        await page.waitForTimeout(300);
        await page.getByTestId("search-input").fill("");
        await page.waitForTimeout(150);
      }
      const typed = ["presupuest", "reunion eq", "factura ub", "propuesta "];
      const done = new Map(await page.evaluate(() => [...(window as unknown as { __search: { done: Map<string, number> } }).__search.done.entries()]));
      // the exact scan (IndexedDB's durable path) is slower than typing: superseded keystrokes never render, so the gate is the
      // last keystroke of each query → its results
      const scanOnly = DURABLE && STORAGE === "idb";
      const keystrokes = scanOnly ? typed.map((q) => done.get(q.trim()) ?? Infinity) : [...done].filter(([q]) => q.length > 0).map(([, ms]) => ms);
      expect(keystrokes.length).toBeGreaterThanOrEqual(scanOnly ? typed.length : 30);
      stats.push(stat(scanOnly ? "last keystroke → its results rendered (exact scan)" : "keystroke → results rendered", scanOnly ? size.budgets.durableKeystroke : size.budgets.keystroke, keystrokes));

      // holding j in the list: keydown → selection committed
      stats.push(stat("j: keydown → selection committed", size.budgets.jKey, await holdJ(page, 100)));

      // an import (a sync): its pace on its own, then interactions while another one runs
      const alone = await page.evaluate(async () => window.__ternoWeb!.importMail(1500, 7));
      const rate = alone.messages / (alone.ms / 1000);
      const imported = await whileImporting(page, 1500);
      stats.push(stat("list during an import (RPC)", size.budgets.concurrent, imported.list));
      stats.push(stat("open thread during an import (RPC)", size.budgets.concurrent, imported.open));
      stats.push(stat("search during an import (RPC)", size.budgets.importSearch, imported.search, imported.strategies.join(" ")));
      importRate = `${alone.messages} messages at ${Math.round(rate)} msgs/s alone, ${Math.round(imported.messages / (imported.ms / 1000))} msgs/s while interacting`;
      const importTooSlow = rate * MULTIPLIER < size.budgets.ingest ? [`import throughput: ${Math.round(rate)} < ${size.budgets.ingest} messages/s`] : [];

      const cache =
        before && after
          ? { hotMiB: +(after.hotBytes / 2 ** 20).toFixed(1), cacheMiB: +(after.cacheBytes / 2 ** 20).toFixed(1), usedMiB: +(after.usedBytes / 2 ** 20).toFixed(1), searchMissRatio: +((after.miss - before.miss) / Math.max(1, after.hit - before.hit + after.miss - before.miss)).toFixed(4) }
          : null;
      results.push({ size: size.label, storage: info.storage ?? "?", load: loadavg(), seedMs, threads: size.threads, stats, cache: { ...cache, strategy, searchStrategies: [...strategies], import: importRate } });
      if (cache) expect(cache.searchMissRatio, "page cache misses while searching").toBeLessThan(0.05);
      const over = [...stats.filter((s) => s.p95 > s.budgetMs * MULTIPLIER).map((s) => `${s.name}: p95 ${s.p95.toFixed(2)} > ${s.budgetMs}`), ...importTooSlow];
      expect(over).toEqual([]);
    } finally {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
