import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Plan 204 (after the panel, revision 10): the digest's way in is Today's last option, so the virtualized list is scrolled
 * to its end until the row is drawn (and the digest has come, `timeout` long).
 */
export async function digestRow(page: Page, timeout = 15_000): Promise<Locator> {
  const list = page.locator('[data-keep-scroll="list"]');
  await expect
    .poll(
      async () => {
        await list.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        return page.getByTestId("digest-row").count();
      },
      { timeout },
    )
    .toBe(1);
  return page.getByTestId("digest-row");
}
