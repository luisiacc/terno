/**
 * Plan 169: categories and accounts are put in order by dragging them in the sidebar (or ⌥↑ ⌥↓ on a focused row).
 * The order shows at once, is saved, and survives a reload; a drag renders nothing until the drop, never opens what
 * it dropped, and leaves the rows as drop targets for mail.
 */
import type { Locator, Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, fresh, rows, scenario, test } from "./fixtures";

const renders = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { __renders?: Record<string, number> }).__renders?.[n] ?? 0, name);
const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** the group's rows as the sidebar shows them, by id */
const shown = (group: Locator) => group.locator(":scope > [data-sort-id]").evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.sortId)));

/** Presses `row`, moves it by `dy` like a hand would, and (unless told not to) lets go. */
async function drag(page: Page, row: Locator, dy: number, { release = true } = {}) {
  const b = (await row.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + Math.sign(dy) * 6, { steps: 2 });
  await page.mouse.move(x, y + dy, { steps: 8 });
  await frame(page);
  if (release) {
    await page.mouse.up();
    await frame(page);
  }
}

test.describe("sorting the sidebar (plan 169)", () => {
  test("categories and accounts: drag, Esc, ⌥↑ ⌥↓, a reload, mail still drops on them", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const storedCategories = () => db.all<{ id: number }>("SELECT id FROM categories ORDER BY position, id").map((r) => r.id);
    const storedAccounts = () => db.all<{ id: number }>("SELECT id FROM accounts ORDER BY position, id").map((r) => r.id);
    const categories = page.getByTestId("nav-categories");
    const accounts = page.locator("[data-sort-group]:has(> [data-account-id])");
    const before = await shown(categories);
    expect(before).toEqual(storedCategories());

    await scenario("a category dragged two rows down lifts, renders nothing on the way, lands there, is saved and opens nothing", async () => {
      const [first, second, third] = before as [number, number, number];
      const row = page.getByTestId(`nav-category-${first}`);
      const pitch = (await row.boundingBox())!.height;
      const items0 = await renders(page, "NavItem");
      await drag(page, row, pitch * 2 + 2, { release: false });
      await expect(categories.locator(`[data-sort-id="${first}"]`)).toHaveAttribute("data-lifted", "");
      await expect(page.locator(":root")).toHaveAttribute("data-sorting", "");
      expect(await renders(page, "NavItem"), "no row renders while dragging").toBe(items0);
      await page.mouse.up();
      await expect.poll(() => shown(categories)).toEqual([second, third, first, ...before.slice(3)]);
      await expect.poll(storedCategories).toEqual([second, third, first, ...before.slice(3)]);
      await expect(page.getByTestId("list-title")).toHaveText("Inbox");
      await expect(page.locator("[data-lifted], [data-settling]")).toHaveCount(0);
      await expect(page.locator(":root")).not.toHaveAttribute("data-sorting");
      await expect(page.getByTestId("sidebar-reorder-live")).toHaveText(/, 3 of \d+$/);
    });

    await scenario("Esc mid-drag puts everything back; a drop where it started saves nothing", async () => {
      const order = await shown(categories);
      const row = page.getByTestId(`nav-category-${order[0]}`);
      await drag(page, row, 80, { release: false });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await frame(page);
      expect(await shown(categories)).toEqual(order);
      await expect(page.locator("[data-lifted]")).toHaveCount(0);
      expect(await categories.locator(":scope > [data-sort-id]").evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform).join(""))).toBe("");
      await drag(page, row, 8);
      expect(await shown(categories)).toEqual(order);
      expect(storedCategories()).toEqual(order);
      await expect(page.getByTestId("list-title")).toHaveText("Inbox");
    });

    await scenario("⌥↑ on a focused category moves it a place up and it keeps the focus; ⌥↓ on an account moves it down", async () => {
      const order = await shown(categories);
      const row = page.getByTestId(`nav-category-${order[2]}`);
      await row.focus();
      await page.keyboard.press("Alt+ArrowUp");
      await expect.poll(() => shown(categories)).toEqual([order[0], order[2], order[1], ...order.slice(3)]);
      await expect(row).toBeFocused();
      await expect(page.getByTestId("sidebar-reorder-live")).toHaveText(/, 2 of \d+$/);
      // the first one down: React moves it out and back in, which drops focus; it's given back
      const people = await shown(accounts);
      const top = page.getByTestId(`nav-account-${people[0]}`);
      await top.focus();
      await page.keyboard.press("Alt+ArrowDown");
      await expect.poll(() => shown(accounts)).toEqual([people[1], people[0], ...people.slice(2)]);
      await expect(top).toBeFocused();
      await expect.poll(storedAccounts).toEqual([people[1], people[0], ...people.slice(2)]);
    });

    await scenario("an open account drags with its folders; pressing one of its folders drags nothing", async () => {
      const people = await shown(accounts);
      const open = people[0]!;
      const row = page.getByTestId(`nav-account-${open}`);
      await row.click();
      await expect(row).toHaveAttribute("aria-expanded", "true");
      const folder = accounts.locator(`[data-sort-id="${open}"] [data-testid^="nav-"]:not([data-sort-handle])`).first();
      await drag(page, folder, 60, { release: false });
      await expect(page.locator("[data-lifted]")).toHaveCount(0);
      await page.mouse.up();
      // the open block past the next account: its bottom past that row's middle
      const next = (await page.getByTestId(`nav-account-${people[1]}`).boundingBox())!;
      await drag(page, row, next.height / 2 + 6);
      await expect.poll(() => shown(accounts)).toEqual([people[1], open, ...people.slice(2)]);
      await expect(row).toHaveAttribute("aria-expanded", "true");
      await expect.poll(storedAccounts).toEqual([people[1], open, ...people.slice(2)]);
      await row.click();
    });

    await scenario("the order survives a reload; mail dropped on a moved category goes there", async () => {
      const cats = await shown(categories);
      const people = await shown(accounts);
      await fresh(page);
      expect(await shown(categories)).toEqual(cats);
      expect(await shown(accounts)).toEqual(people);
      const target = page.getByTestId(`nav-category-${cats[2]}`);
      const row = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${cats[2]}"]))`).first();
      const id = await row.getAttribute("data-thread-id");
      const r = (await row.boundingBox())!;
      const t = (await target.boundingBox())!;
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(r.x + r.width / 2 + 6, r.y + r.height / 2 + 2, { steps: 2 });
      await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
      await expect(target).toHaveAttribute("data-drop-state", "over");
      await page.mouse.up();
      await expect.poll(() => db.get<{ n: number }>("SELECT count(*) AS n FROM thread_categories WHERE thread_id = ? AND category_id = ?", Number(id), cats[2])!.n).toBe(1);
      await expect(rows(page).first()).toBeVisible();
    });
  });
});
