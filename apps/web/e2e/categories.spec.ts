import AxeBuilder from "@axe-core/playwright";
import { expect, rows, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.describe("categories", { tag: "@design" }, () => {
  test("creates a new category from the picker by typing its name; new categories keep their mail out of the Inbox", async ({ app: page, server }) => {
    const first = rows(page).first();
    const id = await first.getAttribute("data-thread-id");
    await first.dispatchEvent("mousedown");
    await page.keyboard.press("l");
    await expect(page.getByTestId("category-picker").getByRole("combobox")).toBeFocused();
    await page.keyboard.type("Proyecto Terno");
    await page.getByTestId("create-category").click();
    const cat = sqlDb(server.backend.store).get<{ id: number; show_in_inbox: number }>("SELECT id, show_in_inbox FROM categories WHERE name = 'Proyecto Terno'")!;
    expect(cat.show_in_inbox).toBe(0);
    await expect(page.getByTestId(`nav-category-${cat.id}`)).toContainText("Proyecto Terno");
    await expect(page.getByTestId(`nav-category-hidden-${cat.id}`)).toBeVisible();
    // filed there, it left the Inbox for the category's list
    await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).toHaveCount(0);
    await page.getByTestId(`nav-category-${cat.id}`).click();
    await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).toBeVisible();
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

  test("⌘K “Add to” files the selection with the same snackbar and undo", async ({ app: page, server }) => {
    const viajes = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
    const row = page.locator(`[data-testid=thread-row]:not(:has([data-slot=category-dot]))`).first();
    const id = (await row.getAttribute("data-thread-id"))!;
    await row.dispatchEvent("mousedown");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const before = Number((await page.getByTestId(`nav-category-${viajes}`).locator("[data-slot=nav-count]").textContent()) || 0);
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill("add to viajes");
    await expect(page.getByRole("option", { selected: true })).toContainText("Add to “Viajes”");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("snackbar-title")).toHaveText("Added to Viajes");
    const target = page.locator(`[data-thread-id="${id}"]`);
    await expect(target.locator("[data-slot=category-dot]")).toHaveCount(1);
    const unread = (await target.getAttribute("data-unread")) !== null;
    if (unread) await expect(page.getByTestId(`nav-category-${viajes}`).locator("[data-slot=nav-count]")).toHaveText(String(before + 1));
    await page.getByTestId("snackbar-undo").click();
    await expect(target.locator("[data-slot=category-dot]")).toHaveCount(0);
  });
});

test.describe("a category hidden from the Inbox (plan 83)", { tag: "@design" }, () => {
  test("right-click → Show in Inbox off: its rows leave the Inbox and its count; the category keeps them; Undo brings them back", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    // the category with the most Inbox threads in the seed
    const { id: cat, name } = db.get<{ id: number; name: string }>(
      `SELECT c.id, c.name FROM categories c JOIN thread_categories tc ON tc.category_id = c.id JOIN threads t ON t.id = tc.thread_id
       WHERE t.in_inbox = 1 GROUP BY c.id ORDER BY count(*) DESC LIMIT 1`,
    )!;
    const hiddenUnread = () =>
      db.get<{ c: number }>(
        "SELECT count(*) AS c FROM threads t WHERE t.in_inbox = 1 AND t.unread_count > 0 AND NOT EXISTS (SELECT 1 FROM thread_categories h JOIN categories k ON k.id = h.category_id WHERE h.thread_id = t.id AND k.show_in_inbox = 0)",
      )!.c;
    const inboxCount = page.getByTestId("nav-inbox").locator("[data-slot=nav-count]");
    await expect(inboxCount).toHaveText(String(hiddenUnread()));
    const inCat = page.locator(`[data-testid=thread-row]:has([data-cat-dot="${cat}"])`);
    await expect(inCat.first()).toBeVisible();

    await page.getByTestId(`nav-category-${cat}`).click({ button: "right" });
    const item = page.getByTestId("category-menu-show-in-inbox");
    await expect(item).toHaveAttribute("aria-checked", "true");
    await item.click();
    await expect(page.getByTestId("snack").filter({ hasText: `${name} is hidden from the Inbox` })).toBeVisible();
    await expect(inCat).toHaveCount(0);
    await expect(page.getByTestId(`nav-category-hidden-${cat}`)).toBeVisible();
    expect(db.get("SELECT show_in_inbox FROM categories WHERE id = ?", cat)).toEqual({ show_in_inbox: 0 });
    await expect(inboxCount).toHaveText(String(hiddenUnread()));
    await expect(rows(page).first()).toBeVisible();

    // where the mail is now: the category's own list
    await page.getByTestId(`nav-category-${cat}`).click();
    await expect(page.getByTestId("list-title")).toHaveText(name);
    await expect(inCat.first()).toBeVisible();
    await page.getByTestId("nav-inbox").click();
    await expect(inCat).toHaveCount(0);

    await page.keyboard.press("z");
    await expect(inCat.first()).toBeVisible();
    await expect(page.getByTestId(`nav-category-hidden-${cat}`)).toHaveCount(0);
    expect(db.get("SELECT show_in_inbox FROM categories WHERE id = ?", cat)).toEqual({ show_in_inbox: 1 });
  });

  test("right-click → Delete…: Cancel keeps it; Delete removes it, keeps its mail, and its open list goes back to the Inbox", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const { id: cat, name } = db.get<{ id: number; name: string }>("SELECT id, name FROM categories WHERE name = 'Facturas'")!;
    const threads = () => db.get<{ c: number }>("SELECT count(*) AS c FROM threads")!.c;
    const before = threads();
    const nav = page.getByTestId(`nav-category-${cat}`);
    await nav.click();
    await expect(page.getByTestId("list-title")).toHaveText(name);

    await nav.click({ button: "right" });
    await page.getByTestId("category-menu-delete").click();
    const dialog = page.getByTestId("category-delete-dialog");
    await expect(dialog).toContainText(`Delete “${name}”?`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(nav).toBeVisible();

    // the row has focus, and the delete answers after the dialog has handed it back
    await nav.focus();
    const handlers = (server.backend.server as unknown as { handlers: Record<string, (...a: unknown[]) => Promise<unknown>> }).handlers;
    const remove = handlers["categories.delete"]!;
    handlers["categories.delete"] = async (...a) => (await new Promise((r) => setTimeout(r, 300)), remove(...a));
    await nav.click({ button: "right" });
    await page.getByTestId("category-menu-delete").click();
    await page.getByTestId("category-delete-dialog-confirm").click();
    await expect(page.getByTestId("snack").filter({ hasText: `“${name}” deleted` })).toBeVisible();
    await expect(nav).toHaveCount(0);
    await expect(page.getByTestId("nav-inbox")).toBeFocused();
    // the Inbox (whose title is a greeting in some designs)
    expect(await page.evaluate(() => (window as unknown as { __terno: { getApp(): { categoryId: number | null; view: string } } }).__terno.getApp())).toMatchObject({ categoryId: null, view: "inbox" });
    expect(db.get("SELECT id FROM categories WHERE id = ?", cat)).toBeUndefined();
    expect(threads()).toBe(before);
  });

  for (const mode of ["light", "dark"] as const) {
    test(`the category menu, its Delete… highlighted, is axe-clean, ${mode}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, { clientId: "setup", origin: "dev" });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const cat = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
      await page.getByTestId(`nav-category-${cat}`).click({ button: "right" });
      await page.getByTestId("category-menu-delete").hover();
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/menu-${mode}.png` });
      const r = await new AxeBuilder({ page }).include(`[data-testid=category-menu-${cat}]`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);
    });
  }

  test("Settings → Categories: the Show in Inbox switch hides it, and says so in the row", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-categories").click();
    const item = page.getByTestId(`category-stats-${facturas}`);
    await item.getByTestId("category-toggle").click();
    const toggle = item.getByRole("switch", { name: "Show in Inbox" });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => db.get("SELECT show_in_inbox FROM categories WHERE id = ?", facturas)).toEqual({ show_in_inbox: 0 });
    await expect(item.getByTestId("category-toggle")).toContainText("Hidden from the Inbox");
    await toggle.click();
    await expect.poll(() => db.get("SELECT show_in_inbox FROM categories WHERE id = ?", facturas)).toEqual({ show_in_inbox: 1 });
  });
});
