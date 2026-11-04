/**
 * Plan 129: a config dialog drags aside to show what's behind it, stays where it's put for the session, and never gets
 * lost past the window's edge.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, test } from "./fixtures";

const settings = (page: Page) => page.getByTestId("settings-dialog");
/** The popup's own entrance is over (a tab may hold a spinner that never ends: not its subtree). */
const settled = (el: Locator) => el.evaluate((node) => Promise.all((node.closest("[data-slot=dialog-content]") ?? node).getAnimations().map((a) => a.finished)));
const backdrop = (page: Page) => page.locator("[data-slot=dialog-overlay]");

async function box(el: Locator) {
  await settled(el);
  const b = await el.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

async function openSettings(page: Page) {
  await page.getByTestId("open-settings").click();
  await expect(settings(page)).toBeVisible();
  return box(settings(page));
}

/** Press on the handle, past the slop, and let go: `release` false leaves the button down. */
async function drag(page: Page, handle: Locator, dx: number, dy: number, { release = true } = {}) {
  const b = await box(handle);
  const [x, y] = [b.x + Math.min(b.width / 2, 60), b.y + b.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2);
  await page.mouse.move(x + dx, y + dy);
  if (release) await page.mouse.up();
}

test.describe("config dialogs move (plan 129)", { tag: "@design" }, () => {
  test("Settings drags by its title row and its sidebar, a pixel for a pixel", async ({ app: page }) => {
    const start = await openSettings(page);
    await drag(page, page.getByTestId("settings-header"), -150, 40);
    const moved = await box(settings(page));
    expect(moved.x - start.x).toBeCloseTo(-150, 0);
    expect(moved.y - start.y).toBeCloseTo(40, 0);
    // the sidebar's heading, above the tabs
    await drag(page, settings(page).locator("nav h2"), 60, -10);
    const again = await box(settings(page));
    expect(again.x - moved.x).toBeCloseTo(60, 0);
    expect(again.y - moved.y).toBeCloseTo(-10, 0);
  });

  test("controls in a handle keep their press", async ({ app: page }) => {
    const start = await openSettings(page);
    // a tab selects, whatever the pointer does on the way
    await drag(page, page.getByTestId("tab-appearance"), 0, 2);
    await expect(page.getByTestId("tab-appearance")).toHaveAttribute("aria-selected", "true");
    await drag(page, page.getByTestId("tab-general"), 200, 0);
    expect((await box(settings(page))).x).toBeCloseTo(start.x, 0);
    await settings(page).locator("[data-slot=dialog-close]").click();
    await expect(settings(page)).toHaveCount(0);
  });

  test("the content below the handles doesn't drag", async ({ app: page }) => {
    const start = await openSettings(page);
    await drag(page, page.getByTestId("language-row"), 100, 50);
    expect((await box(settings(page))).x).toBeCloseTo(start.x, 0);
  });

  test("a release over the backdrop doesn't close it, and a click there still does", async ({ app: page }) => {
    const start = await openSettings(page);
    // the pointer leaves the sheet entirely: it stops at the bound, the pointer goes on
    await drag(page, page.getByTestId("settings-header"), -start.x - 400, 200);
    await expect(settings(page)).toBeVisible();
    await settled(settings(page));
    const after = await box(settings(page));
    await page.mouse.click(after.x + after.width + 30, 200);
    await expect(settings(page)).toHaveCount(0);
  });

  test("a press that doesn't travel is a click, not a move", async ({ app: page }) => {
    await openSettings(page);
    const color = await backdrop(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    const b = await box(page.getByTestId("settings-header"));
    await page.mouse.move(b.x + 20, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 21, b.y + b.height / 2);
    await page.mouse.up();
    await expect(settings(page)).not.toHaveAttribute("style", /translate/);
    expect(await backdrop(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(color);
  });

  test("the dim clears while moved, and a double-click on the handle puts it back", async ({ app: page }) => {
    const start = await openSettings(page);
    const dim = await backdrop(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(dim).not.toMatch(/, 0\)$|^transparent$/);
    // already while dragging, button still down
    await drag(page, page.getByTestId("settings-header"), 120, 0, { release: false });
    await expect(backdrop(page)).toHaveAttribute("data-moved");
    await page.mouse.up();
    await expect.poll(() => backdrop(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/, 0\)$|^transparent$/);
    await page.getByTestId("settings-header").dblclick({ position: { x: 20, y: 10 } });
    await expect(backdrop(page)).not.toHaveAttribute("data-moved");
    expect((await box(settings(page))).x).toBeCloseTo(start.x, 0);
    expect(await backdrop(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(dim);
  });

  test("it holds through a theme change, a tab change and reopening", async ({ app: page }) => {
    await openSettings(page);
    await drag(page, page.getByTestId("settings-header"), -200, 30);
    const spot = await box(settings(page));
    await page.getByTestId("tab-appearance").click();
    await page.getByTestId("theme-card-nord").click();
    expect((await box(settings(page))).x).toBeCloseTo(spot.x, 0);
    await page.keyboard.press("Escape");
    await expect(settings(page)).toHaveCount(0);
    await page.getByTestId("open-settings").click();
    expect((await box(settings(page))).x).toBeCloseTo(spot.x, 0);
    expect((await box(settings(page))).y).toBeCloseTo(spot.y, 0);
    await expect(backdrop(page)).toHaveAttribute("data-moved");
  });

  test("it holds through the language switch's remount", async ({ app: page }) => {
    await openSettings(page);
    await drag(page, page.getByTestId("settings-header"), -180, 20);
    const spot = await box(settings(page));
    await page.getByTestId("language-select").click();
    await page.getByTestId("language-es").click();
    await expect(page.locator("html")).toHaveAttribute("lang", /^es/);
    await expect(settings(page)).toBeVisible();
    expect((await box(settings(page))).x).toBeCloseTo(spot.x, 0);
  });

  test("it can't leave the window, and a smaller window pulls it back", async ({ app: page }) => {
    await openSettings(page);
    await drag(page, page.getByTestId("settings-header"), 3000, 3000);
    const view = page.viewportSize()!;
    let b = await box(settings(page));
    expect(b.x).toBeCloseTo(view.width - 120, 0);
    expect(b.y).toBeCloseTo(view.height - 48, 0);
    await drag(page, settings(page).locator("nav h2"), -3000, -3000);
    b = await box(settings(page));
    expect(b.x + b.width).toBeCloseTo(120, 0);
    expect(b.y).toBeCloseTo(0, 0);
    // the part still showing is the title row's end, short of the close
    await page.mouse.move(b.x + b.width - 80, 10);
    await page.mouse.down();
    await page.mouse.move(view.width, view.height);
    await page.mouse.move(view.width + 3000, view.height + 3000);
    await page.mouse.up();
    b = await box(settings(page));
    expect(b.x).toBeCloseTo(view.width - 120, 0);
    await page.setViewportSize({ width: view.width - 200, height: view.height - 150 });
    await expect.poll(async () => (await box(settings(page))).x).toBeCloseTo(view.width - 200 - 120, 0);
    await expect.poll(async () => (await box(settings(page))).y).toBeCloseTo(view.height - 150 - 48, 0);
  });

  test("a closed dialog reopens inside a window that shrank meanwhile", async ({ app: page }) => {
    await openSettings(page);
    await drag(page, page.getByTestId("settings-header"), 3000, 0);
    await page.keyboard.press("Escape");
    await expect(settings(page)).toHaveCount(0);
    const view = page.viewportSize()!;
    await page.setViewportSize({ width: view.width - 200, height: view.height });
    await page.getByTestId("open-settings").click();
    // within the bound (a keyboard-focused tab may pull it in further: below)
    expect((await box(settings(page))).x).toBeLessThanOrEqual(view.width - 200 - 120 + 0.5);
  });

  test("Tab onto a control past the edge brings it into view", async ({ app: page }) => {
    await openSettings(page);
    await drag(page, page.getByTestId("settings-header"), -3000, 0);
    expect((await box(page.getByTestId("tab-general"))).x).toBeLessThan(0);
    await page.getByTestId("tab-general").focus();
    // the keyboard's way there: off the selected tab and back
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("tab-general")).toBeFocused();
    await expect.poll(async () => (await page.getByTestId("tab-general").boundingBox())!.x).toBeGreaterThanOrEqual(0);
  });

  test("a focused field keeps its focus through a drag", async ({ app: page }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await page.getByTestId("settings-add-account").click();
    const dialog = page.getByTestId("add-account-dialog");
    await expect(dialog).toBeVisible();
    const field = page.getByTestId("imap-email");
    await field.fill("a@b.test");
    await field.focus();
    const start = await box(dialog);
    await drag(page, dialog.locator("[data-slot=dialog-header]"), 100, 40);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("a@b.test");
    expect((await box(dialog)).x - start.x).toBeCloseTo(100, 0);
  });

  test("Add account drags by its margin, not its scrollbar", async ({ app: page }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await page.getByTestId("settings-add-account").click();
    const dialog = page.getByTestId("add-account-dialog");
    const start = await box(dialog);
    await page.mouse.move(start.x + 40, start.y + 8);
    await page.mouse.down();
    await page.mouse.move(start.x + 90, start.y + 38);
    await page.mouse.up();
    const moved = await box(dialog);
    expect(moved.x - start.x).toBeCloseTo(50, 0);
    expect(moved.y - start.y).toBeCloseTo(30, 0);
  });

  test("Filters drags by the strip above its form and its sidebar's title", async ({ app: page }) => {
    await page.getByTestId("open-filters").click();
    const dialog = page.getByTestId("filters-dialog");
    await expect(dialog).toBeVisible();
    const start = await box(dialog);
    await drag(page, dialog.locator("[data-dialog-handle]").last(), -40, 20);
    const moved = await box(dialog);
    expect(moved.x - start.x).toBeCloseTo(-40, 0);
    await drag(page, dialog.locator("aside h2"), 30, 0);
    expect((await box(dialog)).x - moved.x).toBeCloseTo(30, 0);
  });

  test("a dialog not opted in stays put", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("?");
    const dialog = page.getByTestId("shortcuts-dialog");
    const start = await box(dialog);
    await drag(page, dialog.locator("[data-slot=dialog-header]"), 100, 40);
    expect((await box(dialog)).x).toBeCloseTo(start.x, 0);
    await expect(dialog).not.toHaveAttribute("data-movable");
  });

  test("a moved Settings is still clean for axe, in light and dark", async ({ app: page }) => {
    await openSettings(page);
    await drag(page, page.getByTestId("settings-header"), -150, 40);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      const { violations } = await new AxeBuilder({ page }).include("[data-testid=settings-dialog]").analyze();
      expect(violations).toEqual([]);
    }
  });
});

test.describe("closing a moved dialog", () => {
  test.use({ reducedMotion: "no-preference" });

  // this one fades out (Settings and the others unmount at once): mid-fade it's still where it was put
  test("it fades in place instead of jumping to the middle", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const cat = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    await page.getByTestId(`nav-category-${cat}`).click({ button: "right" });
    await page.getByTestId("category-menu-forward").click();
    const dialog = page.getByTestId("category-forward-dialog");
    const start = await box(dialog);
    await drag(page, dialog.locator("[data-slot=dialog-header]"), 120, -30);
    const spot = await box(dialog);
    expect(spot.x - start.x).toBeCloseTo(120, 0);
    const closing = await dialog.evaluate(async (el) => {
      const moved = el.getBoundingClientRect().left;
      el.querySelector<HTMLElement>("[data-slot=dialog-close]")!.click();
      await new Promise((r) => requestAnimationFrame(r));
      const animations = el.getAnimations();
      animations.forEach((a) => a.pause());
      return { animating: animations.length, delta: el.getBoundingClientRect().left - moved };
    });
    expect(closing.animating).toBeGreaterThan(0);
    expect(Math.abs(closing.delta)).toBeLessThan(1);
  });
});
