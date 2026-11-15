import { expect, type Locator, type Page } from "@playwright/test";

/** the feed's digest item */
export const DIGEST = '[data-testid="wm-item"][data-digest]';

/**
 * Plan 204 (after the panel, revision 10): the digest's way in is What matters' last open item, so the virtualized feed is
 * scrolled to its end until the item is drawn (and the digest has come, `timeout` long). Plan 210: the feed's item.
 */
export async function digestRow(page: Page, timeout = 15_000): Promise<Locator> {
  const list = page.locator('[data-keep-scroll="list"]');
  await expect
    .poll(
      async () => {
        await list.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        return page.locator(DIGEST).count();
      },
      { timeout },
    )
    .toBe(1);
  return page.locator(DIGEST);
}
