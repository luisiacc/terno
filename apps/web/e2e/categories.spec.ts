import { expect, rows, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.describe("categories", () => {
  test("creates a new category from the picker by typing its name", async ({ app: page }) => {
    await rows(page).first().dispatchEvent("mousedown");
    await page.keyboard.press("l");
    await expect(page.getByTestId("category-picker").getByRole("combobox")).toBeFocused();
    await page.keyboard.type("Proyecto Terno");
    await page.getByTestId("create-category").click();
    await expect(page.getByTestId("sidebar").getByText("Proyecto Terno")).toBeVisible();
    await expect(page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Proyecto Terno" })).toBeVisible();
  });

  test("a category view gathers mail from several accounts", async ({ app: page }) => {
    await page.getByTestId("sidebar").getByText("Lecturas", { exact: true }).click();
    await expect(page.getByTestId("list-title")).toHaveText("Lecturas");
    await expect(rows(page).first()).toBeVisible();
    const accounts = await page.getByTestId("account-mark").evaluateAll((els) => new Set(els.map((e) => e.className)).size);
    expect(accounts).toBeGreaterThan(1);
    // the account is a small ring beside the time (not a rail-like bar), told apart from filled category dots
    const box = (await page.getByTestId("account-mark").first().boundingBox())!;
    expect(box.width).toBe(box.height);
    expect(box.width).toBeLessThanOrEqual(7);
    expect(await page.getByTestId("account-mark").first().evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test("⌘K «Añadir a» files the selection with the same snackbar and undo", async ({ app: page, server }) => {
    const viajes = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
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
