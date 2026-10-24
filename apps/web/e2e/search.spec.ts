import { expect, rows, search, test } from "./fixtures";

test.describe("search", () => {
  test("shows results with timing and restores the inbox when cleared", async ({ app: page }) => {
    const inboxFirst = await rows(page).first().getAttribute("data-thread-id");
    await search(page, "factura");
    await expect(page.getByTestId("search-stats")).toHaveText(/\d+\+? resultados · (<1|\d+) ms/);
    await expect(page.getByTestId("list-title")).toHaveText("Entrada"); // scoped to the current view
    const n = await rows(page).count();
    expect(n).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Limpiar búsqueda" }).click();
    await expect(page.getByTestId("search-stats")).toHaveCount(0);
    await expect(rows(page).first()).toHaveAttribute("data-thread-id", inboxFirst!);
  });

  test("from: with an exact address only returns that sender", async ({ app: page }) => {
    await search(page, "in:all from:crew@morningbrew.com");
    await expect(rows(page).first()).toBeVisible();
    const senders = [...new Set(await page.getByTestId("row-from").allTextContents())];
    expect(senders).toEqual(["Morning Brew"]);
  });

  test("is accent- and case-insensitive", async ({ app: page }) => {
    await search(page, "in:all REUNION");
    const subjects = await rows(page).evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    expect(subjects.length).toBeGreaterThan(0);
    expect(subjects.some((s) => /reunión/i.test(s))).toBe(true);
  });

  test("searches across all accounts at once", async ({ app: page }) => {
    await search(page, "in:all factura");
    const bars = await page.getByTestId("account-mark").evaluateAll((els) => new Set(els.map((e) => e.className)).size);
    expect(bars).toBeGreaterThan(1);
  });

  test("Escape clears an active query; / focuses the box from anywhere", async ({ app: page }) => {
    await page.keyboard.press("/");
    await expect(page.getByTestId("search-input")).toBeFocused();
    await page.keyboard.type("zzqxjv");
    await expect(page.getByTestId("list-empty")).toContainText("Sin resultados");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("search-input")).toHaveValue("");
    await expect(rows(page).first()).toBeVisible();
  });
});
