/**
 * UI performance in a real browser (production build) against the real backend
 * with the 3,000-thread / 4-account demo mailbox. Timings are taken in-page
 * from the keydown/input event to the DOM commit and to the following frames.
 * Budgets scale only via PERF_BUDGET_MULTIPLIER.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, rows, test } from "./fixtures";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
interface Stat { name: string; budgetMs: number; p50: number; p95: number; max: number; iterations: number }
const stats: Stat[] = [];

function stat(name: string, budgetMs: number, samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  const out = { name, budgetMs, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]!, iterations: s.length };
  stats.push(out);
  return out;
}

test.describe.configure({ mode: "serial" });
// motion on (the config forces reduced motion elsewhere): the gates hold with animations running
test.use({ fixedClock: false, reducedMotion: "no-preference" });

/** Render counts from the test build's probe (window.__renders). */
const renders = (page: import("@playwright/test").Page, name: string) => page.evaluate((n) => (window as unknown as { __renders?: Record<string, number> }).__renders?.[n] ?? 0, name);

test.afterAll(() => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../test-results/perf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ui.json"), JSON.stringify({ title: "Renderer UI performance (Chromium, production build)", meta: { threads: 3000, accounts: 4 }, multiplier: MULT, stats }, null, 2));
  const pad = (v: string, n: number) => v.padEnd(n);
  console.log(
    ["\nRenderer UI performance", `${pad("case", 50)} ${pad("p50", 8)} ${pad("p95", 8)} ${pad("max", 8)} budget`, ...stats.map((s) => `${pad(s.name, 50)} ${pad(s.p50.toFixed(2), 8)} ${pad(s.p95.toFixed(2), 8)} ${pad(s.max.toFixed(2), 8)} ${s.budgetMs ? `${s.budgetMs}ms ${s.p95 <= s.budgetMs * MULT ? "✓" : "✗"}` : "(report)"}`)].join("\n"),
  );
});

test("holding j: every move commits within a frame and the DOM stays bounded", async ({ app: page }) => {
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { t0: number; commit: number[]; raf: number[]; paint: number[]; maxRows: number } };
    w.__perf = { t0: 0, commit: [], raf: [], paint: [], maxRows: 0 };
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "j") return;
        const t0 = performance.now();
        w.__perf.t0 = t0;
        requestAnimationFrame(() => {
          w.__perf.raf.push(performance.now() - t0);
          requestAnimationFrame(() => w.__perf.paint.push(performance.now() - t0));
        });
      },
      { capture: true },
    );
    new MutationObserver((records) => {
      if (records.some((r) => r.attributeName === "aria-selected" && (r.target as Element).getAttribute("aria-selected") === "true")) {
        w.__perf.commit.push(performance.now() - w.__perf.t0);
        w.__perf.maxRows = Math.max(w.__perf.maxRows, document.querySelectorAll("[data-testid=thread-row]").length);
      }
    }).observe(document.querySelector("[role=listbox]")!, { attributes: true, subtree: true, attributeFilter: ["aria-selected"] });
  });
  // list navigation never animates: count finite animations started while j is held
  await page.evaluate(() => {
    const w = window as unknown as { __jAnims: number };
    w.__jAnims = 0;
    const seen = new WeakSet<Animation>();
    const tick = () => {
      for (const a of document.getAnimations()) {
        if (seen.has(a) || a.effect?.getTiming().iterations === Infinity) continue;
        seen.add(a);
        w.__jAnims++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const N = 300;
  for (let i = 0; i < N; i++) {
    await page.keyboard.press("j");
    await page.waitForFunction((n) => (window as any).__perf.paint.length >= n, i + 1, { polling: "raf" });
  }
  const r = await page.evaluate(() => (window as any).__perf as { commit: number[]; raf: number[]; paint: number[]; maxRows: number });
  expect(r.commit.length).toBeGreaterThanOrEqual(N - 1); // each press moved the selection
  const commit = stat("j: keydown → selection committed", 16, r.commit);
  stat("j: keydown → next animation frame", 0, r.raf);
  stat("j: keydown → frame after paint (double rAF)", 0, r.paint);
  stats.push({ name: `max DOM rows while navigating: ${r.maxRows}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(commit.p95).toBeLessThanOrEqual(16 * MULT);
  expect(r.maxRows).toBeLessThanOrEqual(60);
  const anims = await page.evaluate(() => (window as unknown as { __jAnims: number }).__jAnims);
  stats.push({ name: `animations started while holding j: ${anims}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(anims).toBe(0);
  // we navigated past the first page: pagination kept up
  expect(await page.locator("[aria-selected=true]").getAttribute("data-thread-id")).not.toBeNull();
});

test("typing a search: each keystroke renders its results fast", async ({ app: page }) => {
  await page.evaluate(() => {
    const w = window as unknown as { __search: { started: Map<string, number>; done: Map<string, number> } };
    w.__search = { started: new Map(), done: new Map() };
    document.querySelector("[data-testid=search-input]")!.addEventListener("input", (e) => {
      w.__search.started.set((e.target as HTMLInputElement).value.trim(), performance.now());
    });
    const list = document.querySelector("[data-testid=thread-list]")!;
    new MutationObserver(() => {
      const key = list.getAttribute("data-results-for");
      if (!key) return;
      // the query is the last element of the list key
      const q = (JSON.parse(key) as unknown[]).at(-1) as string;
      const t0 = w.__search.started.get(q);
      if (t0 !== undefined && !w.__search.done.has(q)) w.__search.done.set(q, performance.now() - t0);
    }).observe(list, { attributes: true, attributeFilter: ["data-results-for"] });
  });
  const queries = ["presupuest", "reunion eq", "factura ub", "propuesta "];
  for (const q of queries) {
    await page.getByTestId("search-input").click();
    await page.keyboard.type(q, { delay: 110 }); // a fast typist, ~9 chars/s
    await expect(page.getByTestId("search-stats")).toBeVisible();
    await page.waitForTimeout(300);
    await page.getByTestId("search-input").fill("");
    await page.waitForTimeout(150);
  }
  const done = await page.evaluate(() => [...(window as any).__search.done.entries()] as [string, number][]);
  const samples = done.filter(([q]) => q.length > 0).map(([, ms]) => ms);
  expect(samples.length).toBeGreaterThanOrEqual(queries.length * 8); // ~10 keystrokes per query rendered
  const s = stat("search: keystroke → results rendered", 100, samples);
  expect(s.p95).toBeLessThanOrEqual(100 * MULT);
});

test("scrolling 2,000 threads deep: pages load quickly and the DOM stays bounded", async ({ app: page }) => {
  await page.getByTestId("nav-all").click();
  await expect(page.getByTestId("list-title")).toHaveText("Todo el correo");
  await expect(rows(page).first()).toBeVisible();
  const result = await page.evaluate(async () => {
    const scroller = document.querySelector("[role=listbox]") as HTMLElement;
    const pageTimes: number[] = [];
    let maxRows = 0;
    const rowH = 68;
    while (scroller.scrollHeight < 2000 * rowH) {
      const before = scroller.scrollHeight;
      const t0 = performance.now();
      scroller.scrollTop = before; // jump to the end of what's loaded
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("next page never loaded")), 5000);
        const check = () => {
          maxRows = Math.max(maxRows, document.querySelectorAll("[data-testid=thread-row]").length);
          if (scroller.scrollHeight > before) {
            clearTimeout(deadline);
            resolve();
          } else requestAnimationFrame(check);
        };
        check();
      });
      pageTimes.push(performance.now() - t0);
    }
    return { pageTimes, maxRows, rows: Math.round(scroller.scrollHeight / rowH) };
  });
  const s = stat("scroll: reach end → next 100 rows rendered", 150, result.pageTimes);
  stats.push({ name: `max DOM rows while scrolling ${result.rows} threads: ${result.maxRows}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(result.rows).toBeGreaterThanOrEqual(2000);
  expect(result.maxRows).toBeLessThanOrEqual(60);
  expect(s.p95).toBeLessThanOrEqual(150 * MULT);
});

test("switching theme: painted within 50 ms, no row re-renders", async ({ app: page }) => {
  await expect(rows(page).first()).toBeVisible();
  const before = await renders(page, "ThreadRow");
  expect(before).toBeGreaterThan(0); // the probe is compiled into this build
  const samples = await page.evaluate(async () => {
    const u = (window as unknown as { __unica: { updateAppearance(p: object): Promise<unknown> } }).__unica;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const out: number[] = [];
    // alternate light/dark and named palettes: mode, data-theme and every color change each time
    const steps = [
      { theme: "dark", darkTheme: "dracula" },
      { theme: "light", lightTheme: "solarized-light" },
      { theme: "dark", darkTheme: "nord" },
      { theme: "light", lightTheme: "unica-light" },
    ];
    for (let i = 0; i < 32; i++) {
      const t0 = performance.now();
      const done = u.updateAppearance(steps[i % steps.length]!);
      await frame();
      await frame(); // the frame after the new colors were painted
      out.push(performance.now() - t0);
      await done;
    }
    return out;
  });
  await page.waitForTimeout(300);
  const after = await renders(page, "ThreadRow");
  const s = stat("theme switch → painted (double rAF)", 50, samples.slice(2));
  stats.push({ name: `ThreadRow renders during 32 theme switches: ${after - before}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(after - before).toBe(0);
  expect(s.p95).toBeLessThanOrEqual(50 * MULT);
});
