import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Plan 99: a build with Terno's own Google client tucks the bring-your-own fields away.
async function accounts(page: Page, builtIn: boolean) {
  if (builtIn) await page.evaluate(() => ((window as { ternoDesktop?: unknown }).ternoDesktop = { googleBuiltIn: true }));
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-accounts").click();
}

test.describe("plan 99: Google client in Settings", () => {
  test("without a built-in client the fields show as before", async ({ app: page }) => {
    await accounts(page, false);
    await expect(page.getByTestId("gmail-client-id")).toBeVisible();
    await expect(page.getByTestId("google-own-toggle")).toHaveCount(0);
  });

  test("with one, your own client is a disclosure; a client you set keeps the fields open", async ({ app: page }) => {
    await accounts(page, true);
    const toggle = page.getByTestId("google-own-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("gmail-client-id")).toBeHidden();
    await expect(page.getByTestId("google-client")).toContainText("its own Google client");
    expect((await new AxeBuilder({ page }).include("[data-testid=google-client]").analyze()).violations).toEqual([]);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const field = page.getByTestId("gmail-client-id");
    await field.fill("synthetic.apps.googleusercontent.com");
    await field.press("Enter");
    // yours is set: no disclosure to hide it behind
    await expect(toggle).toHaveCount(0);
    await expect(field).toBeVisible();
  });
});
