/**
 * Plan 141 in the page, on the offline fake model and the demo's server: nothing here reaches a real provider. ⌘⇧K, a
 * question, a source, a follow-up, the history; older mail on a click; the page's keys; no provider. A cloud provider
 * asks nothing first (plan 131): ai-no-consent.spec.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import { fakeDraft } from "../../../packages/ai/src/fake";
import { E2E_NOW } from "./constants";
import { inEveryLook, wheelsTo } from "./helpers/looks";
import { unclipped } from "./helpers/unclipped";
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
  test("plan 162 (after ai162-r04): a long answer fits a 1100x700 window with its footer whole and every source in reach; no scratch text; a list; unlinked marked, not underlined; the keys never leave the dialog", async ({ app: page, server }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await withMail(page, server);
    await open(page);
    await question(page, `${WORD} [[long]] [[list]] [[note]] [[uncited]]?`);
    await expect(lastTurn(page)).toHaveAttribute("data-status", "answered");
    // the dialog, its follow-up box and its keys are inside the window (it ran 6 px past it, its sources cut)
    const dialog = (await page.getByRole("dialog").boundingBox())!;
    expect(dialog.y + dialog.height).toBeLessThanOrEqual(700);
    for (const id of ["ask-follow-up", "ask-hints", "ask-header"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.y + box.height, id).toBeLessThanOrEqual(dialog.y + dialog.height);
    }
    await expect(page.getByTestId("ask-hints")).toContainText("1 source");
    // plan 162 (after ai162-r05): the sources sit apart from the long answer, whole, without scrolling it; nothing fades
    await expect(page.getByTestId("ask-source").last()).toBeInViewport({ ratio: 1 });
    expect(await page.getByTestId("ask-area").evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).maskImage === "none")).toBe(true);
    // the model's note to itself never reaches the answer
    await expect(page.getByTestId("ask-answer")).not.toContainText("doesn't mention");
    await expect(page.getByTestId("ask-answer")).not.toContainText("m9");
    // a list is a list, **bold** is bold, and no raw marker shows
    await expect(page.getByTestId("ask-answer-list")).toHaveCount(1);
    await expect(page.getByTestId("ask-answer-item")).toHaveCount(2);
    await expect(page.getByTestId("ask-answer-item").last().locator("strong")).toHaveText("The second");
    await expect(page.getByTestId("ask-answer")).not.toContainText("**");
    // not linked: never an underline (it reads as a link); after ai162-r05 never grey alone either: in the ink, and a mark
    // after it that says so in words, where a citation would be
    const unlinked = page.getByTestId("ask-unlinked").filter({ hasText: "This sentence cites nothing at all here." });
    await expect(unlinked).toHaveCount(1);
    expect(await unlinked.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
    const ink = await page.getByTestId("ask-answer").evaluate((el) => getComputedStyle(el).color);
    expect(await unlinked.evaluate((el) => getComputedStyle(el).color)).toBe(ink);
    await expect(page.getByTestId("ask-unlinked-mark").first()).toHaveText("no source");
    expect(await page.getByTestId("ask-unlinked-mark").count()).toBe(await page.getByTestId("ask-unlinked").count());
    await expect(page.getByTestId("ask-check-unlinked")).toHaveCount(0);
    // the keys stay in Ask: after New question and Previous AI questions, Tab never reaches the app behind the scrim
    const behind = () => page.evaluate(() => !!document.activeElement && document.activeElement !== document.body && !!document.getElementById("root")?.contains(document.activeElement));
    const inBody = () => page.evaluate(() => document.activeElement === document.body);
    await page.getByTestId("ask-new").click();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await behind(), `Tab ${i + 1} after New question`).toBe(false);
    }
    await question(page, `what about ${WORD}?`);
    await expect(lastTurn(page)).toHaveAttribute("data-status", "answered");
    await page.getByTestId("ask-history-row").click();
    await expect(page.getByTestId("palette-input")).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await behind(), `Tab ${i + 1} after Previous AI questions`).toBe(false);
      expect(await inBody(), `Tab ${i + 1} after Previous AI questions`).toBe(false);
    }
  });

  test("plan 162 (after ai162-r05): at 1100x700 a long answer leaves its sources on screen, three whole rows under their count, the rest by ↓; the preview opens under its mark", async ({ app: page, server }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await ingestConversation(server, { subject: `${WORD} policy`, count: 6, now: E2E_NOW });
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await open(page);
    await question(page, `${WORD} [[long]] [[all]]?`);
    await expect(lastTurn(page)).toHaveAttribute("data-status", "answered");
    const sources = page.getByTestId("ask-source");
    expect(await sources.count()).toBeGreaterThanOrEqual(5);
    // the answer is longer than its region, which rests at its top; the sources are apart from it, not under it
    expect(await page.getByTestId("ask-area").evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
    const list = page.getByTestId("ask-sources");
    const box = (await list.boundingBox())!;
    const whole = await sources.evaluateAll((rows, b) => rows.filter((r) => { const x = r.getBoundingClientRect(); return x.top >= b.y - 0.5 && x.bottom <= b.y + b.height + 0.5; }).length, box);
    expect(whole).toBeGreaterThanOrEqual(3);
    await expect(list).toContainText(`${await sources.count()} sources`);
    // the dialog is inside the window, its follow-up box under the sources
    const dialog = (await page.getByRole("dialog").boundingBox())!;
    expect(dialog.y + dialog.height).toBeLessThanOrEqual(700);
    expect((await page.getByTestId("ask-follow-up").boundingBox())!.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
    // every source in reach: ↓ walks to the last, which comes whole into view
    await followUp(page).focus();
    for (let i = 0; i < (await sources.count()); i++) await page.keyboard.press("ArrowDown");
    await expect(sources.last()).toHaveAttribute("data-selected", "true");
    const last = (await sources.last().boundingBox())!;
    const after = (await list.boundingBox())!;
    expect(last.y).toBeGreaterThanOrEqual(after.y - 0.5);
    expect(last.y + last.height).toBeLessThanOrEqual(after.y + after.height + 0.5);
    // a citation's preview opens under its mark, inside the panel, never over the question
    await page.getByTestId("ask-area").evaluate((el) => el.scrollTo({ top: 0 }));
    const mark = page.getByTestId("ask-citation").first();
    await mark.hover();
    const preview = page.getByTestId("ask-citation-preview");
    await expect(preview).toBeVisible();
    const p = (await preview.boundingBox())!, m = (await mark.boundingBox())!;
    expect(p.y).toBeGreaterThanOrEqual(m.y + m.height - 1);
    expect(p.x).toBeGreaterThanOrEqual(dialog.x);
    // Codex review: whichever mark, at either edge of the panel, its preview is inside it
    for (const at of [mark, page.getByTestId("ask-citation").last()]) {
      await page.mouse.move(0, 0);
      await expect(preview).toHaveCount(0);
      await at.scrollIntoViewIfNeeded();
      await at.hover();
      await expect(preview).toBeVisible();
      const b = (await preview.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(dialog.x);
      expect(b.x + b.width).toBeLessThanOrEqual(dialog.x + dialog.width);
    }
    // Codex review: Regenerate asks the same question again, and the new answer is headed by it too
    await page.mouse.move(0, 0);
    await page.getByTestId("ask-again").click();
    await expect(page.getByTestId("ask-turn")).toHaveCount(2);
    await expect(lastTurn(page)).toHaveAttribute("data-status", "answered");
    await expect(lastTurn(page).getByTestId("ask-question")).toBeVisible();
  });

  test("plan 162: Ask's provenance popover is whole, and its answer and sources reach the wheel, in every design, light and dark, 1440 and 1100", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(page, server);
    await open(page);
    await question(page, `what about ${WORD}?`);
    await expect(lastTurn(page)).toHaveAttribute("data-status", "answered");
    await inEveryLook(page, async (where) => {
      await page.getByTestId("ask-provenance").click();
      const popover = page.getByTestId("ask-provenance-popover");
      await expect(popover, where).toBeVisible();
      expect(await unclipped(popover), where).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(popover, where).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "Ask your mail" }), where).toBeVisible();
      expect(await wheelsTo(page, page.getByTestId("ask-area"), page.getByTestId("ask-scope")), where).toBe(true);
      expect(await unclipped(page.getByRole("dialog", { name: "Ask your mail" })), where).toEqual([]);
    });
  });

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
      // pass 3: the one "Written with AI ▾" every AI surface has: it opens what wrote it, and Esc closes only it
      await page.getByTestId("ask-provenance").click();
      await expect(page.getByTestId("ask-provenance-detail")).toContainText(/Written by demo, .+\. It can make mistakes\./);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("ask-provenance-detail")).toHaveCount(0);
      await expect(page.getByTestId("ask-answer").last()).toBeVisible();
      // its keys are its own (Codex review): opened from the keyboard, Enter doesn't also choose the source behind it, and
      // Esc closes it, not Ask
      await page.getByTestId("ask-provenance").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("ask-provenance-detail")).toBeVisible();
      await expect(page.getByTestId("ask-peek")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("ask-provenance-detail")).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "Ask your mail" })).toBeVisible();
      await expect(page.getByTestId("ask-answer").last()).toBeVisible();
      // how far back it looked, beside the way past it
      // plan 162 (after ai162-r03): what was searched, and what the date means (it read as a bound beside older sources)
      await expect(page.getByTestId("ask-scope")).toContainText("Searched all mail on this Mac · complete since");
      await expect(page.getByTestId("ask-scope").getByTestId("ask-older")).toHaveText("Search older mail on your servers");
    });

    await scenario("a citation is bound to its words, and the line's height unchanged (plan 161); the dialog is Ask's (pass 3)", async () => {
      // pass 3: the dialog says what it is, and its way back and its close say what they do
      await expect(page.getByRole("dialog", { name: "Ask your mail" })).toBeVisible();
      // plan 162: opened with ⌘⇧K, the mail is the only thing behind it: the × alone
      await expect(page.getByTestId("palette-back")).toHaveCount(0);
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
      await expect(page.getByTestId("ask-again")).toHaveText("Regenerate");
      // New question and the history: on the keys' line under the sources (pass 3), and smaller than them
      await expect(page.getByTestId("ask-hints").getByTestId("ask-session").getByTestId("ask-new")).toBeVisible();
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
      // the keys' line says what the keys do here: Enter asks, ↓ reaches the sources, Esc closes (opened with ⌘⇧K)
      const hints = page.getByTestId("ask-hints");
      await expect(hints).toHaveAttribute("data-where", "asking");
      await expect(hints).toContainText("Ask");
      await expect(hints).toContainText(/\d+ sources?/);
      await expect(hints).toContainText("Close");
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
      });
      // (a source row: a click on it scrolls it into view first, as any focus does; plan 162 after ai162-r03: the sources
      // are in the answer's one scroll region, so that's the place kept)
      await page.getByTestId("ask-source").first().click();
      await expect(peek).toBeVisible();
      const kept = await page.getByTestId("ask-area").evaluate((el) => el.scrollTop);
      await page.getByTestId("ask-peek-back").click();
      await expect(peek).toHaveCount(0);
      await expect(followUp(page)).toBeFocused();
      await expect(followUp(page)).toHaveValue("half a thought");
      expect(await page.getByTestId("ask-area").evaluate((el) => { const top = el.scrollTop; el.style.maxHeight = ""; return top; })).toBe(kept);
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
      // plan 162 (after ai162-r01): the header is the question being answered now; the first one heads its own turn
      await expect(page.getByTestId("ask-title")).toHaveText(`and ${word} again?`);
      await expect(first.getByTestId("ask-question")).toBeVisible();
      await expect(first.getByTestId("ask-question")).not.toHaveText(`and ${word} again?`);
      // plan 162 (after ai162-r03): folded to their count, so they never stand alone at the top
      await expect(first.getByTestId("ask-turn-sources-toggle")).toHaveText(`${cited} source${cited === 1 ? "" : "s"}`);
      await first.getByTestId("ask-turn-sources-toggle").click();
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

    await scenario("plan 162 (Codex review): a follow-up that can't be done keeps its words in the follow-up field, selected", async () => {
      await followUp(page).fill("Forward recruiters to my boss");
      await followUp(page).press("Enter");
      await expect(page.getByTestId("ask-command-notice")).toBeVisible();
      await expect(followUp(page)).toHaveValue("Forward recruiters to my boss");
      await expect.poll(() => followUp(page).evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!)).toBe("Forward recruiters to my boss".length);
      await followUp(page).fill("");
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
      // the owner's catch: on the empty page its one row sits centred between the field and the hints, not 8 px low
      const gaps = await page.evaluate(() => {
        const row = document.querySelector("[data-testid=ask-history-row]")!.getBoundingClientRect();
        const field = document.querySelector("[cmdk-input-wrapper], [data-slot=command-input-wrapper]")!.getBoundingClientRect();
        const hints = document.querySelector("[data-testid=ask-hints]")!.getBoundingClientRect();
        return { above: row.top - field.bottom, below: hints.top - row.bottom };
      });
      expect(Math.abs(gaps.above - gaps.below), `${gaps.above} px above, ${gaps.below} px below`).toBeLessThanOrEqual(1);
      await page.getByTestId("ask-history-row").click();
      // pass 3: no chip whose × reads as close: a way back and a Close, clear of the field's placeholder. Plan 162: one
      // step back, to Ask, where it came from (Ask was opened with ⌘⇧K)
      await expect(page.getByRole("dialog", { name: "Previous AI questions" })).toBeVisible();
      await expect(page.getByTestId("palette-back")).toHaveText("Ask");
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

  test("Esc stops a running answer first, then steps back one level: from ⌘⇧K it closes, focus back on the list (plan 162); Backspace in the follow-up box only types", async ({ app: page, server }) => {
    await withMail(page, server);
    const word = WORD;
    // the keys on the list, as a person's are after picking a conversation: where Esc's close gives them back (plan 162)
    await page.getByTestId("thread-row").first().click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-keep-scroll"))).toBe("list");
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await expect(page.getByRole("dialog")).toBeVisible();
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
    // plan 162: opened with ⌘⇧K, there's no All commands behind it: no way back but the ×, and one Esc closes it
    await expect(page.getByTestId("palette-back")).toHaveCount(0);
    await expect(page.getByTestId("ask-hints")).toContainText("Close");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // the keys back where they were before ⌘⇧K: the list (never the page)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-keep-scroll"))).toBe("list");
  });

  test("plan 162 (after ai162-r03): Esc before a word keeps the question; ⌘⇧K on a source returns to the answer; an unlinked claim is marked, and only then said; the stream's pieces fade in", async ({ app: page, server }) => {
    await withMail(page, server);
    await open(page);
    // stopped before a word came: the question stays in the field, selected, and says it stopped (it was thrown away)
    fakeDraft.firstTokenMs = 4000;
    await question(page, `${WORD}?`);
    await expect(page.getByTestId("ask-running")).toBeVisible();
    await page.keyboard.press("Escape");
    fakeDraft.firstTokenMs = 0;
    await expect(page.getByTestId("ask-running")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("ask-command-notice")).toContainText("Stopped before an answer");
    await expect(ask(page)).toHaveValue(`${WORD}?`);
    // asked again: the note shows exactly when a claim is marked (it showed under fully cited answers)
    await page.keyboard.press("Enter");
    await expect(lastTurn(page)).toHaveAttribute("data-status", "answered");
    expect(await page.getByTestId("ask-unlinked-mark").count()).toBe(await page.getByTestId("ask-unlinked").count());
    // ⌘⇧K on a shown source goes back to its answer (it closed Ask)
    await page.getByTestId("ask-citation").first().click();
    await expect(page.getByTestId("ask-peek")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await expect(page.getByTestId("ask-peek")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(followUp(page)).toBeFocused();
    // a claim with no citation is marked where it is, and the note says the underlined parts are the ones
    fakeDraft.paceMs = 60;
    await followUp(page).fill(`${WORD} [[uncited]]?`);
    await followUp(page).press("Enter");
    const chunk = page.getByTestId("ask-chunk").first();
    await expect(chunk).toBeAttached();
    // the owner (2026-11-08): each piece fades in, at the motion cap (duration-slow, 100 ms); e2e asks for reduced motion,
    // and then nothing animates
    await expect(chunk).toHaveClass(/fade-in-0/);
    await expect(chunk).toHaveClass(/duration-slow/);
    expect(await chunk.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    fakeDraft.paceMs = 0;
    await expect(lastTurn(page)).toHaveAttribute("data-status", "answered");
    await expect(lastTurn(page).getByTestId("ask-unlinked").last()).toHaveText("This sentence cites nothing at all here.");
    await expect(lastTurn(page).getByTestId("ask-unlinked-mark").last()).toHaveText("no source");
    // plan 162 (after ai162-r05): with more than one turn, each answer is headed by its question, the last one too
    await expect(lastTurn(page).getByTestId("ask-question")).toBeVisible();
    await expect(lastTurn(page).getByTestId("ask-question")).toHaveText(`${WORD} [[uncited]]?`);
    // Codex review: a follow-up under a long answer starts at its top, and stays there as it streams and once it's done
    await page.getByTestId("ask-area").evaluate((el) => (el.style.maxHeight = "140px"));
    fakeDraft.paceMs = 40;
    await followUp(page).fill(`${WORD} once more?`);
    await followUp(page).press("Enter");
    fakeDraft.paceMs = 0;
    await expect(page.getByTestId("ask-turn")).toHaveCount(3);
    await expect(lastTurn(page)).toHaveAttribute("data-status", "answered");
    const offset = async () => (await lastTurn(page).boundingBox())!.y - (await page.getByTestId("ask-area").boundingBox())!.y;
    await expect.poll(offset).toBeLessThanOrEqual(16);
    expect(await offset()).toBeGreaterThanOrEqual(-16);
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
    // Esc in Ask opened from the palette goes back to all commands, the one way back on screen (plan 162: the keys'
    // line doesn't repeat the header's link)
    await expect(page.getByTestId("palette-back")).toHaveText("All commands");
    await expect(page.getByTestId("ask-hints")).not.toContainText("All commands");
    await page.keyboard.press("Escape");
    await ask(page).fill("zzzqqq nothing like it");
    await expect(page.getByTestId("palette-ask-row")).toBeVisible();
    await page.getByTestId("palette-ask-row").click();
    await expect(page.getByTestId("ask-not-found").or(page.getByTestId("ask-answer")).first()).toBeVisible();
  });

  test("⌘K, \"ask\", Ask your mail, Esc: back on all commands with the keys in its field (the owner)", async ({ app: page, server }) => {
    // Ask's own field had the focus, and the commands' field came back without it: typing went nowhere
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("ask");
    await page.getByTestId("palette-ask").click();
    await expect(page.getByTestId("palette-back")).toHaveText("All commands");
    await expect(ask(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-back")).toHaveCount(0);
    await expect(ask(page)).toBeFocused();
    await page.keyboard.type("inbox");
    await expect(ask(page)).toHaveValue("inbox");
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
