import type { Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { expect, focusList, selectThread, test } from "./fixtures";

const toast = (page: Page, text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text });

/** An Uber receipt in the inbox that isn't in Facturas yet, plus a live count of the ones still outside. */
function uberSetup(server: DevServer) {
  const db = server.backend.db;
  const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
  const target = db.get<{ id: number }>(
    `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'uber.receipts@uber.com'
     AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 1`,
    facturas,
  )!.id;
  const outside = () =>
    db.get<{ c: number }>(
      `SELECT count(*) c FROM threads t WHERE t.last_from_email = 'uber.receipts@uber.com' AND t.in_trash = 0 AND t.in_spam = 0
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?)`,
      facturas,
    )!.c;
  return { db, facturas, target, outside };
}

async function fileWithPicker(page: Page, categoryId: number) {
  await page.keyboard.press("l");
  await expect(page.getByTestId("category-picker")).toBeVisible();
  await page.getByTestId(`pick-category-${categoryId}`).click();
  await focusList(page);
}

test.describe("categorization snackbar", () => {
  test("filing one thread offers all mail from its sender: 1 files it, the result toast undoes it", async ({ app: page, server }) => {
    const { facturas, target, outside } = uberSetup(server);
    const rest = outside() - 1;
    expect(rest).toBeGreaterThan(1);
    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await fileWithPicker(page, facturas);

    const snack = page.getByTestId("category-snackbar");
    await expect(snack.getByTestId("snackbar-title")).toHaveText("Añadido a Facturas");
    await expect(snack.getByTestId("snackbar-sender")).toContainText("Todo de Uber Receipts");
    await expect(snack.getByTestId("snackbar-sender-count")).toHaveText(`· ${rest}`);
    await expect(page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Facturas" })).toBeVisible();

    await page.keyboard.press("1");
    await expect(snack).toHaveCount(0);
    const done = toast(page, `${rest} añadidas a Facturas`);
    await expect(done).toBeVisible();
    await expect.poll(outside).toBe(0);
    await done.getByRole("button", { name: "Deshacer" }).click();
    await expect.poll(outside).toBe(rest);
  });

  test("z undoes the add itself without teaching the engine anything; Esc just closes", async ({ app: page, server }) => {
    const { db, facturas, target } = uberSetup(server);
    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await fileWithPicker(page, facturas);
    await expect(page.getByTestId("category-snackbar")).toBeVisible();
    await expect.poll(() => db.get("SELECT label FROM cls_examples WHERE thread_id = ? AND category_id = ?", target, facturas)).toEqual({ label: 1 });
    await page.keyboard.press("z");
    await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
    await expect.poll(() => db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", target, facturas) ?? null).toBeNull();
    // an undo is not a removal: no negative example
    expect(db.get("SELECT 1 FROM cls_examples WHERE thread_id = ?", target)).toBeUndefined();
    await expect(page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Facturas" })).toHaveCount(0);

    await fileWithPicker(page, facturas);
    await expect(page.getByTestId("category-snackbar")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
    expect(db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", target, facturas)).toBeDefined();
  });

  test("5 makes it a filter for that sender", async ({ app: page, server }) => {
    const { db, facturas, target } = uberSetup(server);
    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await fileWithPicker(page, facturas);
    await expect(page.getByTestId("snackbar-filter")).toBeVisible();
    await page.keyboard.press("5");
    await expect(toast(page, "Filtro creado")).toBeVisible();
    const rule = JSON.parse(db.get<{ rule_json: string }>("SELECT rule_json FROM filters ORDER BY id DESC LIMIT 1")!.rule_json);
    expect(rule).toEqual({ match: "all", conditions: [{ field: "from", op: "equals", value: "uber.receipts@uber.com" }], actions: [{ type: "addCategory", categoryId: facturas }] });
    await toast(page, "Filtro creado").getByRole("button", { name: "Editar" }).click();
    await expect(page.getByTestId("filters-dialog")).toBeVisible();
  });

  test("several threads: the chips cover what they share, without duplicates", async ({ app: page, server }) => {
    const db = server.backend.db;
    const lecturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Lecturas'")!.id;
    const [a, b] = db.all<{ id: number }>(
      `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email IN ('notifications@github.com')
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 2`,
      lecturas,
    );
    await page.getByTestId("search-input").fill("in:inbox from:notifications@github.com");
    await expect(page.getByTestId("search-stats")).toBeVisible();
    for (const id of [a!.id, b!.id]) {
      await page.locator(`[data-thread-id="${id}"]`).dispatchEvent("mousedown");
      await focusList(page);
      await page.keyboard.press("x");
    }
    await fileWithPicker(page, lecturas);
    const snack = page.getByTestId("category-snackbar");
    await expect(snack.getByTestId("snackbar-title")).toHaveText("2 conversaciones añadidas a Lecturas");
    await expect(snack.getByTestId("snackbar-sender")).toContainText("Todo de GitHub");
    // @github.com has no mail beyond this sender: no second chip saying the same
    await expect(snack.getByTestId("snackbar-sender-count")).toBeVisible();
    await expect(snack.getByTestId("snackbar-domain")).toHaveCount(0);
    const githubOutside = () =>
      db.get<{ c: number }>(
        `SELECT count(*) c FROM threads t WHERE t.in_trash = 0 AND t.in_spam = 0 AND t.id IN (SELECT thread_id FROM messages WHERE from_email = 'notifications@github.com')
         AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?)`,
        lecturas,
      )!.c;
    await expect(snack.getByTestId("snackbar-sender-count")).toHaveText(`· ${githubOutside()}`);
    await page.keyboard.press("1");
    await expect.poll(githubOutside).toBe(0);
  });
});
