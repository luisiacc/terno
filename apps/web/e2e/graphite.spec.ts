/**
 * Plan 137: what the blueprint asks of the running app, measured rather than read from the design file: every word on
 * screen at 12, 13, 14 or 24 px, regular or medium, at -0.15px; 14 px navigation icons on the section labels' line;
 * pill buttons but not pill toolbars. The other designs draw what they did, and a nested preview draws in its own design.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, openRow, test, fresh, scenario } from "./fixtures";

// the real components, rendered to markup as controls.spec.ts does (helpers/controls-markup.ts says why)
const ui = new URL("../../../packages/ui/", import.meta.url);
const tsx = createRequire(new URL("package.json", ui)).resolve("tsx/cli");
const markup = execFileSync(process.execPath, [tsx, fileURLToPath(new URL("./helpers/controls-markup.ts", import.meta.url))], { cwd: fileURLToPath(ui), encoding: "utf8" });
const addControls = (page: Page) => page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), markup);

/** Hidden text and other designs' previews; MICRO is the marks drawn inside a shape (initials, a file type: source-scan.test.ts lists them). */
const MICRO = ["7px", "9.5px", "10px"];
const EXEMPT = '.sr-only, [data-slot="avatar"], [data-design] [data-design]';

/** Each visible run of text that strays from the blueprint: "<size> <weight> <spacing> <tag> '<text>'". */
const strays = (page: Page) =>
  page.evaluate(([exempt, micro]) => {
    const out = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const el = node.parentElement;
      // words only: the quote toggle's ••• is a drawn mark
      if (!text || !/[\p{L}\p{N}]/u.test(text) || !el || el.closest(exempt) || el.closest("script, style") || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const s = getComputedStyle(el);
      if (![...micro, "12px", "13px", "14px", "24px"].includes(s.fontSize) || !["400", "500"].includes(s.fontWeight) || s.letterSpacing !== "-0.15px") {
        out.add(`${s.fontSize} ${s.fontWeight} ${s.letterSpacing} ${el.tagName.toLowerCase()} '${text.slice(0, 30)}'`);
      }
    }
    return [...out];
  }, [EXEMPT, MICRO] as const);

test.describe("Graphite (plan 137)", () => {
  test.use({ design: "graphite" });

  test("Graphite: the blueprint's words, its icons and rhythm, pills and corners, Settings' cards", async ({ app: page }) => {
    await scenario("every word is on the blueprint: inbox, reader, reply, new message, palette and Settings", async () => {
      expect(await strays(page), "inbox").toEqual([]);
      await openRow(page, 1);
      expect(await strays(page), "reader").toEqual([]);
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-send")).toBeVisible();
      expect(await strays(page), "reply").toEqual([]);
      await page.keyboard.press("Meta+k");
      await expect(page.getByTestId("palette-input")).toBeVisible();
      expect(await strays(page), "palette").toEqual([]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Meta+,");
      await expect(page.getByTestId("settings-dialog")).toBeVisible();
      expect(await strays(page), "settings").toEqual([]);
    });
    await scenario("navigation icons are 14 px, on the section labels' left edge and the new-message row's", async () => {
      await fresh(page);
      const sidebar = page.getByTestId("sidebar");
      const icon = sidebar.getByRole("button", { name: /^Inbox/ }).locator("svg").first();
      await expect(icon).toHaveCSS("width", "14px");
      await expect(icon).toHaveCSS("height", "14px");
      const left = async (selector: ReturnType<Page["locator"]>) => (await selector.boundingBox())!.x;
      const label = await left(sidebar.getByText("Categories", { exact: true }));
      expect(Math.abs((await left(icon)) - label)).toBeLessThan(0.51);
      expect(Math.abs((await left(page.getByTestId("compose-button").locator("svg"))) - label)).toBeLessThan(0.51);
    });
    await scenario("the sidebar keeps the blueprint's rhythm: 12 px insets, one 28 px pitch from New message on, 13 px rows under 12 px labels", async () => {
      await fresh(page);
      const sidebar = page.getByTestId("sidebar");
      const row = (name: RegExp) => sidebar.getByRole("button", { name });
      const label = sidebar.getByText("Categories", { exact: true });
      const box = async (l: ReturnType<Page["locator"]>) => (await l.boundingBox())!;
      const middle = async (l: ReturnType<Page["locator"]>) => {
        const b = await box(l);
        return b.y + b.height / 2;
      };
      const aside = await box(sidebar);
      expect(aside.width).toBe(216);
      const inbox = await box(row(/^Inbox/));
      expect(inbox.x - aside.x).toBe(12);
      expect(aside.x + aside.width - (inbox.x + inbox.width)).toBe(12);
      const y = await Promise.all([page.getByTestId("compose-button"), row(/^Inbox/), row(/^Starred/), page.getByTestId("nav-more")].map(middle));
      expect(y.slice(1).map((v, i) => v - y[i]!)).toEqual([28, 28, 28]);
      // a section: 47 px from the row above to its label, 29 px from the label to its first row
      const first = page.locator('[data-testid^="nav-category-"]').first();
      expect((await middle(label)) - y[3]!).toBeCloseTo(47, 0);
      expect((await middle(first)) - (await middle(label))).toBeCloseTo(29, 0);
      await expect(row(/^Starred/)).toHaveCSS("font-size", "13px");
      await expect(page.getByTestId("compose-button")).toHaveCSS("font-size", "13px");
      await expect(label).toHaveCSS("font-size", "12px");
      // Filters sits on the rows' icon line, though its fill starts wider
      const filters = await box(page.getByTestId("open-filters").locator("svg"));
      expect(Math.abs(filters.x - (await box(row(/^Inbox/).locator("svg").first())).x)).toBeLessThan(2.01);
    });
    await scenario("a button with words is a pill and a toolbar's is not; nav rows are 8 px", async () => {
      await fresh(page);
      await expect(page.getByTestId("sidebar").getByRole("button", { name: /^Inbox/ })).toHaveCSS("border-radius", "8px");
      await openRow(page, 1);
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-send-group")).toHaveCSS("border-radius", "9999px");
      await expect(page.getByRole("button", { name: "Archive", exact: true }).first()).toHaveCSS("border-radius", "8px");
    });
    await scenario("the real buttons: words are pills, icons keep the ladder, and a nested design draws its own corners", async () => {
      await fresh(page);
      await addControls(page);
      for (const id of ["primary", "danger", "outline-off"]) await expect(page.getByTestId(id), id).toHaveCSS("border-radius", "9999px");
      await expect(page.getByTestId("icon-ghost")).toHaveCSS("border-radius", "8px");
      await expect(page.getByTestId("nested-primary")).toHaveCSS("border-radius", "10px");
    });
    await scenario("Settings groups are 16 px outlined cards, and a nested preview keeps its own design", async () => {
      await fresh(page);
      await page.keyboard.press("Meta+,");
      const group = page.getByTestId("settings-dialog").locator(".card-group").first();
      await expect(group).toHaveCSS("border-radius", "16px");
      await expect(group).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.getByTestId("tab-appearance").click();
      const preview = page.getByTestId("design-card-macos").locator('[data-design="macos"]');
      await expect(preview).toHaveCSS("letter-spacing", "normal");
      expect(await preview.evaluate((el) => getComputedStyle(el).getPropertyValue("--cta-floor").trim())).toBe("0px");
    });
  });

});

test.describe("the other designs keep what they drew (plan 137)", () => {
  test("macOS keeps what it drew: buttons, tracking, nav icons, Send and Settings' groups", async ({ app: page }) => {
    await scenario("macOS: its real buttons keep their 8 px corners", async () => {
      await addControls(page);
      for (const id of ["primary", "danger", "outline-off"]) await expect(page.getByTestId(id), id).toHaveCSS("border-radius", "8px");
    });
    await scenario("macOS: no base tracking, 16 px nav icons, Send's 6 px corner and 12.8 px label, 10 px Settings groups", async () => {
      await fresh(page);
      await expect(page.locator("html")).toHaveCSS("letter-spacing", "normal");
      await expect(page.getByTestId("sidebar").getByRole("button", { name: /^Inbox/ }).locator("svg").first()).toHaveCSS("width", "16px");
      await openRow(page, 1);
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-send-group")).toHaveCSS("border-radius", "6px");
      await expect(page.getByTestId("compose-send")).toHaveCSS("font-size", "12.8px");
      await page.keyboard.press("Meta+,");
      const group = page.getByTestId("settings-dialog").locator(".card-group").first();
      await expect(group).toHaveCSS("border-radius", "10px");
    });
  });

});
