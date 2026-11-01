/**
 * Plan 115: a draft pinned at the reading area's bottom right stays there
 * while other conversations are read; the reader's end scrolls clear of it;
 * unpinning puts it back where it lives (inline on its conversation, or saved
 * away with a snack to open it).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, focusList, openRow, rows, test } from "./fixtures";

const card = (page: Page) => page.getByTestId("pinned-draft");
const cardBody = (page: Page) => card(page).getByTestId("compose-body");
const toast = (page: Page, text: string) => page.locator("[data-testid=snack]").filter({ hasText: text });

/** Opens a reply on row `index`, types `text`, pins it. */
async function pinReply(page: Page, index: number, text: string): Promise<string> {
  const id = await openRow(page, index);
  await focusList(page);
  await page.keyboard.press("r");
  const body = page.getByTestId("reader").getByTestId("compose-body");
  await expect(body).toBeFocused();
  await page.keyboard.type(text);
  await page.getByTestId("reader").getByTestId("compose-pin").click();
  await expect(card(page)).toBeVisible();
  await expect(cardBody(page)).toBeFocused();
  return id;
}

/** The reader scrolled to its end: the conversation's foot (the reply bar) is above the card. */
async function footClearsCard(page: Page): Promise<void> {
  await page.locator("[data-reader-scroller]").evaluate((el) => (el.scrollTop = el.scrollHeight));
  const slot = await page.getByTestId("reader").getByTestId("draft-slot").boundingBox();
  const pinned = await card(page).boundingBox();
  expect(slot && pinned).toBeTruthy();
  expect(slot!.y + slot!.height).toBeLessThanOrEqual(pinned!.y);
}

test.describe("a pinned draft", { tag: "@design" }, () => {
  test("stays while other conversations are read; its own shows it pinned; r there goes to the card", async ({ app: page }) => {
    const first = await pinReply(page, 1, "Pinned while I look something up");
    // its conversation keeps a quiet line in its place, no second editor
    await expect(page.getByTestId("reader").getByTestId("draft-pinned")).toBeVisible();
    await expect(page.getByTestId("reader").getByTestId("composer")).toHaveCount(0);
    // Esc leaves the card, which stays; j reads on
    await page.keyboard.press("Escape");
    await expect(cardBody(page)).not.toBeFocused();
    await page.keyboard.press("j");
    await expect(page.locator("[data-testid=thread-row][data-cursor]")).not.toHaveAttribute("data-thread-id", first);
    await expect(card(page)).toBeVisible();
    await expect(cardBody(page)).toContainText("Pinned while I look something up");
    // a long conversation: its end scrolls clear of the card
    await openRow(page, 0);
    await expect(card(page)).toBeVisible();
    await footClearsCard(page);
    // the strip doesn't list it (it's on screen)
    await expect(page.locator(`[data-testid=strip-item][data-key="${await card(page).getAttribute("data-draft-key")}"]`)).toHaveCount(0);
    // back on its conversation, r goes to the card instead of opening another reply
    await openRow(page, 1);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(cardBody(page)).toBeFocused();
    await expect(page.getByTestId("reader").getByTestId("composer")).toHaveCount(0);
  });

  test("unpinned on its conversation, it drops back inline, open, focused, with its text", async ({ app: page }) => {
    await pinReply(page, 1, "Back where it was");
    await card(page).getByTestId("compose-unpin").click();
    await expect(card(page)).toHaveCount(0);
    const inline = page.getByTestId("reader").getByTestId("compose-body");
    await expect(inline).toBeFocused();
    await expect(inline).toContainText("Back where it was");
  });

  test("unpinned elsewhere, written work is saved into its conversation and the snack opens it", async ({ app: page }) => {
    const id = await pinReply(page, 1, "Saved away");
    await openRow(page, 2);
    await card(page).getByTestId("compose-unpin").click();
    await expect(card(page)).toHaveCount(0);
    await expect(toast(page, "Draft saved")).toBeVisible();
    await toast(page, "Draft saved").getByRole("button", { name: "Open saved draft" }).click();
    await expect(page.locator("[data-testid=thread-row][data-cursor]")).toHaveAttribute("data-thread-id", id);
    const inline = page.getByTestId("reader").getByTestId("compose-body");
    await expect(inline).toContainText("Saved away");
  });

  test("a new message pinned stays while conversations are opened, and sends from the card", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "new");
    await page.getByTestId("compose-to").fill("ana@example.com");
    await page.getByTestId("compose-to").press("Enter");
    await page.getByTestId("compose-pin").click();
    await expect(card(page)).toBeVisible();
    await openRow(page, 0);
    await openRow(page, 2);
    await expect(card(page)).toBeVisible();
    await cardBody(page).click();
    await page.keyboard.type("Sent from the corner");
    await page.keyboard.press("Meta+Enter");
    await expect(card(page)).toHaveCount(0);
    await expect(toast(page, "Message sent")).toBeVisible();
  });

  test("discard from the card; undo pins it back", async ({ app: page }) => {
    await pinReply(page, 1, "Not lost");
    await card(page).getByTestId("compose-discard").click();
    await expect(card(page)).toHaveCount(0);
    await toast(page, "Draft discarded").getByRole("button", { name: "Undo discard draft" }).click();
    await expect(card(page)).toBeVisible();
    await expect(cardBody(page)).toContainText("Not lost");
  });

  test("Pin draft and Unpin draft from the palette", async ({ app: page }) => {
    await openRow(page, 1);
    await focusList(page);
    await page.keyboard.press("r");
    await page.keyboard.type("Via the palette");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-draft-pin").click();
    await expect(card(page)).toBeVisible();
    await expect(cardBody(page)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("palette-draft-pin")).toHaveCount(0);
    await page.getByTestId("palette-draft-unpin").click();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByTestId("reader").getByTestId("compose-body")).toContainText("Via the palette");
  });

  test("the card is axe-clean in light and dark", async ({ app: page }) => {
    await pinReply(page, 1, "Accessible");
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const results = await new AxeBuilder({ page }).include("[data-testid=pinned-draft]").analyze();
      expect(results.violations).toEqual([]);
    }
  });
});

test.describe("a pinned draft in the List layout", () => {
  test.use({ layout: "list" });

  test("stays over the list and the conversations opened from it; their end scrolls clear of it", async ({ app: page }) => {
    await rows(page).nth(1).click();
    await focusList(page);
    await page.keyboard.press("r");
    await page.keyboard.type("From the list layout");
    await page.getByTestId("reader").getByTestId("compose-pin").click();
    await expect(card(page)).toBeVisible();
    await page.keyboard.press("Escape");
    // back to the list: the card stays
    await page.getByTestId("reader").getByRole("button", { name: /back/i }).first().click();
    await expect(card(page)).toBeVisible();
    await rows(page).nth(0).click();
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await footClearsCard(page);
    await expect(cardBody(page)).toContainText("From the list layout");
  });
});
