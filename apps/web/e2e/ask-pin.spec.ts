/**
 * Plan 165, on the offline fake model and the demo's server: coming back to an answer where it was left (its scroll, the
 * sources read marked, a follow-up half typed), and the answer pinned to the reading pane's corner (a source opens with
 * the card still there; collapse, Esc, unpin, close; with a pinned draft beside it or above it). Axe: design-axe.spec.
 */
import type { Locator, Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import { E2E_NOW } from "./constants";
import { expect, fresh, focusList, ingestConversation, rows, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const card = (page: Page) => page.getByTestId("pinned-ask");
const draftCard = (page: Page) => page.getByTestId("pinned-draft");
const WORD = "Quokka";

async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  await server.backend.server.invoke("settings.update", patch, dev);
  await fresh(page);
}

/** an answer, with its sources, from mail no other mail matches */
async function answered(page: Page, server: DevServerFixture, patch: SettingsPatch = {}) {
  await ingestConversation(server, { subject: `${WORD} policy`, count: 3, now: E2E_NOW });
  await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, ...patch });
  await focusList(page);
  await page.keyboard.press("ControlOrMeta+Shift+k");
  await page.getByTestId("palette-input").fill(`what about ${WORD}?`);
  await page.getByTestId("ask-submit").waitFor();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("ask-turn").last()).toHaveAttribute("data-status", "answered");
}

/** Focus is somewhere in `where`. */
const focusIn = (page: Page, testId: string) => page.evaluate((id) => document.activeElement?.closest(`[data-testid=${id}]`) !== null, testId);

/** Reply to row `index`, pinned (plan 115). */
async function pinReply(page: Page, index: number) {
  await rows(page).nth(index).click();
  await focusList(page);
  await page.keyboard.press("r");
  await expect(page.getByTestId("reader").getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Thanks, I'll look.");
  await page.getByTestId("reader").getByTestId("compose-pin").click();
  await expect(draftCard(page)).toBeVisible();
}

const box = async (l: Locator) => (await l.boundingBox())!;

test.describe("back to the answer, and the answer pinned (plan 165)", () => {
  test("Split: the way back keeps the place; pinned, a source opens beside the card; with a draft at 1100x700 it goes above it", async ({ app: page, server }) => {
    await page.setViewportSize({ width: 1100, height: 560 });
    await answered(page, server);

    await scenario("back from a source opened in the reader: the same scroll, the row chosen, the follow-up typed, the source read", async () => {
      // a second turn, so the answer's region scrolls in a short window
      await page.getByTestId("ask-follow-up").fill(`and ${WORD} again?`);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("ask-turn")).toHaveCount(2);
      await expect(page.getByTestId("ask-turn").last()).toHaveAttribute("data-status", "answered");
      const area = page.getByTestId("ask-area");
      expect(await area.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await area.evaluate((el) => (el.scrollTop = 7));
      await page.getByTestId("ask-follow-up").fill("half a thought");
      await page.getByTestId("ask-follow-up").press("ArrowDown");
      const chosen = await page.locator("[data-testid=ask-source][data-selected=true]").getAttribute("data-value");
      expect(chosen).toBeTruthy();
      await page.getByTestId("ask-source").first().click();
      await page.getByTestId("ask-peek-open").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("back-to-answer")).toBeVisible();
      await page.getByTestId("back-to-answer").click();
      await expect(page.getByRole("dialog", { name: "Ask your mail" })).toBeVisible();
      await expect.poll(() => area.evaluate((el) => el.scrollTop)).toBe(7);
      await expect(page.getByTestId("ask-follow-up")).toHaveValue("half a thought");
      await expect(page.locator("[data-testid=ask-source][data-selected=true]")).toHaveAttribute("data-value", chosen!);
      // read: a quiet check on its row, said to screen readers, and its citation's name says so too
      const read = page.getByTestId("ask-source").first();
      await expect(read.getByTestId("ask-source-visited")).toBeVisible();
      await expect(read).toContainText("Opened");
      await expect(page.locator("[data-testid=ask-citation][data-visited]").first()).toHaveAccessibleName(/, opened$/);
      await page.getByTestId("ask-follow-up").fill("");
    });

    await scenario("pinned: the card holds the answer and its sources; a source opens in the reader and the card stays, with focus", async () => {
      await page.setViewportSize({ width: 1100, height: 700 });
      const question = (await page.getByTestId("ask-title").textContent())!;
      await page.getByTestId("ask-pin").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(card(page)).toBeVisible();
      await expect(card(page)).toHaveAccessibleName(`Pinned answer: ${question}`);
      await expect(page.getByTestId("pinned-ask-title")).toContainText(question);
      await expect(page.getByTestId("pinned-ask-body")).toBeFocused();
      // the corner of the reading pane, 12 px in
      const reader = await box(page.locator("main"));
      const pinned = await box(card(page));
      expect(Math.round(reader.x + reader.width - (pinned.x + pinned.width))).toBe(12);
      expect(Math.round(reader.y + reader.height - (pinned.y + pinned.height))).toBe(12);
      // another conversation first: the source's opens over it
      await rows(page).nth(2).click();
      const source = page.getByTestId("pinned-ask-source").first();
      await source.click();
      await expect(page.getByTestId("reader-subject")).toContainText(`${WORD} policy`);
      await expect(card(page)).toBeVisible();
      await expect(source).toHaveAttribute("data-visited", "true");
      expect(await focusIn(page, "pinned-ask")).toBe(true);
      // the card is the way back: the reader offers none of its own
      await expect(page.getByTestId("back-to-answer")).toHaveCount(0);
      await rows(page).nth(2).click();
      await page.getByTestId("pinned-ask").getByTestId("ask-citation").first().click();
      await expect(page.getByTestId("reader-subject")).toContainText(`${WORD} policy`);
      expect(await focusIn(page, "pinned-ask")).toBe(true);
      // the reader's end scrolls clear of it
      await page.locator("[data-reader-scroller]").evaluate((el) => (el.scrollTop = el.scrollHeight));
      const slot = await box(page.getByTestId("reader").getByTestId("draft-slot"));
      expect(slot.y + slot.height).toBeLessThanOrEqual((await box(card(page))).y);
    });

    await scenario("it survives other conversations; collapse folds it to its header; Esc leaves it pinned and gives the keys back", async () => {
      await rows(page).nth(3).click();
      await expect(card(page)).toBeVisible();
      const toggle = page.getByTestId("pinned-ask-toggle");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await toggle.click();
      await expect(card(page)).toHaveAttribute("data-collapsed", "true");
      await expect(page.getByTestId("pinned-ask-body")).toHaveCount(0);
      expect(Math.round((await box(card(page))).height)).toBe(40);
      await expect(toggle).toBeFocused();
      await toggle.click();
      await expect(page.getByTestId("pinned-ask-body")).toBeVisible();
      await page.getByTestId("pinned-ask-body").focus();
      await page.keyboard.press("Escape");
      await expect(card(page)).toBeVisible();
      expect(await focusIn(page, "pinned-ask")).toBe(false);
      // Esc was the card's: the conversation is still open
      await expect(page.getByTestId("reader-subject")).toBeVisible();
    });

    await scenario("with a pinned draft at 1100x700: the draft keeps the corner, the card goes above it, never over it", async () => {
      await pinReply(page, 1);
      await expect(card(page)).toHaveAttribute("data-where", "above");
      const d = await box(draftCard(page));
      const c = await box(card(page));
      expect(c.y + c.height).toBeLessThanOrEqual(d.y - 11);
      expect(Math.round(c.x + c.width)).toBe(Math.round(d.x + d.width));
      // a short window under a tall draft: no room to open above it, its header alone, and Expand says why
      await draftCard(page).getByTestId("compose-body").click();
      await page.keyboard.type(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
      await page.setViewportSize({ width: 1100, height: 560 });
      await expect(card(page)).toHaveAttribute("data-collapsed", "true");
      const s = await box(card(page));
      expect(s.y + s.height).toBeLessThanOrEqual((await box(draftCard(page))).y - 11);
      await expect(page.getByTestId("pinned-ask-toggle")).toHaveAttribute("aria-disabled", "true");
      await page.setViewportSize({ width: 1100, height: 700 });
      await expect(card(page)).not.toHaveAttribute("data-collapsed", "true");
    });

    await scenario("unpin brings the same answer back into Ask; pinned again, close takes it away", async () => {
      const question = (await page.getByTestId("pinned-ask-title").textContent())!.replace(/^Pinned answer: /, "");
      await page.getByTestId("pinned-ask-unpin").click();
      await expect(card(page)).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "Ask your mail" })).toBeVisible();
      await expect(page.getByTestId("ask-title")).toHaveText(question);
      await page.getByTestId("ask-pin").click();
      await expect(card(page)).toBeVisible();
      await page.getByTestId("pinned-ask-close").click();
      await expect(card(page)).toHaveCount(0);
      // the scroll ends lose its room
      await expect.poll(() => page.locator("[data-reader-scroller]").evaluate((el) => getComputedStyle(el).paddingBottom)).not.toBe("0px");
    });
  });

  test("List: at 1440 the card sits to the pinned draft's left; a source opened from the list's page keeps focus on the card", async ({ app: page, server }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await answered(page, server, { layout: "list" });
    await page.getByTestId("ask-pin").click();
    await expect(card(page)).toBeVisible();
    await expect(page.getByTestId("pinned-ask-body")).toBeFocused();
    // the first source opened from the list: List's page opens, and doesn't take the keys from the card
    await page.getByTestId("pinned-ask-source").first().click();
    await expect(page.getByTestId("list-page")).toBeVisible();
    await expect(card(page)).toBeVisible();
    // the page's own focus waits a frame after it opens
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await focusIn(page, "pinned-ask")).toBe(true);
    await page.keyboard.press("Escape");
    // a draft pinned: the corner is the draft's, the card to its left with the gap between
    await page.keyboard.press("Escape");
    await pinReply(page, 1);
    await expect(card(page)).toHaveAttribute("data-where", "beside");
    const d = await box(draftCard(page));
    const c = await box(card(page));
    expect(c.x + c.width).toBeLessThanOrEqual(d.x - 11);
    expect(Math.round(c.y + c.height)).toBe(Math.round(d.y + d.height));
  });
});
