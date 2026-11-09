/**
 * Plan 165, on the offline fake model and the demo's server: coming back to an answer where it was left (its scroll, the
 * sources read marked, a follow-up half typed), and the answer pinned to the reading pane's corner (a source opens with
 * the card still there; collapse, Esc, unpin, close; with a pinned draft, always to its left). Axe: design-axe.spec.
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

/** Reply to row `index`, pinned (plan 115); `text` a note for AI shows Generate's word in its foot. */
async function pinReply(page: Page, index: number, text = "Thanks, I'll look.") {
  await rows(page).nth(index).click();
  await focusList(page);
  await page.keyboard.press("r");
  await expect(page.getByTestId("reader").getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type(text);
  await page.getByTestId("reader").getByTestId("compose-pin").click();
  await expect(draftCard(page)).toBeVisible();
}

const box = async (l: Locator) => (await l.boundingBox())!;

/**
 * The owner: with a draft pinned the card is always to its left, never above it: feet on one line, never over the draft,
 * inside the window and (`sidebar`: unless the window leaves no other room) off the sidebar, above what it reaches over.
 * The draft is a little narrower beside it, its foot still one line with Generate's word.
 */
async function besideDraft(page: Page, { sidebar = true, word = false } = {}) {
  await expect(card(page)).toHaveAttribute("data-where", "beside");
  await expect.poll(async () => { const d = await box(draftCard(page)); const c = await box(card(page)); return Math.round(c.y + c.height) - Math.round(d.y + d.height); }).toBe(0);
  const d = await box(draftCard(page));
  const c = await box(card(page));
  expect(c.x + c.width).toBeLessThanOrEqual(d.x - 11);
  expect(c.x).toBeGreaterThanOrEqual(11);
  expect(c.y).toBeGreaterThanOrEqual(0);
  if (sidebar) expect(c.x).toBeGreaterThanOrEqual((await box(page.locator("#app-list"))).x + 11);
  // on top of whatever it reaches over (the list, its pane edge)
  const atLeft = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("[data-testid=pinned-ask]") !== null, [c.x + 6, c.y + c.height - 6]);
  expect(atLeft).toBe(true);
  // 28.5 rem where the pane holds it; the foot on one line, every control inside the card
  const pane = await box(draftCard(page).locator(".."));
  expect(Math.round(d.width)).toBe(Math.min(456, Math.round(pane.width) - 24));
  const mid = async (id: string) => { const b = await box(draftCard(page).getByTestId(id)); return b.y + b.height / 2; };
  for (const id of ["compose-ai", "compose-discard"]) expect(Math.abs((await mid("compose-send")) - (await mid(id)))).toBeLessThanOrEqual(4);
  const discard = await box(draftCard(page).getByTestId("compose-discard"));
  expect(discard.x + discard.width).toBeLessThanOrEqual(d.x + d.width - 8);
  if (word) await expect(draftCard(page).getByTestId("compose-ai-word")).toBeVisible();
  return { card: c, draft: d };
}

test.describe("back to the answer, and the answer pinned (plan 165)", () => {
  test("Split: the way back keeps the place; pinned, a source opens beside the card; with a draft always to its left", async ({ app: page, server }) => {
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
      await expect(card(page).getByRole("region", { name: "Answer" })).toBeFocused();
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
      // folded from the answer by a click that doesn't move focus (Safari's): the header keeps it (Codex code review)
      await page.getByTestId("pinned-ask-body").focus();
      await toggle.evaluate((el: HTMLElement) => el.click());
      await expect(toggle).toBeFocused();
      await toggle.click();
      await page.getByTestId("pinned-ask-body").focus();
      await page.keyboard.press("Escape");
      await expect(card(page)).toBeVisible();
      expect(await focusIn(page, "pinned-ask")).toBe(false);
      // Esc was the card's: the conversation is still open
      await expect(page.getByTestId("reader-subject")).toBeVisible();
    });

    await scenario("with a pinned draft: always to its left, over the list where the reading pane can't hold both (1100x700, 1440x900, 1880x1040)", async () => {
      await pinReply(page, 1);
      // 1100x700: a ~530 px reading pane; the card keeps its 20 rem and reaches over the thread list
      const narrow = await besideDraft(page);
      const main = await box(page.locator("main"));
      expect(Math.round(narrow.card.width)).toBe(320);
      expect(narrow.card.x).toBeLessThan(main.x);
      // the list's end scrolls clear of it
      const list = page.getByTestId("thread-list").locator("[data-keep-scroll=list]");
      await expect.poll(() => list.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; })).toBeGreaterThan(0);
      await expect.poll(async () => { const last = await box(rows(page).last()); return last.y + last.height <= (await box(card(page))).y; }).toBe(true);
      // a taller draft doesn't lift it off the line
      await draftCard(page).getByTestId("compose-body").click();
      await page.keyboard.type(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
      await besideDraft(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await besideDraft(page);
      // wide: in the reading pane, at its own 24 rem
      await page.setViewportSize({ width: 1880, height: 1040 });
      const wide = await besideDraft(page);
      expect(Math.round(wide.card.width)).toBe(384);
      expect(wide.card.x).toBeGreaterThanOrEqual((await box(page.locator("main"))).x);
      await page.setViewportSize({ width: 1100, height: 900 });
    });

    await scenario("unpin brings the same answer back into Ask; pinned again, close takes it away", async () => {
      const question = (await page.getByTestId("pinned-ask-title").textContent())!.replace(/^Pinned answer: /, "");
      await page.getByTestId("pinned-ask-unpin").click();
      await expect(card(page)).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "Ask your mail" })).toBeVisible();
      await expect(page.getByTestId("ask-title")).toHaveText(question);
      // scrolled to its end, then another answer pinned in its place: that one starts at its top
      await page.getByTestId("ask-pin").click();
      await page.getByTestId("pinned-ask-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.getByTestId("pinned-ask-unpin").click();
      await page.getByTestId("ask-follow-up").fill(`${WORD} once more?`);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("ask-turn").last()).toHaveAttribute("data-status", "answered");
      await page.getByTestId("ask-pin").click();
      await expect(page.getByTestId("pinned-ask-title")).toContainText(`${WORD} once more?`);
      expect(await page.getByTestId("pinned-ask-body").evaluate((el) => el.scrollTop)).toBe(0);
      const beside = (await box(draftCard(page))).width;
      await page.getByTestId("pinned-ask-close").click();
      await expect(card(page)).toHaveCount(0);
      // the draft alone: its own width again
      expect((await box(draftCard(page))).width).toBeGreaterThan(beside + 40);
      // the scroll ends lose its room
      await expect.poll(() => page.locator("[data-reader-scroller]").evaluate((el) => getComputedStyle(el).paddingBottom)).not.toBe("0px");
    });
  });

  test("List: the card sits to the pinned draft's left at 1440 and in a narrow window; a source opened from the list's page keeps focus on the card", async ({ app: page, server }) => {
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
    // a note for AI: Generate shows its word, still on one line in the narrower draft
    await pinReply(page, 1, "fine by me, tell him that");
    await besideDraft(page, { word: true });
    await page.setViewportSize({ width: 1100, height: 700 });
    await besideDraft(page, { word: true });
    // a window narrower than the desktop's least: still beside it, over the sidebar now (nothing else holds it), and
    // never over the toolbar of the page that opened under it (Codex review: the pane didn't change size when List's
    // page came, so the toolbar went unmeasured)
    await page.getByTestId("pinned-draft").getByTestId("compose-body").click();
    await page.keyboard.type(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
    await page.setViewportSize({ width: 900, height: 800 });
    await besideDraft(page, { sidebar: false });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("list-page")).toHaveCount(0);
    await page.getByTestId("pinned-ask-source").first().click();
    await expect(page.getByTestId("list-page")).toBeVisible();
    const scroller = await box(page.getByTestId("list-page").locator("[data-reader-scroller]"));
    await expect.poll(async () => (await box(card(page))).y).toBeGreaterThanOrEqual(scroller.y);
  });
});
