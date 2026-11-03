/**
 * Plan 119: a panel of rows has corners concentric with its rows'. The panel's radius is the row's plus the inset
 * between them, so the two curves run parallel in every design: the send-later popover, a right-click
 * menu, the palette, the date picker, the category picker.
 */
import type { Locator } from "@playwright/test";
import { addRecipients, expect, focusList, openRow, rows, test } from "./fixtures";

async function concentric(panel: Locator, row: Locator) {
  await expect(row).toBeVisible();
  // settled: an opening zoom would scale the rects
  await panel.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const outer = await panel.evaluate((el) => ({ r: parseFloat(getComputedStyle(el).borderTopLeftRadius), left: el.getBoundingClientRect().left }));
  const inner = await row.evaluate((el) => ({ r: parseFloat(getComputedStyle(el).borderTopLeftRadius), left: el.getBoundingClientRect().left }));
  const inset = inner.left - outer.left;
  expect(inset, "the rows sit inside the panel").toBeGreaterThan(0);
  expect(Math.abs(outer.r - (inner.r + inset)), `panel ${outer.r}px = row ${inner.r}px + inset ${inset}px`).toBeLessThanOrEqual(0.5);
}

test.describe("menu corners are concentric with their rows (plan 119)", { tag: "@design" }, () => {
  test("the send-later popover", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("c");
    await addRecipients(page, "compose-to", "ana@example.com");
    await page.getByTestId("compose-send-later").click();
    const popover = page.getByTestId("send-later-popover");
    await concentric(popover, popover.getByTestId("send-later-now"));
  });

  test("a right-click menu", async ({ app: page }) => {
    await rows(page).first().click({ button: "right" });
    const menu = page.locator("[data-slot=context-menu-content]");
    await concentric(menu, menu.getByRole("menuitem").first());
  });

  test("the palette", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.locator("[data-slot=dialog-content]").filter({ has: page.locator("[data-slot=command]") });
    await concentric(dialog, dialog.locator("[data-slot=command-item]").first());
  });

  // plan 120: BoardUI's date picker, its days 2.5 in from the popover's edge
  test("the date picker", async ({ app: page }) => {
    await openRow(page, 1);
    await page.getByTestId("action-remind").click();
    await page.getByTestId("remind-pick").click();
    await page.getByTestId("remind-date").click();
    const calendar = page.getByTestId("remind-calendar");
    // a full week's first day (the first week may start mid-row)
    await concentric(calendar, calendar.locator("[data-slot=calendar] tbody tr").nth(1).locator("button[data-day]").first());
  });

  test("the category picker", async ({ app: page }) => {
    await rows(page).first().dispatchEvent("mousedown");
    await page.keyboard.press("l");
    const picker = page.getByTestId("category-picker");
    await concentric(picker, picker.locator("[data-slot=command-item]").first());
  });
});
