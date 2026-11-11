/**
 * Plan 179: pinned conversations. P, the row menu or the reader's Pin button
 * pins one to the Inbox's top, under "Pinned (N)" above the due reminders and
 * the rest of the Inbox under its own name and count; putting it away (archive)
 * ends the pin and its Undo brings it back. Only Inboxes show pins, each
 * account's its own; no row draws a pin.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { E2E_NOW } from "./constants";
import { expect, focusList, fresh, navTo, openRow, rows, scenario, searchBox, test } from "./fixtures";

const snackWith = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });
const rowOf = (page: Page, id: string | number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
const idAt = async (page: Page, i: number) => (await rows(page).nth(i).getAttribute("data-thread-id"))!;
const wcag = (page: Page, root: string) => new AxeBuilder({ page }).setLegacyMode().include(root).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
/** PINS_SHOTS=<dir>: pictures of the section for a person to look at, one folder per style (no baselines) */
const shotsDir = () => process.env.PINS_SHOTS && `${process.env.PINS_SHOTS}/${test.info().project.name}`;

test.describe("pinned conversations", () => {
  test("pin to the top, unpin, archive and Undo, only in Inboxes", { tag: "@design" }, async ({ app: page, server }) => {
    const SHOTS = shotsDir();
    const pinned: string[] = [];
    await scenario("P pins the open conversation: it leads the Inbox under Pinned (1), the Inbox (N) after it, the selection on it", async () => {
      const id = await openRow(page, 3);
      await focusList(page);
      await page.keyboard.press("p");
      await expect(snackWith(page, "Pinned to the top")).toBeVisible();
      await expect(rows(page).first()).toHaveAttribute("data-thread-id", id);
      await expect(page.getByTestId("inbox-pinned-label")).toHaveText("Pinned(1)");
      // the rest under the Inbox's name and how many it holds, the pinned one among them
      const total = (await server.backend.server.invoke("threads.scopeCount", { scope: { kind: "view", view: "inbox" } }, { clientId: "setup", origin: "dev" })).count;
      await expect(page.getByTestId("inbox-rest-label")).toHaveText(`Inbox(${total})`);
      const restLabel = await page.getByTestId("inbox-rest-label").boundingBox();
      const second = await rows(page).nth(1).boundingBox();
      expect(restLabel!.y + restLabel!.height).toBeLessThanOrEqual(second!.y + 1);
      await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
      // no row draws a pin; a screen reader hears it
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

    await scenario("from the row menu: Pin to top at the top level, right after Star; the newest pin leads, Pinned (2)", async () => {
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
      await expect(page.getByTestId("inbox-pinned-label")).toHaveText("Pinned(2)");
      // on a pinned one: Unpin, the pin filled in Star's yellow
      await rowOf(page, id).click({ button: "right" });
      await expect(page.getByTestId("menu-unpin")).toBeVisible();
      await expect(page.getByTestId("menu-pin")).toHaveCount(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/row-menu-pinned-light.png` });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("menu-unpin")).toHaveCount(0);
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
      await expect(page.getByTestId("inbox-rest-label")).toBeVisible();
    });

    await scenario("with a due reminder too: Pinned, then Reminders, then the mail", async () => {
      const id = await idAt(page, 6);
      const dev = { clientId: "setup", origin: "dev" as const };
      await server.backend.server.invoke("reminders.set", { threadIds: [Number(id)], dueAt: E2E_NOW, kind: "always" }, dev);
      await expect(rows(page).nth(2)).toHaveAttribute("data-thread-id", id);
      await expect(page.getByTestId("inbox-reminders-label")).toHaveText("Reminders(1)");
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

    await scenario("a search shows a pinned conversation as any other: no section, no pin", async () => {
      const subject = (await rowOf(page, pinned[0]!).getByTestId("row-subject").textContent())!.trim();
      const box = await searchBox(page);
      await box.fill(`"${subject}"`);
      await expect(rowOf(page, pinned[0]!)).toBeVisible();
      await expect(rowOf(page, pinned[0]!).getByTestId("row-pin")).toHaveCount(0);
      await expect(page.getByTestId("inbox-pinned-label")).toHaveCount(0);
      await box.fill("");
      await fresh(page);
      await expect(page.getByTestId("inbox-pinned-label")).toBeVisible();
    });

    await scenario("one account's Inbox shows its own pins under its name; another's shows none; a category shows none", async () => {
      const dev = { clientId: "setup", origin: "dev" as const };
      const pins = (await server.backend.server.invoke("pins.threads", {}, dev)).items;
      // each account's id and name as the sidebar lists it (its unread count after the name)
      const accounts = await page.locator("[data-testid^=nav-account-]").evaluateAll((els) =>
        els.flatMap((el) => {
          const id = Number(el.getAttribute("data-testid")!.slice("nav-account-".length));
          return Number.isFinite(id) ? [{ id, displayName: (el as HTMLElement).innerText.replace(/[\d,.]+\s*$/, "").trim() }] : [];
        }),
      );
      const own = accounts.find((a) => a.id === pins[0]!.accountId)!;
      const ownPins = pins.filter((t) => t.accountId === own.id);
      await page.getByTestId(`nav-account-${own.id}`).click();
      await expect(rows(page).first()).toHaveAttribute("data-thread-id", String(ownPins[0]!.id));
      await expect(page.getByTestId("inbox-pinned-label")).toHaveText(`Pinned(${ownPins.length})`);
      const total = (await server.backend.server.invoke("threads.scopeCount", { scope: { kind: "view", view: "inbox", accountId: own.id } }, dev)).count;
      await expect(page.getByTestId("inbox-rest-label")).toHaveText(`${own.displayName}(${total})`);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/pinned-account-light.png` });
      const other = accounts.find((a) => !pins.some((t) => t.accountId === a.id));
      if (other) {
        await page.getByTestId(`nav-account-${other.id}`).click();
        await expect(page.getByTestId("list-title")).toContainText(other.displayName);
        await expect(rows(page).first()).toBeVisible();
        await expect(page.getByTestId("inbox-pinned-label")).toHaveCount(0);
        await expect(page.getByTestId("inbox-rest-label")).toHaveCount(0);
        for (const t of pins) await expect(rowOf(page, t.id)).toHaveCount(0);
      }
      // a category the pinned one is filed in lists it by its date, under no heading
      const filed = pins.find((t) => t.categoryIds.length > 0);
      if (filed) {
        await page.getByTestId(`nav-category-${filed.categoryIds[0]}`).click();
        await expect(rowOf(page, filed.id)).toBeVisible();
        await expect(page.getByTestId("inbox-pinned-label")).toHaveCount(0);
        await expect(page.getByTestId("inbox-rest-label")).toHaveCount(0);
      }
      await navTo(page, "inbox");
      await expect(page.getByTestId("inbox-pinned-label")).toBeVisible();
    });
  });
});
