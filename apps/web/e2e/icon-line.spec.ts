/**
 * Plan 92: one icon line weight at every size, and a surface can still tune it. Tagged @design: every design.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** the on-screen line of the first stroked shape in each matching icon */
const lines = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((svgs) =>
    svgs.map((svg) => {
      const shape = svg.querySelector("[stroke]")!;
      const s = getComputedStyle(shape);
      return { size: svg.getBoundingClientRect().width, line: s.strokeWidth, scaling: s.vectorEffect };
    }),
  );

test.describe("icon line", { tag: "@design" }, () => {
  test("the same line at every size", async ({ app: page }) => {
    await expect(page.getByTestId("message").first()).toBeVisible();
    const all = await lines(page, "svg.icon");
    expect(new Set(all.map((i) => Math.round(i.size))).size).toBeGreaterThan(1);
    expect(all.every((i) => i.scaling === "non-scaling-stroke")).toBe(true);
    const stroke = Number(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--icon-stroke")));
    expect(new Set(all.map((i) => i.line))).toEqual(new Set([`${(stroke * 2) / 3}px`]));
  });

  test("a toolbar's weight beats the default (the defaults sit below every utility)", async ({ app: page }) => {
    await expect(page.getByTestId("action-archive")).toBeVisible();
    // unequal weights: the toolbar's at 3 (a 2 px line), the rest at the design's
    await page.evaluate(() => document.documentElement.style.setProperty("--icon-stroke-toolbar", "3"));
    expect((await lines(page, "[data-testid='action-archive'] svg.icon"))[0]!.line).toBe("2px");
    const stroke = Number(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--icon-stroke")));
    expect((await lines(page, "[data-testid='sidebar'] svg.icon"))[0]!.line).toBe(`${(stroke * 2) / 3}px`);
  });
});
