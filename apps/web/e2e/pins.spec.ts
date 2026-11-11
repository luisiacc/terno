/**
 * Plan 177: pinned conversations. P, the row menu or the reader's Pin button
 * pins one to the Inbox's top, under a quiet "Pinned" heading above the due
 * reminders and the mail; putting it away (archive) ends the pin and its Undo
 * brings it back; elsewhere a pinned row shows a quiet pin.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { E2E_NOW } from "./constants";
import { expect, focusList, fresh, openRow, rows, scenario, searchBox, test } from "./fixtures";

const snackWith = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });
const rowOf = (page: Page, id: string | number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
const idAt = async (page: Page, i: number) => (await rows(page).nth(i).getAttribute("data-thread-id"))!;
const wcag = (page: Page, root: string) => new AxeBuilder({ page }).setLegacyMode().include(root).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
/** PINS_SHOTS=<dir>: pictures of the section for a person to look at, one folder per style (no baselines) */
const shotsDir = () => process.env.PINS_SHOTS && `${process.env.PINS_SHOTS}/${test.info().project.name}`;

test.describe("pinned conversations", () => {
  test("pin to the top, unpin, archive and Undo, the mark elsewhere", { tag: "@design" }, async ({ app: page, server }) => {
    const SHOTS = shotsDir();
    const pinned: string[] = [];
    await scenario("P pins the open conversation: it leads the Inbox under Pinned, the hairline after it, the selection on it", async () => {
      const id = await openRow(page, 3);
      await focusList(page);
      await page.keyboard.press("p");
      await expect(snackWith(page, "Pinned to the top")).toBeVisible();
      await expect(rows(page).first()).toHaveAttribute("data-thread-id", id);
      await expect(page.getByTestId("inbox-pinned-label")).toHaveText("Pinned");
      await expect(page.getByTestId("inbox-top-end")).toBeVisible();
      await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
      // in the section the heading says it: no pin on the row; a screen reader hears it
      await expect(rows(page).first().getByTestId("row-pin")).toHaveCount(0);
      await expect(rows(page).first()).toContainText(", pinned");
      // the heading stands on the rows' text edge, under nothing, above the row
      const label = await page.getByTestId("inbox-pinned-label").boundingBox();
      const first = await rows(page).first().boundingBox();
      expect(label!.y + label!.height).toBeLessThanOrEqual(first!.y + 1);
      pinned.push(id);
    });

    await scenario("the reader's toolbar: Pin beside Star, pressed while pinned; it unpins and pins again", async () => {
      const pin = page.getByTestId("action-pin");
      const star = page.getByTestId("action-star");
      await expect(pin).toHaveAttribute("aria-pressed", "true");
      await expect(pin).toHaveAccessibleName("Unpin");
      // right after Star, on its line
      const [s, p] = [await star.boundingBox(), await pin.boundingBox()];
      expect(Math.abs(s!.y - p!.y)).toBeLessThan(1);
      expect(p!.x).toBeGreaterThan(s!.x);
      if (SHOTS) {
        await pin.hover();
        await expect(page.locator("[data-slot=tooltip-content]")).toContainText("Unpin");
        await page.screenshot({ path: `${SHOTS}/toolbar-pinned-light.png` });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({ path: `${SHOTS}/toolbar-pinned-dark.png` });
        await page.emulateMedia({ colorScheme: "light" });
      }
      await pin.click();
      await expect(snackWith(page, "Unpinned")).toBeVisible();
      await expect(pin).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("inbox-pinned-label")).toHaveCount(0);
      await pin.click();
      await expect(pin).toHaveAttribute("aria-pressed", "true");
      await expect(rows(page).first()).toHaveAttribute("data-thread-id", pinned[0]!);
    });

    await scenario("from the row menu: Pin to top at the top level, right after Star; the newest pin leads", async () => {
      const id = await idAt(page, 5);
      await rowOf(page, id).click({ button: "right" });
      const item = page.getByTestId("menu-pin");
      await expect(item).toBeVisible();
      await expect(item).toContainText("Pin to top");
      // beside Star, not under More
      await expect(page.getByTestId("menu-star").locator("xpath=following-sibling::*[1]")).toHaveAttribute("data-testid", "menu-pin");
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/row-menu-light.png` });
      await item.click();
      await expect(snackWith(page, "Pinned to the top")).toBeVisible();
      await expect(rows(page).nth(0)).toHaveAttribute("data-thread-id", id);
      await expect(rows(page).nth(1)).toHaveAttribute("data-thread-id", pinned[0]!);
      pinned.unshift(id);
      // one heading for the two
      await expect(page.getByTestId("inbox-pinned-label")).toHaveCount(1);
    });

    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/pinned-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/pinned-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
    }

    await scenario("axe-clean with Pinned on top, light and dark", async () => {
      expect((await wcag(page, "[data-testid=thread-list]").analyze()).violations).toEqual([]);
      await page.emulateMedia({ colorScheme: "dark" });
      expect((await wcag(page, "[data-testid=thread-list]").analyze()).violations).toEqual([]);
      await page.emulateMedia({ colorScheme: "light" });
    });

    await scenario("P on a pinned one unpins it; Undo pins it back where it was", async () => {
      await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("p");
      await expect(snackWith(page, "Unpinned")).toBeVisible();
      await expect(rows(page).first()).toHaveAttribute("data-thread-id", pinned[1]!);
      await page.keyboard.press("z");
      await expect(rows(page).first()).toHaveAttribute("data-thread-id", pinned[0]!);
      await expect(rows(page).nth(1)).toHaveAttribute("data-thread-id", pinned[1]!);
    });

    await scenario("archiving a pinned one ends its pin; Undo brings it back pinned", async () => {
      await openRow(page, 1);
      await focusList(page);
      await page.keyboard.press("e");
      await expect(rowOf(page, pinned[1]!)).toHaveCount(0);
      await expect(page.getByTestId("inbox-pinned-label")).toBeVisible();
      await page.keyboard.press("z");
      await expect(rows(page).nth(1)).toHaveAttribute("data-thread-id", pinned[1]!);
      await expect(page.getByTestId("inbox-top-end")).toBeVisible();
    });

    await scenario("with a due reminder too: Pinned, then Reminders, then the mail", async () => {
      const id = await idAt(page, 6);
      const dev = { clientId: "setup", origin: "dev" as const };
      await server.backend.server.invoke("reminders.set", { threadIds: [Number(id)], dueAt: E2E_NOW, kind: "always" }, dev);
      await expect(rows(page).nth(2)).toHaveAttribute("data-thread-id", id);
      const pinnedLabel = await page.getByTestId("inbox-pinned-label").boundingBox();
      const remindersLabel = await page.getByTestId("inbox-reminders-label").boundingBox();
      const third = await rows(page).nth(2).boundingBox();
      expect(pinnedLabel!.y).toBeLessThan(remindersLabel!.y);
      expect(remindersLabel!.y + remindersLabel!.height).toBeLessThanOrEqual(third!.y + 1);
      // the headings share an edge
      expect(Math.abs(pinnedLabel!.x - remindersLabel!.x)).toBeLessThan(1);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/pinned-reminders-light.png` });
      await server.backend.server.invoke("reminders.clear", { threadIds: [Number(id)] }, dev);
      await expect(page.getByTestId("inbox-reminders-label")).toHaveCount(0);
    });

    await scenario("a pinned conversation in a search shows a quiet pin among its marks", async () => {
      const subject = (await rowOf(page, pinned[0]!).getByTestId("row-subject").textContent())!.trim();
      const box = await searchBox(page);
      await box.fill(`"${subject}"`);
      await expect(rowOf(page, pinned[0]!).getByTestId("row-pin")).toBeVisible();
      await expect(page.getByTestId("inbox-pinned-label")).toHaveCount(0);
      await box.fill("");
      await fresh(page);
      await expect(page.getByTestId("inbox-pinned-label")).toBeVisible();
    });
  });
});
