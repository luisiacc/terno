/**
 * Plan 204: Relief's depth, measured in the running app: raised controls carry its rim and lit edge, tracks and fields are
 * sunk, Settings' groups are raised cards, and the switch is the picture's pale track and plain disc. A nested preview of
 * another design draws flat, and macOS (flat) draws exactly the shadows it did before depth was a design value.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, fresh, scenario, test } from "./fixtures";

// the real components, rendered to markup as controls.spec.ts does (helpers/controls-markup.ts says why)
const ui = new URL("../../../packages/ui/", import.meta.url);
const tsx = createRequire(new URL("package.json", ui)).resolve("tsx/cli");
const markup = execFileSync(process.execPath, [tsx, fileURLToPath(new URL("./helpers/controls-markup.ts", import.meta.url))], { cwd: fileURLToPath(ui), encoding: "utf8" });
const addControls = (page: Page) => page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), markup);

/** The layers of a computed box-shadow that draw something (Tailwind composes empty ones for rings it isn't drawing) */
const layers = (el: Locator) => el.evaluate((node) => {
  const s = getComputedStyle(node).boxShadow;
  return s === "none" ? 0 : s.split(/,(?![^(]*\))/).filter((l) => !/^\s*rgba\(0, 0, 0, 0\) 0px 0px 0px 0px\s*$/.test(l)).length;
});
const shadow = (el: Locator) => el.evaluate((node) => getComputedStyle(node).boxShadow);
const insets = (el: Locator) => el.evaluate((node) => (getComputedStyle(node).boxShadow.match(/inset/g) ?? []).length);

test.describe("Relief (plan 204)", () => {
  test.use({ design: "relief" });

  test("raised, sunk and lit as the pictures are", async ({ app: page }) => {
    await scenario("the real controls: raised pills ringed and lit, tracks and fields sunk, words pressed in", async () => {
      await addControls(page);
      // the outline button: a white ring inside its rim, the lit top edge, a contact shadow and a drop
      const outline = page.getByTestId("state-outline");
      expect(await insets(outline)).toBe(2);
      expect(await layers(outline)).toBeGreaterThanOrEqual(4);
      expect(await outline.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
      expect(await outline.evaluate((el) => getComputedStyle(el).textShadow)).not.toBe("none");
      // the primary: the ink's rim and lift
      expect(await layers(page.getByTestId("primary"))).toBeGreaterThanOrEqual(4);
      // the segmented control: a sunk track, the chosen item raised with its rim in the shadow
      expect(await insets(page.getByTestId("segmented"))).toBe(2);
      expect(await layers(page.getByTestId("segmented-on"))).toBeGreaterThanOrEqual(5);
      // a field is sunk
      expect(await insets(page.getByTestId("group"))).toBeGreaterThanOrEqual(1);
    });
    await scenario("Settings: raised cards, the pale switch with its rim and a plain disc, the chosen tab lifted", async () => {
      await fresh(page);
      await page.keyboard.press("Meta+,");
      const dialog = page.getByTestId("settings-dialog");
      const group = dialog.locator(".card-group").first();
      await expect(group).toHaveCSS("border-radius", "18px");
      expect(await group.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      expect(await layers(group)).toBeGreaterThanOrEqual(4);
      const off = dialog.locator('[data-slot="switch"][data-unchecked]').first();
      expect(await insets(off)).toBe(2);
      // the chip is the flat designs' only
      expect(await off.locator('[data-slot="switch-thumb"]').evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("0");
      expect(await insets(off.locator('[data-slot="switch-thumb"]'))).toBe(1);
      expect(await layers(off.locator('[data-slot="switch-thumb"]'))).toBeGreaterThanOrEqual(4);
      expect(await layers(dialog.locator('[data-settings-tab][data-active]'))).toBe(3);
      // a nested preview of a flat design draws flat
      await page.getByTestId("tab-appearance").click();
      const lumen = page.getByTestId("design-card-lumen").locator('[data-design="lumen"]');
      expect(await lumen.evaluate((el) => [getComputedStyle(el).getPropertyValue("--depth-well").trim(), getComputedStyle(el).getPropertyValue("--emboss").trim()])).toEqual(["0 0 transparent", "none"]);
    });
    await scenario("a plain select stays plain: the composer's From has no sheen or pressed-in words (Codex code review)", async () => {
      await fresh(page);
      await page.keyboard.press("c");
      const from = page.getByTestId("compose-from");
      await expect(from).toBeVisible();
      expect(await from.evaluate((el) => [getComputedStyle(el).backgroundImage, getComputedStyle(el).textShadow])).toEqual(["none", "none"]);
    });
  });
});

test.describe("a flat design keeps what it drew (plan 204)", () => {
  test("macOS: the same shadows as before depth was a design value", async ({ app: page }) => {
    await scenario("the real controls", async () => {
      await addControls(page);
      // what Tailwind's shadow-xs draws, for comparison
      const xs = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement("i"));
        probe.className = "shadow-xs";
        const s = getComputedStyle(probe).boxShadow;
        probe.remove();
        return s;
      });
      expect(await shadow(page.getByTestId("state-outline"))).toBe(xs);
      expect(await shadow(page.getByTestId("segmented-on"))).toBe(xs);
      expect(await page.getByTestId("state-outline").evaluate((el) => [getComputedStyle(el).backgroundImage, getComputedStyle(el).textShadow])).toEqual(["none", "none"]);
      expect(await layers(page.getByTestId("primary"))).toBe(2);
      // the track has no shadow worth drawing
      expect(await layers(page.getByTestId("segmented"))).toBe(0);
    });
  });
});
