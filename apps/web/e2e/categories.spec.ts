import { expect, rows, test } from "./fixtures";

test.describe("categories", () => {
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

  test("⌘K «Añadir a» files the selection with the same snackbar and undo", async ({ app: page, server }) => {
    const viajes = server.backend.db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
    const row = page.locator(`[data-testid=thread-row]:not(:has([data-slot=category-dot]))`).first();
    const id = (await row.getAttribute("data-thread-id"))!;
    await row.dispatchEvent("mousedown");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const before = Number((await page.getByTestId(`nav-category-${viajes}`).locator("[data-slot=nav-count]").textContent()) || 0);
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill("añadir a viajes");
    await expect(page.getByRole("option", { selected: true })).toContainText("Añadir a «Viajes»");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("snackbar-title")).toHaveText("Añadido a Viajes");
    const target = page.locator(`[data-thread-id="${id}"]`);
    await expect(target.locator("[data-slot=category-dot]")).toHaveCount(1);
    const unread = (await target.getAttribute("data-unread")) !== null;
    if (unread) await expect(page.getByTestId(`nav-category-${viajes}`).locator("[data-slot=nav-count]")).toHaveText(String(before + 1));
    await page.getByTestId("snackbar-undo").click();
    await expect(target.locator("[data-slot=category-dot]")).toHaveCount(0);
  });
});
