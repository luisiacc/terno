/** Turning animations back on replays nothing: the open dialog, its backdrop and the rest stay as they are (no flash). */
import { expect, test } from "./fixtures";

test.use({ reducedMotion: "no-preference" });

test("switching from No animation to an animation doesn't replay what's on screen", async ({ app: page }) => {
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("general-tab").waitFor();
  await page.getByTestId("tab-appearance").click();
  await page.getByTestId("motion-0").click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  // what starts in the same frame the setting flips (a replayed entrance would be running from its start)
  await page.evaluate(() => {
    const w = window as unknown as { __replayed: string[] };
    w.__replayed = [];
    new MutationObserver((_, o) => {
      if (document.documentElement.dataset.motion !== "on") return;
      o.disconnect();
      requestAnimationFrame(() => {
        for (const a of document.getAnimations()) {
          const finite = Number.isFinite(Number(a.effect?.getComputedTiming().iterations));
          if (a instanceof CSSAnimation && finite && a.playState === "running") w.__replayed.push(`${a.animationName} on ${(a.effect as KeyframeEffect).target?.getAttribute("data-slot") ?? (a.effect as KeyframeEffect).target?.tagName}`);
        }
      });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  });
  await page.getByTestId("motion-75").click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => (window as unknown as { __replayed: string[] }).__replayed)).toEqual([]);
});

test("the preview says what it is, and plays when pressed or when a speed is picked", async ({ app: page }, testInfo) => {
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("general-tab").waitFor();
  await page.getByTestId("tab-appearance").click();
  const demo = page.getByTestId("motion-demo");
  await expect(demo).toHaveAccessibleName("Preview");
  await expect(demo).toHaveAttribute("data-side", "left");
  await demo.click();
  await expect(demo).toHaveAttribute("data-side", "right");
  await page.getByTestId("motion-100").click();
  await expect(demo).toHaveAttribute("data-side", "left");
  await page.mouse.move(0, 0);
  await page.getByTestId("motion-toggle").locator("xpath=ancestor::section[1]").screenshot({ path: testInfo.outputPath("preview-light.png") });
  await page.getByTestId("mode-dark").click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.mouse.move(0, 0);
  await page.getByTestId("motion-toggle").locator("xpath=ancestor::section[1]").screenshot({ path: testInfo.outputPath("preview-dark.png") });
});
