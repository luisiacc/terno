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
    await expect(page.locator("[data-testid=snack]").filter({ hasText: /Filtro aplicado a \d+ conversaciones/ })).toBeVisible();
    await expect(page.getByTestId("filter-item")).toContainText(["IA"]);
    await expect.poll(inboxUber).toBe(0);
    await page.keyboard.press("Escape");
    await search(page, "from:uber.receipts@uber.com");
    await expect(page.getByTestId("list-empty")).toBeVisible();
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

  test("the learned suggestion becomes a filter in one click", async ({ app: page }) => {
    const banner = page.getByTestId("learned-banner");
    await expect(banner).toContainText("daily.morningbrew.com");
    await page.getByTestId("learned-accept").click();
    await expect(banner).toHaveCount(0);
    await page.getByTestId("open-filters").click();
    await expect(page.getByTestId("filter-item").filter({ hasText: "Aprendido" })).toContainText("daily.morningbrew.com");
    await expect(rows(page).first()).toBeVisible();
  });
});
