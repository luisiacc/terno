import { expect, rows, search, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.describe("AI filters and learned filters", () => {
  test("builds a filter from a Spanish prompt, previews it live and applies it", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const inboxUber = () => db.get<{ c: number }>("SELECT count(*) c FROM threads WHERE in_inbox = 1 AND last_from_email = 'uber.receipts@uber.com'")!.c;
    expect(inboxUber()).toBeGreaterThan(0);

    await page.getByTestId("open-filters").click();
    await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com y ponlos en Facturas");
    await page.getByTestId("ai-generate").click();
    await expect(page.getByTestId("ai-explanation")).toBeVisible();
    await expect(page.getByTestId("condition-value")).toHaveValue("uber.com");
    await expect(page.getByTestId("action-toggle-archive")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("action-category-select")).toContainText("Facturas");

    const preview = page.getByTestId("preview-count");
    await expect(preview).toHaveText(/^[1-9]\d*$/);
    const uberCount = Number(await preview.textContent());
    expect(await page.getByTestId("filter-preview").locator("li").count()).toBeGreaterThan(0);

    // live preview: editing the condition changes the matches
    await page.getByTestId("condition-value").fill("rappi.com");
    await expect(preview).not.toHaveText(String(uberCount));
    await page.getByTestId("condition-value").fill("uber.com");
    await expect(preview).toHaveText(String(uberCount));

    await page.getByTestId("filter-save-apply").click();
    await expect(page.locator("[data-testid=snack]").filter({ hasText: /Filter applied to \d+ conversations/ })).toBeVisible();
    await expect(page.getByTestId("filter-item")).toContainText(["AI"]);
    await expect.poll(inboxUber).toBe(0);
    await page.keyboard.press("Escape");
    // nothing of theirs is left in the Inbox (a search everywhere still finds them, where the filter put them)
    await search(page, "in:inbox from:uber.receipts@uber.com");
    await expect(page.getByTestId("list-empty")).toBeVisible();
  });

  test("with AI off there is no AI box: rules are built by hand", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, { clientId: "setup", origin: "dev" });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.getByTestId("open-filters").click();
    await expect(page.getByTestId("condition-value")).toBeVisible();
    await expect(page.getByTestId("ai-prompt")).toHaveCount(0);
    await expect(page.getByTestId("ai-generate")).toHaveCount(0);
  });

  test("invalid rules can't be saved", async ({ app: page }) => {
    await page.getByTestId("open-filters").click();
    await expect(page.getByTestId("condition-value")).toHaveValue("");
    await expect(page.getByTestId("filter-save")).toBeDisabled();
    await page.getByTestId("condition-value").fill("news@tienda.com");
    await expect(page.getByTestId("filter-save")).toBeEnabled();
    await page.getByTestId("action-toggle-archive").click(); // remove the only action
    await expect(page.getByTestId("filter-save")).toBeDisabled();
  });

  test("plan 89: a pattern is checked as it's typed, saved, and applied in the background", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const read = () => db.get<{ c: number }>("SELECT count(*) c FROM threads WHERE unread_count = 0 AND last_from_email = 'uber.receipts@uber.com'")!.c;
    await page.getByTestId("open-filters").click();
    await page.getByTestId("condition-field").click();
    await page.getByRole("option", { name: "Sender", exact: true }).click();
    await page.getByTestId("condition-op").click();
    await page.getByRole("option", { name: "matches pattern" }).click();
    const value = page.getByTestId("condition-value");
    const help = page.getByTestId("condition-pattern-help");
    await expect(help).toContainText("[0-9]+ is any number");
    // a lookahead isn't supported: said under the field, and the filter can't be saved
    await value.fill("(?=uber)");
    await expect(value).toHaveAttribute("aria-invalid", "true");
    await expect(help).toHaveText("Patterns can’t look around (?=, ?!) or refer back to a group (\\1).");
    await expect(page.getByTestId("filter-save")).toBeDisabled();
    await value.fill("^uber\\.receipts@uber\\.(com|mx)$");
    await expect(value).not.toHaveAttribute("aria-invalid");
    await expect(page.getByTestId("preview-count")).toHaveText(/^[1-9]\d*$/);
    await page.getByTestId("action-toggle-archive").click();
    await page.getByTestId("action-toggle-markRead").click();
    await page.getByTestId("filter-save-apply").click();
    // the dialog is free at once; the snack follows the job to its end
    await expect(page.getByTestId("filter-save")).toBeEnabled();
    await expect(page.locator("[data-testid=snack]").filter({ hasText: /Filter applied to \d+ conversations?/ })).toBeVisible();
    await expect.poll(read).toBeGreaterThan(0);
    await expect(page.getByTestId("filter-item").first()).toBeVisible();
  });

  test("the learned suggestion becomes a filter in one click", async ({ app: page }) => {
    const banner = page.getByTestId("learned-banner");
    await expect(banner).toContainText("daily.morningbrew.com");
    await page.getByTestId("learned-accept").click();
    await expect(banner).toHaveCount(0);
    await page.getByTestId("open-filters").click();
    await expect(page.getByTestId("filter-item").filter({ hasText: "Learned" })).toContainText("daily.morningbrew.com");
    await expect(rows(page).first()).toBeVisible();
  });
});
