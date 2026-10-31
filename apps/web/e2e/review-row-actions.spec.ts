/**
 * Plan 80: a category's Review list answers its suggestions from the rows: ✓
 * files the conversation, Always ▾ files the same subject from the sender (or
 * everything from them) now and in the future, with one Undo for both.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, test } from "./fixtures";

const ctx = { clientId: "test", origin: "dev" } as const;
const SUBJECT = "Tu recibo de Rappi";
const toast = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });

/**
 * Three uncategorized Rappi receipts with a pending Facturas suggestion; two of them (and only those) share one
 * subject. A fresh page (counts at boot) on the Review list.
 */
async function reviewing(page: Page, server: DevServer) {
  const db = sqlDb(server.backend.store);
  const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
  const threads = db
    .all<{ id: number }>(
      `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'recibos@rappi.com'
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 3`,
    )
    .map((r) => r.id);
  expect(threads).toHaveLength(3);
  for (const [i, t] of threads.entries()) {
    if (i < 2) db.run("UPDATE messages SET subject = ?, subject_norm = lower(?) WHERE thread_id = ?", SUBJECT, SUBJECT, t);
    db.run("INSERT OR REPLACE INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.91, '[]', ?)", t, facturas, Date.now());
  }
  const sameSubject = db.get<{ c: number }>(
    `SELECT count(DISTINCT m.thread_id) c FROM messages m JOIN threads t ON t.id = m.thread_id
     WHERE m.from_email = 'recibos@rappi.com' AND m.subject_norm = lower(?) AND m.is_sent = 0 AND t.in_trash = 0 AND t.in_spam = 0
     AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?)`,
    SUBJECT,
    facturas,
  )!.c;
  const fromRappi = () =>
    db.get<{ c: number }>(
      `SELECT count(DISTINCT m.thread_id) c FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.from_email = 'recibos@rappi.com' AND m.is_sent = 0 AND t.in_trash = 0 AND t.in_spam = 0
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?)`,
      facturas,
    )!.c;
  const filed = (t: number) => db.get<{ added_by: string }>("SELECT added_by FROM thread_categories WHERE thread_id = ? AND category_id = ?", t, facturas)?.added_by ?? null;
  // the filters about this sender (the demo mailbox has its own)
  const filters = () =>
    db.all<{ name: string; rule_json: string }>("SELECT name, rule_json FROM filters WHERE rule_json LIKE '%recibos@rappi.com%' ORDER BY id").map((f) => ({ name: f.name, rule: JSON.parse(f.rule_json) as unknown }));
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await page.getByTestId(`nav-review-${facturas}`).click();
  await expect(page.getByTestId("list-title")).toHaveText("Review · Facturas");
  await expect(page.getByTestId("thread-row")).toHaveCount(3);
  return { db, facturas, threads, sameSubject, fromRappi, filed, filters };
}

/** the open thread (the list's cursor), if any */
const cursor = async (page: Page) => (await page.locator("[data-testid=thread-row][data-cursor]").count()) ? Number(await page.locator("[data-testid=thread-row][data-cursor]").getAttribute("data-thread-id")) : null;

const row = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);

test.describe("Review list: answering from the rows (plan 80)", { tag: "@design" }, () => {
  test("only Review rows have the controls; ✓ files it as accepted, the row leaves, nothing opens", async ({ app: page, server }) => {
    await expect(page.getByTestId("thread-row").first()).toBeVisible();
    await expect(page.getByTestId("row-review-accept")).toHaveCount(0);
    const { facturas, threads, filed } = await reviewing(page, server);
    await expect(page.getByTestId("row-review-accept")).toHaveCount(3);
    await expect(row(page, threads[0]!).getByTestId("row-review-accept")).toHaveAttribute("title", "Belongs in Facturas");

    // a row that isn't the open one: pressing its ✓ opens nothing
    const open = await cursor(page);
    const target = threads.find((t) => t !== open)!;
    await row(page, target).getByTestId("row-review-accept").click();
    await expect(row(page, target)).toHaveCount(0);
    await expect(page.getByTestId("thread-row")).toHaveCount(2);
    await expect.poll(() => filed(target)).toBe("suggestion");
    expect(await cursor(page)).toBe(open);
    await expect(page.getByTestId("category-snackbar")).toBeVisible();
    await expect(page.getByTestId(`nav-review-${facturas}`)).toContainText("2");
    // the snackbar's undo puts it back in Review
    await page.getByTestId("snackbar-undo").click();
    await expect.poll(() => filed(target)).toBeNull();
    await expect(row(page, target)).toHaveCount(1);
  });

  test("y and n in Review answer this category's suggestion; the row leaves and the selection moves on", async ({ app: page, server }) => {
    const { db, threads, filed } = await reviewing(page, server);
    await row(page, threads[0]!).dispatchEvent("mousedown");
    await expect(row(page, threads[0]!)).toHaveAttribute("data-cursor", "true");
    await focusList(page);
    await page.keyboard.press("y");
    await expect(row(page, threads[0]!)).toHaveCount(0);
    await expect(row(page, threads[1]!)).toHaveAttribute("data-cursor", "true");
    await expect.poll(() => filed(threads[0]!)).toBe("suggestion");
    await page.keyboard.press("Escape");
    await page.keyboard.press("n");
    await expect(row(page, threads[1]!)).toHaveCount(0);
    await expect.poll(() => db.get("SELECT label, source FROM cls_examples WHERE thread_id = ?", threads[1]!)).toEqual({ label: -1, source: "reject" });
    expect(filed(threads[1]!)).toBeNull();
  });

  test("Always ▾ offers the same subject first, then all from the sender, counted; Escape gives the list back", async ({ app: page, server }) => {
    const { threads, sameSubject, fromRappi } = await reviewing(page, server);
    const all = fromRappi();
    expect(sameSubject).toBe(2);
    expect(all).toBeGreaterThan(sameSubject);
    const open = await cursor(page);
    await row(page, threads[1]!).getByTestId("row-review-always").click();
    const menu = page.getByTestId("review-always-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Always add to Facturas…");
    await expect(menu).toContainText("Now and future mail");
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText(`Same subject from Rappi${SUBJECT}`);
    await expect(page.getByTestId("review-always-subject-count")).toHaveText(String(sameSubject));
    await expect(items.nth(1)).toContainText("All from Rappi");
    await expect(page.getByTestId("review-always-sender-count")).toHaveText(String(Math.min(all, 1000)));
    // the press didn't open the row; shortcuts wait while the menu is open (j would move the cursor)
    expect(await cursor(page)).toBe(open);
    await page.keyboard.press("j");
    expect(await cursor(page)).toBe(open);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.locator("[data-testid=thread-list] [role=listbox]")).toBeFocused();
    await expect(page.getByTestId("thread-row")).toHaveCount(3);
    // a click outside closes it (modal, as the thread menu: the click goes no further) and the list keeps the focus
    await row(page, threads[1]!).getByTestId("row-review-always").click();
    await expect(menu).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(menu).toHaveCount(0);
    await expect(page.locator("[data-testid=thread-list] [role=listbox]")).toBeFocused();
    await expect(page.getByTestId("thread-row")).toHaveCount(3);
  });

  test("Always → same subject files exactly those now and saves the filter; one Undo takes back both", async ({ app: page, server }) => {
    const { facturas, threads, filed, filters } = await reviewing(page, server);
    await row(page, threads[1]!).getByTestId("row-review-always").click();
    await page.getByTestId("review-always-subject").click();
    await expect(toast(page, "2 added to Facturas, future mail too")).toBeVisible();
    for (const t of threads.slice(0, 2)) await expect.poll(() => filed(t)).toBe("bulk");
    expect(filed(threads[2]!)).toBeNull();
    expect(filters()).toEqual([
      {
        name: `Rappi · ${SUBJECT} → Facturas`,
        rule: { match: "all", conditions: [{ field: "from", op: "equals", value: "recibos@rappi.com" }, { field: "subject", op: "equals", value: SUBJECT }], actions: [{ type: "addCategory", categoryId: facturas }] },
      },
    ]);
    // what was filed left Review: only the receipt with another subject is still there
    await expect(page.getByTestId("thread-row")).toHaveCount(1);
    await expect(row(page, threads[2]!)).toHaveCount(1);

    await toast(page, "future mail too").getByRole("button", { name: "Undo, and stop adding future mail" }).click();
    await expect.poll(() => filters()).toEqual([]);
    for (const t of threads.slice(0, 2)) await expect.poll(() => filed(t)).toBeNull();
    await expect(page.getByTestId("thread-row")).toHaveCount(3);
  });

  test("Always → all from the sender, with z as its undo; the thread menu offers the same answers", async ({ app: page, server }) => {
    const { facturas, threads, filed, filters, fromRappi } = await reviewing(page, server);
    await row(page, threads[2]!).click({ button: "right" });
    const menu = page.getByTestId("thread-menu");
    await expect(menu.getByTestId("menu-review-accept")).toHaveText("Belongs in Facturas");
    await menu.getByTestId("menu-review-always").hover();
    const sub = page.getByTestId("menu-review-always-list");
    await expect(sub.getByTestId("menu-review-always-subject")).toBeVisible();
    await sub.getByTestId("menu-review-always-sender").click();
    await expect(toast(page, /added to Facturas, future mail too/)).toBeVisible();
    await expect.poll(() => fromRappi()).toBe(0);
    expect(filters()).toEqual([{ name: "Rappi → Facturas", rule: { match: "all", conditions: [{ field: "from", op: "equals", value: "recibos@rappi.com" }], actions: [{ type: "addCategory", categoryId: facturas }] } }]);
    await expect(page.getByTestId("thread-row")).toHaveCount(0);

    await focusList(page);
    await page.keyboard.press("z");
    await expect.poll(() => filters()).toEqual([]);
    await expect.poll(() => filed(threads[2]!)).toBeNull();
    await expect(page.getByTestId("thread-row")).toHaveCount(3);
  });
});

test("the controls and the open menu are axe-clean and read well in light and dark", async ({ app: page, server }) => {
  for (const theme of ["light", "dark"] as const) {
    await server.backend.server.invoke("settings.update", { theme }, ctx);
    const { threads } = await reviewing(page, server);
    await row(page, threads[0]!).dispatchEvent("mousedown");
    await row(page, threads[1]!).hover();
    await row(page, threads[1]!).getByTestId("row-review-always").click();
    await expect(page.getByTestId("review-always-subject-count")).toBeVisible();
    const r = await new AxeBuilder({ page }).include("[data-testid=review-always-menu]").include("[data-testid=thread-list]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(r.violations.map((v) => `${theme} ${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-review-actions-${theme}.png` });
    await page.keyboard.press("Escape");
  }
});
