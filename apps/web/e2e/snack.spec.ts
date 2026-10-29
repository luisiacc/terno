/**
 * The docked snackbar (plan 13): one snack at a time, embedded at the bottom
 * of the thread list; its Undo's border is the countdown, which waits
 * while hovered, focused or covered by a dialog. The list keeps room for it.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, focusList, openRow, rows, search, selectedRow, test, searchBox } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

const dock = (page: Page) => page.getByTestId("snack");
/** How much of the ring has drained (0–100; the dash moves from 0 to −100). */
const drained = (page: Page) => page.getByTestId("snack-ring").first().evaluate((p) => -parseFloat(getComputedStyle(p).strokeDashoffset));
const renders = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { __renders?: Record<string, number> }).__renders?.[n] ?? 0, name);

async function archiveOne(page: Page, index = 1) {
  await openRow(page, index);
  await focusList(page);
  await page.keyboard.press("e");
  await expect(dock(page)).toContainText("Archived");
}

function handlers(server: { backend: { server: unknown } }) {
  return (server.backend.server as { handlers: Record<string, (...a: unknown[]) => unknown> }).handlers;
}

test.describe("the docked snackbar", { tag: "@design" }, () => {
  test("archive: the bar sits inside the list column, compact, over neither the sidebar nor the reader", async ({ app: page }) => {
    await page.mouse.move(1300, 100);
    await archiveOne(page);
    // plan 63: the rest from the same sender etc. grow a second row of chips under it
    await expect(dock(page).getByTestId("similar-snackbar")).toBeVisible();
    const bar = (await dock(page).boundingBox())!;
    const list = (await page.getByTestId("thread-list").boundingBox())!;
    const sidebar = (await page.getByTestId("sidebar").boundingBox())!;
    const strip = (await dock(page).getByTestId("snackbar-strip").boundingBox())!;
    expect(bar.height - strip.height).toBeLessThanOrEqual(40);
    expect(bar.height).toBeLessThanOrEqual(72);
    expect(bar.x).toBeGreaterThan(list.x);
    expect(bar.x + bar.width).toBeLessThan(list.x + list.width);
    expect(bar.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
    expect(bar.y + bar.height).toBeLessThanOrEqual(list.y + list.height);
    expect(bar.y + bar.height).toBeGreaterThan(list.y + list.height - 16);
    // the action says what it takes back, and z is its key while it is
    const undo = dock(page).getByTestId("snack-action");
    await expect(undo).toHaveAccessibleName("Undo archive");
    await expect(undo).toHaveAttribute("aria-keyshortcuts", "z");
    await expect(page.getByTestId("snack-live")).toHaveText("Archived");
  });

  test("the ring drains over the lifetime and holds while hovered; it goes when it's over", async ({ app: page }) => {
    // flowing (reduced motion steps it once a second: motion.spec)
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.mouse.move(1300, 100);
    await archiveOne(page);
    const a = await drained(page);
    await page.waitForTimeout(600);
    const b = await drained(page);
    expect(b).toBeGreaterThan(a + 5);
    await dock(page).hover();
    await page.waitForTimeout(100);
    const c = await drained(page);
    await page.waitForTimeout(1500);
    expect(Math.abs((await drained(page)) - c)).toBeLessThan(0.5);
    // the rows don't re-render while it counts down
    const before = await renders(page, "ThreadRow");
    await page.mouse.move(1300, 100);
    await page.waitForTimeout(800);
    expect(await renders(page, "ThreadRow")).toBe(before);
    expect(await drained(page)).toBeGreaterThan(c + 5);
    await expect(dock(page)).toHaveCount(0, { timeout: 7000 });
  });

  test("Undo restores the row; z does too and takes the bar with it", async ({ app: page }) => {
    const first = await openRow(page, 1);
    await focusList(page);
    await page.keyboard.press("e");
    await expect(page.locator(`[data-thread-id="${first}"]`)).toHaveCount(0);
    await dock(page).getByTestId("snack-action").click();
    await expect(page.locator(`[data-thread-id="${first}"]`)).toHaveCount(1);
    await expect(dock(page)).toHaveCount(0);

    const second = await openRow(page, 2);
    await focusList(page);
    await page.keyboard.press("e");
    await expect(dock(page)).toContainText("Archived");
    await page.keyboard.press("z");
    await expect(page.locator(`[data-thread-id="${second}"]`)).toHaveCount(1);
    await expect(dock(page)).toHaveCount(0);
    // z again has nothing left: the undo ran once
    await page.keyboard.press("z");
    await expect(page.locator(`[data-thread-id="${second}"]`)).toHaveCount(1);
  });

  test("a new snack replaces the current one: one bar, the newest", async ({ app: page }) => {
    await archiveOne(page, 1);
    await page.keyboard.press("#");
    await expect(dock(page)).toContainText("Moved to Trash");
    await expect(page.getByTestId("snack-dock").getByTestId("snack-message")).toHaveCount(1);
  });

  test("the last row and the keyboard's row stay above the bar", async ({ app: page, server }) => {
    // a sender with a few screens of mail: the list has an end
    const { email } = sqlDb(server.backend.store).get<{ email: string }>(
      "SELECT last_from_email AS email FROM threads WHERE in_inbox = 1 GROUP BY 1 HAVING count(*) BETWEEN 20 AND 90 ORDER BY count(*) DESC LIMIT 1",
    )!;
    await search(page, `in:inbox from:${email}`);
    await archiveOne(page);
    // the pointer over the bar keeps it up for as long as this takes
    await dock(page).hover();
    const top = (await dock(page).boundingBox())!.y;
    // scrolled to the end, the last row ends above the bar
    const list = page.getByRole("listbox", { name: "Conversations" });
    let height = -1;
    for (let i = 0; i < 20 && height !== (await list.evaluate((el) => el.scrollHeight)); i++) {
      height = await list.evaluate((el) => el.scrollHeight);
      await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.waitForTimeout(150);
    }
    const last = (await rows(page).last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(top + 0.5);
    // back at the top: j onto the row under the bar brings it up above it
    await list.evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(100);
    const boxes = await rows(page).evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-thread-id"), ...e.getBoundingClientRect().toJSON() })));
    const under = boxes.findIndex((b) => b.y + b.height > top);
    expect(under).toBeGreaterThan(0);
    await page.locator(`[data-thread-id="${boxes[under - 1]!.id}"]`).dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("j");
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", boxes[under]!.id!);
    await page.waitForTimeout(100);
    const sel = (await selectedRow(page).boundingBox())!;
    expect(sel.y + sel.height).toBeLessThanOrEqual(top + 0.5);
  });

  test("F6 goes to Undo without the bar ever taking focus; Esc closes it and focus goes back", async ({ app: page }) => {
    await page.mouse.move(1300, 100);
    await archiveOne(page);
    // showing it took nothing: focus is where it was
    await expect(page.locator("body")).toBeFocused();
    // from the search field (F6 works while typing), and back to it
    const input = await searchBox(page);
    await input.focus();
    await page.keyboard.press("F6");
    await expect(dock(page).getByTestId("snack-action")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dock(page)).toHaveCount(0);
    await expect(input).toBeFocused();
    // Esc there closed the bar only: the open thread is still open
    await expect(selectedRow(page)).toHaveCount(1);
  });

  test("a dialog over the app holds the countdown; the bar is still there after it closes", async ({ app: page }) => {
    await page.mouse.move(1300, 100);
    await archiveOne(page);
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    const held = await drained(page);
    await page.waitForTimeout(6500);
    expect(Math.abs((await drained(page)) - held)).toBeLessThan(0.5);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    await expect(dock(page)).toContainText("Archived");
  });

  test("any modal holds it, not only the app's dialogs: Base UI's aria-hidden on the bar is the signal; F6 waits too", async ({ app: page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.mouse.move(1300, 100);
    await archiveOne(page);
    // a modal marks the bar hidden (the first run and a report preview aren't app dialogs)
    await page.getByTestId("open-settings").click();
    await expect(dock(page)).toHaveAttribute("aria-hidden", "true");
    await page.keyboard.press("Escape");
    await expect(dock(page)).not.toHaveAttribute("aria-hidden", "true");
    // the same mark without an app dialog behind it holds the countdown and keeps F6 out
    await dock(page).evaluate((el) => el.setAttribute("aria-hidden", "true"));
    await page.waitForTimeout(100);
    const held = await drained(page);
    await page.waitForTimeout(1200);
    expect(Math.abs((await drained(page)) - held)).toBeLessThan(0.5);
    await page.keyboard.press("F6");
    await expect(dock(page).getByTestId("snack-action")).not.toBeFocused();
    await dock(page).evaluate((el) => el.removeAttribute("aria-hidden"));
    await page.waitForTimeout(600);
    expect(await drained(page)).toBeGreaterThan(held + 3);
  });

  test("a slow bulk undo's outcome waits behind what the user did meanwhile", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const target = db.get<{ id: number }>(
      `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'uber.receipts@uber.com'
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 1`,
      facturas,
    )!.id;
    await search(page, "in:inbox from:uber.receipts@uber.com");
    await page.locator(`[data-thread-id="${target}"]`).dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await page.getByTestId(`pick-category-${facturas}`).click();
    await expect(page.getByTestId("snackbar-sender-count")).toBeVisible();
    await focusList(page);
    await page.keyboard.press("1");
    await expect(dock(page)).toContainText("added to Facturas");
    // the bulk undo is slow; meanwhile the user archives something
    const h = handlers(server);
    const original = h["categorize.undo"]!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h["categorize.undo"] = async (...args: unknown[]) => {
      await gate;
      return original(...args);
    };
    try {
      await dock(page).getByTestId("snack-action").click();
      await openRow(page, 1);
      await focusList(page);
      await page.keyboard.press("e");
      await expect(dock(page)).toContainText("Archived");
      release();
      await page.waitForTimeout(500);
      await expect(dock(page)).toContainText("Archived");
      await dock(page).getByTestId("snack-close").click();
      await expect(dock(page)).toContainText("removed from Facturas");
    } finally {
      release();
      h["categorize.undo"] = original;
    }
  });

  test("an error says so assertively, in the destructive ink", async ({ app: page, server }) => {
    const h = handlers(server);
    const original = h["threads.act"]!;
    h["threads.act"] = async () => {
      throw new Error("no connection");
    };
    try {
      await openRow(page, 1);
      await focusList(page);
      await page.keyboard.press("e");
      await expect(dock(page)).toHaveAttribute("data-tone", "error");
      await expect(page.getByTestId("snack-alert")).toContainText("Couldn’t complete: no connection");
      await expect(page.getByTestId("snack-live")).toHaveText("");
    } finally {
      h["threads.act"] = original;
    }
  });

  test("the categorization snackbar lives in the bar: two compact rows, 1 and z still work", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const row = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${facturas}"]))`).first();
    const id = Number(await row.getAttribute("data-thread-id"));
    await row.dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await page.getByTestId(`pick-category-${facturas}`).click();
    const snack = page.getByTestId("snack-dock").getByTestId("category-snackbar");
    await expect(snack).toBeVisible();
    const box = (await dock(page).boundingBox())!;
    const list = (await page.getByTestId("thread-list").boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(84);
    expect(box.x + box.width).toBeLessThan(list.x + list.width);
    await expect(snack.getByTestId("snackbar-undo")).toHaveAccessibleName(/^Undo: Added to Facturas/);
    await page.keyboard.press("z");
    await expect(snack).toHaveCount(0);
    await expect(dock(page)).toContainText("Undone: Facturas");
    await expect.poll(() => db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", id, facturas)).toBeUndefined();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe: plain, error and categorization bars in ${scheme}`, async ({ app: page, server }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.mouse.move(1300, 100);
      const check = async () => {
        const r = await new AxeBuilder({ page }).include("[data-testid=snack-dock]").analyze();
        expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 200)).join(", ")}`)).toEqual([]);
      };
      await archiveOne(page);
      await dock(page).hover();
      await check();
      await page.mouse.move(1300, 100);
      const h = handlers(server);
      const original = h["threads.act"]!;
      h["threads.act"] = async () => {
        throw new Error("no connection");
      };
      await openRow(page, 2);
      await focusList(page);
      await page.keyboard.press("e");
      await expect(dock(page)).toHaveAttribute("data-tone", "error");
      await check();
      h["threads.act"] = original;
      const facturas = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
      await page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${facturas}"]))`).first().dispatchEvent("mousedown");
      await focusList(page);
      await page.keyboard.press("l");
      await page.getByTestId(`pick-category-${facturas}`).click();
      await expect(page.getByTestId("snackbar-sender-count")).toBeVisible();
      await check();
    });
  }
});
