/**
 * Motion: nothing runs longer than 100 ms, 0 (or the OS asking for reduced
 * motion) turns every animation off, and list navigation never animates.
 * The config forces reduced motion for every other spec; these opt out.
 */
import type { Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { expect, focusList, rows, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

const ctx = { clientId: "setup", origin: "dev" as const };

type Sample = { max: number; finite: number; loops: number; names: string[] };

/** Samples document.getAnimations() every frame: finite ones (with their length) and loops (spinners, pulses, pings). */
async function startSampler(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __anim: { durations: number[]; finite: number; loops: number; names: string[]; stop: boolean } };
    w.__anim = { durations: [], finite: 0, loops: 0, names: [], stop: false };
    const seen = new WeakSet<Animation>();
    const tick = () => {
      for (const a of document.getAnimations()) {
        const t = a.effect?.getTiming();
        if (!t) continue;
        const el = (a.effect as KeyframeEffect | null)?.target as Element | null;
        const name = `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? "?"}@${el?.getAttribute("data-testid") ?? el?.getAttribute("aria-label") ?? el?.getAttribute("class")?.slice(0, 60)}`;
        if (!w.__anim.names.includes(name)) w.__anim.names.push(name);
        if (seen.has(a)) continue;
        seen.add(a);
        if (t.iterations === Infinity) w.__anim.loops++;
        else {
          w.__anim.finite++;
          w.__anim.durations.push(Number(t.duration) + Number(t.delay ?? 0));
        }
      }
      if (!w.__anim.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const sampled = (page: Page): Promise<Sample> =>
  page.evaluate(() => {
    const w = window as unknown as { __anim: { durations: number[]; finite: number; loops: number; names: string[]; stop: boolean } };
    w.__anim.stop = true;
    return { max: Math.max(0, ...w.__anim.durations), finite: w.__anim.finite, loops: w.__anim.loops, names: w.__anim.names };
  });

/** Holds a backend method until released, so its loading state (spinner, skeleton) stays on screen. */
function hold(server: DevServer, method: string) {
  const handlers = (server.backend.server as unknown as { handlers: Record<string, (...a: unknown[]) => unknown> }).handlers;
  const original = handlers[method]!;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  handlers[method] = async (...args: unknown[]) => {
    await gate;
    return original(...args);
  };
  return () => {
    release();
    handlers[method] = original;
  };
}

/**
 * Opens and closes a dialog, a select popup and a menu-like popover, expands a
 * collapsed message, opens an inline reply and collapses it, and shows a toast.
 */
async function exercise(page: Page) {
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.getByTestId("settings-dialog").getByRole("combobox").first().click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  // a conversation with earlier (collapsed) messages: one expands, then collapses
  await page.locator("[data-testid=thread-row][data-messages]").first().dispatchEvent("mousedown");
  const collapsed = page.locator("[data-testid=message-toggle][aria-expanded=false]").first();
  if (await collapsed.count()) {
    await collapsed.click();
    await page.waitForTimeout(150);
    await page.locator("[data-testid=message-toggle][aria-expanded=true]").first().click();
    await page.waitForTimeout(150);
  }
  // the inline reply opens and collapses
  await focusList(page);
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("draft-collapsed")).toBeVisible();
  await page.waitForTimeout(150);
  await focusList(page);
  await rows(page).first().dispatchEvent("mousedown");
  await page.keyboard.press("e");
  await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
  await page.waitForTimeout(150);
}

/** Loading states that loop: the AI filter builder's spinner and the snackbar's count skeleton, held on screen. */
async function exerciseLoading(page: Page, server: DevServer) {
  const releaseAi = hold(server, "filters.generate");
  await page.getByTestId("open-filters").click();
  await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com");
  await page.getByTestId("ai-generate").click();
  await expect(page.getByTestId("ai-generate").locator(".animate-spin")).toBeVisible();
  await page.waitForTimeout(200);
  releaseAi();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ai-generate")).toHaveCount(0);

  const releaseCount = hold(server, "categorize.count");
  const facturas = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
  const row = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${facturas}"]))`).first();
  await row.dispatchEvent("mousedown");
  await focusList(page);
  await page.keyboard.press("l");
  await page.getByTestId(`pick-category-${facturas}`).click();
  await expect(page.getByTestId("snackbar-count-loading").first()).toBeVisible();
  await page.waitForTimeout(200);
  releaseCount();
}

test.describe("motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("at the default 75 ms nothing runs longer than 100 ms; loading loops run", async ({ app: page, server }) => {
    await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
    await startSampler(page);
    await exercise(page);
    await exerciseLoading(page, server);
    const r = await sampled(page);
    expect(r.finite).toBeGreaterThan(0); // things did animate
    expect(r.loops, r.names.join(",")).toBeGreaterThanOrEqual(2); // the spinner and the skeleton pulse were exercised
    expect(r.max, r.names.join(",")).toBeLessThanOrEqual(100);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--motion-slow").trim())).toBe("100ms");
  });

  test("at 100 ms the slowest is still 100 ms; at 50 everything is quicker", async ({ app: page, server }) => {
    for (const [ms, cap] of [
      [100, 100],
      [50, 67],
    ] as const) {
      await server.backend.server.invoke("settings.update", { motionMs: ms }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await startSampler(page);
      await exercise(page);
      const r = await sampled(page);
      expect(r.finite).toBeGreaterThan(0);
      expect(r.max, `${ms}: ${r.names.join(",")}`).toBeLessThanOrEqual(cap);
    }
  });

  test("0 turns every animation, transition and loop off", async ({ app: page, server }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-appearance").click();
    await page.getByTestId("motion-0").click();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    await startSampler(page);
    await exercise(page);
    await exerciseLoading(page, server);
    const r = await sampled(page);
    expect({ finite: r.finite, loops: r.loops }, r.names.join(",")).toEqual({ finite: 0, loops: 0 });
    expect(await page.getByTestId("compose-button").evaluate((b) => getComputedStyle(b).transitionDuration)).toBe("0s");
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });

  test("holding j never animates", async ({ app: page }) => {
    await focusList(page);
    const first = await rows(page).first().getAttribute("data-thread-id");
    await startSampler(page);
    for (let i = 0; i < 25; i++) await page.keyboard.press("j");
    await expect(page.locator("[data-testid=thread-row][aria-selected=true]")).not.toHaveAttribute("data-thread-id", first!);
    const r = await sampled(page);
    // no transition or enter/exit animation; loading loops (the reader's skeleton) may run with motion on, as §6 says
    expect(r.finite, r.names.join(",")).toBe(0);
  });
});

test.describe("motion under the OS reduced-motion preference", () => {
  test.use({ reducedMotion: "reduce" });

  test("overrides the setting: nothing animates", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { motionMs: 100 }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
    await startSampler(page);
    await exercise(page);
    await exerciseLoading(page, server);
    const r = await sampled(page);
    expect({ finite: r.finite, loops: r.loops }, r.names.join(",")).toEqual({ finite: 0, loops: 0 });
    expect(await page.getByTestId("compose-button").evaluate((b) => getComputedStyle(b).transitionDuration)).toBe("0s");
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });

  test("turning reduced motion off at runtime brings animations back", async ({ app: page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
  });
});
