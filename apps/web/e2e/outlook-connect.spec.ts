/**
 * Plan 259 stage 3: an Outlook account in the window, against a synthetic Microsoft (sign-in, token, Graph's /me):
 * added from Add account (a refused consent first, said in the form), named Outlook in Settings, signed in again from
 * its row once Microsoft stops honouring its token, and removed with the way to withdraw Terno's access at Microsoft.
 * Sync and send over Graph join this spec with the provider (stage 2).
 */
import { axeBothModes, expect, scenario, test } from "./fixtures";

test.use({ backendOptions: { microsoft: true } });

test("plan 259: add, sign in again and remove an Outlook account", async ({ app: page, server }) => {
  const microsoft = server.microsoft!;
  microsoft.ms.personal("ana@outlook.com");
  const dialog = page.getByTestId("add-account-dialog");
  const row = page.getByTestId("settings-account").filter({ hasText: "ana@outlook.com" });

  await scenario("Add account offers Microsoft beside Google, and an Outlook.com address typed for IMAP points to it", async () => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await page.getByTestId("settings-add-account").click();
    await expect(dialog.getByTestId("connect-microsoft")).toHaveText("Continue with Microsoft");
    const google = await dialog.getByTestId("connect-gmail").boundingBox();
    const ms = await dialog.getByTestId("connect-microsoft").boundingBox();
    // stacked under Google's, the same size and edges
    expect(ms!.x).toBe(google!.x);
    expect(ms!.y).toBeGreaterThan(google!.y);
    expect([ms!.width, ms!.height]).toEqual([google!.width, google!.height]);
    await dialog.getByTestId("imap-email").fill("ana@outlook.com");
    await expect(dialog.getByTestId("imap-microsoft-hint")).toHaveText("outlook.com no longer takes passwords from other apps. Continue with Microsoft");
    await axeBothModes(page, "[data-testid=add-account-dialog]");
  });

  await scenario("a refused consent is said under the buttons; the form keeps what was typed", async () => {
    microsoft.behaviour = "deny";
    await dialog.getByTestId("connect-microsoft").click();
    await expect(dialog.getByTestId("add-account-error")).toHaveText("Microsoft access was denied.");
    await expect(dialog.getByTestId("imap-email")).toHaveValue("ana@outlook.com");
  });

  await scenario("approved, the account is added and named Outlook in Settings", async () => {
    microsoft.behaviour = "approve";
    await dialog.getByTestId("imap-microsoft-connect").click();
    await expect(page.getByTestId("snack-message").getByText("ana@outlook.com")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // Add account took Settings' place; back there, the new row
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(row.getByTestId("account-toggle")).toContainText("ana@outlook.com · Outlook");
    const added = (await server.backend.store.accounts.list()).find((a) => a.email === "ana@outlook.com")!;
    expect(added.kind).toBe("outlook");
    expect(microsoft.ms.authorizations.at(-1)!.get("prompt")).toBe("select_account");
  });

  await scenario("Microsoft stops honouring its sign-in: its row asks, and Continue with Microsoft clears it", async () => {
    const account = (await server.backend.store.accounts.list()).find((a) => a.email === "ana@outlook.com")!;
    microsoft.ms.refreshTokens.clear();
    await server.backend.syncAccount(account.id);
    await expect(row.getByTestId("account-toggle")).toContainText("Needs you to sign in again");
    await row.getByTestId("account-row-sign-in").click();
    const popover = page.getByTestId("sign-in-popover");
    await expect(popover.getByTestId("sign-in-microsoft")).toHaveText("Continue with Microsoft");
    await popover.getByTestId("sign-in-microsoft").click();
    await expect(page.getByTestId("snack-message").getByText("ana@outlook.com is connected again")).toBeVisible();
    // signing in again names the account to Microsoft instead of asking which one
    expect(microsoft.ms.authorizations.at(-1)!.get("login_hint")).toBe("ana@outlook.com");
    await expect(row.getByTestId("account-row-sign-in")).toHaveCount(0);
    await expect.poll(async () => (await server.backend.store.accounts.get(account.id))!.syncState).toMatchObject({ authRequired: false });
  });

  await scenario("removing it says Terno can't withdraw its access at Microsoft, and where to", async () => {
    await row.getByTestId("account-toggle").click();
    await row.getByTestId("account-remove").click();
    const remove = page.getByTestId("account-remove-dialog");
    await expect(remove).toContainText("Terno can’t withdraw its own access at Microsoft");
    await expect(remove.getByRole("button", { name: "Personal account" })).toBeVisible();
    await expect(remove.getByRole("button", { name: "Work or school account" })).toBeVisible();
    await expect(remove.getByRole("button", { name: "Cancel" })).toBeFocused();
    await axeBothModes(page, "[data-testid=account-remove-dialog]");
    await page.getByTestId("account-remove-dialog-confirm").click();
    await expect(page.getByTestId("snack-message").getByText("Account removed")).toBeVisible();
    await expect(row).toHaveCount(0);
    expect((await server.backend.store.accounts.list()).some((a) => a.email === "ana@outlook.com")).toBe(false);
  });
});
