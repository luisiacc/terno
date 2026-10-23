/**
 * Motion: nothing runs longer than 100 ms, 0 (or the OS asking for reduced
 * motion) turns every animation off, and list navigation never animates.
 * The config forces reduced motion for every other spec; these opt out.
 */
import type { Page } from "@playwright/test";
import { expect, focusList, rows, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

/** Samples document.getAnimations() every frame; loops (spinners, pings) are reported apart. */
async function startSampler(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __anim: { finite: number[]; names: string[]; count: number; stop: boolean } };
    w.__anim = { finite: [], names: [], count: 0, stop: false };
    const tick = () => {
      for (const a of document.getAnimations()) {
        const t = a.effect?.getTiming();
        if (!t || t.iterations === Infinity) continue;
        w.__anim.count++;
        w.__anim.finite.push(Number(t.duration) + Number(t.delay ?? 0));
        const el = (a.effect as KeyframeEffect | null)?.target as Element | null; const name = `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? "?"}@${el?.getAttribute("data-testid") ?? el?.getAttribute("aria-label") ?? el?.className.toString().slice(0, 60)}`;
        if (!w.__anim.names.includes(name)) w.__anim.names.push(name);
      }
      if (!w.__anim.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const sampled = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __anim: { finite: number[]; names: string[]; count: number; stop: boolean } };
    w.__anim.stop = true;
    return { max: Math.max(0, ...w.__anim.finite), count: w.__anim.count, names: w.__anim.names };
  });

/** Opens and closes a dialog, a select popup and a menu-like popover, and shows a toast. */
async function exercise(page: Page) {
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.getByTestId("settings-dialog").getByRole("combobox").first().click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await focusList(page);
  await rows(page).first().dispatchEvent("mousedown");
  await page.keyboard.press("e");
  await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
  await page.waitForTimeout(150);
}

test.describe("motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("at the default 75 ms nothing runs longer than 100 ms", async ({ app: page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
    await startSampler(page);
    await exercise(page);
    const r = await sampled(page);
    expect(r.count).toBeGreaterThan(0); // things did animate
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
      expect(r.count).toBeGreaterThan(0);
      expect(r.max, `${ms}: ${r.names.join(",")}`).toBeLessThanOrEqual(cap);
    }
  });

  test("0 turns every animation and transition off", async ({ app: page }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-appearance").click();
    await page.getByTestId("motion-0").click();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    await startSampler(page);
    await exercise(page);
    expect((await sampled(page)).count).toBe(0);
    expect(await page.getByTestId("compose-button").evaluate((b) => getComputedStyle(b).transitionDuration)).toBe("0s");
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).length)).toBe(0);
  });

  test("holding j never animates", async ({ app: page }) => {
    await focusList(page);
    const first = await rows(page).first().getAttribute("data-thread-id");
    await startSampler(page);
    for (let i = 0; i < 25; i++) await page.keyboard.press("j");
    await expect(page.locator("[data-testid=thread-row][aria-selected=true]")).not.toHaveAttribute("data-thread-id", first!);
    const r = await sampled(page);
    expect(r.count, r.names.join(",")).toBe(0);
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
    expect((await sampled(page)).count).toBe(0);
    expect(await page.getByTestId("compose-button").evaluate((b) => getComputedStyle(b).transitionDuration)).toBe("0s");
  });

  test("turning reduced motion off at runtime brings animations back", async ({ app: page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
  });
});
