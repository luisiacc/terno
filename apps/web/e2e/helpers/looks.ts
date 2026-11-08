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

/** Whether `el` shows whole: inside the window and inside every ancestor that clips its overflow, top and bottom. */
function shownWhole(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    let top = 0;
    let bottom = innerHeight;
    for (let at = node.parentElement; at; at = at.parentElement) {
      const s = getComputedStyle(at);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) {
        const b = at.getBoundingClientRect();
        top = Math.max(top, b.top);
        bottom = Math.min(bottom, b.bottom);
      }
    }
    return r.height > 0 && r.top >= top - 0.5 && r.bottom <= bottom + 0.5;
  });
}

/**
 * Plan 162: the wheel, over `pane`, brings `last` into view whole: inside the window and every pane that clips it (Codex
 * review: the window alone passed content a pane still cut off). An AI pane's end is reachable as a person reaches it.
 */
export async function wheelsTo(page: Page, pane: Locator, last: Locator): Promise<boolean> {
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  for (let i = 0; i < 20; i++) {
    if (await shownWhole(last)) return true;
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(50);
  }
  return shownWhole(last);
}
