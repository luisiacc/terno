/**
 * Plan 14: English by default; Español from Settings → General switches the
 * whole app at once (no reload), keeps where you were, survives a reload
 * from its first frame, and leaves no English behind; English comes back
 * the same way.
 */
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import type { Page } from "@playwright/test";
import { expect, openRow, rows, selectedId, test } from "./fixtures";
import { englishLeaks } from "./i18n-leaks";

const SETTINGS_TABS = ["general", "appearance", "accounts", "categories", "filters", "ai", "agents", "data"] as const;

async function openSettings(page: Page) {
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("general-tab").waitFor();
}

async function chooseLanguage(page: Page, value: "es" | "en" | "system") {
  await openSettings(page);
  await page.getByTestId("language-select").click();
  await page.getByTestId(`language-${value}`).click();
  await expect(page.locator("html")).toHaveAttribute("lang", value === "es" ? "es-MX" : "en-US");
}

async function expectNoLeaks(page: Page, where: string) {
  expect(await englishLeaks(page), `English left on screen: ${where}`).toEqual([]);
}

test.describe("languages", () => {
  test("English by default on an English system", async ({ app: page }) => {
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(page.getByTestId("list-title")).toHaveText(en["view.inbox"]);
    await openRow(page, 0);
    await expect(page.getByTestId("action-archive")).toHaveAttribute("aria-label", en["actions.archive"]);
    await openSettings(page);
    await expect(page.getByTestId("language-select")).toContainText("System (English)");
  });

  test("Español switches everything at once, keeps where you were, and English comes back", async ({ app: page }) => {
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
    // somewhere to come back to: a conversation open, the list scrolled, a reply being written
    await page.locator("[data-keep-scroll=list]").evaluate((el) => (el.scrollTop = 480));
    const id = await openRow(page, 8);
    await page.keyboard.press("r");
    const body = page.getByTestId("compose-body").first();
    await body.waitFor();
    await body.fill("Borrador que sobrevive al cambio de idioma");
    await page.locator("[data-keep-scroll=list]").evaluate((el) => (el.scrollTop = 480));

    await chooseLanguage(page, "es");
    // no reload, the settings sheet still open on General, focus back on the control
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    await expect(page.getByTestId("general-tab")).toBeVisible();
    await expect(page.getByTestId("language-select")).toBeFocused();
    await expect(page.getByTestId("language-select")).toContainText("Español");
    for (const tab of SETTINGS_TABS) await expect(page.getByTestId(`tab-${tab}`)).toHaveText(es[`settings.tab.${tab}`]);
    await expect(page.getByText(es["diag.settings.title"], { exact: true }).first()).toBeVisible();
    await page.keyboard.press("Escape");

    // the list, the reader and the dates, in Spanish; the same conversation, scroll and draft
    await expect(page.getByTestId("list-title")).toHaveText(es["view.inbox"]);
    await expect(page.getByTestId("action-archive")).toHaveAttribute("aria-label", es["actions.archive"]);
    await expect(page.getByTestId("action-trash")).toHaveAttribute("aria-label", es["actions.trash"]);
    expect(await selectedId(page)).toBe(id);
    await expect.poll(() => page.locator("[data-keep-scroll=list]").evaluate((el) => el.scrollTop)).toBe(480);
    await expect(page.getByTestId("compose-body").first()).toHaveText("Borrador que sobrevive al cambio de idioma");
    const dates = await rows(page).getByTestId("row-date").allTextContents();
    expect(dates.length).toBeGreaterThan(5);
    // Spanish list dates: "09:34", "21 oct", "3 sept 2024": never "AM", "Yesterday" or "Oct 21"
    for (const d of dates) expect(d.trim()).toMatch(/^(\d{2}:\d{2}|\d{1,2} [a-zñé]{3,4}( \d{4})?)$/);
    await expectNoLeaks(page, "main window");

    // the palette
    await page.keyboard.press("Escape");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("palette-input")).toHaveAttribute("placeholder", es["palette.placeholder"]);
    await expect(page.getByText(es["palette.group.goTo"], { exact: true })).toBeVisible();
    await expectNoLeaks(page, "palette");
    await page.keyboard.press("Escape");

    // a snack: archive, its message and its undo in Spanish
    await openRow(page, 2);
    await page.keyboard.press("e");
    await expect(page.getByTestId("snack-message")).toContainText(es["actions.done.archive"]);
    await expect(page.getByTestId("snack-dock").getByRole("button", { name: es["common.undo"] }).first()).toBeVisible();
    await expectNoLeaks(page, "snack");
    await page.keyboard.press("z");

    // the print sheet
    await openRow(page, 0);
    await page.keyboard.press("Meta+p");
    await page.getByTestId("print-sheet").waitFor();
    await expectNoLeaks(page, "print sheet");
    await page.keyboard.press("Escape");

    // English again, the same way
    await chooseLanguage(page, "en");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("list-title")).toHaveText(en["view.inbox"]);
    await expect(page.getByTestId("action-archive")).toHaveAttribute("aria-label", en["actions.archive"]);
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  });

  test("no English anywhere in Spanish: every settings tab and the main surfaces", async ({ app: page }) => {
    await chooseLanguage(page, "es");
    for (const tab of SETTINGS_TABS) {
      await page.getByTestId(`tab-${tab}`).click();
      await page.getByTestId(`${tab}-tab`).waitFor();
      await expectNoLeaks(page, `settings → ${tab}`);
    }
    await page.keyboard.press("Escape");
    await expectNoLeaks(page, "inbox");
    for (const nav of ["nav-starred", "nav-sent", "nav-archive", "nav-trash"]) {
      await page.getByTestId(nav).click();
      await expectNoLeaks(page, nav);
    }
    // the shortcuts dialog
    await page.getByTestId("nav-inbox").click();
    await page.keyboard.press("Shift+Slash");
    await page.getByRole("dialog").waitFor();
    await expectNoLeaks(page, "shortcuts");
    await page.keyboard.press("Escape");
    // a selection and its bar
    await rows(page).nth(0).click({ modifiers: ["Meta"] });
    await rows(page).nth(1).click({ modifiers: ["Meta"] });
    await expectNoLeaks(page, "selection");
  });

  test("Spanish holds across a reload, from the first frame", async ({ app: page }) => {
    await chooseLanguage(page, "es");
    await page.keyboard.press("Escape");
    // what the first frame shows, before the backend answers
    await page.addInitScript(() => {
      new MutationObserver(() => {
        const w = window as unknown as { __firstLang?: string };
        if (!w.__firstLang && document.querySelector("#root > *")) w.__firstLang = document.documentElement.lang;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    expect(await page.evaluate(() => (window as unknown as { __firstLang?: string }).__firstLang)).toBe("es-MX");
    await expect(page.getByTestId("list-title")).toHaveText(es["view.inbox"]);
  });

  test("typing on the closed Language control applies the choice too", async ({ app: page }) => {
    await openSettings(page);
    await page.getByTestId("language-select").focus();
    await page.keyboard.type("Esp");
    await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
    await expect(page.getByTestId("tab-general")).toHaveText(es["settings.tab.general"]);
    await expect.poll(() => page.evaluate(() => { const a = document.activeElement as HTMLElement; return a?.id === "language-select" ? "language-select" : `${a?.tagName} ${a?.getAttribute("role")} ${a?.dataset.testid} ${a?.className.slice(0, 60)}`; })).toBe("language-select");
    // and it was saved: still Spanish after a reload
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(page.getByTestId("list-title")).toHaveText(es["view.inbox"]);
  });

  test("System follows the browser's language", async ({ app: page }) => {
    await chooseLanguage(page, "es");
    await openSettings(page);
    await page.getByTestId("language-select").click();
    await page.getByTestId("language-system").click();
    // this browser is en-US
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(page.getByTestId("language-select")).toContainText("System (English)");
  });
});
