/**
 * Plan 141 in the page, on the offline fake model and the demo's server: nothing here reaches a real provider. ⌘⇧K, a
 * question, a source, a follow-up, the history; older mail on a click; the page's keys; consent; no provider.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import { fakeDraft } from "../../../packages/ai/src/fake";
import { E2E_NOW } from "./constants";
import { expect, fresh, focusList, ingestConversation, scenario, test, type DevServerFixture } from "./fixtures";
import { englishLeaks } from "./i18n-leaks";
import { sqlDb } from "../../backend-dev/src/server";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const ask = (page: Page) => page.getByTestId("palette-input");
const followUp = (page: Page) => page.getByTestId("ask-follow-up");
const lastTurn = (page: Page) => page.getByTestId("ask-turn").last();
const SHOTS = process.env.ASK_SHOTS;

async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  await server.backend.server.invoke("settings.update", patch, dev);
  await fresh(page);
}

/** mail with a word no other mail holds, found by a question asking about it */
const WORD = "Quokka";
async function withMail(page: Page, server: DevServerFixture) {
  await ingestConversation(server, { subject: `${WORD} policy`, count: 3, now: E2E_NOW });
  await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
}

/**
 * How much the citations change the first answer's height: it beside a copy of itself, the same width, its markers plain
 * text (a blank line in an answer has no text to measure, so lines aren't counted).
 */
const lineDrift = (page: Page) =>
  page.getByTestId("ask-answer").first().evaluate((p) => {
    const copy = p.cloneNode(true) as HTMLElement;
    for (const b of copy.querySelectorAll("[data-testid=ask-citation]")) b.replaceWith(document.createTextNode(b.textContent ?? ""));
    Object.assign(copy.style, { position: "absolute", visibility: "hidden", width: `${p.getBoundingClientRect().width}px` });
    p.parentElement!.append(copy);
    const plain = copy.getBoundingClientRect().height;
    copy.remove();
    return Math.abs(p.getBoundingClientRect().height - plain);
  });

async function open(page: Page) {
  await focusList(page);
  await page.keyboard.press("ControlOrMeta+Shift+k");
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function question(page: Page, text: string) {
  await expect(ask(page)).toBeFocused();
  await ask(page).fill(text);
  await page.getByTestId("ask-submit").waitFor();
  await page.keyboard.press("Enter");
}

test.describe("ask your mail (plan 141)", () => {
  test("⌘⇧K: a question, its source, a return, a follow-up, the history, delete and Undo", async ({ app: page, server }) => {
    await withMail(page, server);
    const word = WORD;

    await scenario("asked, it streams to an answer with its source", async () => {
      await open(page);
      await question(page, `what about ${word}?`);
      await expect(lastTurn(page)).toHaveAttribute("data-status", "answered");
      await expect(page.getByTestId("ask-answer").last()).toContainText("Mensaje");
      // plan 161: one phrase on every AI surface; the model and the caution behind it
      await expect(page.getByTestId("ask-provenance")).toHaveText("Written with AI");
      await expect(followUp(page)).toBeFocused();
      await page.getByTestId("ask-provenance").hover();
      await expect(page.getByTestId("ask-provenance-detail")).toContainText(/Written by demo, .+\. It can make mistakes\./);
      // how far back it looked, beside the way past it
      await expect(page.getByTestId("ask-scope")).toContainText("Searched mail on this Mac back to");
      await expect(page.getByTestId("ask-scope").getByTestId("ask-older")).toHaveText("Search older mail on your servers");
    });

    await scenario("a citation is bound to its words, and the line's height unchanged (plan 161); the dialog is Ask's (pass 3)", async () => {
      // pass 3: the dialog says what it is, and its way back and its close say what they do
      await expect(page.getByRole("dialog", { name: "Ask your mail" })).toBeVisible();
      await expect(page.getByTestId("palette-back")).toHaveText("All commands");
      await expect(page.getByTestId("ask-close")).toHaveAccessibleName("Close");
      await expect(page.getByTestId("palette-page")).toHaveCount(0);
      const cited = page.getByTestId("ask-cited").first();
      await expect(cited.getByTestId("ask-citation")).toHaveText("1");
      // one line box: the marker never starts a line, nor does what closes the clause after it
      expect(await cited.evaluate((el) => el.getClientRects().length)).toBe(1);
      const hit = await page.getByTestId("ask-citation").first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
        const at = (dx: number, dy: number) => document.elementFromPoint(x + dx, y + dy)?.closest("[data-testid=ask-citation]") === el;
        return { height: r.height, corners: [at(-11, -11), at(11, -11), at(-11, 11), at(11, 11)], outside: at(0, 14) };
      });
      // pass 3: the element itself measures 24 × 24, as a rater's ruler does (the size in every design: the @design test)
      expect(hit.height).toBeGreaterThanOrEqual(24);
      expect(hit.corners).toEqual([true, true, true, true]);
      expect(hit.outside).toBe(false);
      // the marker grows no line: the answer is as tall as itself with its markers as plain text
      expect(await lineDrift(page)).toBeLessThanOrEqual(1);
      // hovering it names its source
      await page.getByTestId("ask-citation").first().hover();
      await expect(page.getByTestId("ask-citation-preview")).toContainText(`${WORD} policy`);
      await page.mouse.move(0, 0);
      // Answer again says what it does; Copy and it are buttons, not grey words
      await expect(page.getByTestId("ask-again")).toHaveText("Answer again");
      // New question and the history: on the keys' line under the sources (pass 3), and smaller than them
      await expect(page.getByTestId("ask-hints").getByTestId("ask-new")).toBeVisible();
      const source = (await page.getByTestId("ask-source").last().boundingBox())!;
      const session = (await page.getByTestId("ask-new").boundingBox())!;
      expect(session.y).toBeGreaterThanOrEqual(source.y + source.height - 1);
      const size = (testId: string) => page.getByTestId(testId).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(await size("ask-new")).toBeLessThan(await size("ask-source"));
      expect(session.height).toBeLessThan(source.height);
    });

    await scenario("the source row and the inline number show the message in Ask; Open message opens the thread (plan 161, pass 3)", async () => {
      const source = page.getByTestId("ask-source").first();
      await expect(source).toBeVisible();
      // the keys' line says what the keys do here: Enter asks, ↓ reaches the sources, Esc goes back to all commands
      const hints = page.getByTestId("ask-hints");
      await expect(hints).toHaveAttribute("data-where", "asking");
      await expect(hints).toContainText("Ask");
      await expect(hints).toContainText("Sources");
      await expect(hints).toContainText("All commands");
      await expect(hints).not.toContainText("Navigate");
      await followUp(page).press("ArrowDown");
      await expect(hints).toHaveAttribute("data-where", "walking");
      await expect(hints).toContainText("Show");
      // pass 2: ↑↓ walk the source rows, and the chosen row's number lights in the answer
      const chosen = await page.locator("[data-testid=ask-source][data-selected=true] [data-testid=ask-source-n]").textContent();
      await expect(page.locator("[data-testid=ask-citation][data-lit]").first()).toHaveText(chosen!);
      await page.keyboard.press("Enter");
      // the preview's keys never move the rows under it (Codex review, pass 3, round 2): the same row is chosen after Esc
      await expect(page.getByTestId("ask-peek-body")).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Control+n");
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-testid=ask-source][data-selected=true] [data-testid=ask-source-n]")).toHaveText(chosen!);
      await page.keyboard.press("Enter");
      // the message, inside Ask: the answer is a step back, never lost
      const peek = page.getByTestId("ask-peek");
      await expect(peek).toHaveAttribute("data-state", "ready");
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByTestId("ask-peek-subject")).toContainText(`${WORD} policy`);
      await expect(page.getByTestId("ask-peek-text")).not.toBeEmpty();
      await expect(hints).toHaveAttribute("data-where", "peek");
      await expect(page.getByTestId("ask-peek-body")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(peek).toHaveCount(0);
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(followUp(page)).toBeFocused();
      await expect(lastTurn(page)).toBeVisible();
      // Codex review (pass 3) #6: back from a row's source, the keys' line still tells the truth: Enter shows it again
      await expect(hints).toHaveAttribute("data-where", "walking");
      await page.keyboard.press("Enter");
      await expect(peek).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(peek).toHaveCount(0);
      // the inline marker shows it too, and Back to the answer is the way back, with a follow-up typed and the place
      // read to kept (Codex review, pass 3, #1 and #5)
      await followUp(page).fill("half a thought");
      await page.getByTestId("ask-area").evaluate((el) => {
        el.style.maxHeight = "40px";
        el.scrollTop = 7;
      });
      // (a source row: a click on a marker scrolls it into view first, as any focus does)
      await page.getByTestId("ask-source").first().click();
      await expect(peek).toBeVisible();
      await page.getByTestId("ask-peek-back").click();
      await expect(peek).toHaveCount(0);
      await expect(followUp(page)).toBeFocused();
      await expect(followUp(page)).toHaveValue("half a thought");
      expect(await page.getByTestId("ask-area").evaluate((el) => { const top = el.scrollTop; el.style.maxHeight = ""; return top; })).toBe(7);
      await followUp(page).fill("");
      await page.getByTestId("ask-citation").first().click();
      await expect(peek).toBeVisible();
      await page.getByTestId("ask-peek-back").click();
      await expect(followUp(page)).toBeFocused();
      // Open message (↵ in the preview) opens the thread: focus on its message, and a visible way back
      await page.getByTestId("ask-citation").first().click();
      await expect(page.getByTestId("ask-peek-body")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("reader-subject")).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-reader-scroller] article[data-message-id]") !== null)).toBe(true);
      await expect(page.getByTestId("back-to-answer")).toBeVisible();
      await page.keyboard.press("ControlOrMeta+Shift+k");
      await expect(followUp(page)).toBeFocused();
      await expect(lastTurn(page)).toBeVisible();
      await page.getByTestId("ask-citation").first().click();
      await page.getByTestId("ask-peek-open").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByTestId("back-to-answer").click();
      await expect(followUp(page)).toBeFocused();
      await expect(lastTurn(page)).toBeVisible();
    });

    await scenario("a follow-up keeps one entry, and the first turn keeps its sources (plan 161, pass 2)", async () => {
      const cited = await page.getByTestId("ask-source").count();
      await followUp(page).fill(`and ${word} again?`);
      await followUp(page).press("Enter");
      await expect(page.getByTestId("ask-turn")).toHaveCount(2);
      await expect(followUp(page)).toHaveValue("");
      await expect(lastTurn(page)).toHaveAttribute("data-status", /answered|not_found/);
      // the follow-up's question reads as a question, not a caption
      const asked = page.getByTestId("ask-turn").last().getByTestId("ask-question");
      await expect(asked).toHaveText(`and ${word} again?`);
      expect(await asked.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(await page.getByTestId("ask-answer").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize)));
      const first = page.getByTestId("ask-turn").first();
      await expect(first.getByTestId("ask-turn-source")).toHaveCount(cited);
      // only the last answer offers to answer again
      await expect(first.getByTestId("ask-again")).toHaveCount(0);
      await first.getByTestId("ask-turn-source").first().click();
      await expect(page.getByTestId("ask-peek-subject")).toContainText(`${WORD} policy`);
      await page.getByTestId("ask-peek-open").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("reader-subject")).toContainText(`${WORD} policy`);
      await page.keyboard.press("ControlOrMeta+Shift+k");
      await expect(page.getByTestId("ask-turn")).toHaveCount(2);
    });

    await scenario("Enter on Copy and Ask again stays with them, not the list's active row", async () => {
      await page.getByTestId("ask-copy").last().focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByTestId("ask-turn").first()).toBeVisible();
    });

    await scenario("Previous AI questions reopens it with no request", async () => {
      await page.getByTestId("ask-new").click();
      await expect(ask(page)).toBeFocused();
      await page.getByTestId("ask-history-row").click();
      // pass 3: no chip whose × reads as close: All commands and a Close, clear of the field's placeholder
      await expect(page.getByRole("dialog", { name: "Previous AI questions" })).toBeVisible();
      await expect(page.getByTestId("palette-back")).toHaveText("All commands");
      expect((await page.getByTestId("ask-nav").boundingBox())!.x).toBeGreaterThanOrEqual((await ask(page).boundingBox())!.x + (await ask(page).boundingBox())!.width - 1);
      const item = page.getByTestId("ask-history-item");
      await expect(item).toHaveCount(1);
      await expect(item).toContainText("1 follow-up");
      const before = await server.backend.aiService.limiter.report();
      await item.click();
      await expect(page.getByTestId("ask-turn")).toHaveCount(2);
      expect((await server.backend.aiService.limiter.report()).today.requests).toBe(before.today.requests);
    });

    await scenario("delete with ⌘⌫, and Undo", async () => {
      await page.getByTestId("ask-history-row").click();
      const item = page.getByTestId("ask-history-item");
      await item.first().hover();
      await ask(page).press("ControlOrMeta+Backspace");
      await expect(item).toHaveCount(0);
      await page.getByTestId("ask-history-undo").click();
      await expect(item).toHaveCount(1);
    });

    await scenario("cleared from another window, an open history empties and offers no Undo", async () => {
      const item = page.getByTestId("ask-history-item");
      await item.first().hover();
      await ask(page).press("ControlOrMeta+Backspace");
      await expect(page.getByTestId("ask-history-undo")).toBeVisible();
      await server.backend.server.invoke("ai.summaries.clear", {}, dev);
      await expect(page.getByTestId("ask-history-undo")).toHaveCount(0);
      await expect(item).toHaveCount(0);
    });
  });

  test("not found offers older mail; a click finds it, keeps it as mail, and answers from it", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await open(page);
    await question(page, "when does the qqlease renewal lease zzz happen?");
    // the demo mailbox holds no lease letter: the plan's words find nothing, and nothing is asked of a server before the click
    const older = page.getByTestId("ask-older");
    await expect(older).toBeVisible();
    await expect(page.getByTestId("ask-not-found")).toContainText("Nothing in your mail on this Mac answers this.");
    // pass 2: one look and one label for older mail, here and after an answer's scope line
    await expect(older).toHaveText("Search older mail on your servers");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/not-found-light.png` });
    await older.click();
    await expect(page.getByTestId("ask-source").first()).toContainText("Greenway Rentals");
    await expect(page.getByTestId("ask-turn").last()).toHaveAttribute("data-status", "answered");
    await expect(page.getByTestId("ask-answer").last()).toContainText("1 March 2027");
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/answer-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      await page.screenshot({ path: `${SHOTS}/answer-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
    }
    // stored as normal mail, at its old date, and its source shows it, then opens it
    await page.getByTestId("ask-citation").first().click();
    await expect(page.getByTestId("ask-peek-subject")).toHaveText("Your lease renewal");
    await page.getByTestId("ask-peek-open").click();
    await expect(page.getByTestId("reader-subject")).toHaveText("Your lease renewal");
  });

  test("a source moved to Trash while it's shown says so in the preview, and the second press opens it (Codex review, pass 3, round 2)", async ({ app: page, server }) => {
    await withMail(page, server);
    await open(page);
    await question(page, `what about ${WORD}?`);
    await page.getByTestId("ask-citation").first().click();
    await expect(page.getByTestId("ask-peek")).toHaveAttribute("data-state", "ready");
    const id = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM threads WHERE subject LIKE ? LIMIT 1", `%${WORD} policy%`)!.id;
    await server.backend.server.invoke("threads.act", { threadIds: [id], action: "trash" }, dev);
    await page.getByTestId("ask-peek-open").click();
    await expect(page.getByTestId("ask-peek-armed")).toContainText("Trash");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByTestId("ask-peek-open").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("reader-subject")).toContainText(`${WORD} policy`);
  });

  test("Esc stops a running answer first, then goes back; Backspace in the follow-up box only types", async ({ app: page, server }) => {
    await withMail(page, server);
    const word = WORD;
    await open(page);
    await question(page, `${word}?`);
    await expect(page.getByTestId("ask-answer")).toBeVisible();
    fakeDraft.paceMs = 300;
    await followUp(page).fill(`${word} again?`);
    await followUp(page).press("Enter");
    await expect(page.getByTestId("ask-streaming")).toBeVisible();
    await page.keyboard.press("Escape");
    fakeDraft.paceMs = 0;
    await expect(page.getByTestId("ask-running")).toHaveCount(0);
    // it stopped, the page stays, and what was written so far is kept and says so
    await expect(page.getByTestId("ask-stopped")).toBeVisible();
    await expect(followUp(page)).toBeFocused();
    await followUp(page).fill("ab");
    await followUp(page).press("Backspace");
    await expect(followUp(page)).toHaveValue("a");
    await followUp(page).press("Backspace");
    await followUp(page).press("Backspace");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(followUp(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await expect(page.getByTestId("palette-page")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the palette's last row asks; Enter on a command that matches still wins", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    await ask(page).fill("archive");
    await expect(page.getByTestId("palette-ask-row")).toContainText("Ask AI: “archive”");
    await expect(page.getByRole("option", { selected: true })).not.toHaveAttribute("data-testid", "palette-ask-row");
    // pass 3: a sentence that's plainly an instruction is AI's first, and Enter takes it there; a search keeps its order
    await ask(page).fill("archive old mail");
    await expect(page.getByRole("option", { selected: true })).toHaveAttribute("data-testid", "palette-search-row");
    await ask(page).fill("Archive zzzqqq notices older than a month");
    await expect(page.getByTestId("palette-ask-row")).toHaveText("Do with AI: “Archive zzzqqq notices older than a month”");
    await expect(page.getByRole("option", { selected: true })).toHaveAttribute("data-testid", "palette-ask-row");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ask-command-notice").or(page.getByTestId("action-preview")).first()).toBeVisible();
    // Esc in Ask goes back to all commands
    await page.keyboard.press("Escape");
    await ask(page).fill("zzzqqq nothing like it");
    await expect(page.getByTestId("palette-ask-row")).toBeVisible();
    await page.getByTestId("palette-ask-row").click();
    await expect(page.getByTestId("ask-not-found").or(page.getByTestId("ask-answer")).first()).toBeVisible();
  });

  test("no provider shows nothing; one that goes from under it says what it needs; off removes the rows and the shortcut", async ({ app: page, server }) => {
    // plan 147: a free install: no row, no shortcut
    await settingUp(page, server, { ai: { provider: "none" } });
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await ask(page).fill("ask your");
    await expect(page.getByTestId("palette-ask")).toHaveCount(0);
    await expect(page.getByTestId("palette-ask-row")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // this window hasn't heard yet, as when another one's Settings changed it: the backend's answer says so
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, dev);
    await open(page);
    await question(page, "does anyone answer?");
    await expect(page.getByTestId("ask-no-provider")).toContainText("Ask needs an AI provider.");
    await page.getByTestId("ask-open-settings").click();
    await expect(page.getByTestId("ai-ask")).toBeVisible();
    await expect(page.getByTestId("ai-ask-switch")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("ai-ask-switch").click();
    await expect(page.getByTestId("ai-ask-switch")).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await ask(page).fill("ask your");
    await expect(page.getByTestId("palette-ask")).toHaveCount(0);
    await expect(page.getByTestId("palette-ask-row")).toHaveCount(0);
  });

  test("a cloud destination says where it goes before anything leaves, naming the server; Enter on Settings stays with it", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "compatible", preset: "custom", model: "m", baseURL: "https://ai.example.test/v1" } });
    await open(page);
    await question(page, "where does this go?");
    const consent = page.getByTestId("ask-consent");
    await expect(consent).toContainText("ai.example.test");
    await expect(page.getByTestId("ask-consent-continue")).toBeVisible();
    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=ask-consent]").analyze()).violations).toEqual([]);
    await page.getByTestId("ask-consent-settings").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ai-ask")).toBeVisible();
  });

  test("the page is axe-clean in both modes, in every design it can change, and in Spanish", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(page, server);
    const word = WORD;
    await open(page);
    await question(page, `${word}?`);
    await expect(page.getByTestId("ask-answer")).toBeVisible();
    // keyboard scrolling, and no ring around the whole pane (plan 52)
    await expect(page.getByTestId("ask-area")).toHaveAttribute("tabindex", "0");
    expect(await page.getByTestId("ask-area").getAttribute("class")).not.toMatch(/ring/);
    const axe = () => new AxeBuilder({ page }).setLegacyMode().include("[role=dialog]").analyze();
    expect((await axe()).violations).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    expect((await axe()).violations).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
    // pass 3: in every design, the citation's own box is 24 × 24, and the answer's lines keep the paragraph's height
    const cite = (await page.getByTestId("ask-citation").first().boundingBox())!;
    expect(cite.width).toBeGreaterThanOrEqual(24);
    expect(cite.height).toBeGreaterThanOrEqual(24);
    expect(await lineDrift(page)).toBeLessThanOrEqual(1);
    // the source shown in Ask is axe-clean too
    await page.getByTestId("ask-citation").first().click();
    await expect(page.getByTestId("ask-peek")).toHaveAttribute("data-state", "ready");
    expect((await axe()).violations).toEqual([]);
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-peek-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-peek-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.keyboard.press("Escape");
    // alignment: the question, its answer and its source rows start on one line in the page's own column
    const left = async (locator: ReturnType<Page["getByTestId"]>) => (await locator.first().boundingBox())!.x;
    expect(Math.abs((await left(page.getByTestId("ask-answer"))) - (await left(page.getByTestId("ask-follow-up"))))).toBeLessThanOrEqual(1);
    await settingUp(page, server, { language: "es" });
    await open(page);
    await expect(followUp(page).or(ask(page)).first()).toBeVisible();
    expect(await englishLeaks(page)).toEqual([]);
  });
});
