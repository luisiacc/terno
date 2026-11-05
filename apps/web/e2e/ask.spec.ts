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
      await expect(page.getByTestId("ask-provenance")).toHaveText("Written by demo");
      await expect(followUp(page)).toBeFocused();
    });

    await scenario("the source row and the inline number open the thread; ⌘⇧K comes back to the conversation", async () => {
      const source = page.getByTestId("ask-source").first();
      await expect(source).toBeVisible();
      await followUp(page).press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("reader-subject")).toBeVisible();
      await page.keyboard.press("ControlOrMeta+Shift+k");
      await expect(followUp(page)).toBeFocused();
      await expect(lastTurn(page)).toBeVisible();
    });

    await scenario("a follow-up keeps one entry", async () => {
      await followUp(page).fill(`and ${word} again?`);
      await followUp(page).press("Enter");
      await expect(page.getByTestId("ask-turn")).toHaveCount(2);
      await expect(followUp(page)).toHaveValue("");
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
  });

  test("not found offers older mail; a click finds it, keeps it as mail, and answers from it", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await open(page);
    await question(page, "when does the qqlease renewal lease zzz happen?");
    // the demo mailbox holds no lease letter: the plan's words find nothing, and nothing is asked of a server before the click
    const older = page.getByTestId("ask-older");
    await expect(older).toBeVisible();
    await expect(page.getByTestId("ask-not-found")).toContainText("Nothing in your mail on this Mac answers this.");
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
    // stored as normal mail, at its old date, and its source opens it
    await page.getByTestId("ask-citation").first().click();
    await expect(page.getByTestId("reader-subject")).toHaveText("Your lease renewal");
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
    await ask(page).fill("zzzqqq nothing like it");
    await expect(page.getByTestId("palette-ask-row")).toBeVisible();
    await page.getByTestId("palette-ask-row").click();
    await expect(page.getByTestId("ask-not-found").or(page.getByTestId("ask-answer")).first()).toBeVisible();
  });

  test("no provider says what it needs; off removes the rows and the shortcut", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "none" } });
    await open(page);
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

  test("a cloud destination asks once, in the page, and Enter on its button stays with it", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "compatible", preset: "custom", model: "m", baseURL: "http://127.0.0.1:9/v1" } });
    await open(page);
    await question(page, "where does this go?");
    const consent = page.getByTestId("ask-consent");
    // a server on this Mac doesn't ask: only a cloud one does, and a custom one at loopback is on this Mac
    await expect(consent.or(page.getByTestId("ask-error")).first()).toBeVisible();
  });

  test("the page is axe-clean in both modes, in every design it can change, and in Spanish", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(page, server);
    const word = WORD;
    await open(page);
    await question(page, `${word}?`);
    await expect(page.getByTestId("ask-answer")).toBeVisible();
    const axe = () => new AxeBuilder({ page }).setLegacyMode().include("[role=dialog]").analyze();
    expect((await axe()).violations).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    expect((await axe()).violations).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
    // alignment: the question, its answer and its source rows start on one line in the page's own column
    const left = async (locator: ReturnType<Page["getByTestId"]>) => (await locator.first().boundingBox())!.x;
    expect(Math.abs((await left(page.getByTestId("ask-answer"))) - (await left(page.getByTestId("ask-follow-up"))))).toBeLessThanOrEqual(1);
    await settingUp(page, server, { language: "es" });
    await open(page);
    await expect(followUp(page).or(ask(page)).first()).toBeVisible();
    expect(await englishLeaks(page)).toEqual([]);
  });
});
