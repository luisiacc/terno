/**
 * UI performance in a real browser (production build) against the real backend
 * with the 3,000-thread / 4-account demo mailbox. Timings are taken in-page
 * from the keydown/input event to the DOM commit and to the following frames.
 * Budgets scale only via PERF_BUDGET_MULTIPLIER.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, ingestConversation, rows, selectThread, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

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
      // the open thread moved (the row gains data-cursor)
      if (records.some((r) => r.attributeName === "data-cursor" && (r.target as Element).hasAttribute("data-cursor"))) {
        w.__perf.commit.push(performance.now() - w.__perf.t0);
        w.__perf.maxRows = Math.max(w.__perf.maxRows, document.querySelectorAll("[data-testid=thread-row]").length);
      }
    }).observe(document.querySelector("[role=listbox]")!, { attributes: true, subtree: true, attributeFilter: ["data-cursor"] });
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
  expect(await page.locator("[data-cursor]").getAttribute("data-thread-id")).not.toBeNull();
});

/**
 * Frame timing while something runs: every rAF interval, plus the
 * long-animation-frame entries Chromium reports (frames > 50 ms).
 */
async function startFrames(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: { deltas: number[]; loaf: number; stop: boolean; obs?: PerformanceObserver } };
    w.__frames = { deltas: [], loaf: 0, stop: false };
    let last = 0;
    const tick = (t: number) => {
      if (last) w.__frames.deltas.push(t - last);
      last = t;
      if (!w.__frames.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      w.__frames.obs = new PerformanceObserver((l) => (w.__frames.loaf += l.getEntries().length));
      w.__frames.obs.observe({ type: "long-animation-frame" });
    } catch {
      /* no LoAF: the rAF intervals still bound the longest frame */
    }
  });
}
async function stopFrames(page: import("@playwright/test").Page): Promise<{ deltas: number[]; loaf: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: { deltas: number[]; loaf: number; stop: boolean; obs?: PerformanceObserver } };
    w.__frames.stop = true;
    w.__frames.obs?.disconnect();
    return { deltas: w.__frames.deltas, loaf: w.__frames.loaf };
  });
}
/** Frame interval p95 ≤ 20 ms and no frame longer than 50 ms. */
function frameGate(label: string, f: { deltas: number[]; loaf: number }) {
  const s = stat(`${label}: frame interval`, 20, f.deltas);
  stats.push({ name: `${label}: long animation frames ${f.loaf}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(s.p95, `${label} frame p95`).toBeLessThanOrEqual(20 * MULT);
  expect(s.max, `${label} longest frame`).toBeLessThanOrEqual(50 * MULT);
}
async function setDensity(page: import("@playwright/test").Page, server: import("../../backend-dev/src/server").DevServer, density: "comfortable" | "compact") {
  await server.backend.server.invoke("settings.update", { density }, { clientId: "setup", origin: "dev" as const });
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
}

for (const density of ["comfortable", "compact"] as const) {
  test(`sustained j at key-repeat rate (${density}): frames stay smooth and the selection keeps up, with drafts around`, async ({ app: page, server }) => {
    // a collapsed reply draft on a listed thread and a new draft in the strip, both restored by the reload below
    const ctx = { clientId: "setup", origin: "dev" as const };
    const db = sqlDb(server.backend.store);
    const target = db.get<{ id: number; thread_id: number; account_id: number }>("SELECT m.id, m.thread_id, m.account_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.in_inbox = 1 ORDER BY t.last_date DESC LIMIT 1 OFFSET 3")!;
    await server.backend.server.invoke("drafts.save", { accountId: target.account_id, to: [], cc: [], subject: "Re: x", bodyText: "Borrador a medias", inReplyToMessageId: target.id, uiState: "collapsed" }, ctx);
    await server.backend.server.invoke("drafts.save", { accountId: target.account_id, to: [{ name: "", email: "ana@example.com" }], cc: [], subject: "Nuevo", bodyText: "Para después" }, ctx);
    await setDensity(page, server, density);
    await expect(page.getByTestId("strip-item")).toHaveCount(1);
    await expect(page.locator(`[data-testid=thread-row][data-thread-id="${target.thread_id}"]`)).toContainText("Borrador");
    const rendersBefore = await renders(page, "ThreadRow");
    await expect(page.locator(`[data-testid=thread-row]`).first()).toHaveCSS("height", density === "compact" ? "40px" : "68px");
    await page.evaluate(() => {
      const w = window as unknown as { __moves: number };
      w.__moves = 0;
      new MutationObserver((records) => {
        for (const r of records) if ((r.target as Element).hasAttribute("data-cursor")) w.__moves++;
      }).observe(document.querySelector("[role=listbox]")!, { attributes: true, subtree: true, attributeFilter: ["data-cursor"] });
    });
    await startFrames(page);
    // 300 presses at macOS's default key repeat (~30/s), without waiting for each one
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let n = 0;
          const id = setInterval(() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", bubbles: true }));
            if (++n === 300) {
              clearInterval(id);
              setTimeout(resolve, 200);
            }
          }, 33);
        }),
    );
    const f = await stopFrames(page);
    const moves = await page.evaluate(() => (window as unknown as { __moves: number }).__moves);
    const perMove = ((await renders(page, "ThreadRow")) - rendersBefore) / moves;
    stats.push({ name: `j at key repeat (${density}): selection moves ${moves}, row renders per move ${perMove.toFixed(2)}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
    expect(moves).toBeGreaterThanOrEqual(300);
    // the two rows whose selection changed, plus the row the scroll brings into view (and a page load now and then);
    // drafts add none
    expect(perMove).toBeLessThanOrEqual(3.5);
    expect(await rows(page).count()).toBeLessThanOrEqual(60);
    frameGate(`j at key repeat (${density})`, f);
  });

  test(`continuous scrolling across 2,000 threads (${density}): frames stay smooth, the DOM stays bounded`, async ({ app: page, server }) => {
    await setDensity(page, server, density);
    await page.getByTestId("nav-all").click();
    await expect(page.getByTestId("list-title")).toHaveText("Todo el correo");
    const rowH = density === "compact" ? 40 : 68;
    await expect(rows(page).first()).toHaveCSS("height", `${rowH}px`);
    await startFrames(page);
    const r = await page.evaluate(async (h) => {
      const scroller = document.querySelector("[role=listbox]") as HTMLElement;
      const target = 2000 * h;
      const perFrame = target / 180; // ~3 s at 60 Hz, as a fast trackpad fling
      let maxRows = 0;
      const t0 = performance.now();
      await new Promise<void>((resolve, reject) => {
        const step = () => {
          if (performance.now() - t0 > 20_000) return reject(new Error(`stuck at ${scroller.scrollTop}px`));
          scroller.scrollTop = Math.min(scroller.scrollTop + perFrame, scroller.scrollHeight);
          maxRows = Math.max(maxRows, document.querySelectorAll("[data-testid=thread-row]").length);
          if (scroller.scrollTop + scroller.clientHeight >= target) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      return { maxRows, ms: performance.now() - t0 };
    }, rowH);
    const f = await stopFrames(page);
    stats.push({ name: `scroll 2,000 (${density}): ${Math.round(r.ms)} ms, max DOM rows ${r.maxRows}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
    expect(r.maxRows).toBeLessThanOrEqual(80);
    frameGate(`continuous scroll (${density})`, f);
  });
}

test("a long conversation: expanding 19 messages (5 HTML) keeps every frame ≤ 50 ms and collapsing leaves no frame or observer behind", async ({ app: page, server }) => {
  const id = await ingestConversation(server, { subject: "Conversación larga del presupuesto", count: 20, html: 5, now: Date.now() });
  await selectThread(page, id, 'subject:"Conversación larga del presupuesto"');
  // observers watching a mail frame's document, alive right now
  await page.evaluate(() => {
    const w = window as unknown as { __frameObservers: Set<ResizeObserver> };
    w.__frameObservers = new Set();
    const Native = window.ResizeObserver;
    window.ResizeObserver = class extends Native {
      override observe(target: Element, options?: ResizeObserverOptions) {
        if (target.ownerDocument !== document) w.__frameObservers.add(this);
        super.observe(target, options);
      }
      override disconnect() {
        w.__frameObservers.delete(this);
        super.disconnect();
      }
    };
  });
  const reader = page.getByTestId("reader");
  await startFrames(page);
  await reader.getByTestId("more-messages").click();
  for (let i = 0; i < 19; i++) {
    const toggle = reader.getByTestId("message").nth(i).getByTestId("message-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(120);
  }
  const f = await stopFrames(page);
  await expect(reader.locator("iframe")).toHaveCount(5);
  frameGate("long conversation: expanding", { deltas: f.deltas, loaf: f.loaf });
  for (let i = 0; i < 19; i++) await reader.getByTestId("message").nth(i).getByTestId("message-toggle").click();
  await expect(reader.locator("[data-testid=message-toggle][aria-expanded=true]")).toHaveCount(1);
  await expect(reader.locator("iframe")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __frameObservers: Set<ResizeObserver> }).__frameObservers.size)).toBe(0);
});

test("inline reply: keypress → first frame showing the draft ≤ 50 ms; from that frame its expansion ends within slow + 2 frames", async ({ app: page }) => {
  await rows(page).first().dispatchEvent("mousedown");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __reply: { t0: number; waiting: boolean; first: number[]; end: number[]; expand: number[] } };
    w.__reply = { t0: 0, waiting: false, first: [], end: [], expand: [] };
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "r" || (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName))) return;
        w.__reply.t0 = performance.now();
        w.__reply.waiting = true;
      },
      { capture: true },
    );
    new MutationObserver(() => {
      if (!w.__reply.waiting) return;
      const wrap = document.querySelector("[data-testid=composer]")?.closest<HTMLElement>("[data-state]");
      if (wrap?.dataset.state !== "open") return;
      w.__reply.waiting = false;
      const t0 = w.__reply.t0;
      let shown = 0;
      requestAnimationFrame(() => {
        shown = performance.now();
        w.__reply.first.push(shown - t0);
      });
      const onEnd = (ev: TransitionEvent) => {
        if (ev.target !== wrap || ev.propertyName !== "grid-template-rows") return;
        wrap.removeEventListener("transitionend", onEnd);
        w.__reply.end.push(performance.now() - t0);
        w.__reply.expand.push(performance.now() - shown);
      };
      wrap.addEventListener("transitionend", onEnd);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  });
  const N = 20;
  for (let i = 0; i < N; i++) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("r");
    await page.waitForFunction((n) => (window as any).__reply.end.length >= n, i + 1, { polling: "raf" });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("draft-collapsed")).toBeVisible();
    await page.waitForTimeout(150);
  }
  const r = await page.evaluate(() => (window as any).__reply as { first: number[]; end: number[]; expand: number[] });
  const first = stat("inline reply: keypress → first frame showing it", 50, r.first);
  // the expansion itself, from the frame it first shows: slow (100 ms at the default 75) + 2 frames
  const expand = stat("inline reply: first frame → expansion done", 133, r.expand);
  // reported: the sum of the two gated parts (≈ slow + 2 frames at p95, too close to a 133 ms line under load)
  stat("inline reply: keypress → expansion done", 0, r.end);
  expect(first.p95).toBeLessThanOrEqual(50 * MULT);
  expect(expand.p95).toBeLessThanOrEqual(133 * MULT);
});

test("typing in a draft with 2,000 drafts around: each keystroke is handled and rendered within a frame", async ({ app: page, server }) => {
  // 2,000 reply drafts, one per conversation (most of them outside the loaded list, so all in the strip's reach)
  const db = sqlDb(server.backend.store);
  const targets = db.all<{ id: number; thread_id: number; account_id: number }>("SELECT max(id) AS id, thread_id, account_id FROM messages GROUP BY thread_id ORDER BY thread_id DESC LIMIT 2000");
  expect(targets.length).toBe(2000);
  const now = Date.now();
  for (const [i, t] of targets.entries()) {
    await server.backend.store.drafts.save({ accountId: t.account_id, threadId: t.thread_id, to: [{ name: "", email: "ana@example.com" }], cc: [], subject: `Re: borrador ${i}`, bodyText: `Borrador ${i}`, inReplyToMessageId: t.id }, now - i);
  }
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
  await expect(page.getByTestId("strip-more")).toBeVisible();
  await rows(page).nth(5).dispatchEvent("mousedown");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("r");
  const body = page.getByTestId("compose-body");
  await expect(body).toBeFocused();
  await page.evaluate(() => {
    const w = window as unknown as { __typing: { t0: number; handled: number[]; frame: number[] } };
    w.__typing = { t0: 0, handled: [], frame: [] };
    document.addEventListener("keydown", () => (w.__typing.t0 = performance.now()), { capture: true });
    // bubbling to the document runs after React handled the input (and rendered what it changed)
    document.addEventListener("input", () => {
      const t0 = w.__typing.t0;
      w.__typing.handled.push(performance.now() - t0);
      requestAnimationFrame(() => w.__typing.frame.push(performance.now() - t0));
    });
  });
  const text = "Hola, lo reviso esta tarde y te confirmo mañana temprano.";
  for (const ch of text) await page.keyboard.type(ch, { delay: 30 });
  await page.waitForTimeout(1200); // an autosave answers too: its state update is part of the work
  await page.keyboard.type(" Gracias.", { delay: 30 });
  const r = await page.evaluate(() => (window as any).__typing as { handled: number[]; frame: number[] });
  expect(r.handled.length).toBeGreaterThanOrEqual(text.length);
  const handled = stat("draft typing (2,000 drafts): keystroke → handled and rendered", 16, r.handled);
  stat("draft typing (2,000 drafts): keystroke → next frame", 0, r.frame);
  expect(handled.p95).toBeLessThanOrEqual(16 * MULT);
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
    const u = (window as unknown as { __terno: { updateAppearance(p: object): Promise<unknown> } }).__terno;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const out: number[] = [];
    // alternate light/dark and named palettes: mode, data-theme and every color change each time
    const steps = [
      { theme: "dark", darkTheme: "dracula" },
      { theme: "light", lightTheme: "solarized-light" },
      { theme: "dark", darkTheme: "nord" },
      { theme: "light", lightTheme: "terno-light" },
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
  const cats = sqlDb(server.backend.store).all<{ id: number }>("SELECT id FROM categories ORDER BY position");
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
  const viajes = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
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

test("context menu: right-click → menu painted within 50 ms, no row renders", async ({ app: page }) => {
  await expect(rows(page).first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __menu: { t0: number; open: number[]; paint: number[]; renders: number[] }; __renders?: Record<string, number> };
    w.__menu = { t0: 0, open: [], paint: [], renders: [] };
    let r0 = 0;
    // before the menu's own handler (capture on window): t0 precedes all of its work
    window.addEventListener("contextmenu", () => ((w.__menu.t0 = performance.now()), (r0 = w.__renders?.ThreadRow ?? 0)), { capture: true });
    new MutationObserver(() => {
      const m = document.querySelector("[data-testid=thread-menu]");
      if (!m || !w.__menu.t0) return;
      const t0 = w.__menu.t0;
      w.__menu.t0 = 0;
      w.__menu.open.push(performance.now() - t0);
      // the frame that shows it: rAF runs before its paint, a message posted from there after it
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          w.__menu.paint.push(performance.now() - t0);
          w.__menu.renders.push((w.__renders?.ThreadRow ?? 0) - r0);
        };
        ch.port2.postMessage(null);
      });
    }).observe(document.body, { childList: true, subtree: true });
  });
  const N = 40;
  for (let i = 0; i < N; i++) {
    const b = (await rows(page).nth(1 + (i % 6)).boundingBox())!;
    await page.mouse.click(b.x + 100, b.y + b.height / 2, { button: "right" });
    await page.waitForFunction((n) => (window as any).__menu.paint.length >= n, i + 1);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("thread-menu")).toBeHidden();
  }
  const m = await page.evaluate(() => (window as any).__menu as { open: number[]; paint: number[]; renders: number[] });
  stat("menu: right-click → menu in the DOM", 0, m.open);
  const s = stat("menu: right-click → menu painted (rAF + task)", 50, m.paint);
  stats.push({ name: `ThreadRow renders per menu open: max ${Math.max(...m.renders)}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(s.p95).toBeLessThanOrEqual(50 * MULT);
  expect(Math.max(...m.renders)).toBe(0);
});

test("selection: toggling one row renders one row; ⌘A over 500 loaded rows commits within a frame and renders only rows that changed", async ({ app: page }) => {
  await page.getByTestId("nav-all").click();
  await expect(page.getByTestId("list-title")).toHaveText("Todo el correo");
  await expect(rows(page).first()).toBeVisible();
  // load five pages (500 rows), then come back to the top
  await page.evaluate(async () => {
    const scroller = document.querySelector("[role=listbox]") as HTMLElement;
    const loaded = () => (window as unknown as { __terno: { loadedIds(): number[] } }).__terno.loadedIds().length;
    while (loaded() < 500) {
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((r) => setTimeout(r, 50));
    }
    scroller.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 100));
  });
  const loaded = await page.evaluate(() => (window as unknown as { __terno: { loadedIds(): number[] } }).__terno.loadedIds().length);
  expect(loaded).toBeGreaterThanOrEqual(500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // x: one row changes, one row renders
  const toggles: number[] = [];
  for (let i = 0; i < 10; i++) {
    const before = await renders(page, "ThreadRow");
    await page.keyboard.press("x");
    await page.waitForTimeout(30);
    toggles.push((await renders(page, "ThreadRow")) - before);
  }
  // ⌘-click with others checked: one row
  await page.keyboard.press("x"); // 11 presses: the open row is checked
  const clicks: number[] = [];
  for (let i = 3; i < 9; i++) {
    const before = await renders(page, "ThreadRow");
    await rows(page).nth(i).click({ modifiers: ["ControlOrMeta"] });
    await page.waitForTimeout(30);
    clicks.push((await renders(page, "ThreadRow")) - before);
  }
  await page.keyboard.press("Escape");
  stats.push({ name: `ThreadRow renders per x toggle: max ${Math.max(...toggles)}, per ⌘-click: max ${Math.max(...clicks)}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: toggles.length + clicks.length });
  expect(Math.max(...toggles)).toBe(1);
  expect(Math.max(...clicks)).toBe(1);

  await page.evaluate(() => {
    const w = window as unknown as { __sel: { t0: number; commit: number[]; changed: number[]; renders: number[]; mounted: number[] }; __renders?: Record<string, number> };
    w.__sel = { t0: 0, commit: [], changed: [], renders: [], mounted: [] };
    let r0 = 0;
    let changed = 0;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "a" || !(e.metaKey || e.ctrlKey)) return;
      w.__sel.t0 = performance.now();
      r0 = w.__renders?.ThreadRow ?? 0;
      changed = 0;
      requestAnimationFrame(() => {
        w.__sel.changed.push(changed);
        w.__sel.renders.push((w.__renders?.ThreadRow ?? 0) - r0);
        w.__sel.mounted.push(document.querySelectorAll("[data-testid=thread-row]").length);
      });
    }, { capture: true });
    new MutationObserver((records) => {
      const first = w.__sel.t0;
      for (const r of records) if (r.attributeName === "data-checked") changed++;
      if (first) {
        w.__sel.commit.push(performance.now() - first);
        w.__sel.t0 = 0;
      }
    }).observe(document.querySelector("[role=listbox]")!, { attributes: true, subtree: true, attributeFilter: ["data-checked"] });
  });
  const N = 40;
  for (let i = 0; i < N; i++) {
    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForFunction((n) => (window as any).__sel.renders.length >= n, i + 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(20);
  }
  const r = await page.evaluate(() => (window as any).__sel as { commit: number[]; changed: number[]; renders: number[]; mounted: number[] });
  const s = stat(`⌘A over ${loaded} loaded rows: keydown → committed`, 16, r.commit);
  stats.push({ name: `⌘A: ThreadRow renders ${Math.max(...r.renders)} for ${Math.max(...r.changed)} changed of ${Math.max(...r.mounted)} mounted rows`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: N });
  expect(r.commit).toHaveLength(N);
  expect(s.p95).toBeLessThanOrEqual(16 * MULT);
  // only the rows whose checked state changed render: the mounted ones (500 loaded, ~30 in the DOM)
  for (let i = 0; i < N; i++) expect(r.renders[i]).toBe(r.changed[i]);
  expect(Math.max(...r.mounted)).toBeLessThanOrEqual(60);
  // ⌘A again with everything selected changes nothing and renders nothing
  await page.keyboard.press("ControlOrMeta+a");
  await page.waitForTimeout(50);
  const before = await renders(page, "ThreadRow");
  await page.keyboard.press("ControlOrMeta+a");
  await page.waitForTimeout(50);
  expect((await renders(page, "ThreadRow")) - before).toBe(0);
});

test("printing: the print document for a 100-message conversation builds in under 30 ms", async ({ app: page }) => {
  // the sheet loads the builder (a lazy chunk); then build straight from it, with realistic bodies
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByTestId("print-preview")).toHaveAttribute("data-ready", "true");
  await page.keyboard.press("Escape");
  const samples = await page.evaluate(() => {
    const build = (window as unknown as { __terno: { buildPrintDocument(i: unknown, o: unknown): string } }).__terno.buildPrintDocument;
    const para = "Revisamos la propuesta, los tiempos y el presupuesto de la campaña. ¿Te parece si lo cerramos esta semana? ";
    const messages = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      from: { name: "Yuki Gutiérrez", email: "yuki@acme.studio" },
      to: [{ name: "Luis Cordero", email: "luis@terno.mx" }],
      cc: i % 3 ? [] : [{ name: "Ana Ruiz", email: "ana@despacho.mx" }],
      date: Date.UTC(2026, 9, 1) + i * 3_600_000,
      // half HTML (sanitized), half plain text with a trailing quote
      bodyHtml: i % 2 ? `<div><p>${para.repeat(4)}</p><table><tr><td>Concepto</td><td>$1,200</td></tr></table><p>${para}</p><div class="gmail_quote">El lunes escribió:<blockquote>${para.repeat(3)}</blockquote></div></div>` : null,
      bodyText: `${para.repeat(5)}\n\nSaludos.\n\nEl lunes, Yuki escribió:\n> ${para}\n> ${para}`,
      attachments: i % 10 ? [] : [{ filename: "propuesta.pdf", size: 240_000 }],
      allowRemote: false,
    }));
    const out: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      build({ subject: "Propuesta campaña", messages }, { content: "headers", quoted: i % 2 ? "hide" : "show", paper: "letter" });
      out.push(performance.now() - t0);
    }
    return out.slice(5);
  });
  const s = stat("print document: 100 messages built", 30, samples);
  expect(s.p95).toBeLessThanOrEqual(30 * MULT);
});

test("the unread filter: ⌘L → the other list rendered within 100 ms; moving off the kept read row renders only rows on screen", async ({ app: page }) => {
  await expect(rows(page).first()).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const samples: number[] = [];
  for (let i = 0; i < 16; i++) {
    const ms = await page.evaluate(async (want) => {
      const list = document.querySelector("[data-testid=thread-list]")!;
      // [view, account, category, review, unreadOnly, query]
      const shows = () => (JSON.parse(list.getAttribute("data-results-for") ?? "[]") as unknown[])[4] === want;
      const t0 = performance.now();
      const mac = navigator.platform.includes("Mac");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: mac, ctrlKey: !mac, cancelable: true }));
      await new Promise<void>((resolve) => {
        if (shows()) return resolve();
        const mo = new MutationObserver(() => {
          if (!shows()) return;
          mo.disconnect();
          resolve();
        });
        mo.observe(list, { attributes: true, attributeFilter: ["data-results-for"] });
      });
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      return performance.now() - t0;
    }, i % 2 === 0);
    samples.push(ms);
  }
  const s = stat("unread filter: ⌘L → list rendered (+1 frame)", 100, samples.slice(2));
  // off again after 16 toggles; on, with the open thread read and kept: j moves off it and it leaves
  await page.keyboard.press("ControlOrMeta+l");
  await expect(page.locator("[data-testid=thread-row]:not([data-unread])")).toHaveCount(1);
  const mounted = await rows(page).count();
  const before = await renders(page, "ThreadRow");
  await page.keyboard.press("j");
  await expect(page.locator("[data-testid=thread-row]:not([data-unread])")).toHaveCount(0);
  await page.waitForTimeout(200);
  const moved = (await renders(page, "ThreadRow")) - before;
  stats.push({ name: `ThreadRow renders moving off the kept row: ${moved} (rows mounted ${mounted})`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  // the rows below it slide up a place (a mounted row renders for its new place, the cursor's two for the move), nothing past the DOM window
  expect(moved).toBeLessThanOrEqual(mounted * 2);
  expect(s.p95).toBeLessThanOrEqual(100 * MULT);
});
