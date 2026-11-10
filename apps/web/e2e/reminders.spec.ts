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
import { menuPath, expect, focusList, openRow, rows, selectedRow, test, timeText, typeTime, fresh, scenario, watchWhole } from "./fixtures";

const snackWith = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });
const rowOf = (page: Page, id: string | number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
const wcag = (page: Page, root: string) => new AxeBuilder({ page }).setLegacyMode().include(root).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);

async function goReminders(page: Page) {
  await focusList(page);
  await page.keyboard.press("g");
  await page.keyboard.press("r");
  await expect(page.getByTestId("list-title")).toHaveText("Reminders");
}

test.describe("remind me", () => {
  test("from the menu: Tomorrow sets it, the row shows a bell, Reminders lists it at its time, Undo takes it back", { tag: "@variant" }, async ({ app: page }) => {
    const row = rows(page).nth(2);
    const id = (await row.getAttribute("data-thread-id"))!;
    await row.click({ button: "right" });
    // right after reply and triage
    const items = await page.locator("[role=menu] > [data-testid^=menu-]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid));
    expect(items.indexOf("menu-remind-always")).toBe(items.indexOf("menu-star") + 1);
    await menuPath(page, "menu-remind-always");
    const list = page.getByTestId("menu-remind-always-list");
    // the day isn't said twice: "Tomorrow" beside its time, the if-no-reply kind inside
    await expect(list.getByTestId("menu-remind-always-tomorrow")).toHaveText(/^Tomorrow\s*\d/);
    await expect(list.getByTestId("menu-remind-noReply")).toBeVisible();
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
    await expect(page.getByTestId("filter-menu")).toHaveCount(0);
    await expect(page.getByTestId("quick-filters")).toHaveCount(0);

    await focusList(page);
    await page.keyboard.press("z");
    await expect(page.getByTestId("list-empty")).toContainText("No reminders");
  });

  test("reminders: the bell's own time, a due one on top, archiving it, the menu's picker", async ({ app: page, server }) => {
    await scenario("from the reader's bell: If no reply on a date and time of your own; a past one is refused", async () => {
      await openRow(page, 1);
      // its first open too: the choices come with the popover, no empty box first
      const whole = await watchWhole(page, "remind-popover", "remind-picker");
      await page.getByTestId("action-remind").click();
      expect(await whole()).toBe(true);
      const popover = page.getByTestId("remind-popover");
      await expect(popover).toBeVisible();
      await popover.getByTestId("remind-kind-noReply").click();
      await expect(popover.getByTestId("remind-preset-in3d")).toContainText("Sun 10:00 AM");
      // Custom's first click shows the calendar and the time at once too
      const custom = await watchWhole(page, "remind-custom", "remind-time");
      await popover.getByTestId("remind-pick").click();
      expect(await custom()).toBe(true);
      // the calendar (tomorrow chosen) offers no day before today
      await expect(popover.getByTestId("remind-date")).toHaveText("Fri, Oct 23");
      await popover.getByTestId("remind-date").click();
      const calendar = page.getByTestId("remind-calendar");
      await expect(calendar.locator('button[data-day="2026-10-21"]')).toBeDisabled();
      // today at a time already gone: refused, said why
      await calendar.locator('button[data-day="2026-10-22"]').click();
      await expect(calendar).toBeHidden();
      await expect(popover.getByTestId("remind-past")).toHaveText("Pick a time in the future.");
      await expect(popover.getByTestId("remind-set")).toBeDisabled();
      await popover.getByTestId("remind-date").click();
      await calendar.locator('button[data-day="2026-10-30"]').click();
      await typeTime(popover.getByTestId("remind-time"), 2, 0, "PM");
      expect(await timeText(popover.getByTestId("remind-time"))).toBe("2:00 PM");
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
    await scenario("a due reminder brings its conversation to the top of the Inbox, archived or not, until it's opened", async () => {
      await fresh(page);
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
    await scenario("archiving a due one ends it; Undo brings it back on top", async () => {
      await fresh(page);
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
    await scenario("the menu's Pick date & time… opens the picker on the kind it was under, over the reminder's own", async () => {
      await fresh(page);
      const row = rows(page).nth(2);
      const id = Number(await row.getAttribute("data-thread-id"));
      await server.backend.server.invoke("reminders.set", { threadIds: [id], dueAt: E2E_NOW + 86_400_000, kind: "always" }, { clientId: "setup", origin: "dev" });
      await expect(rowOf(page, id).getByTestId("row-reminder")).toBeVisible();
      await row.click({ button: "right" });
      await menuPath(page, "menu-remind-always");
      await page.getByTestId("menu-remind-noReply").click();
      await page.getByTestId("menu-remind-noReply-pick").click();
      const dialog = page.getByTestId("remind-dialog");
      await expect(dialog.getByTestId("remind-kind-noReply")).toHaveAttribute("aria-pressed", "true");
      await expect(dialog.getByTestId("remind-custom")).toBeVisible();
      await dialog.getByTestId("remind-set").click();
      await expect(snackWith(page, "if they don't answer")).toBeVisible();
    });
    await scenario("the bell's picker open, the title bands aren't the window's drag area: a click on one closes it on desktop (plan 174)", async () => {
      // (Electron takes a click on a drag area for the window before the page sees it; a popover has no layer of its own over them)
      const region = (testId: string) => page.getByTestId(testId).evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region"));
      await openRow(page, 1);
      expect(await region("list-header")).toBe("drag");
      await page.getByTestId("action-remind").click();
      await expect(page.getByTestId("remind-popover")).toBeVisible();
      expect(await region("list-header")).toBe("no-drag");
      await page.getByTestId("list-title").click();
      await expect(page.getByTestId("remind-popover")).toHaveCount(0);
      expect(await region("list-header")).toBe("drag");
    });
  });

  test("the picker and the menu are axe-clean, in light and dark", async ({ app: page }) => {
    for (const mode of ["light", "dark"] as const) {
      await scenario(mode, async () => {
        await fresh(page);
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
});
