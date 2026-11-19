/**
 * Plan 207: the first screen, asked once when What matters is first offered, and the one number it brings: the question
 * after Settings closes, What matters chosen (the feed at once and at launch, its row's number alone), Settings → General's
 * "Open at launch" back to the Inbox, Esc keeping the Inbox for good; axe on the question, light and dark.
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

test("asked once AI is on, after Settings closes; What matters leads the sidebar, the launch and Settings; Esc keeps the Inbox", async ({ app: page, server }) => {
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
    await expect(question(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(question(page)).toBeVisible();
    await expect(question(page).getByRole("heading")).toHaveText("Start with What matters?");
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
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/what-matters-first.png` });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(today).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("wm-feed")).toBeVisible();
    await expect(question(page)).toHaveCount(0);
  });

  await scenario("Settings → General → Open at launch: found by the search; the Inbox again, its number back, and the launch", async () => {
    await settings(page, "settings general", "general");
    await page.getByTestId("settings-find").fill("launch");
    await expect(page.getByTestId("settings-find-result").first().getByTestId("settings-find-name")).toHaveText("Open at launch");
    await page.getByTestId("settings-find").fill("");
    await expect(page.getByTestId("first-screen-what-matters")).toHaveAttribute("aria-pressed", "true");
    // the Dock's switch says which number it shows
    await expect(page.getByTestId("badge-row")).toContainText(/What matters|app icon/);
    if (SHOTS) await page.getByTestId("first-screen-group").screenshot({ path: `${SHOTS}/setting-light.png` });
    await page.getByTestId("first-screen-inbox").click();
    await expect(page.getByTestId("first-screen-inbox")).toHaveAttribute("aria-pressed", "true");
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
