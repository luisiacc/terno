import { expect, rows, selectThread, test } from "./fixtures";

test.describe("categories", () => {
  test("l adds a category; similar mail is suggested and added in one click", async ({ app: page, server }) => {
    const db = server.backend.db;
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const target = db.get<{ id: number }>(
      `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'uber.receipts@uber.com'
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 1`,
      facturas,
    )!.id;
    const uncategorized = () =>
      db.get<{ c: number }>(
        `SELECT count(*) c FROM threads t WHERE t.last_from_email = 'uber.receipts@uber.com' AND t.in_trash = 0 AND t.in_spam = 0
         AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?)`,
        facturas,
      )!.c;
    const missing = uncategorized();
    expect(missing).toBeGreaterThan(1);

    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await page.keyboard.press("l");
    await expect(page.getByTestId("category-picker")).toBeVisible();
    await page.getByTestId(`pick-category-${facturas}`).click();
    await expect(page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Facturas" })).toBeVisible();
    await expect(page.locator(`[data-thread-id="${target}"] [data-slot=category-dot]`)).toHaveCount(1);

    const card = page.getByTestId("category-suggestion");
    await expect(card).toContainText("conversaciones similares");
    await expect(card).toContainText(`Hay ${missing - 1} conversaciones`);
    await page.getByTestId("suggestion-accept").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "añadidas a Facturas" })).toBeVisible();
    await expect.poll(uncategorized).toBe(0);
  });

  test("creates a new category from the picker by typing its name", async ({ app: page }) => {
    await rows(page).first().dispatchEvent("mousedown");
    await page.keyboard.press("l");
    await expect(page.getByTestId("category-picker").getByRole("combobox")).toBeFocused();
    await page.keyboard.type("Proyecto Única");
    await page.getByTestId("create-category").click();
    await expect(page.getByTestId("sidebar").getByText("Proyecto Única")).toBeVisible();
    await expect(page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Proyecto Única" })).toBeVisible();
  });

  test("a category view gathers mail from several accounts", async ({ app: page }) => {
    await page.getByTestId("sidebar").getByText("Lecturas", { exact: true }).click();
    await expect(page.getByTestId("list-title")).toHaveText("Lecturas");
    await expect(rows(page).first()).toBeVisible();
    const accounts = await page.getByTestId("account-bar").evaluateAll((els) => new Set(els.map((e) => e.className)).size);
    expect(accounts).toBeGreaterThan(1);
  });
});
