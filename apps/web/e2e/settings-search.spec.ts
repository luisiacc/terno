/**
 * Plan 203: Settings' search. Every setting on every page, its placement and why it matched in the dropdown; a choice
 * opens the section (and page, and account) with the setting marked and its control focused; Esc steps back a level
 * at a time; ⌘F finds; axe on the open dropdown in light and dark.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, fresh, scenario, test } from "./fixtures";

const dialog = (page: Page) => page.getByTestId("settings-dialog");
const field = (page: Page) => page.getByTestId("settings-find");
const popup = (page: Page) => page.getByTestId("settings-find-popup");
const results = (page: Page) => page.getByTestId("settings-find-result");
const setting = (page: Page, id: string) => dialog(page).locator(`[data-setting="${id}"]`).first();

async function find(page: Page, query: string) {
  // (a fill of the text already there changes nothing, and opens nothing)
  await field(page).fill("");
  await field(page).fill(query);
  await expect(popup(page)).toBeVisible();
}

async function open(page: Page) {
  await page.getByTestId("open-settings").click();
  await expect(dialog(page)).toBeVisible();
}

test("Settings' search finds every kind of setting, says where and why, and opens it", async ({ app: page }) => {
  await scenario("⌘F finds; a name match opens its section with the row marked and its switch focused; the query stays", async () => {
    await open(page);
    await page.getByTestId("tab-appearance").click();
    await page.keyboard.press("Meta+f");
    await expect(field(page)).toBeFocused();
    await find(page, "undo");
    const first = results(page).first();
    await expect(first.getByTestId("settings-find-name")).toHaveText("Undo send");
    await expect(first.getByTestId("settings-find-where")).toHaveText(/General.*Writing/);
    // the name shows why: no third line
    await expect(first.getByTestId("settings-find-why")).toHaveCount(0);
    await expect(first).toHaveAttribute("data-highlighted");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tab-general")).toHaveAttribute("aria-selected", "true");
    await expect(setting(page, "general.undoSend")).toHaveAttribute("data-found", "on");
    await expect(page.getByTestId("undo-send-switch")).toBeFocused();
    await expect(popup(page)).toHaveCount(0);
    await expect(field(page)).toHaveValue("undo");
    // the mark goes by itself
    await expect(setting(page, "general.undoSend")).not.toHaveAttribute("data-found", { timeout: 4000 });
    // back in the field, ↓ shows the same results again
    await page.keyboard.press("Meta+f");
    await expect(field(page)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(results(page).first().getByTestId("settings-find-name")).toHaveText("Undo send");
  });

  await scenario("a description match shows its words; a related word says it matched", async () => {
    await find(page, "whoosh");
    await expect(results(page).first().getByTestId("settings-find-name")).toHaveText("Send sound");
    const why = results(page).first().getByTestId("settings-find-why");
    await expect(why).toContainText("soft whoosh");
    await expect(why.locator("mark")).toHaveText("whoosh");
    await find(page, "unsend");
    await expect(results(page).first().getByTestId("settings-find-name")).toHaveText("Undo send");
    await expect(results(page).first().getByTestId("settings-find-why")).toHaveText("Matches “unsend”");
    await find(page, "zzqx");
    await expect(page.getByTestId("settings-find-none")).toHaveText("No settings match “zzqx”");
  });

  await scenario("an account's setting is a result per account, and opens that account", async () => {
    await find(page, "signature");
    const count = await results(page).count();
    expect(count).toBeGreaterThan(0);
    const first = results(page).first();
    await expect(first.getByTestId("settings-find-where")).toHaveText(/^Accounts/);
    // the pointer chooses too
    await first.click();
    await expect(page.getByTestId("tab-accounts")).toHaveAttribute("aria-selected", "true");
    const row = setting(page, "account.signature");
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-found", "on");
    await expect(row.locator("textarea")).toBeFocused();
    await expect(field(page)).toHaveValue("signature");
  });

  await scenario("a Writing style setting opens that page; another AI setting leaves it", async () => {
    await find(page, "clear all");
    const first = results(page).first();
    await expect(first.getByTestId("settings-find-where")).toHaveText(/AI.*Drafting.*Writing style/);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("writing-style-back")).toBeVisible();
    await expect(setting(page, "style.clear")).toHaveAttribute("data-found", "on");
    await page.keyboard.press("Meta+f");
    await find(page, "summarize new");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("writing-style-back")).toHaveCount(0);
    await expect(setting(page, "ai.summaries")).toHaveAttribute("data-found", "on");
  });

  await scenario("a setting under a switch that's off opens the switch", async () => {
    await page.keyboard.press("Meta+f");
    await find(page, "nudge");
    await expect(results(page).first().getByTestId("settings-find-where")).toHaveText(/AI.*Follow-ups/);
    await page.keyboard.press("Enter");
    await expect(setting(page, "ai.followups")).toHaveAttribute("data-found", "on", { timeout: 4000 });
  });

  await scenario("a group comes into view untinted: only rows are marked (owner, 2026-11-12)", async () => {
    await page.keyboard.press("Meta+f");
    await find(page, "account");
    await results(page).filter({ hasText: "Your Terno account" }).first().click();
    await expect(page.getByTestId("tab-accounts")).toHaveAttribute("aria-selected", "true");
    await expect(setting(page, "accounts.owner")).toBeInViewport();
    await expect(dialog(page).locator("[data-found]")).toHaveCount(0);
  });

  await scenario("a Gmail account's photos from Google open on Appearance, that account's row (Codex code review)", async () => {
    await page.keyboard.press("Meta+f");
    await find(page, "photos google personal");
    const first = results(page).first();
    await expect(first.getByTestId("settings-find-where")).toHaveText(/Appearance.*Sender pictures.*Personal/);
    await page.keyboard.press("Enter");
    await expect(dialog(page).locator("[data-setting='appearance.googlePhotos'][data-found]")).toHaveCount(1);
  });

  await scenario("Snippets opens its list even with a snippet open in its editor (Codex code review)", async () => {
    await page.getByTestId("tab-snippets").click();
    await page.getByTestId("settings-snippet-new").click();
    await expect(page.getByTestId("snippet-name")).toBeFocused();
    await page.keyboard.press("Meta+f");
    await find(page, "snippets");
    await page.keyboard.press("Enter");
    // the list (a group: in view, untinted) in place of the editor
    await expect(page.getByTestId("snippet-name")).toHaveCount(0);
    await expect(setting(page, "snippets.list")).toBeInViewport();
  });

  await scenario("Esc closes the list, then empties the field, then closes Settings", async () => {
    await page.keyboard.press("Meta+f");
    await find(page, "mode");
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(field(page)).toHaveValue("mode");
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(field(page)).toHaveValue("");
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
  });

  await scenario("axe finds nothing serious on the open list, light and dark; each result is named by its setting", async () => {
    await fresh(page);
    await open(page);
    await page.keyboard.press("Meta+f");
    await find(page, "theme");
    await expect(page.getByRole("listbox", { name: "Settings found" })).toBeVisible();
    await expect(page.getByRole("option").first()).toHaveAccessibleName(/theme/i);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const r = await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=settings-find-popup]").include("[data-testid=settings-dialog]").analyze();
      expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id), scheme).toEqual([]);
      if (process.env.SETTINGS_SHOTS) await page.screenshot({ path: `${process.env.SETTINGS_SHOTS}/find-${test.info().project.name}-${scheme}.png` });
    }
    if (!process.env.SETTINGS_SHOTS) return;
    // the marked row, looked at in both schemes (not asserted: the pictures are for review)
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.keyboard.press("Meta+f");
      await find(page, "account color");
      await page.keyboard.press("Enter");
      await expect(setting(page, "account.color")).toHaveAttribute("data-found", "on");
      await expect(popup(page)).toHaveCount(0);
      await page.screenshot({ path: `${process.env.SETTINGS_SHOTS}/found-${test.info().project.name}-${scheme}.png` });
    }
  });
});
