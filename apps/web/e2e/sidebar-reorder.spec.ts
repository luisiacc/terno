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
      await row.dblclick();
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

  test("everywhere categories and accounts are listed, they're in the sidebar's order", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const categories = page.getByTestId("nav-categories");
    const accounts = page.locator("[data-sort-group]:has(> [data-account-id])");
    // an order that isn't the one they were made in: the last of each first
    const cats = await shown(categories);
    const people = await shown(accounts);
    await page.getByTestId(`nav-category-${cats.at(-1)}`).focus();
    for (let i = 1; i < cats.length; i++) await page.keyboard.press("Alt+ArrowUp");
    await page.getByTestId(`nav-account-${people.at(-1)}`).focus();
    for (let i = 1; i < people.length; i++) await page.keyboard.press("Alt+ArrowUp");
    const wantCats = [cats.at(-1)!, ...cats.slice(0, -1)];
    const wantPeople = [people.at(-1)!, ...people.slice(0, -1)];
    await expect.poll(() => db.all<{ id: number }>("SELECT id FROM categories ORDER BY position, id").map((r) => r.id)).toEqual(wantCats);
    await expect.poll(() => db.all<{ id: number }>("SELECT id FROM accounts ORDER BY position, id").map((r) => r.id)).toEqual(wantPeople);
    await fresh(page);
    expect(await shown(categories)).toEqual(wantCats);
    expect(await shown(accounts)).toEqual(wantPeople);

    await scenario("the category picker", async () => {
      await rows(page).first().dispatchEvent("mousedown");
      await page.keyboard.press("l");
      const picker = page.getByTestId("category-picker");
      await expect(picker).toBeVisible();
      const listed = await picker.locator("[data-testid^=pick-category-]").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-testid")!.slice("pick-category-".length))));
      expect(listed).toEqual(wantCats);
      await page.keyboard.press("Escape");
    });

    await scenario("Settings: Categories and Accounts", async () => {
      await page.getByTestId("open-settings").click();
      await page.getByRole("tab", { name: "Categories" }).click();
      expect(await page.locator("[data-testid^=category-stats-]").evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.categoryId)))).toEqual(wantCats);
      await page.getByRole("tab", { name: "Accounts" }).click();
      expect(await page.getByTestId("settings-account").evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.accountId)))).toEqual(wantPeople);
      await page.keyboard.press("Escape");
    });

    await scenario("a conversation's categories in its row", async () => {
      // two categories the Inbox shows, filed on its first row in the opposite order to the sidebar's
      const inInbox = new Set(db.all<{ id: number }>("SELECT id FROM categories WHERE show_in_inbox = 1").map((r) => r.id));
      const [first, second] = wantCats.filter((c) => inInbox.has(c)) as [number, number];
      const thread = Number(await rows(page).first().getAttribute("data-thread-id"));
      db.run("DELETE FROM thread_categories WHERE thread_id = ?", thread);
      for (const c of [second, first]) db.run("INSERT INTO thread_categories (thread_id, category_id, added_by) VALUES (?, ?, 'user')", thread, c);
      await fresh(page);
      const row = page.locator(`[data-testid=thread-row][data-thread-id="${thread}"]`);
      await expect(row.locator("[data-cat-dot]")).toHaveCount(2);
      expect(await row.locator("[data-cat-dot]").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-cat-dot"))))).toEqual([first, second]);
    });
  });

  test.describe("with motion (Codex code review)", () => {
    test.use({ reducedMotion: "no-preference", viewport: { width: 1280, height: 520 } });

    test("a drag over a settling one, a drop mid-slide, a scroll with the pointer still", async ({ app: page }) => {
      const categories = page.getByTestId("nav-categories");
      const ids = await shown(categories);
      /** pointer events dispatched in one task, as fast as a hand can't, so the timing is the code's alone */
      const press = (steps: { row: number; dy: number; up?: boolean }[]) =>
        page.evaluate(async (steps) => {
          const fire = (type: string, x: number, y: number) =>
            (type === "pointerdown" ? document.elementFromPoint(x, y)! : window).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }));
          for (const { row, dy, up } of steps) {
            const r = document.querySelector(`[data-testid=nav-categories] > [data-sort-id="${row}"] [data-sort-handle]`)!.getBoundingClientRect();
            const x = r.left + 40;
            const y = r.top + r.height / 2;
            fire("pointerdown", x, y);
            fire("pointermove", x, y + Math.sign(dy) * 6);
            fire("pointermove", x, y + dy);
            if (up) fire("pointerup", x, y + dy);
          }
          // the render that shows a new order runs before the frame
          await Promise.resolve();
          const items = [...document.querySelectorAll<HTMLElement>("[data-testid=nav-categories] > [data-sort-id]")];
          return { lifted: items.filter((el) => el.hasAttribute("data-lifted")).map((el) => Number(el.dataset.sortId)), settling: items.filter((el) => el.hasAttribute("data-settling")).map((el) => Number(el.dataset.sortId)) };
        }, steps);
      const release = async () => {
        await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 })));
        await expect(page.locator("[data-lifted], [data-settling]")).toHaveCount(0);
      };

      await scenario("a row dropped in place and another dragged while it settles: only the new one is lifted", async () => {
        const state = await press([{ row: ids[0]!, dy: 8, up: true }, { row: ids[2]!, dy: 10 }]);
        expect(state.lifted).toEqual([ids[2]]);
        await release();
      });

      await scenario("dropped the moment it passes a neighbour: the neighbour slides from where it was, it doesn't jump", async () => {
        const pitch = (await page.getByTestId(`nav-category-${ids[0]}`).boundingBox())!.height;
        const state = await press([{ row: ids[0]!, dy: pitch, up: true }]);
        expect(await shown(categories)).toEqual([ids[1], ids[0], ...ids.slice(2)]);
        expect(state.settling).toContain(ids[1]);
        await expect(page.locator("[data-lifted], [data-settling]")).toHaveCount(0);
      });

      await scenario("the sidebar scrolled under a still pointer: the row stays under it", async () => {
        const nav = page.locator("nav[data-drop-scroll]");
        const order = await shown(categories);
        const row = page.getByTestId(`nav-category-${order[1]}`);
        // the row in the sidebar's middle, far from the edges that scroll it on their own, with room to scroll 20 px more
        const top = await nav.evaluate((el, id) => {
          const r = el.querySelector(`[data-testid="nav-category-${id}"]`)!.getBoundingClientRect();
          const n = el.getBoundingClientRect();
          el.scrollTop = Math.min(Math.max(0, el.scrollTop + r.top + r.height / 2 - (n.top + n.height / 2)), el.scrollHeight - el.clientHeight - 20);
          return el.scrollTop;
        }, order[1]!);
        const n = (await nav.boundingBox())!;
        const b = (await row.boundingBox())!;
        expect(b.y - n.y, "away from the top edge").toBeGreaterThan(60);
        expect(n.y + n.height - (b.y + b.height), "away from the bottom edge").toBeGreaterThan(60);
        await press([{ row: order[1]!, dy: 10 }]);
        const pointer = b.y + b.height / 2 + 10;
        // the move's own frame has placed it: from here only the scroll can move anything
        await frame(page);
        await nav.evaluate((el, top) => (el.scrollTop = top + 20), top);
        await expect.poll(async () => {
          const r = (await row.boundingBox())!;
          return Math.round(r.y + r.height / 2 - pointer);
        }).toBe(0);
        await release();
      });
    });
  });
});
