/**
 * Plan 143 in the page, on the offline fake model: a sentence, its preview, Apply, one Undo. Nothing runs before Apply;
 * Cancel leaves no trace. What each step guarantees in both stores is in the conformance and backend suites.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import { E2E_NOW } from "./constants";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, fresh, focusList, ingestConversation, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const SHOTS = process.env.ACTION_SHOTS;
const DAY = 86_400_000;

async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  await server.backend.server.invoke("settings.update", patch, dev);
  await fresh(page);
}

/** mail the sentences find, and mail they don't */
async function withMail(page: Page, server: DevServerFixture) {
  const old = E2E_NOW - 60 * DAY;
  await ingestConversation(server, { subject: "Your shipping notice 4411", count: 1, now: old });
  await ingestConversation(server, { subject: "Shipping delivery tracking 9921", count: 1, now: old - DAY });
  await ingestConversation(server, { subject: "Tracking your delivery 2231", count: 1, now: old - 2 * DAY });
  await ingestConversation(server, { subject: "Recruiter call about a role", count: 1, now: E2E_NOW - DAY });
  await ingestConversation(server, { subject: "Recruiter intro", count: 1, now: E2E_NOW - 2 * DAY });
  await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
}

async function say(page: Page, sentence: string) {
  await focusList(page);
  await page.keyboard.press("ControlOrMeta+Shift+k");
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await page.getByTestId("palette-input").fill(sentence);
  await page.getByTestId("ask-submit").waitFor();
  await page.keyboard.press("Enter");
}

const rows = (page: Page) => page.getByTestId("thread-row");

test.describe("actions in plain English (plan 143)", () => {
  test("\"from now on\" acts on what's here, and saves the rule too", async ({ app: page, server }) => {
    await withMail(page, server);
    // every row holds one of its words, so the offline check takes none out and the rule can be saved
    await say(page, "From now on archive shipping delivery tracking");
    await page.getByTestId("action-apply").click();
    await expect.poll(() => sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) AS n FROM filters")?.n).toBeGreaterThan(0);
    await expect.poll(() => sqlDb(server.backend.store).get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE subject = ?", "Your shipping notice 4411")?.in_inbox).toBe(0);
  });

  test("a sentence, its preview, one row out, Apply, Undo; Cancel leaves no trace", async ({ app: page, server }) => {
    await withMail(page, server);
    const inInbox = (subject: string) => expect.poll(() => sqlDb(server.backend.store).get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE subject = ?", subject)?.in_inbox);
    const list = page.locator('[data-keep-scroll="list"]');
    // past the first page: the list has to come back holding those rows
    await expect.poll(async () => {
      await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
      return page.evaluate(() => document.querySelector('[data-keep-scroll="list"] > div:last-child')?.getBoundingClientRect().height ?? 0);
    }).toBeGreaterThan(7000);
    const place = await list.evaluate((el) => el.scrollTop);
    expect(place).toBeGreaterThan(5000);

    await scenario("nothing runs: the preview is the list", async () => {
      await say(page, "Archive shipping notices older than a month");
      await expect(page.getByTestId("action-preview")).toBeVisible();
      // the rule found three; the check took out the one that isn't about shipping, and says so
      await expect(page.getByTestId("action-title")).toHaveText("Archive 2 conversations");
      await expect(page.getByTestId("action-conditions")).toContainText("Inbox");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(rows(page)).toHaveCount(2);
      await expect(page.getByTestId("action-left-out")).toContainText("Left out by AI (1)");
    });

    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
    }

    await scenario("Esc goes back with no trace", async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("action-preview")).toHaveCount(0);
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(place);
      await inInbox("Your shipping notice 4411").toBe(1);
    });

    await scenario("from All Mail too, Cancel puts its rows back", async () => {
      await page.getByTestId("nav-more").click();
      await page.getByTestId("nav-all").click();
      await expect.poll(() => rows(page).count()).toBeGreaterThan(3);
      await say(page, "Archive shipping notices older than a month");
      await expect(page.getByTestId("action-title")).toHaveText("Archive 2 conversations");
      await page.getByTestId("action-cancel").click();
      await expect(page.getByTestId("action-preview")).toHaveCount(0);
      await expect.poll(() => rows(page).count()).toBeGreaterThan(3);
      await page.getByTestId("nav-inbox").click();
    });

    await scenario("a row out with x, Apply, and the snack's Undo brings them all back", async () => {
      await say(page, "Archive shipping notices older than a month");
      await expect(page.getByTestId("action-title")).toHaveText("Archive 2 conversations");
      await page.getByTestId("action-show-left-out").click();
      await expect(rows(page)).toHaveCount(3);
      await expect(rows(page).last()).toHaveAttribute("data-included", "false");
      await rows(page).last().getByTestId("row-include").click();
      await expect(page.getByTestId("action-title")).toHaveText("Archive 3 conversations");
      await rows(page).first().click();
      await page.keyboard.press("x");
      await expect(page.getByTestId("action-title")).toHaveText("Archive 2 conversations");
      await expect(rows(page).first()).toHaveAttribute("data-included", "false");
      await page.getByTestId("action-apply").click();
      await expect(page.getByTestId("action-preview")).toHaveCount(0);
      await expect(page.getByTestId("snack")).toContainText("Archived 2 conversations");
      // the first row stayed out of it; the rest left
      await inInbox("Your shipping notice 4411").toBe(1);
      await inInbox("Tracking your delivery 2231").toBe(0);
      await page.getByTestId("snack-action").click();
      await inInbox("Tracking your delivery 2231").toBe(1);
      await inInbox("Shipping delivery tracking 9921").toBe(1);
    });

    await scenario("⌘↩ in a reply sends the reply; it doesn't apply the preview", async () => {
      await say(page, "Archive shipping notices older than a month");
      await expect(page.getByTestId("action-title")).toHaveText("Archive 2 conversations");
      await rows(page).first().click();
      await page.keyboard.press("r");
      const editor = page.locator("[contenteditable=true]").first();
      await expect(editor).toBeFocused();
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(page.getByTestId("action-preview")).toBeVisible();
      await inInbox("Your shipping notice 4411").toBe(1);
      await page.getByTestId("action-cancel").click();
    });
  });

  test("a new category says so, and Undo removes it empty", async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Send recruiters to a Recruiting category");
    await expect(page.getByTestId("action-title")).toHaveText("Move 2 conversations to Recruiting");
    await expect(page.getByTestId("action-creates")).toContainText("Recruiting");
    await expect(page.getByTestId("action-hidden")).toBeVisible();
    await expect(page.getByTestId("action-future-box")).toHaveAttribute("data-checked");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/category-light.png` });
    const results = await new AxeBuilder({ page }).include('[data-testid="action-preview"]').include('[data-keep-scroll="list"]').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 140)}`)).toEqual([]);
    await page.getByTestId("action-apply").click();
    await expect(page.getByTestId("snack")).toContainText("Moved 2 conversations to Recruiting");
    await expect(page.getByTestId("snack")).toContainText("New mail too");
    await expect(page.getByRole("button", { name: "Recruiting" }).or(page.getByText("Recruiting", { exact: true })).first()).toBeVisible();
    await page.getByTestId("snack-action").click();
    await expect(page.getByTestId("snack")).toContainText("back");
    await expect(page.getByText("Recruiting", { exact: true })).toHaveCount(0);
  });

  test("history shows what a command came to, and Run again plans afresh; Spanish too", async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Archive shipping notices older than a month");
    await expect(page.getByTestId("action-title")).toHaveText("Archive 2 conversations");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("snack")).toContainText("Archived 2 conversations");
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await page.getByTestId("ask-history-row").click();
    await page.getByTestId("ask-history-item").first().click();
    await expect(page.getByTestId("ask-command-outcome")).toContainText("Archived 2 conversations");
    await page.getByTestId("ask-run-again").click();
    // planned afresh: what's left is another preview, or nothing to do
    await expect(page.getByTestId("ask-command-notice").or(page.getByTestId("action-preview"))).toBeVisible();
    await page.keyboard.press("Escape");
    await server.backend.server.invoke("settings.update", { language: "es" }, dev);
    await fresh(page);
    await say(page, "Archive recruiters");
    await expect(page.getByTestId("action-title")).toHaveText("Archivar 2 conversaciones");
    await expect(page.getByTestId("action-apply")).toHaveText("Archivar");
    await expect(page.getByTestId("action-conditions")).toContainText("Recibidos");
  });

  test("the header sits on the list's content line, in every design, light and dark", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Send recruiters to a Recruiting category");
    await expect(page.getByTestId("action-title")).toHaveText("Move 2 conversations to Recruiting");
    const left = async (testId: string) => page.getByTestId(testId).first().evaluate((el) => el.getBoundingClientRect().left);
    expect(Math.abs((await left("action-title")) - (await left("row-include")))).toBeLessThanOrEqual(1);
    for (const mode of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: mode as "light" | "dark" });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-category-${mode}.png` });
      const results = await new AxeBuilder({ page }).include('[data-testid="action-preview"]').include('[data-keep-scroll="list"]').analyze();
      expect(results.violations.map((v) => `${mode} ${v.id}: ${v.nodes[0]?.html.slice(0, 140)}`)).toEqual([]);
    }
  });

  test("what can't be done, and what nothing matches, stay on the page", async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Forward recruiters to my boss");
    await expect(page.getByTestId("ask-command-notice")).toContainText("can't do that from a sentence");
    await expect(page.getByTestId("action-preview")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await say(page, "Archive zebras");
    await expect(page.getByTestId("ask-command-notice")).toContainText("No mail matches");
  });
});
