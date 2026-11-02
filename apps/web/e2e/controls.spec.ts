/**
 * Plans 117 and 118: BoardUI's controls, the base of every design, keep their states: an error border, focus under
 * hover, a disabled fill, and a primary whose text is on fills the contrast suite checks. The real components,
 * rendered to markup here, drawn by the app's own stylesheet in each design, against probes of the token they should show.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { DESIGN_IDS } from "@terno/core";
import { expect, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

// the real components, rendered to markup in a process of their own (helpers/controls-markup.ts says why)
// (run from packages/ui, whose tsconfig compiles the components' JSX)
const ui = new URL("../../../packages/ui/", import.meta.url);
const tsx = createRequire(new URL("package.json", ui)).resolve("tsx/cli");
const markup = execFileSync(process.execPath, [tsx, fileURLToPath(new URL("./helpers/controls-markup.ts", import.meta.url))], { cwd: fileURLToPath(ui), encoding: "utf8" });

const css = (page: Page, id: string, prop: string) => page.getByTestId(id).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

for (const design of DESIGN_IDS) for (const mode of ["light", "dark"] as const) {
  test.describe(`the controls keep their states, ${design} ${mode} (plan 118)`, () => {
    test.use({ design });
    test.beforeEach(async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-design", design);
      await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), markup);
    });

    test("an invalid outline button keeps the error border, hovered too", async ({ app: page }) => {
      const want = await css(page, "probe-destructive", "border-top-color");
      expect(await css(page, "invalid-outline", "border-top-color")).toBe(want);
      await page.getByTestId("invalid-outline").hover();
      expect(await css(page, "invalid-outline", "border-top-color")).toBe(want);
    });

    test("a focused field group keeps its focus border while hovered", async ({ app: page }) => {
      await page.getByTestId("group-input").focus();
      await page.getByTestId("group").hover();
      expect(await css(page, "group", "border-top-color")).toBe(await css(page, "probe-ring", "border-top-color"));
    });

    test("a disabled field keeps the disabled fill", async ({ app: page }) => {
      if (mode === "dark") test.skip(true, "dark keeps its own, more specific disabled fill");
      expect(await css(page, "disabled-input", "background-color")).toBe(await css(page, "probe-disabled", "background-color"));
    });

    test("the primary's gradient runs between primary-hover and primary, the fills its text is checked on", async ({ app: page }) => {
      const stops = [await css(page, "primary", "--tw-gradient-from"), await css(page, "primary", "--tw-gradient-to")].map((s) => s.trim());
      const fills = [await css(page, "probe-primary-hover", "background-color"), await css(page, "probe-primary", "background-color")];
      expect(stops.sort()).toEqual(fills.sort());
      // hovered: no gradient, the plain hover fill
      await page.getByTestId("primary").hover();
      expect(await css(page, "primary", "background-image")).toBe("none");
    });
  });
}
