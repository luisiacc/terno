/**
 * Plan 143 in the page, on the offline fake model: a sentence, its preview, Apply, one Undo. Nothing runs before Apply;
 * Cancel leaves no trace. What each step guarantees in both stores is in the conformance and backend suites.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import { E2E_NOW, UNDO_KEYS } from "./constants";
import { sqlDb } from "../../backend-dev/src/server";
import { inEveryLook, wheelsTo } from "./helpers/looks";
import { unclipped } from "./helpers/unclipped";
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
  test("plan 162: the rule's provenance and its Exact pattern are whole, and the rule's end reaches the wheel, in every design, light and dark, 1440 and 1100", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Archive shipping notices older than a month");
    await expect(page.getByTestId("action-apply")).toHaveText("Archive 2");
    await inEveryLook(page, async (where) => {
      await page.getByTestId("action-provenance").click();
      const popover = page.getByTestId("action-provenance-popover");
      await expect(popover, where).toBeVisible();
      expect(await unclipped(popover), where).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(popover, where).toHaveCount(0);
      await expect(page.getByTestId("action-rule"), where).toBeVisible();
      // plan 162 (after ai162-r01): a list of words has no exact search to show; where there is one, it's whole
      const details = (await page.getByTestId("action-details-toggle").count()) > 0;
      if (details) await page.getByTestId("action-details-toggle").click();
      if (details) expect(await unclipped(page.getByTestId("action-details-text")), where).toEqual([]);
      expect(await wheelsTo(page, page.getByTestId("action-rule"), page.getByTestId("action-help")), where).toBe(true);
      if (details) await page.getByTestId("action-details-toggle").click();
    });
  });

  test("\"from now on\" acts on what's here, and saves the rule too", async ({ app: page, server }) => {
    await withMail(page, server);
    // every row holds one of its words, so the offline check takes none out and the rule can be saved
    await say(page, "From now on archive shipping delivery tracking");
    await page.getByTestId("action-apply").click();
    await expect.poll(() => sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) AS n FROM filters")?.n).toBeGreaterThan(0);
    await expect.poll(() => sqlDb(server.backend.store).get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE subject = ?", "Your shipping notice 4411")?.in_inbox).toBe(0);
    await expect(page.getByTestId("action-preview")).toBeHidden();
    const before = sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) AS n FROM filters")!.n;
    // nothing here yet: what it can do is keep the rule for what arrives
    await say(page, "From now on archive zebras");
    await expect(page.getByTestId("action-title")).toHaveText(/zebras/i);
    await expect(page.getByTestId("action-future")).toBeHidden();
    await expect(page.getByTestId("list-empty")).toContainText("New mail that matches will follow this rule.");
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/rule-only-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/rule-only-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.getByTestId("action-apply").click();
    await expect(page.getByTestId("action-preview")).toBeHidden();
    await expect.poll(() => sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) AS n FROM filters")?.n).toBe(before + 1);
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
      // plan 161: every row the preview ever draws, from the first frame: none of the mailbox you were in
      await page.evaluate(() => {
        const seen = ((window as unknown as { previewRows: string[] }).previewRows = []);
        const note = () => document.querySelectorAll<HTMLElement>("[data-testid=thread-row][data-included]").forEach((r) => seen.push(`${performance.now() | 0} ${document.querySelector("[data-testid=action-title]")?.textContent} ${r.innerText.replace(/\n/g, " | ")}`));
        new MutationObserver(note).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-included"] });
      });
      await say(page, "Archive shipping notices older than a month");
      await expect(page.getByTestId("action-preview")).toBeVisible();
      // the rule found three; the check took out the one that isn't about shipping, and says so
      await expect(page.getByTestId("action-title")).toHaveText("2 conversations");
      await expect(page.getByTestId("action-conditions")).toContainText("Inbox");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(rows(page)).toHaveCount(2);
      await expect(page.getByTestId("action-left-out")).toContainText("Left out by AI (1)");
      const seen = await page.evaluate(() => (window as unknown as { previewRows: string[] }).previewRows);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((text) => !/shipping|delivery|tracking/i.test(text))).toEqual([]);
    });

    await scenario("the rule in words in the reader, one count, the sidebar on its scope, the keys on the list (plan 161)", async () => {
      // the same number on the title and the button, and only once the search is done
      await expect(page.getByTestId("action-apply")).toHaveText("Archive 2");
      await expect(page.getByTestId("nav-inbox")).toHaveAttribute("data-active");
      await expect(page.locator("#app-sidebar [data-active]")).toHaveCount(1);
      const rule = page.getByTestId("action-rule");
      // plan 162 (after ai162-r01): Apply and Cancel have one place, the list's header, while the rule shows and while a
      // match is read; the rule holds none. An Archive is the primary
      await expect(page.getByTestId("action-preview").getByTestId("action-apply")).toHaveAttribute("data-variant", "default");
      await expect(page.getByTestId("action-preview").getByTestId("action-cancel")).toBeVisible();
      await expect(rule.getByTestId("action-apply")).toHaveCount(0);
      await expect(page.getByTestId("action-decision")).toHaveCount(0);
      const decided = (await page.getByTestId("action-apply").boundingBox())!;
      // the keys are the buttons' own: no line under the rule repeats them; x is said as what it does, on the one being read
      await expect(page.getByTestId("action-keys")).toHaveCount(0);
      await expect(rule.getByTestId("action-help")).toHaveText("Untick any you want to keep, or press X on the one you’re reading. Click one to read it.");
      // a small archive needs no words about what it'll do
      await expect(rule.getByTestId("action-consequence")).toHaveCount(0);
      // plan 161, pass 2: what Apply does is the title, what was asked the line under it
      await expect(rule.getByTestId("action-rule-title")).toHaveText("Archive 2 conversations");
      await expect(rule.getByTestId("action-rule-request")).toHaveText("“Archive shipping notices older than a month”");
      expect(await rule.getByTestId("action-rule-title").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(await rule.getByTestId("action-rule-request").evaluate((el) => parseFloat(getComputedStyle(el).fontSize)));
      await expect(rule.getByTestId("action-conditions")).toContainText("Older than 30 days");
      // plan 162 (after ai162-r01): the terms are words in the ink, "shipping, delivery or tracking", not chips
      await expect(rule.getByTestId("action-rule-term")).toHaveText(["shipping", "delivery", "tracking"]);
      await expect(rule.getByTestId("action-conditions")).toContainText("shipping, delivery, or tracking");
      expect(await rule.getByTestId("action-rule-term").first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      // the pattern is never in the rows, and a list of words has no exact search to show: it says nothing more
      await expect(rule.getByTestId("action-conditions")).not.toContainText("|");
      await expect(rule.getByTestId("action-details-toggle")).toHaveCount(0);
      // and what it found, from the rows, to check before Apply: who sent them, and when
      await expect(rule.getByTestId("action-found")).toContainText("What it found");
      await expect(rule.getByTestId("action-found-line").first()).not.toBeEmpty();
      // checkboxes to assistive tech: the column's check, and the row's checked state (the cursor stays aria-selected)
      await expect(page.getByRole("checkbox", { name: /^Include / })).toHaveCount(2);
      await expect(page.getByRole("checkbox", { name: /^Include / }).first()).toHaveAttribute("aria-checked", "true");
      await expect(rows(page).first()).toHaveAttribute("aria-checked", "true");
      // the body opens the mail to check it; the rule comes back from the header
      await rows(page).first().getByTestId("row-subject").click();
      await expect(page.getByTestId("reader-subject")).toBeVisible();
      await expect(rows(page).first()).toHaveAttribute("data-included", "true");
      await expect(page.getByTestId("action-sentence")).toContainText("Archive shipping notices older than a month");
      // the decision didn't move
      expect((await page.getByTestId("action-apply").boundingBox())!).toEqual(decided);
      // Codex review: while a match is read, Esc goes back to the rule: Cancel doesn't claim it
      await expect(page.getByTestId("action-cancel")).not.toHaveAttribute("aria-keyshortcuts", "Escape");
      await expect(page.getByTestId("action-show-rule")).toHaveAttribute("aria-keyshortcuts", "Escape");
      // the rule isn't on screen: the header has Apply again, so it's always there exactly once
      await expect(page.getByTestId("action-preview").getByTestId("action-apply")).toHaveText("Archive 2");
      await expect(page.getByTestId("action-apply")).toHaveCount(1);
      await page.getByTestId("action-show-rule").click();
      await expect(page.getByTestId("action-rule")).toBeVisible();
      // the check column, at the row's height, toggles
      const include = rows(page).first().getByTestId("row-include");
      expect((await include.boundingBox())!.height).toBeGreaterThanOrEqual(24);
      await include.click({ position: { x: 10, y: 4 } });
      await expect(rows(page).first()).toHaveAttribute("data-included", "false");
      await expect(page.getByTestId("action-apply")).toHaveText("Archive 1");
      await include.click();
      await expect(page.getByTestId("action-apply")).toHaveText("Archive 2");
    });

    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
    }

    await scenario("Esc while reading a matched conversation closes it, back to the rule with everything kept (plan 161, pass 2)", async () => {
      await rows(page).last().getByTestId("row-include").click();
      await expect(page.getByTestId("action-apply")).toHaveText("Archive 1");
      await rows(page).first().getByTestId("row-subject").click();
      await expect(page.getByTestId("reader-subject")).toBeVisible();
      await page.keyboard.press("Escape");
      // the preview, its request, its ticks and its count: all still here, the rule back in the reader, the keys the list's
      await expect(page.getByTestId("action-preview")).toBeVisible();
      await expect(page.getByTestId("action-rule")).toBeVisible();
      await expect(page.getByTestId("action-rule-request")).toContainText("Archive shipping notices older than a month");
      await expect(rows(page).last()).toHaveAttribute("data-included", "false");
      await expect(page.getByTestId("action-apply")).toHaveText("Archive 1");
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-keep-scroll"))).toBe("list");
      // j/k open one too; Esc closes that first as well
      await page.keyboard.press("j");
      await expect(page.getByTestId("action-rule")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("action-rule")).toBeVisible();
      await rows(page).last().getByTestId("row-include").click();
      await expect(page.getByTestId("action-apply")).toHaveText("Archive 2");
    });

    await scenario("Esc with nothing open goes back with no trace", async () => {
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
      await expect(page.getByTestId("action-title")).toHaveText("2 conversations");
      await page.getByTestId("action-cancel").click();
      await expect(page.getByTestId("action-preview")).toHaveCount(0);
      await expect.poll(() => rows(page).count()).toBeGreaterThan(3);
      await page.getByTestId("nav-inbox").click();
    });

    await scenario("a row out with x, Apply, and the snack's Undo brings them all back", async () => {
      await say(page, "Archive shipping notices older than a month");
      await expect(page.getByTestId("action-title")).toHaveText("2 conversations");
      await page.getByTestId("action-show-left-out").click();
      await expect(rows(page)).toHaveCount(3);
      await expect(rows(page).last()).toHaveAttribute("data-included", "false");
      await rows(page).last().getByTestId("row-include").click();
      await expect(page.getByTestId("action-title")).toHaveText("3 conversations");
      await rows(page).first().click();
      await page.keyboard.press("x");
      await expect(page.getByTestId("action-title")).toHaveText("2 conversations");
      await expect(rows(page).first()).toHaveAttribute("data-included", "false");
      await page.getByTestId("action-apply").click();
      await expect(page.getByTestId("action-preview")).toHaveCount(0);
      await expect(page.getByTestId("snack")).toContainText("Archived 2 conversations");
      // plan 162: the result says what it was for, under the count
      await expect(page.getByTestId("snack")).toContainText("You asked: “Archive shipping notices older than a month”");
      // plan 161: back on the list you came from, its keys yours
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-keep-scroll"))).toBe("list");
      // the first row stayed out of it; the rest left
      await inInbox("Your shipping notice 4411").toBe(1);
      await inInbox("Tracking your delivery 2231").toBe(0);
      await page.keyboard.press("ControlOrMeta+z");
      // a result, not a command
      await expect(page.getByTestId("snack").filter({ hasText: "Moved 2 conversations back to the Inbox" })).toBeVisible();
      await inInbox("Tracking your delivery 2231").toBe(1);
      await inInbox("Shipping delivery tracking 9921").toBe(1);
    });

    await scenario("⌘↩ in a reply sends the reply; it doesn't apply the preview", async () => {
      await say(page, "Archive shipping notices older than a month");
      await expect(page.getByTestId("action-title")).toHaveText("2 conversations");
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

  test("Esc with focus inside a matched HTML mail closes it back to the rule (plan 161, pass 2, Codex review #1)", async ({ app: page, server }) => {
    await ingestConversation(server, { subject: "Shipping notice in HTML 7781", count: 1, html: 1, now: E2E_NOW - 70 * DAY });
    await withMail(page, server);
    await say(page, "Archive shipping notices older than a month");
    await expect(page.getByTestId("action-apply")).toHaveText("Archive 3");
    await rows(page).filter({ hasText: "Shipping notice in HTML 7781" }).getByTestId("row-subject").click();
    await page.frameLocator("[data-testid=reader] iframe >> nth=-1").locator("body").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("action-rule")).toBeVisible();
    await expect(page.getByTestId("action-preview")).toBeVisible();
    await expect(page.getByTestId("action-apply")).toHaveText("Archive 3");
  });

  test("a new category says so, and Undo removes it empty", async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Send recruiters to a Recruiting category");
    await expect(page.getByTestId("action-title")).toHaveText("2 conversations");
    await expect(page.getByTestId("action-rule-title")).toHaveText("Move 2 conversations to Recruiting");
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
    await expect(page.getByTestId("action-title")).toHaveText("2 conversations");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("snack")).toContainText("Archived 2 conversations");
    // z undoes (⌘Z too, in the flow before)
    await expect(page.getByTestId("snack-action")).toHaveAttribute("aria-keyshortcuts", UNDO_KEYS);
    // plan 161, pass 2: the keycap is the platform's undo; bare z still works
    await expect(page.getByTestId("snack-action").locator("[data-key]")).toHaveAttribute("data-key", /^(⌘Z|Ctrl\+Z)$/);
    await page.keyboard.press("z");
    await expect(page.getByTestId("snack").filter({ hasText: "Moved 2 conversations back to the Inbox" })).toBeVisible();
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
    await expect(page.getByTestId("action-title")).toHaveText("2 conversaciones");
    await expect(page.getByTestId("action-rule-title")).toHaveText("Archivar 2 conversaciones");
    await expect(page.getByTestId("action-apply")).toHaveText("Archivar 2");
    await expect(page.getByTestId("action-conditions")).toContainText("Recibidos");
  });

  test("the header sits on the list's content line, in every design, light and dark", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Send recruiters to a Recruiting category");
    await expect(page.getByTestId("action-title")).toHaveText("2 conversations");
    await expect(page.getByTestId("action-rule-title")).toHaveText("Move 2 conversations to Recruiting");
    const left = async (testId: string) => page.getByTestId(testId).first().evaluate((el) => el.getBoundingClientRect().left);
    const box = await page.getByTestId("row-include").first().locator("[data-slot=checkbox]").evaluate((el) => el.getBoundingClientRect().left);
    expect(Math.abs((await left("action-title")) - box)).toBeLessThanOrEqual(1);
    for (const mode of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: mode as "light" | "dark" });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-category-${mode}.png` });
      const results = await new AxeBuilder({ page }).include('[data-testid="action-preview"]').include('[data-keep-scroll="list"]').analyze();
      expect(results.violations.map((v) => `${mode} ${v.id}: ${v.nodes[0]?.html.slice(0, 140)}`)).toEqual([]);
    }
  });

  test("Trash is the destructive button and says what it does, in every design, light and dark (plan 161, pass 3)", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Delete recruiters");
    const rule = page.getByTestId("action-rule");
    const apply = page.getByTestId("action-preview").getByTestId("action-apply");
    await expect(apply).toHaveText("Move 2 to Trash");
    await expect(apply).toHaveAttribute("data-variant", "destructive");
    await expect(rule.getByTestId("action-consequence")).toHaveText("2 conversations go to Trash, from all your mail except Spam and Trash.");
    await expect(rule.getByTestId("action-consequence")).toHaveAttribute("data-destructive", "true");
    // the danger's fill, not the primary's (a design can't turn it back into an Archive's)
    const fills = await page.evaluate(() => {
      const probe = document.createElement("div");
      document.body.append(probe);
      const of = (v: string) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
      const out = { destructive: of("--destructive"), primary: of("--primary") };
      probe.remove();
      return out;
    });
    const bg = await apply.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe(fills.destructive);
    expect(bg).not.toBe(fills.primary);
    for (const mode of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: mode as "light" | "dark" });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-trash-${mode}.png` });
      const results = await new AxeBuilder({ page }).include('[data-testid="action-rule"]').include('[data-testid="action-preview"]').analyze();
      expect(results.violations.map((v) => `${mode} ${v.id}: ${v.nodes[0]?.html.slice(0, 140)}`)).toEqual([]);
    }
  });

  test("a sender the sentence names and the rule doesn't look at is said beside the rule, without a model; Apply still works (plan 161, the owner)", async ({ app: page, server }) => {
    await ingestConversation(server, { subject: "Your trip receipt 5521", count: 1, now: E2E_NOW - 3 * DAY });
    await withMail(page, server);
    // a name the mailbox doesn't have isn't one (the same rule, the same rows)
    await say(page, "Archive receipts from Zyxwbank");
    await expect(page.getByTestId("action-conditions")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("action-sender")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("action-preview")).toHaveCount(0);
    // Uber Receipts (uber.com) has written to this mailbox; the offline model's rule looks only at the subject
    await say(page, "Archive receipts from Uber");
    const said = page.getByTestId("action-rule").getByTestId("action-sender");
    await expect(said).toHaveText("Your sentence names Uber, but this rule doesn’t look at the sender. Check it below, or edit it as a rule.");
    // beside the rule: above what Terno read it as
    expect((await said.boundingBox())!.y).toBeLessThan((await page.getByTestId("action-conditions").boundingBox())!.y);
    await expect(page.getByTestId("action-apply")).toBeEnabled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/sender-split-light.png` });
    await page.getByTestId("action-apply").click();
    await expect.poll(() => sqlDb(server.backend.store).get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE subject = ?", "Your trip receipt 5521")?.in_inbox).toBe(0);
    await expect(page.getByTestId("action-preview")).toBeHidden();
    // the demo's own sentence names nobody: nothing said
    await say(page, "Archive shipping notices older than a month");
    await expect(page.getByTestId("action-apply")).toHaveText("Archive 2");
    await expect(page.getByTestId("action-conditions")).toBeVisible();
    await expect(page.getByTestId("action-sender")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("action-preview")).toHaveCount(0);
  });

  test("what can't be done, and what nothing matches, stay on the page", async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Forward recruiters to my boss");
    await expect(page.getByTestId("ask-command-notice")).toContainText("can't do that from a sentence");
    await expect(page.getByTestId("action-preview")).toHaveCount(0);
    // plan 162 (after ai162-r01): the words stay in the field, selected, to change or send again
    await expect(page.getByTestId("palette-input")).toHaveValue("Forward recruiters to my boss");
    await expect.poll(() => page.getByTestId("palette-input").evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!)).toBe("Forward recruiters to my boss".length);
    await page.keyboard.press("Escape");
    await say(page, "Archive zebras");
    // and a miss says what to try, not only "different words"
    await expect(page.getByTestId("ask-command-notice")).toContainText("Nothing in your mail matches that. Name a sender");
    await expect(page.getByTestId("palette-input")).toHaveValue("Archive zebras");
  });
});

test.describe("actions in plain English, List layout (plan 161)", () => {
  test.use({ layout: "list", viewport: { width: 1100, height: 700 } });

  test("Esc from a matched conversation's page comes back to the preview; a second Esc cancels (plan 161, pass 2)", async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Archive shipping notices older than a month");
    await expect(page.getByTestId("action-apply")).toHaveText("Archive 2");
    // pass 3: List's rule is right under its header, so Apply stays there, beside the outcome
    await expect(page.getByTestId("action-preview").getByTestId("action-apply")).toBeVisible();
    await expect(page.getByTestId("action-decision")).toHaveCount(0);
    // List's header has the window's width: the whole outcome, on one line
    await expect(page.getByTestId("action-title")).toHaveText("Archive 2 conversations");
    await rows(page).first().getByTestId("row-include").click();
    await rows(page).last().getByTestId("row-subject").click();
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("action-preview")).toBeVisible();
    await expect(rows(page).first()).toHaveAttribute("data-included", "false");
    await expect(page.getByTestId("action-apply")).toHaveText("Archive 1");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("action-preview")).toHaveCount(0);
  });

  test("List says the sender check under its header, beside the rule (plan 161, the owner)", async ({ app: page, server }) => {
    await ingestConversation(server, { subject: "Your trip receipt 5521", count: 1, now: E2E_NOW - 3 * DAY });
    await withMail(page, server);
    await say(page, "Archive receipts from Uber");
    const rule = page.getByTestId("action-preview").getByTestId("action-rule");
    await expect(rule.getByTestId("action-sender")).toHaveText(/^Your sentence names Uber, but this rule doesn’t look at the sender\./);
    await expect(rule.getByTestId("action-sender")).toBeInViewport();
    await expect(page.getByTestId("action-preview").getByTestId("action-apply")).toBeEnabled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/sender-list-light.png` });
  });

  test("the rule sits under the header, bounded: Details open, the rows keep their room (Codex review #1)", async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Archive shipping notices older than a month");
    await expect(page.getByTestId("action-apply")).toHaveText("Archive 2");
    const rule = page.getByTestId("action-rule");
    await expect(rule.getByTestId("action-rule-term").first()).toBeVisible();
    expect(await rule.evaluate((el) => [getComputedStyle(el).overflowY, getComputedStyle(el).maxHeight !== "none"])).toEqual(["auto", true]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/list-layout-light.png` });
    const rule0 = (await rule.boundingBox())!;
    expect(rule0.height).toBeLessThanOrEqual(288 + 1);
    const list = (await page.locator('[data-keep-scroll="list"]').boundingBox())!;
    expect(list.height).toBeGreaterThanOrEqual(200);
    await expect(rows(page).first()).toBeInViewport();
    // plan 162 (after ai162-r01): a long term is a word in a sentence now, wrapping with it inside the rule's column
    const term = await rule.getByTestId("action-rule-term").first().evaluate((el) => {
      el.textContent = "a very long phrase the model might have written for the start of a shipping notice ".repeat(4);
      const box = el.getBoundingClientRect(), row = el.closest("dd")!.getBoundingClientRect();
      return box.right <= row.right + 0.5;
    });
    expect(term).toBe(true);
  });
});

test.describe("actions in plain English at 1100 × 700 (plan 161, pass 2)", () => {
  test.use({ viewport: { width: 1100, height: 700 } });

  test("a long rule never scrolls Apply out of reach (Codex review, pass 3, #4)", async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Archive shipping notices older than a month");
    const apply = page.getByTestId("action-preview").getByTestId("action-apply");
    await expect(apply).toHaveText("Archive 2");
    await page.setViewportSize({ width: 1100, height: 320 });
    // the rule is longer than its pane, and the pane rests at its top
    const pane = page.getByTestId("action-rule").locator("> div");
    expect(await pane.evaluate((el) => el.scrollHeight > el.clientHeight + 40 && el.scrollTop === 0)).toBe(true);
    await expect(apply).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("action-preview").getByTestId("action-cancel")).toBeInViewport({ ratio: 1 });
  });

  test("Split's header is one line beside its buttons, and the outcome reads whole in the reader", async ({ app: page, server }) => {
    await withMail(page, server);
    await say(page, "Archive shipping notices older than a month");
    await expect(page.getByTestId("action-apply")).toHaveText("Archive 2");
    // lines a text box holds: its height over its line height (the title's text is the span inside its heading)
    const lines = (testId: string) => page.getByTestId(testId).evaluate((el) => { const box = el.firstElementChild ?? el; const lh = parseFloat(getComputedStyle(box).lineHeight); return Math.round(box.getBoundingClientRect().height / lh); });
    expect(await lines("action-title")).toBe(1);
    expect(await lines("action-rule-title")).toBe(1);
    // the help is its own line, whole. Plan 162 (after ai162-r01): the keys are the header buttons' own; no line repeats them
    await expect(page.getByTestId("action-help")).toHaveText("Untick any you want to keep, or press X on the one you’re reading. Click one to read it.");
    expect(await lines("action-help")).toBeLessThanOrEqual(2);
    await expect(page.getByTestId("action-keys")).toHaveCount(0);
    await expect(page.getByTestId("action-rule")).not.toContainText("brings you back");
    // the one provenance control every AI result has, at the rule's line's end: what it did and how to check it
    await page.getByTestId("action-provenance").click();
    await expect(page.getByTestId("action-provenance-popover")).toContainText("Check the rule and the rows before you apply.");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("action-provenance-popover")).toHaveCount(0);
    await expect(page.getByTestId("action-rule")).toBeVisible();
    // reading one, the way back says its key
    await rows(page).first().getByTestId("row-subject").click();
    await expect(page.getByTestId("action-show-rule")).toContainText("Show the rule");
    await expect(page.getByTestId("action-show-rule")).toHaveAttribute("aria-keyshortcuts", "Escape");
  });
});
