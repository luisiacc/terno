/**
 * Plan 87: remind me. Set from the thread menu (near its top) and from the
 * reader's bell, "Remind me" or "If no reply"; the Reminders list behind
 * More; a due reminder at the top of the Inbox until the conversation is
 * opened. The app's clock and the backend's are E2E_NOW: Thursday Oct 22,
 * 2026, 9:30 AM in Mexico City.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { E2E_NOW } from "./constants";
import { expect, focusList, openRow, rows, selectedRow, test } from "./fixtures";

const snackWith = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });
const rowOf = (page: Page, id: string | number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
const wcag = (page: Page, root: string) => new AxeBuilder({ page }).include(root).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);

async function goReminders(page: Page) {
  await focusList(page);
  await page.keyboard.press("g");
  await page.keyboard.press("r");
  await expect(page.getByTestId("list-title")).toHaveText("Reminders");
}

test.describe("remind me", { tag: "@design" }, () => {
  test("from the menu: Tomorrow sets it, the row shows a bell, Reminders lists it at its time, Undo takes it back", async ({ app: page }) => {
    const row = rows(page).nth(2);
    const id = (await row.getAttribute("data-thread-id"))!;
    await row.click({ button: "right" });
    // near the top: right after Reply, Reply all, Forward and Print, before the read and star items
    const items = await page.locator("[role=menu] > [data-testid^=menu-]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid));
    expect(items.indexOf("menu-remind-always")).toBe(items.indexOf("menu-print") + 1);
    expect(items.indexOf("menu-remind-noReply")).toBe(items.indexOf("menu-remind-always") + 1);
    expect(items.indexOf("menu-remind-noReply")).toBeLessThan(items.indexOf("menu-read") === -1 ? items.indexOf("menu-unread") : items.indexOf("menu-read"));
    await page.getByTestId("menu-remind-always").hover();
    const list = page.getByTestId("menu-remind-always-list");
    await expect(list.getByTestId("menu-remind-always-laterToday")).toContainText("1:00 PM");
    await expect(list.getByTestId("menu-remind-always-weekend")).toContainText("Sat 9:00 AM");
    await list.getByTestId("menu-remind-always-tomorrow").click();
    await expect(snackWith(page, "I'll remind you tomorrow at 9:00 AM")).toBeVisible();
    await expect(rowOf(page, id).getByTestId("row-reminder")).toBeVisible();
    await expect(rowOf(page, id).getByTestId("row-reminder")).not.toHaveAttribute("data-due");

    await goReminders(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveAttribute("data-thread-id", id);
    await expect(rows(page).first().getByTestId("row-date")).toHaveText("Tomorrow 9:00 AM");
    // no quick filters in Reminders
    await expect(page.getByTestId("unread-filter")).toHaveCount(0);
    await expect(page.getByTestId("quick-filters")).toHaveCount(0);

    await focusList(page);
    await page.keyboard.press("z");
    await expect(page.getByTestId("list-empty")).toContainText("No reminders");
  });

  test("from the reader's bell: If no reply on a date and time of your own; a past one is refused", async ({ app: page }) => {
    await openRow(page, 1);
    await page.getByTestId("action-remind").click();
    const popover = page.getByTestId("remind-popover");
    await expect(popover).toBeVisible();
    await popover.getByTestId("remind-kind-noReply").click();
    await expect(popover.getByTestId("remind-preset-in3d")).toContainText("Sun 10:00 AM");
    await popover.getByTestId("remind-pick").click();
    await popover.getByTestId("remind-date").fill("2026-10-21");
    await expect(popover.getByTestId("remind-past")).toHaveText("Pick a time in the future.");
    await expect(popover.getByTestId("remind-set")).toBeDisabled();
    await popover.getByTestId("remind-date").fill("2026-10-30");
    await popover.getByTestId("remind-time").fill("14:00");
    await popover.getByTestId("remind-set").click();
    await expect(popover).toBeHidden();
    await expect(snackWith(page, "I'll remind you on Oct 30 at 2:00 PM if they don't answer")).toBeVisible();
    await expect(page.getByTestId("action-remind")).toHaveAttribute("data-set", "true");
    await expect(page.getByTestId("action-remind")).toHaveAccessibleName("Reminder: Oct 30 2:00 PM");
    // h opens it again, now with the reminder there is and Clear
    await focusList(page);
    await page.keyboard.press("h");
    await expect(popover.getByTestId("remind-current")).toHaveText("Reminds you on Oct 30 at 2:00 PM if they don't answer");
    await popover.getByTestId("remind-clear").click();
    await expect(snackWith(page, "Reminder cleared")).toBeVisible();
    await expect(page.getByTestId("action-remind")).not.toHaveAttribute("data-set");
  });

  test("a due reminder brings its conversation to the top of the Inbox, archived or not, until it's opened", async ({ app: page, server }) => {
    const id = Number(await rows(page).nth(6).getAttribute("data-thread-id"));
    const dev = { clientId: "setup", origin: "dev" as const };
    await server.backend.server.invoke("threads.act", { threadIds: [id], action: "archive" }, dev);
    await expect(rowOf(page, id)).toHaveCount(0);
    // its time came (the backend's clock is E2E_NOW)
    await server.backend.server.invoke("reminders.set", { threadIds: [id], dueAt: E2E_NOW, kind: "always" }, dev);
    await expect(rows(page).first()).toHaveAttribute("data-thread-id", String(id));
    await expect(rows(page).first().getByTestId("row-reminder")).toHaveAttribute("data-due", "true");
    // the sidebar's Reminders shows, with More closed, and counts it
    const nav = page.getByTestId("nav-reminders");
    await expect(nav).toBeVisible();
    await expect(nav.locator("[data-slot=nav-count]")).toHaveText("1");
    // the Unread filter keeps it too
    await focusList(page);
    await page.keyboard.press("Shift+U");
    await expect(rows(page).first()).toHaveAttribute("data-thread-id", String(id));
    await page.keyboard.press("Shift+A");

    // opened: the reminder ends after a moment, the row stays while it's open, and goes when the selection moves on
    await rows(page).first().dispatchEvent("mousedown");
    await rows(page).first().dispatchEvent("click");
    await expect(nav.locator("[data-slot=nav-count]")).toHaveCount(0);
    await expect(rows(page).first()).toHaveAttribute("data-thread-id", String(id));
    await focusList(page);
    await page.keyboard.press("j");
    await expect(rowOf(page, id)).toHaveCount(0);
  });

  test("archiving a due one ends it; Undo brings it back on top", async ({ app: page, server }) => {
    const id = Number(await rows(page).nth(4).getAttribute("data-thread-id"));
    await server.backend.server.invoke("reminders.set", { threadIds: [id], dueAt: E2E_NOW, kind: "always" }, { clientId: "setup", origin: "dev" });
    await expect(rows(page).first()).toHaveAttribute("data-thread-id", String(id));
    await rows(page).first().click({ button: "right" });
    await page.getByTestId("menu-archive").click();
    await expect(rowOf(page, id)).toHaveCount(0);
    await expect(page.getByTestId("nav-reminders").locator("[data-slot=nav-count]")).toHaveCount(0);
    await focusList(page);
    await page.keyboard.press("z");
    await expect(rows(page).first()).toHaveAttribute("data-thread-id", String(id));
    await expect(page.getByTestId("nav-reminders").locator("[data-slot=nav-count]")).toHaveText("1");
  });

  test("the menu's Pick date & time… opens the picker on the kind it was under, over the reminder's own", async ({ app: page, server }) => {
    const row = rows(page).nth(2);
    const id = Number(await row.getAttribute("data-thread-id"));
    await server.backend.server.invoke("reminders.set", { threadIds: [id], dueAt: E2E_NOW + 86_400_000, kind: "always" }, { clientId: "setup", origin: "dev" });
    await expect(rowOf(page, id).getByTestId("row-reminder")).toBeVisible();
    await row.click({ button: "right" });
    await page.getByTestId("menu-remind-noReply").hover();
    await page.getByTestId("menu-remind-noReply-pick").click();
    const dialog = page.getByTestId("remind-dialog");
    await expect(dialog.getByTestId("remind-kind-noReply")).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByTestId("remind-custom")).toBeVisible();
    await dialog.getByTestId("remind-set").click();
    await expect(snackWith(page, "if they don't answer")).toBeVisible();
  });

  for (const mode of ["light", "dark"] as const) {
    test(`the picker and the menu are axe-clean, ${mode}`, async ({ app: page }) => {
      await page.emulateMedia({ colorScheme: mode });
      await openRow(page, 0);
      await page.getByTestId("action-remind").click();
      await expect(page.getByTestId("remind-popover")).toBeVisible();
      await page.getByTestId("remind-pick").click();
      expect((await wcag(page, "[data-testid=remind-popover]").analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
      await selectedRow(page).click({ button: "right" });
      await page.getByTestId("menu-remind-always").hover();
      await expect(page.getByTestId("menu-remind-always-list")).toBeVisible();
      expect((await wcag(page, "[data-testid=menu-remind-always-list]").analyze()).violations).toEqual([]);
    });
  }
});
