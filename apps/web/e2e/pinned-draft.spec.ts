/**
 * Plan 115: a draft pinned at the reading area's bottom right stays there
 * while other conversations are read; the reader's end scrolls clear of it;
 * unpinning puts it back where it lives (inline on its conversation, or saved
 * away with a snack to open it).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, focusList, openRow, rows, test, fresh, scenario } from "./fixtures";

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

/** Plan 130: a tall pinned card over the foot of a short window: the new message's own foot stays reachable, above it. */
async function newMessageUnderTallPin(page: Page, opener: () => Promise<unknown>): Promise<void> {
  await page.setViewportSize({ width: 980, height: 600 });
  await rows(page).nth(1).click();
  await focusList(page);
  await page.keyboard.press("r");
  await expect(page.getByTestId("reader").getByTestId("compose-body")).toBeFocused();
  await page.getByTestId("reader").getByTestId("compose-pin").click();
  await expect(cardBody(page)).toBeFocused();
  await page.keyboard.type(Array.from({ length: 30 }, (_, i) => `línea ${i}`).join("\n"));
  await page.keyboard.press("Escape");
  await opener();
  await focusList(page);
  await page.keyboard.press("c");
  const composer = page.locator("[data-testid=composer][data-mode=new]");
  await expect(composer.getByTestId("compose-to")).toBeFocused();
  const send = composer.getByTestId("compose-send"), collapse = composer.getByTestId("compose-collapse");
  await collapse.scrollIntoViewIfNeeded();
  const pinned = (await card(page).boundingBox())!;
  for (const control of [send, collapse]) {
    const b = (await control.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(pinned.y);
  }
  await collapse.click();
  await expect(composer).toHaveCount(0);
  await expect(card(page)).toBeVisible();
}

test.describe("a pinned draft", () => {
  test("pinned reply: stays while reading, unpinned here or elsewhere, discarded with undo, a new one's own form, axe", async ({ app: page }) => {
    await scenario("stays while other conversations are read; its own shows it pinned; r there goes to the card", async () => {
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
    await scenario("unpinned on its conversation, it drops back inline, open, focused, with its text", async () => {
      await fresh(page);
      await pinReply(page, 1, "Back where it was");
      // pinned reads without a hover: its pin is pressed (plan 158)
      await expect(card(page).getByTestId("compose-unpin")).toHaveAttribute("aria-pressed", "true");
      await card(page).getByTestId("compose-unpin").click();
      await expect(card(page)).toHaveCount(0);
      const inline = page.getByTestId("reader").getByTestId("compose-body");
      await expect(inline).toBeFocused();
      await expect(inline).toContainText("Back where it was");
    });
    await scenario("unpinned elsewhere, written work is saved into its conversation and the snack opens it", async () => {
      await fresh(page);
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
    await scenario("discard from the card; undo pins it back", async () => {
      await fresh(page);
      await pinReply(page, 1, "Not lost");
      await card(page).getByTestId("compose-discard").click();
      await expect(card(page)).toHaveCount(0);
      await toast(page, "Draft discarded").getByRole("button", { name: "Undo discard draft" }).click();
      await expect(card(page)).toBeVisible();
      await expect(cardBody(page)).toContainText("Not lost");
    });
    await scenario("another draft pinned starts with its own form, not the last one's (Codex code review 1)", async () => {
      await fresh(page);
      await pinReply(page, 1, "First");
      // the first draft's Cc row, revealed in the card
      await card(page).getByTestId("compose-show-cc").click();
      await expect(card(page).getByTestId("compose-cc")).toBeVisible();
      await pinReply(page, 2, "Second");
      await expect(cardBody(page)).toContainText("Second");
      await expect(card(page).getByTestId("compose-cc")).toHaveCount(0);
      await expect(card(page).getByTestId("compose-show-cc")).toBeVisible();
    });
    await scenario("the card is axe-clean in light and dark", async () => {
      await fresh(page);
      await pinReply(page, 1, "Accessible");
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const results = await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=pinned-draft]").analyze();
        expect(results.violations).toEqual([]);
      }
    });
  });

  test("plan 130: a new message's foot clears a tall pinned card, in a short window", async ({ app: page }) => {
    await newMessageUnderTallPin(page, async () => {});
  });

  test("a new message pinned and from the palette; a tall card in a short window", async ({ app: page }) => {
    await scenario("a new message pinned stays while conversations are opened, and sends from the card", async () => {
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
    await scenario("Pin draft and Unpin draft from the palette", async () => {
      await fresh(page);
      await openRow(page, 1);
      await focusList(page);
      await page.keyboard.press("r");
      await expect(page.getByTestId("reader").getByTestId("compose-body")).toBeFocused();
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
  });

});

test.describe("a pinned draft in the List layout", () => {
  test.use({ layout: "list" });

  test("plan 130: a new message's foot clears a tall pinned card, in a short window", async ({ app: page }) => {
    await newMessageUnderTallPin(page, () => page.getByTestId("reader").getByRole("button", { name: /back/i }).first().click());
  });

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

  test("plan 158: a conversation opened under the card moves the dock onto its column: a snack there stands clear of the card", async ({ app: page }) => {
    await rows(page).nth(1).click();
    await focusList(page);
    await page.keyboard.press("r");
    await page.keyboard.type("Beside the dock");
    await page.getByTestId("reader").getByTestId("compose-pin").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("reader").getByRole("button", { name: /back/i }).first().click();
    await expect(card(page)).toBeVisible();
    await rows(page).nth(0).click();
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await focusList(page);
    await page.keyboard.press("l");
    await page.locator("[data-testid^=pick-category-]").first().click();
    const snack = page.getByTestId("snack");
    await expect(snack).toBeVisible();
    await page.mouse.move(0, 0);
    await expect.poll(async () => {
      const [a, b] = [(await snack.boundingBox())!, (await card(page).boundingBox())!];
      const apart = a.x + a.width <= b.x || b.y + b.height <= a.y;
      return apart;
    }).toBe(true);
  });

  test("plan 158: in a narrow window the card stands on the dock and on the drafts strip under it (Codex review)", async ({ app: page }) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    // a draft parked in the strip
    await focusList(page);
    await page.keyboard.press("c");
    await page.getByTestId("compose-subject").fill("Parked in the strip");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("drafts-strip")).toBeVisible();
    await page.getByTestId("reader").getByRole("button", { name: /back/i }).first().click().catch(() => {});
    // a reply pinned, back on the list
    await rows(page).nth(1).click();
    await focusList(page);
    await page.keyboard.press("r");
    await page.keyboard.type("Pinned over the strip");
    await page.getByTestId("reader").getByTestId("compose-pin").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("reader").getByRole("button", { name: /back/i }).first().click();
    await expect(page.getByTestId("drafts-strip")).toBeVisible();
    // a snack over the list
    await rows(page).nth(3).dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("e");
    const snack = page.getByTestId("snack");
    await expect(snack).toContainText("Archived");
    await page.mouse.move(0, 0);
    await expect.poll(async () => {
      const [a, b] = [(await snack.boundingBox())!, (await card(page).boundingBox())!];
      return a.x + a.width <= b.x || b.y + b.height <= a.y;
    }).toBe(true);
  });

  test("Esc in the card over a new message goes to that message, not the hidden list (Codex code review 3)", async ({ app: page }) => {
    await rows(page).nth(1).click();
    await focusList(page);
    await page.keyboard.press("r");
    await page.keyboard.type("Pinned first");
    await page.getByTestId("reader").getByTestId("compose-pin").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("reader").getByRole("button", { name: /back/i }).first().click();
    await focusList(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("list-page")).toHaveAttribute("data-page", "compose");
    await cardBody(page).click();
    await page.keyboard.press("Escape");
    await expect(cardBody(page)).not.toBeFocused();
    await expect(page.getByTestId("list-page").getByTestId("compose-to")).toBeFocused();
  });
});

test("plan 158: another draft pinned, a long reply keeps Send and the line being typed above the card", async ({ app: page }) => {
  await openRow(page, 0);
  await focusList(page);
  await page.keyboard.press("r");
  await page.getByTestId("compose-body").pressSequentially("Fijado");
  await page.getByTestId("compose-pin").click();
  await openRow(page, 1);
  await focusList(page);
  await page.keyboard.press("r");
  const body = page.getByTestId("reader").getByTestId("compose-body");
  await expect(body).toBeFocused();
  for (let i = 0; i < 40; i++) { await page.keyboard.type(`línea ${i}`); await page.keyboard.press("Enter"); }
  const card = (await page.getByTestId("pinned-draft").boundingBox())!;
  const foot = (await page.getByTestId("reader").locator("[data-draft-foot]").boundingBox())!;
  const caret = await page.evaluate(() => { const node = getSelection()!.anchorNode!; return (node.nodeType === 1 ? node as Element : node.parentElement!).getBoundingClientRect().bottom; });
  expect(foot.y + foot.height).toBeLessThanOrEqual(card.y);
  expect(caret).toBeLessThanOrEqual(foot.y);
});
