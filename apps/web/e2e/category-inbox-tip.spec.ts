import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, rows, test } from "./fixtures";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";

// the tip is seen already in every other spec (fixtures): here it's a first category
test.use({ tips: true });

const tip = (page: Page) => page.getByTestId("tip-category-inbox");

const categoryId = (server: DevServer, name: string): number => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = ?", name)!.id;

/** the sidebar's +: type a name, Enter */
async function create(page: Page, server: DevServer, name: string): Promise<number> {
  await page.getByTestId("new-category").click();
  await page.getByTestId("new-category-input").fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sidebar").getByText(name, { exact: true })).toBeVisible();
  return categoryId(server, name);
}

test.describe("the first new category's tip (plan 113)", { tag: "@design" }, () => {
  test("shows once, to the right of the new row, with the right-click pictured; Got it closes it for good", async ({ app: page, server }) => {
    const id = await create(page, server, "LinkedIn");
    await expect(tip(page)).toBeVisible();
    await expect(tip(page).getByRole("heading")).toHaveText("LinkedIn stays out of the Inbox");
    await expect(tip(page)).toContainText("right-click LinkedIn and choose Show in Inbox");
    const picture = page.getByTestId("tip-picture");
    await expect(picture).toContainText("Right-click");
    await expect(picture).toContainText("Show in Inbox");
    await expect(picture).toHaveAttribute("aria-hidden", "true");

    // beside its row, to the right, level with it
    const row = (await page.getByTestId(`nav-category-${id}`).boundingBox())!;
    const box = (await tip(page).boundingBox())!;
    expect(box.x).toBeGreaterThan(row.x + row.width);
    expect(box.y).toBeLessThan(row.y + row.height);
    expect(box.y + box.height).toBeGreaterThan(row.y);
    // it never takes focus
    expect(await tip(page).evaluate((el) => el.contains(document.activeElement))).toBe(false);

    await page.getByTestId("tip-done").click();
    await expect(tip(page)).toHaveCount(0);

    // the next category, and a reload: no tip
    await create(page, server, "Recibos");
    await expect(tip(page)).toHaveCount(0);
    await page.reload();
    await rows(page).first().waitFor();
    await create(page, server, "Viajes 2");
    await expect(tip(page)).toHaveCount(0);
  });

  test("a right-click on the row closes it and opens the category's menu", async ({ app: page, server }) => {
    const id = await create(page, server, "LinkedIn");
    await expect(tip(page)).toBeVisible();
    await page.getByTestId(`nav-category-${id}`).click({ button: "right" });
    await expect(page.getByTestId(`category-menu-${id}`)).toBeVisible();
    await expect(tip(page)).toHaveCount(0);
    // Show in Inbox, as it said: the eye-off goes
    await page.getByTestId("category-menu-show-in-inbox").click();
    await expect(page.getByTestId(`nav-category-hidden-${id}`)).toHaveCount(0);
    await expect(tip(page)).toHaveCount(0);
  });

  test("Escape closes it, and only it", async ({ app: page, server }) => {
    const id = await create(page, server, "LinkedIn");
    await expect(tip(page)).toBeVisible();
    const before = await page.evaluate(() => (window as unknown as { __terno: { getApp(): { categoryId: number | null } } }).__terno.getApp().categoryId);
    expect(before).toBe(id);
    await page.keyboard.press("Escape");
    await expect(tip(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __terno: { getApp(): { categoryId: number | null } } }).__terno.getApp().categoryId)).toBe(id);
  });

  test("Escape while typing a search closes the tip and leaves the search as it was (Codex review)", async ({ app: page, server }) => {
    await create(page, server, "LinkedIn");
    await expect(tip(page)).toBeVisible();
    await page.keyboard.press("/");
    const search = page.getByTestId("search-input");
    await expect(search).toBeFocused();
    await page.keyboard.type("factura");
    await page.keyboard.press("Escape");
    await expect(tip(page)).toHaveCount(0);
    await expect(search).toHaveValue("factura");
    await expect(search).toBeFocused();
  });

  test("from the picker, it waits for the picker to close, then points at the row", async ({ app: page, server }) => {
    await rows(page).first().dispatchEvent("mousedown");
    await page.keyboard.press("l");
    await expect(page.getByTestId("category-picker").getByRole("combobox")).toBeFocused();
    await page.keyboard.type("LinkedIn");
    await page.getByTestId("create-category").click();
    await expect(page.getByTestId("category-picker")).toHaveCount(0);
    const id = categoryId(server, "LinkedIn");
    await expect(tip(page)).toBeVisible();
    const row = (await page.getByTestId(`nav-category-${id}`).boundingBox())!;
    expect((await tip(page).boundingBox())!.x).toBeGreaterThan(row.x + row.width);
    // a dialog over it ends it
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await expect(tip(page)).toHaveCount(0);
  });

  test("from Settings, it waits for Settings to close", async ({ app: page, server }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-categories").click();
    await page.getByTestId("category-new").fill("LinkedIn");
    await page.getByTestId("category-create").click();
    await expect(page.getByTestId("sidebar").getByText("LinkedIn", { exact: true })).toBeAttached();
    await expect(tip(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(tip(page)).toBeVisible();
    const row = (await page.getByTestId(`nav-category-${categoryId(server, "LinkedIn")}`).boundingBox())!;
    expect((await tip(page).boundingBox())!.x).toBeGreaterThan(row.x + row.width);
  });

  for (const mode of ["light", "dark"] as const) {
    test(`is axe-clean, ${mode}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, { clientId: "setup", origin: "dev" });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await create(page, server, "LinkedIn");
      await expect(tip(page)).toBeVisible();
      // past its fade-in
      await page.waitForTimeout(300);
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/tip-${test.info().project.name}-${mode}.png` });
      const r = await new AxeBuilder({ page }).include("[data-testid=tip-category-inbox]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);
    });
  }
});
