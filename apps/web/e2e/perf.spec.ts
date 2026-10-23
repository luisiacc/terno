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

test("dragging rows to the sidebar: starts within a frame, no row renders, two NavItems per target change", async ({ app: page, server }) => {
  const cats = server.backend.db.all<{ id: number }>("SELECT id FROM categories ORDER BY position");
  const row = rows(page).nth(2);
  const b = (await row.boundingBox())!;
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const targets: { x: number; y: number }[] = [];
  for (const c of cats) {
    const t = (await page.getByTestId(`nav-category-${c.id}`).boundingBox())!;
    targets.push({ x: t.x + t.width / 2, y: t.y + t.height / 2 });
  }
  // pressing a row selects it (two rows render, as with j): select it first so the window below is the drag alone
  await row.dispatchEvent("mousedown");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(100);
  await page.evaluate(() => performance.clearMeasures());
  const rows0 = await renders(page, "ThreadRow");
  const nav0 = await renders(page, "NavItem");
  const DRAGS = 30;
  let changes = 0;
  for (let i = 0; i < DRAGS; i++) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 3, from.y + 1);
    await page.mouse.move(from.x + 8, from.y + 2); // crosses the 4 px threshold
    for (const t of targets) {
      await page.mouse.move(t.x, t.y - 4);
      await page.mouse.move(t.x, t.y + 4); // a second move on the same target: no change
      changes++;
    }
    await page.mouse.move(from.x, from.y, { steps: 3 }); // off every target
    changes++;
    await page.keyboard.press("Escape");
    await page.mouse.up();
  }
  await page.waitForTimeout(200);
  const rowRenders = (await renders(page, "ThreadRow")) - rows0;
  const navRenders = (await renders(page, "NavItem")) - nav0;
  const m = await page.evaluate(() => {
    const d = (name: string) => performance.getEntriesByName(name).map((e) => e.duration);
    return { start: d("drag:start"), frame: d("drag:start-frame"), paint: d("drag:start-paint"), move: d("drag:move"), missed: d("drag:start-frame-missed").length };
  });
  // the display's frame interval: the paint budget is one frame (16 ms), or one frame of a slower display
  const interval = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const t: number[] = [];
        const step = (now: number) => (t.push(now), t.length < 31 ? requestAnimationFrame(step) : resolve((t[30]! - t[0]!) / 30));
        requestAnimationFrame(step);
      }),
  );
  const paintBudget = Math.round(Math.max(16, interval) * 10) / 10;
  expect(m.start).toHaveLength(DRAGS);
  expect(m.frame).toHaveLength(DRAGS);
  expect(m.paint).toHaveLength(DRAGS);
  expect(m.missed).toBe(0); // every drag's first frame already had the ghost
  const start = stat("drag: threshold move → ghost shown, targets measured", 16, m.start);
  const frame = stat("drag: threshold move → frame showing the ghost (rAF)", paintBudget, m.frame);
  const paint = stat("drag: threshold move → that frame rendered (rAF + task)", paintBudget, m.paint);
  const move = stat("drag: pointermove handler", 2, m.move);
  stats.push({ name: `ThreadRow renders during ${DRAGS} drags: ${rowRenders}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  stats.push({ name: `NavItem renders per target change: ${(navRenders / changes).toFixed(2)}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(rowRenders).toBe(0);
  expect(navRenders / changes).toBeLessThanOrEqual(2);
  expect(start.p95).toBeLessThanOrEqual(16 * MULT);
  expect(frame.p95).toBeLessThanOrEqual(paintBudget * MULT);
  expect(paint.p95).toBeLessThanOrEqual(paintBudget * MULT);
  expect(move.p95).toBeLessThanOrEqual(2 * MULT);
});

test("dropping: the dot is on the row within a frame; only the dropped row renders", async ({ app: page, server }) => {
  const viajes = server.backend.db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
  const target = (await page.getByTestId(`nav-category-${viajes}`).boundingBox())!;
  const samples: number[] = [];
  const renderCounts: number[] = [];
  for (let i = 0; i < 12; i++) {
    const row = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${viajes}"]))`).nth(i % 4);
    const id = (await row.getAttribute("data-thread-id"))!;
    await page.evaluate(
      ({ id, cat }) => {
        const w = window as unknown as { __drop: Promise<{ ms: number; renders: number }>; __renders?: Record<string, number> };
        const count = () => w.__renders?.ThreadRow ?? 0;
        w.__drop = new Promise((resolve) => {
          // registered before the controller's own listener (added at pointerdown), so t0 precedes the drop's work
          let t0 = 0;
          let r0 = 0;
          window.addEventListener(
            "pointerup",
            () => {
              t0 = performance.now();
              r0 = count();
            },
            { capture: true, once: true },
          );
          const list = document.querySelector("[role=listbox]")!;
          const mo = new MutationObserver(() => {
            if (t0 && list.querySelector(`[data-thread-id="${id}"] [data-cat-dot="${cat}"]`)) {
              mo.disconnect();
              resolve({ ms: performance.now() - t0, renders: count() - r0 });
            }
          });
          mo.observe(list, { childList: true, subtree: true });
        });
      },
      { id, cat: viajes },
    );
    const b = (await row.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 2);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 });
    await page.mouse.up();
    const r = await page.evaluate(() => (window as unknown as { __drop: Promise<{ ms: number; renders: number }> }).__drop);
    samples.push(r.ms);
    renderCounts.push(r.renders);
    // put it back for the next round (and let the snackbar go)
    await page.getByTestId("snackbar-undo").click();
    await expect(page.locator(`[data-thread-id="${id}"] [data-cat-dot="${viajes}"]`)).toHaveCount(0);
  }
  const s = stat("drop → dot on the row (DOM)", 16, samples);
  stats.push({ name: `ThreadRow renders from drop to dot (one row dragged): max ${Math.max(...renderCounts)}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(s.p95).toBeLessThanOrEqual(16 * MULT);
  // exactly the dragged row renders to show its dot
  expect(Math.max(...renderCounts)).toBe(1);
});
