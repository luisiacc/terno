/**
 * Plan 117: Board's controls (the board: variant) keep the states the shared ones draw: an error border, focus
 * under hover, a disabled fill, and a primary whose text is on fills the contrast suite checks. The real components,
 * rendered to markup here, drawn by the app's own stylesheet in Board, against probes of the token they should show.
 */
import type { Page } from "@playwright/test";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { InputGroup, InputGroupInput } from "@terno/ui/components/input-group";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

const markup = renderToStaticMarkup(
  h(
    "div",
    { id: "board-probe", style: { position: "fixed", inset: "40px auto auto 40px", zIndex: 9999, display: "grid", gap: 8, width: 240, padding: 8 }, className: "bg-background" },
    h(Button, { variant: "outline", "aria-invalid": true, "data-testid": "invalid-outline" }, "Invalid"),
    h(Button, { "data-testid": "primary" }, "Send"),
    h(Input, { disabled: true, "data-testid": "disabled-input", defaultValue: "180" }),
    h(InputGroup, { "data-testid": "group" }, h(InputGroupInput, { "data-testid": "group-input", placeholder: "Search" })),
    h("i", { "data-testid": "probe-destructive", className: "border border-destructive" }),
    h("i", { "data-testid": "probe-ring", className: "border border-ring" }),
    h("i", { "data-testid": "probe-disabled", className: "bg-input/50" }),
    h("i", { "data-testid": "probe-primary-hover", className: "bg-primary-hover" }),
    h("i", { "data-testid": "probe-primary", className: "bg-primary" }),
  ),
);

const css = (page: Page, id: string, prop: string) => page.getByTestId(id).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

for (const mode of ["light", "dark"] as const) {
  test.describe(`Board's controls keep their states, ${mode} (plan 117)`, () => {
    test.use({ design: "board" });
    test.beforeEach(async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-design", "board");
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
