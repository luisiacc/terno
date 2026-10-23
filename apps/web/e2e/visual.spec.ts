/**
 * Visual regression of the key screens (light + dark). Baselines live in
 * e2e/__screenshots__; regenerate with `pnpm test:e2e --update-snapshots`.
 */
import { expect, focusList, openRow, search, stabilize, test } from "./fixtures";
import type { Page } from "@playwright/test";

async function ready(page: Page, { banner = true } = {}) {
  await page.evaluate(() => document.fonts.ready);
  if (banner) await expect(page.getByTestId("learned-banner")).toBeVisible();
  await expect(page.getByTestId("message").first()).toBeVisible();
  await stabilize(page);
}

test.describe("light", () => {
  test("inbox with the reader", async ({ app: page }) => {
    await ready(page);
    await expect(page).toHaveScreenshot("inbox-light.png");
  });

  test("HTML newsletter with remote content blocked", async ({ app: page }) => {
    await openRow(page, 2);
    await expect(page.getByTestId("remote-blocked")).toBeVisible();
    await expect(page.frameLocator("iframe[title='Contenido del correo']").locator("h1")).toBeVisible();
    await ready(page);
    await expect(page).toHaveScreenshot("reader-html.png");
  });

  test("search results", async ({ app: page }) => {
    await search(page, "in:all factura");
    await ready(page, { banner: false });
    await expect(page).toHaveScreenshot("search.png", { mask: [page.getByTestId("search-stats")] });
  });

  test("reply composer", async ({ app: page }) => {
    await ready(page);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await expect(page).toHaveScreenshot("composer-reply.png");
  });

  test("AI filter builder with live preview", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("open-filters").click();
    await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com y ponlos en Facturas");
    await page.getByTestId("ai-generate").click();
    await expect(page.getByTestId("preview-count")).toHaveText(/^\d+$/);
    await stabilize(page);
    await expect(page).toHaveScreenshot("filters-ai.png", { mask: [page.getByTestId("preview-ms")] });
  });

  test("settings: agents", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-agents").click();
    await expect(page.getByTestId("mcp-claude")).toBeVisible();
    await stabilize(page);
    await expect(page).toHaveScreenshot("settings-agents.png");
  });

  test("add account", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("sidebar").getByText("Añadir cuenta").click();
    await page.getByTestId("imap-email").fill("ana@icloud.com");
    await stabilize(page);
    await expect(page).toHaveScreenshot("add-account.png");
  });

  test("category picker and similar-mail suggestion", async ({ app: page, server }) => {
    const facturas = server.backend.db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    await search(page, "in:inbox from:uber.receipts@uber.com");
    const target = server.backend.db.get<{ id: number }>(
      `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'uber.receipts@uber.com'
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 1`,
      facturas,
    )!.id;
    await page.locator(`[data-thread-id="${target}"]`).dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await expect(page.getByTestId("category-picker").getByRole("combobox")).toBeFocused();
    await stabilize(page);
    await expect(page).toHaveScreenshot("category-picker.png", { mask: [page.getByTestId("search-stats")] });
    await page.getByTestId(`pick-category-${facturas}`).click();
    await expect(page.getByTestId("category-suggestion")).toBeVisible();
    await expect(page).toHaveScreenshot("category-suggestion.png", { mask: [page.getByTestId("search-stats")] });
  });
});

test.describe("dark", () => {
  test.use({ colorScheme: "dark" });

  test("inbox with the reader", async ({ app: page }) => {
    await ready(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page).toHaveScreenshot("inbox-dark.png");
  });

  test("AI filter builder", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("open-filters").click();
    await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com y ponlos en Facturas");
    await page.getByTestId("ai-generate").click();
    await expect(page.getByTestId("preview-count")).toHaveText(/^\d+$/);
    await stabilize(page);
    await expect(page).toHaveScreenshot("filters-ai-dark.png", { mask: [page.getByTestId("preview-ms")] });
  });
});
