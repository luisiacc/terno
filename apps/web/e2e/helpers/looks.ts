import type { Locator, Page } from "@playwright/test";

/** Plan 162: every look an AI surface is rated in: light and dark, at 1440x900 and the 1100x700 window. */
export async function inEveryLook(page: Page, run: (where: string) => Promise<void>): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const size of [{ width: 1440, height: 900 }, { width: 1100, height: 700 }]) {
      await page.setViewportSize(size);
      await run(`${scheme} ${size.width}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
}

/**
 * Plan 162: the wheel, over `pane`, brings `last` fully into the window: an AI pane's end is reachable as a person
 * reaches it, not only by keyboard or a scroll a test sets. True once it's in view.
 */
export async function wheelsTo(page: Page, pane: Locator, last: Locator): Promise<boolean> {
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  for (let i = 0; i < 20; i++) {
    const b = await last.boundingBox();
    if (b && b.y >= 0 && b.y + b.height <= (await page.evaluate(() => innerHeight)) + 0.5) return true;
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(50);
  }
  const b = await last.boundingBox();
  return !!b && b.y + b.height <= (await page.evaluate(() => innerHeight)) + 0.5;
}
