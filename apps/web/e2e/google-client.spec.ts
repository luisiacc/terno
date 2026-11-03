import { expect, test } from "./fixtures";

// Plan 123: Gmail connects only through Terno's own Google client; there is nothing to set up.
test.describe("plan 123: no Google client of your own", () => {
  test("Settings → Accounts has no Google client fields", async ({ app: page }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(page.getByTestId("accounts-group")).toBeVisible();
    await expect(page.getByText("Google (Gmail)")).toHaveCount(0);
    await expect(page.getByTestId("gmail-client-id")).toHaveCount(0);
    await expect(page.getByTestId("gmail-secret")).toHaveCount(0);
  });

  test.describe("a build without Terno's Google client", () => {
    test.use({ backendOptions: { noGoogle: true } });

    test("says so in the form, which stays open with what was typed", async ({ app: page }) => {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-accounts").click();
      await page.getByTestId("settings-add-account").click();
      const dialog = page.getByTestId("add-account-dialog");
      await dialog.getByTestId("imap-email").fill("ana@icloud.com");
      await dialog.getByTestId("connect-gmail").click();
      await expect(dialog.getByRole("alert")).toHaveText("This copy of Terno can’t connect Google accounts. Add the account with IMAP instead.");
      await expect(dialog.getByTestId("imap-email")).toHaveValue("ana@icloud.com");
      await expect(page.getByTestId("tab-accounts")).toHaveCount(0);
    });
  });
});
