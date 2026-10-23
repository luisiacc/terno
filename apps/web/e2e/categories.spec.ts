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
});
