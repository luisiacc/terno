/**
 * Drag rows from the virtualized list onto sidebar categories: one row and a
 * multi-selection, the "already" state, Esc, a click that stays a click,
 * moves out of a category view and out of several categories, the keyboard
 * path, and mid-drag baselines. Every drop is an exclusive move (the thread
 * ends up in that category only) and offers the categorization snackbar.
 */
import type { Locator, Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { expect, focusList, rows, selectRows, stabilize, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.use({ reducedMotion: "no-preference" });

const ctx = { clientId: "setup", origin: "dev" as const };
const categoryId = (server: DevServer, name: string) => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = ?", name)!.id;

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Presses on a row and moves (in steps, like a hand) onto a target, without releasing. */
async function dragTo(page: Page, row: Locator, target: Locator) {
  const from = await center(row);
  const to = await center(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 2, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
}

/** Rows in the inbox that aren't in the category yet. */
function notIn(page: Page, catId: number) {
  return page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${catId}"]))`);
}

const navCount = async (page: Page, catId: number) => Number((await page.getByTestId(`nav-category-${catId}`).locator("[data-slot=nav-count]").textContent().catch(() => "0")) || 0);

test.describe("drag and drop to a category", () => {
  test("one row: ghost, target highlight, dot, count, the snackbar and its undo", async ({ app: page, server }) => {
    const viajes = categoryId(server, "Viajes");
    const target = page.getByTestId(`nav-category-${viajes}`);
    // an unread one, so the sidebar's unread count moves too
    const row = page.locator(`[data-testid=thread-row][data-unread]:not(:has([data-cat-dot="${viajes}"]))`).first();
    const id = (await row.getAttribute("data-thread-id"))!;
    const before = await navCount(page, viajes);
    const subject = (await row.getByTestId("row-subject").textContent())!;

    await dragTo(page, row, target);
    const ghost = page.getByTestId("drag-ghost");
    await expect(ghost).toBeVisible();
    await expect(ghost).toContainText(subject.slice(0, 12));
    await expect(page.getByTestId("drag-ghost-count")).toHaveText("1");
    await expect(target).toHaveAttribute("data-drop-state", "over");
    await expect(page.locator("html")).toHaveAttribute("data-dragging", "");
    await page.mouse.up();

    await expect(page.getByTestId("category-snackbar")).toBeVisible();
    await expect(page.getByTestId("snackbar-title")).toHaveText("Movido a Viajes");
    const dropped = page.locator(`[data-thread-id="${id}"]`);
    await expect(dropped.locator(`[data-cat-dot="${viajes}"]`)).toHaveCount(1);
    await expect(dropped.locator("[data-cat-dot]")).toHaveCount(1);
    await expect.poll(() => navCount(page, viajes)).toBe(before + 1);
    await expect(target).not.toHaveAttribute("data-drop-state");
    await expect(page.locator("html")).not.toHaveAttribute("data-dragging");
    await expect(ghost).toBeHidden();
    // the backend has it (and recorded it as a drag-and-drop filing)
    expect(sqlDb(server.backend.store).get<{ added_by: string }>("SELECT added_by FROM thread_categories WHERE thread_id = ? AND category_id = ?", Number(id), viajes)).toBeTruthy();

    await page.getByTestId("snackbar-undo").click();
    await expect(dropped.locator(`[data-cat-dot="${viajes}"]`)).toHaveCount(0);
    await expect.poll(() => navCount(page, viajes)).toBe(before);
    expect(sqlDb(server.backend.store).get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", Number(id), viajes)).toBeUndefined();
  });

  test("a multi-selection travels together: the ghost says 3 and all three get the dot", async ({ app: page, server }) => {
    const viajes = categoryId(server, "Viajes");
    const candidates = notIn(page, viajes);
    const ids = await candidates.evaluateAll((els) => els.slice(0, 3).map((e) => e.getAttribute("data-thread-id")!));
    await selectRows(page, ids);
    await dragTo(page, page.locator(`[data-thread-id="${ids[1]}"]`), page.getByTestId(`nav-category-${viajes}`));
    await expect(page.getByTestId("drag-ghost-count")).toHaveText("3");
    // the dragged rows are dimmed by a keyed rule, not by re-rendering them
    expect(await page.locator(`[data-thread-id="${ids[0]}"]`).evaluate((e) => getComputedStyle(e).opacity)).toBe("0.5");
    await page.mouse.up();
    await expect(page.getByTestId("snackbar-title")).toHaveText("3 conversaciones movidas a Viajes");
    for (const id of ids) await expect(page.locator(`[data-thread-id="${id}"] [data-cat-dot="${viajes}"]`)).toHaveCount(1);
    for (const id of ids) await expect(page.locator(`[data-thread-id="${id}"] [data-cat-dot]`)).toHaveCount(1);
  });

  test("a category that already has every dragged thread (and only it) shows a check and ignores the drop", async ({ app: page, server }) => {
    const lecturas = categoryId(server, "Lecturas");
    const row = page.locator(`[data-testid=thread-row]:has([data-cat-dot="${lecturas}"]):not(:has([data-cat-dot]:not([data-cat-dot="${lecturas}"])))`).first();
    const target = page.getByTestId(`nav-category-${lecturas}`);
    await dragTo(page, row, target);
    await expect(target).toHaveAttribute("data-drop-state", "already");
    await expect(target.getByLabel("Ya está aquí")).toBeVisible();
    await page.mouse.up();
    await expect(page.getByTestId("drag-ghost")).toBeHidden();
    await page.waitForTimeout(200);
    await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
  });

  test("Esc cancels the drag and nothing else: the reader stays open", async ({ app: page, server }) => {
    const viajes = categoryId(server, "Viajes");
    const row = notIn(page, viajes).first();
    const id = (await row.getAttribute("data-thread-id"))!;
    await dragTo(page, row, page.getByTestId(`nav-category-${viajes}`));
    await expect(page.getByTestId(`nav-category-${viajes}`)).toHaveAttribute("data-drop-state", "over");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("drag-ghost")).toBeHidden();
    await expect(page.getByTestId(`nav-category-${viajes}`)).not.toHaveAttribute("data-drop-state");
    await page.mouse.up(); // releasing over the category after Esc does nothing
    await page.waitForTimeout(200);
    await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
    await expect(page.locator(`[data-thread-id="${id}"] [data-cat-dot="${viajes}"]`)).toHaveCount(0);
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveAttribute("aria-selected", "true");
  });

  test("a press that moves under 4 px is a click: it selects, nothing drags", async ({ app: page }) => {
    const row = rows(page).nth(3);
    const p = await center(row);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 2, p.y + 1);
    await page.mouse.up();
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("drag-ghost")).toBeHidden();
    await expect(page.locator("html")).not.toHaveAttribute("data-dragging");
  });

  test("in a category view a drop moves the row out: it leaves, the snackbar says so, undo restores both", async ({ app: page, server }) => {
    const lecturas = categoryId(server, "Lecturas");
    const viajes = categoryId(server, "Viajes");
    await page.getByTestId(`nav-category-${lecturas}`).click();
    await expect(page.getByTestId("list-title")).toHaveText("Lecturas");
    // the title changes first; wait until the rows are Lecturas' own
    await expect(page.locator("[data-testid=thread-row]:not(:has([data-cat-dot]))")).toHaveCount(0);
    await expect(page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${lecturas}"]))`)).toHaveCount(0);
    const row = notIn(page, viajes).first();
    const id = Number(await row.getAttribute("data-thread-id"));
    await dragTo(page, row, page.getByTestId(`nav-category-${viajes}`));
    await page.mouse.up();
    await expect(page.getByTestId("snackbar-title")).toHaveText("Movido a Viajes");
    await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(0);
    const inCat = (cat: number) => !!sqlDb(server.backend.store).get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", id, cat);
    await expect.poll(() => [inCat(viajes), inCat(lecturas)]).toEqual([true, false]);
    await page.getByTestId("snackbar-undo").click();
    await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(1);
    await expect.poll(() => [inCat(viajes), inCat(lecturas)]).toEqual([false, true]);
  });

  test("a thread in two categories dragged to a third ends in the third only; undo puts it back in both", async ({ app: page, server }) => {
    const [lecturas, clientes, viajes] = [categoryId(server, "Lecturas"), categoryId(server, "Clientes"), categoryId(server, "Viajes")];
    const row = page.locator("[data-testid=thread-row]:not(:has([data-cat-dot]))").first();
    const id = Number(await row.getAttribute("data-thread-id"));
    for (const cat of [lecturas, clientes]) await server.backend.server.invoke("categories.addThreads", { categoryId: cat, threadIds: [id], source: "picker" }, ctx);
    const dropped = page.locator(`[data-thread-id="${id}"]`);
    await expect(dropped.locator("[data-cat-dot]")).toHaveCount(2);
    const cats = () => sqlDb(server.backend.store).all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ? ORDER BY category_id", id).map((r) => r.category_id);
    const before = cats();
    await dragTo(page, dropped, page.getByTestId(`nav-category-${viajes}`));
    await page.mouse.up();
    await expect(page.getByTestId("snackbar-title")).toHaveText("Movido a Viajes");
    // the same frame shows the target alone; the backend agrees
    await expect(dropped.locator("[data-cat-dot]")).toHaveCount(1);
    await expect(dropped.locator(`[data-cat-dot="${viajes}"]`)).toHaveCount(1);
    await expect.poll(cats).toEqual([viajes]);
    await page.getByTestId("snackbar-undo").click();
    await expect.poll(cats).toEqual(before);
    await expect(dropped.locator("[data-cat-dot]")).toHaveCount(2);
  });

  test("dropping a multi-filed thread on one of its categories is not a no-op: it leaves the other", async ({ app: page, server }) => {
    const [lecturas, clientes] = [categoryId(server, "Lecturas"), categoryId(server, "Clientes")];
    const row = page.locator("[data-testid=thread-row]:not(:has([data-cat-dot]))").first();
    const id = Number(await row.getAttribute("data-thread-id"));
    for (const cat of [lecturas, clientes]) await server.backend.server.invoke("categories.addThreads", { categoryId: cat, threadIds: [id], source: "picker" }, ctx);
    const dropped = page.locator(`[data-thread-id="${id}"]`);
    await expect(dropped.locator("[data-cat-dot]")).toHaveCount(2);
    const target = page.getByTestId(`nav-category-${lecturas}`);
    await dragTo(page, dropped, target);
    await expect(target).toHaveAttribute("data-drop-state", "over");
    await page.mouse.up();
    await expect(page.getByTestId("snackbar-title")).toHaveText("Movido a Lecturas");
    await expect(dropped.locator("[data-cat-dot]")).toHaveCount(1);
    await expect.poll(() => sqlDb(server.backend.store).all("SELECT category_id FROM thread_categories WHERE thread_id = ?", id)).toEqual([{ category_id: lecturas }]);
  });

  test("a move's undo is one atomic step: when it fails nothing changes and the snackbar offers a retry", async ({ app: page, server }) => {
    const lecturas = categoryId(server, "Lecturas");
    const viajes = categoryId(server, "Viajes");
    await page.getByTestId(`nav-category-${lecturas}`).click();
    await expect(page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${lecturas}"]))`)).toHaveCount(0);
    const row = notIn(page, viajes).first();
    const id = Number(await row.getAttribute("data-thread-id"));
    const inCat = (cat: number) => !!sqlDb(server.backend.store).get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", id, cat);
    const before = sqlDb(server.backend.store).get("SELECT added_by, added_at, batch_id FROM thread_categories WHERE thread_id = ? AND category_id = ?", id, lecturas);
    await dragTo(page, row, page.getByTestId(`nav-category-${viajes}`));
    await page.mouse.up();
    await expect(page.getByTestId("snackbar-title")).toHaveText("Movido a Viajes");
    await expect.poll(() => [inCat(viajes), inCat(lecturas)]).toEqual([true, false]);

    // the backend refuses the restore: the destination must keep the thread, the snackbar turns into the error with a retry
    sqlDb(server.backend.store).exec("CREATE TRIGGER e2e_fail_restore BEFORE INSERT ON thread_categories BEGIN SELECT RAISE(ABORT, 'disco lleno'); END");
    await page.getByTestId("snackbar-undo").click();
    await expect(page.getByTestId("snackbar-title")).toContainText("No se pudo deshacer");
    await expect(page.getByTestId("snack-alert")).toContainText("No se pudo deshacer");
    await expect(page.getByTestId("snackbar-undo")).toHaveText(/Retry/);
    expect([inCat(viajes), inCat(lecturas)]).toEqual([true, false]);

    sqlDb(server.backend.store).exec("DROP TRIGGER e2e_fail_restore");
    await page.getByTestId("snackbar-undo").click();
    await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
    await expect.poll(() => [inCat(viajes), inCat(lecturas)]).toEqual([false, true]);
    // back exactly as it was
    expect(sqlDb(server.backend.store).get("SELECT added_by, added_at, batch_id FROM thread_categories WHERE thread_id = ? AND category_id = ?", id, lecturas)).toEqual(before);
    await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(1);
  });

  test("a removal reflows: the leaving row fades as a copy, the rest slide only during that window", async ({ app: page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __reflow: { set: boolean; ghosts: number } };
      w.__reflow = { set: false, ghosts: 0 };
      const list = document.querySelector("[role=listbox]")!;
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === "attributes" && list.hasAttribute("data-reflow")) w.__reflow.set = true;
          for (const n of r.addedNodes) if (n instanceof HTMLElement && n.getAttribute("aria-hidden") === "true" && n.getAttribute("role") === "option") w.__reflow.ghosts++;
        }
      }).observe(list, { attributes: true, attributeFilter: ["data-reflow"], childList: true, subtree: true });
    });
    const row = rows(page).first();
    const id = await row.getAttribute("data-thread-id");
    await row.dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("e");
    await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __reflow: unknown }).__reflow)).toEqual({ set: true, ghosts: 1 });
    // the window closes and the copies are gone
    await expect(page.locator("[role=listbox]")).not.toHaveAttribute("data-reflow");
    await expect(page.locator("[role=listbox] [aria-hidden=true][role=option]")).toHaveCount(0);
  });

  test("keyboard path: l files the selection with the same snackbar", async ({ app: page, server }) => {
    const viajes = categoryId(server, "Viajes");
    const row = notIn(page, viajes).first();
    await row.dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await page.getByTestId(`pick-category-${viajes}`).click();
    await expect(page.getByTestId("snackbar-title")).toHaveText("Añadido a Viajes");
  });
});

test.describe("visual: mid-drag", () => {
  test.use({ deviceScaleFactor: 1 });
  for (const theme of ["terno-light", "dracula"] as const) {
    test(`ghost and highlighted target in ${theme}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", theme === "dracula" ? { theme: "dark", darkTheme: "dracula" } : { theme: "light" }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const viajes = categoryId(server, "Viajes");
      await page.evaluate(() => document.fonts.ready);
      await stabilize(page);
      const ids = await notIn(page, viajes).evaluateAll((els) => els.slice(0, 2).map((e) => e.getAttribute("data-thread-id")!));
      await selectRows(page, ids);
      await dragTo(page, page.locator(`[data-thread-id="${ids[0]}"]`), page.getByTestId(`nav-category-${viajes}`));
      await expect(page.getByTestId(`nav-category-${viajes}`)).toHaveAttribute("data-drop-state", "over");
      await expect(page).toHaveScreenshot(`mid-drag-${theme}.png`);
      await page.keyboard.press("Escape");
      await page.mouse.up();
    });
  }
});
