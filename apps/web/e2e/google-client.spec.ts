import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Plan 99: a build with Terno's own Google client has no Google setup in Settings.
async function accounts(page: Page, builtIn: boolean) {
  if (builtIn) await page.evaluate(() => ((window as { ternoDesktop?: unknown }).ternoDesktop = { googleBuiltIn: true }));
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-accounts").click();
}

test.describe("plan 99: Google client in Settings", () => {
  test("without a built-in client the fields show as before", async ({ app: page }) => {
    await accounts(page, false);
    await expect(page.getByTestId("gmail-client-id")).toBeVisible();
  });

  test("with one, the Google group isn't there at all", async ({ app: page }) => {
    await accounts(page, true);
    await expect(page.getByTestId("accounts-group")).toBeVisible();
    await expect(page.getByText("Google (Gmail)")).toHaveCount(0);
    await expect(page.getByTestId("gmail-client-id")).toHaveCount(0);
  });
});
