/**
 * Plan 207: the first screen, asked once when What matters is first offered: the question after Settings closes, What
 * matters chosen (the feed at once and at launch, the Inbox's number hidden unless kept, the Dock's What matters'), Settings
 * → General's "Open at launch" back to the Inbox, Esc keeping the Inbox for good; axe on the question, light and dark.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, scenario, test } from "./fixtures";

test.use({ today: true, firstScreen: null, backendOptions: { devAi: { anthropic: "invented-anthropic-key" } } });

const SHOTS = process.env.FIRST_SCREEN_SHOTS;
const question = (page: Page) => page.getByTestId("first-screen-question");
const drawn = (row: Locator) => row.locator("[data-slot=nav-count]");
/** what a row's number is said as, drawn or not (its description) */
const said = (row: Locator) => row.evaluate((el) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? "");

async function settings(page: Page, query: string, tab: string): Promise<void> {
  await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill(query);
  await expect(page.getByRole("option", { selected: true })).toHaveAttribute("data-testid", `palette-settings-${tab}`);
  await page.keyboard.press("Enter");
}

/** the installed web app's icon number (Badging API), as the page last set it; -1: never set */
const appBadge = (page: Page) => page.evaluate(() => (window as unknown as { __badge?: number }).__badge ?? -1);

test("asked once AI is on, after Settings closes; What matters leads the sidebar, the launch and Settings; Esc keeps the Inbox", async ({ app: page, server }) => {
  // every load from here on has the Badging API, recorded (the next reload's page shows the app icon's number)
  await page.addInitScript(() => {
    const w = window as unknown as { __badge?: number };
    Object.assign(navigator, { setAppBadge: async (n?: number) => void (w.__badge = n ?? 0), clearAppBadge: async () => void (w.__badge = 0) });
  });
  const inbox = page.getByTestId("nav-inbox");
  const today = page.getByTestId("nav-today");
  // a mailbox with unread mail: the Inbox's number is the sidebar's while it leads
  await expect(drawn(inbox)).toHaveText(/^\d+$/);
  const unread = await drawn(inbox).textContent();

  await scenario("AI turned on in Settings: asked when Settings closes, never over it", async () => {
    await settings(page, "settings dev mode", "dev");
    await page.getByTestId("dev-ai-switch").click();
    await expect(page.getByTestId("dev-ai-on")).toBeVisible();
    await expect(today).toBeVisible();
    // the Inbox leads until asked, and What matters shows its number all the same (the owner)
    await expect(drawn(today)).toHaveText(/^[1-9]\d*$/);
    await expect(page.locator("#today-count-help")).toContainText(`${await drawn(today).textContent()} need`);
    await expect(drawn(inbox)).toHaveText(unread!);
    await expect(question(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(question(page)).toBeVisible();
    await expect(question(page).getByRole("heading")).toHaveText("Want to try the “What matters” view?");
    await expect(page.getByTestId("first-screen-choose-what-matters")).toBeFocused();
    if (SHOTS) await question(page).screenshot({ path: `${SHOTS}/question-light.png` });
    expect((await new AxeBuilder({ page }).include("[data-testid=first-screen-question]").analyze()).violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    if (SHOTS) await question(page).screenshot({ path: `${SHOTS}/question-dark.png` });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/question-window-dark.png` });
    expect((await new AxeBuilder({ page }).include("[data-testid=first-screen-question]").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "light" });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/question-window-light.png` });
  });

  await scenario("What matters chosen: the feed at once, its number the sidebar's, the Inbox's said but not drawn; the launch too", async () => {
    await page.getByTestId("first-screen-choose-what-matters").click();
    await expect(question(page)).toHaveCount(0);
    await expect(today).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("wm-feed")).toBeVisible();
    await expect(drawn(inbox)).toHaveCount(0);
    expect(await said(inbox)).toBe(`${unread} unread`);
    // its number drawn, the one its description says (the demo's feed has people waiting on you)
    await expect(drawn(today)).toHaveText(/^[1-9]\d*$/);
    const needs = (await drawn(today).textContent())!;
    await expect(page.locator("#today-count-help")).toContainText(`${needs} need`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/what-matters-first.png` });
    // the launch asks for the feed once (Codex code review #5: bootstrap's own place is boot's first list)
    const feed = server.backend.today as unknown as { list: (...a: unknown[]) => unknown };
    const list = feed.list;
    let asked = 0;
    feed.list = (...a) => (asked++, list.apply(feed, a));
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(today).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("wm-feed")).toBeVisible();
    await expect(question(page)).toHaveCount(0);
    expect(asked).toBe(1);
    feed.list = list;
    // the app icon shows What matters' number, not the Inbox's
    await expect.poll(() => appBadge(page)).toBe(Number(needs));
    // List's own address (#/, no conversation in it) is a launch too (Codex code review #1)
    await server.backend.server.invoke("settings.update", { layout: "list" }, { clientId: "setup", origin: "dev" as const });
    await page.evaluate(() => history.replaceState(null, "", "#/"));
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(today).toHaveAttribute("data-active", "true");
    await server.backend.server.invoke("settings.update", { layout: "split" }, { clientId: "setup", origin: "dev" as const });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
  });

  await scenario("Settings → What matters → Open at launch: found by the search in its own section; the Inbox again, its number back, and the launch", async () => {
    await settings(page, "settings general", "general");
    // plan 247: nothing of What matters is left in General; the app icon's switch says which number it shows
    await expect(page.getByTestId("first-screen-row")).toHaveCount(0);
    await expect(page.getByTestId("today-show")).toHaveCount(0);
    await expect(page.getByTestId("badge-row")).toContainText("Show the “What matters” number on the app icon");
    await expect(page.getByTestId("badge-row")).toContainText("What needs you in “What matters”, the same number as in the sidebar.");
    // plan 273: notifications follow it too
    await expect(page.getByTestId("notify-row")).toContainText("New mail that needs you in “What matters”, while this tab is open in the background.");
    if (SHOTS) {
      await page.getByTestId("notifications-group").screenshot({ path: `${SHOTS}/notify-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.getByTestId("notifications-group").screenshot({ path: `${SHOTS}/notify-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.getByTestId("settings-find").fill("launch");
    const result = page.getByTestId("settings-find-result").first();
    await expect(result.getByTestId("settings-find-name")).toHaveText("Open at launch");
    await result.click();
    await expect(page.getByTestId("tab-whatMatters")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("first-screen-what-matters")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("first-screen-what-matters")).toBeInViewport();
    if (SHOTS) await page.getByTestId("wm-settings-view").screenshot({ path: `${SHOTS}/setting-light.png` });
    // the Inbox's number, hidden while What matters leads, kept by its switch; the app icon stays What matters'
    const keep = page.getByTestId("keep-inbox-count");
    await expect(keep).not.toBeChecked();
    await keep.click();
    await expect(keep).toBeChecked();
    await expect(drawn(inbox)).toHaveText(unread!);
    await expect(drawn(today)).toHaveText(/^[1-9]\d*$/);
    await expect.poll(() => appBadge(page)).toBe(Number(await drawn(today).textContent()));
    await keep.click();
    await expect(drawn(inbox)).toHaveCount(0);
    await page.getByTestId("first-screen-inbox").click();
    // the switch is What matters-first's alone
    await expect(page.getByTestId("keep-inbox-count-row")).toHaveCount(0);
    await expect(page.getByTestId("first-screen-inbox")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("tab-general").click();
    await expect(page.getByTestId("badge-row")).toContainText("Show unread count on the app icon");
    await expect(page.getByTestId("notify-row")).toContainText("New mail from people you’ve written to, replies in your conversations, and mail Gmail marks important");
    await expect.poll(() => appBadge(page)).toBe(Number(unread));
    await page.keyboard.press("Escape");
    await expect(drawn(inbox)).toHaveText(unread!);
    // the screen you're on stays: it decides launches
    await expect(today).toHaveAttribute("data-active", "true");
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(inbox).toHaveAttribute("data-active", "true");
  });

  await scenario("not asked yet at launch (AI on already): asked; Esc keeps the Inbox, and it's never asked again", async () => {
    await server.backend.server.invoke("settings.update", { firstScreen: null }, { clientId: "setup", origin: "dev" as const });
    await page.reload();
    await expect(question(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(question(page)).toHaveCount(0);
    await expect(inbox).toHaveAttribute("data-active", "true");
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(drawn(inbox)).toHaveText(unread!);
    await expect(question(page)).toHaveCount(0);
  });
});
