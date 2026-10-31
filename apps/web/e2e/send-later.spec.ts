/**
 * Plan 94: send later. The clock joined to Send opens Send now, Tomorrow at
 * 8:00 and Custom; a scheduled message leaves the composer for the strip
 * above the list, where a click offers Send now, a new time or Edit message.
 * The app's clock and the backend's are E2E_NOW: Thursday Oct 22, 2026,
 * 9:30 AM in Mexico City.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { addRecipients, expect, focusList, openRow, test } from "./fixtures";

const snackWith = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });
const body = (page: Page) => page.getByTestId("compose-body");
const scheduled = (page: Page) => page.getByTestId("strip-scheduled");
const wcag = (page: Page, root: string) => new AxeBuilder({ page }).include(root).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);

async function newMessage(page: Page, subject: string) {
  await focusList(page);
  await page.keyboard.press("c");
  await addRecipients(page, "compose-to", "ana@example.com");
  await page.getByTestId("compose-subject").fill(subject);
  await body(page).click();
  await page.keyboard.type("See you at nine.");
}

test.describe("send later", { tag: "@design" }, () => {
  test("the clock: Tomorrow at 8:00 schedules it, the strip shows it at its time, Undo brings the draft back", async ({ app: page }) => {
    await newMessage(page, "Standup notes");
    await page.getByTestId("compose-send-later").click();
    const popover = page.getByTestId("send-later-popover");
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId("send-later-now")).toContainText("Send now");
    await expect(popover.getByTestId("send-later-tomorrow")).toContainText("Tomorrow at 8:00 AM");
    await expect(popover.getByTestId("send-later-tomorrow")).toContainText("Fri, Oct 23");
    await expect(popover.getByTestId("send-later-local")).toBeVisible();
    // the first choice has the focus; arrows move through them
    await expect(popover.getByTestId("send-later-now")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(popover.getByTestId("send-later-tomorrow")).toBeFocused();
    expect((await wcag(page, "[data-testid=send-later-popover]").analyze()).violations).toEqual([]);

    await page.keyboard.press("Enter");
    await expect(snackWith(page, "Will send tomorrow at 8:00 AM")).toBeVisible();
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await expect(scheduled(page)).toHaveCount(1);
    await expect(scheduled(page)).toContainText("Standup notes");
    await expect(scheduled(page).getByTestId("strip-scheduled-when")).toHaveText("Tomorrow 8:00 AM");
    // a scheduled draft isn't an editable one
    await expect(page.getByTestId("strip-item")).toHaveCount(0);

    await snackWith(page, "Will send tomorrow at 8:00 AM").getByRole("button", { name: "Undo scheduling" }).click();
    await expect(scheduled(page)).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("compose-subject")).toHaveValue("Standup notes");
    await expect(body(page)).toContainText("See you at nine.");
  });

  test("⌘⇧↵ opens it (never sends); Custom schedules a reply at a time of your own; Send now from the strip sends it", async ({ app: page }) => {
    await openRow(page, 0);
    const before = await page.getByTestId("message").count();
    await page.getByTestId("quick-reply").click();
    await expect(body(page)).toBeFocused();
    await page.keyboard.type("Works for me.");
    await page.keyboard.press("Meta+Shift+Enter");
    const popover = page.getByTestId("send-later-popover");
    await expect(popover).toBeVisible();
    await expect(page.getByTestId("message")).toHaveCount(before);

    await popover.getByTestId("send-later-custom").click();
    await expect(popover.getByTestId("send-later-date")).toContainText("Fri, Oct 23");
    await popover.getByTestId("send-later-time").click();
    await page.getByTestId("send-later-times").getByRole("option", { name: "10:15 AM" }).click();
    await popover.getByTestId("send-later-set").click();
    await expect(snackWith(page, "Will send tomorrow at 10:15 AM")).toBeVisible();
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await expect(page.getByTestId("message")).toHaveCount(before);
    // the conversation says its reply is scheduled, above the reply bar
    await expect(page.getByTestId("reader-scheduled")).toContainText("Reply scheduled");
    await expect(page.getByTestId("reader-scheduled")).toContainText("Tomorrow 10:15 AM");

    await scheduled(page).click();
    const strip = page.getByTestId("scheduled-popover");
    await expect(strip.getByTestId("send-later-current")).toHaveText("Sends tomorrow at 10:15 AM");
    expect((await wcag(page, "[data-testid=scheduled-popover]").analyze()).violations).toEqual([]);
    await strip.getByTestId("send-later-now").click();
    await expect(scheduled(page)).toHaveCount(0);
    await expect(page.getByTestId("message")).toHaveCount(before + 1);
    await expect(page.getByTestId("reader-scheduled")).toHaveCount(0);
  });

  test("a time that has passed can't be scheduled; Edit message makes it a draft again, opened", async ({ app: page }) => {
    await newMessage(page, "Budget");
    await page.getByTestId("compose-send-later").click();
    const popover = page.getByTestId("send-later-popover");
    await popover.getByTestId("send-later-custom").click();
    await popover.getByTestId("send-later-date").click();
    await page.getByTestId("send-later-calendar").getByRole("button", { name: /October 22/ }).click();
    await popover.getByTestId("send-later-time").click();
    await page.getByTestId("send-later-times").getByRole("option", { name: "9:00 AM", exact: true }).click();
    await expect(popover.getByTestId("send-later-past")).toHaveText("Pick a time in the future.");
    await expect(popover.getByTestId("send-later-set")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);

    await page.getByTestId("compose-send-later").click();
    await page.getByTestId("send-later-popover").getByTestId("send-later-tomorrow").click();
    await expect(scheduled(page)).toHaveCount(1);
    await scheduled(page).click();
    await page.getByTestId("scheduled-popover").getByTestId("send-later-edit").click();
    await expect(scheduled(page)).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("compose-subject")).toHaveValue("Budget");
  });
});
