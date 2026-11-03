/**
 * Plans 117, 118 and 120: the base controls of every design keep their states: an error border, focus under
 * hover, a disabled fill, and a primary whose text is on fills the contrast suite checks. The real components,
 * rendered to markup here, drawn by the app's own stylesheet in each design, against probes of the token they should show.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { DESIGN_IDS } from "@terno/core";
import { expect, focusList, openRow, test } from "./fixtures";

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

    // plan 120: BoardUI's segmented control, tabs, avatar and divider
    test("the segmented control: a track with a raised thumb, corners concentric", async ({ app: page }) => {
      await segmented(page, "segmented", "segmented-on", "segmented-off", mode);
    });

    test("tabs: the default list is the segmented track; a line tab is chosen in the primary, underlined", async ({ app: page }) => {
      expect(await css(page, "tabs", "background-color")).toBe(await css(page, mode === "light" ? "probe-field" : "probe-background", "background-color"));
      expect(await css(page, "tab-on", "background-color")).toBe(await css(page, mode === "light" ? "probe-card" : "probe-muted", "background-color"));
      expect(await css(page, "line-tab-on", "color")).toBe(await css(page, "probe-primary-ink", "color"));
      const after = await page.getByTestId("line-tab-on").evaluate((el) => ({ bg: getComputedStyle(el, "::after").backgroundColor, opacity: getComputedStyle(el, "::after").opacity }));
      expect(after).toEqual({ bg: await css(page, "probe-primary", "background-color"), opacity: "1" });
    });

    test("the avatar is round with no ring, 36 px when large; the divider is a hairline", async ({ app: page }) => {
      const avatar = await page.getByTestId("avatar").evaluate((el) => ({ w: el.getBoundingClientRect().width, ring: getComputedStyle(el, "::after").content }));
      expect(avatar).toEqual({ w: 36, ring: "none" });
      expect(await css(page, "separator", "background-color")).toBe(await css(page, "probe-hairline", "background-color"));
      expect(await css(page, "separator", "height")).toBe(await css(page, "probe-hairline", "height"));
    });
  });
}

async function segmented(page: Page, track: string, on: string, off: string, mode: "light" | "dark") {
  const light = mode === "light";
  expect(await css(page, track, "background-color"), "the track").toBe(await css(page, light ? "probe-field" : "probe-background", "background-color"));
  expect(await css(page, on, "background-color"), "the thumb").toBe(await css(page, light ? "probe-card" : "probe-muted", "background-color"));
  expect(await css(page, off, "background-color"), "no thumb").toBe("rgba(0, 0, 0, 0)");
  const r = await page.getByTestId(track).evaluate((el) => {
    const item = el.querySelector("[data-slot=toggle-group-item]")!;
    return { outer: parseFloat(getComputedStyle(el).borderTopLeftRadius), inner: parseFloat(getComputedStyle(item).borderTopLeftRadius), inset: item.getBoundingClientRect().left - el.getBoundingClientRect().left };
  });
  expect(Math.abs(r.outer - (r.inner + r.inset)), `track ${r.outer}px = item ${r.inner}px + inset ${r.inset}px`).toBeLessThanOrEqual(0.5);
}

// plan 118 review: call sites that restyle a control keep their states over its new base
for (const mode of ["light", "dark"] as const) {
  test.describe(`controls restyled in place keep their states, ${mode} (plan 118)`, () => {
    test.beforeEach(async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), markup);
    });

    test("Send's schedule half, open, keeps its hover fill when the pointer leaves (no gradient over it)", async ({ app: page }) => {
      await focusList(page);
      await page.keyboard.press("c");
      await page.getByTestId("compose-send-later").click();
      await page.mouse.move(1, 1);
      await expect(page.getByTestId("compose-send-later")).toHaveAttribute("aria-expanded", "true");
      expect(await css(page, "compose-send-later", "background-image")).toBe("none");
      expect(await css(page, "compose-send-later", "background-color")).toBe(await css(page, "probe-primary-hover", "background-color"));
    });

    // plan 120: the print sheet's and the remind popover's own segmented controls are the shared one
    test("the print sheet's and the remind popover's choices are the segmented control", async ({ app: page }) => {
      await openRow(page, 1);
      await page.getByTestId("action-remind").click();
      await segmented(page, "remind-kind", "remind-kind-always", "remind-kind-noReply", mode);
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+p");
      await segmented(page, "print-content", "print-content-headers", "print-content-body", mode);
    });

    test("the date picker's today keeps readable text when hovered and when chosen", async ({ app: page }) => {
      await openRow(page, 1);
      await page.getByTestId("action-remind").click();
      const popover = page.getByTestId("remind-popover");
      await popover.getByTestId("remind-pick").click();
      await popover.getByTestId("remind-date").click();
      const today = page.locator("[data-slot=calendar] button[data-today]");
      const ink = await css(page, "probe-foreground", "color");
      await today.hover();
      expect(await today.evaluate((el) => getComputedStyle(el).color)).toBe(ink);
      await today.click();
      await popover.getByTestId("remind-date").click();
      await expect(today).toHaveAttribute("data-selected", "true");
      await page.mouse.move(1, 1);
      expect(await today.evaluate((el) => getComputedStyle(el).color)).toBe(ink);
    });

    // plan 120 review: a chosen day shown as another month's (December 1 in November's last row) is the ink too
    test("the date picker's chosen day keeps readable text outside its month", async ({ app: page }) => {
      await openRow(page, 1);
      await page.getByTestId("action-remind").click();
      const popover = page.getByTestId("remind-popover");
      await popover.getByTestId("remind-pick").click();
      await popover.getByTestId("remind-date").click();
      const calendar = page.locator("[data-slot=calendar]");
      await calendar.locator(".rdp-button_next").click();
      await calendar.locator(".rdp-button_next").click();
      await calendar.locator('button[data-day="2026-12-01"]').click();
      await popover.getByTestId("remind-date").click();
      await calendar.locator(".rdp-button_previous").click();
      const day = calendar.locator('button[data-day="2026-12-01"]');
      await expect(day).toHaveAttribute("data-outside", "true");
      await expect(day).toHaveAttribute("data-selected", "true");
      await page.mouse.move(1, 1);
      expect(await day.evaluate((el) => getComputedStyle(el).color)).toBe(await css(page, "probe-foreground", "color"));
    });

    // plan 121: BoardUI's picker triggers and time slots, the date and time as wide as the rows above them
    test("the date and time pickers: BoardUI's triggers on the rows' width, its time slots", async ({ app: page }) => {
      await openRow(page, 1);
      await page.getByTestId("action-remind").click();
      const popover = page.getByTestId("remind-popover");
      await popover.getByTestId("remind-pick").click();
      const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
      const row = await box("remind-pick");
      const date = await box("remind-date");
      const time = await box("remind-time");
      expect(Math.abs(date.x - row.x), "the date starts on the row's edge").toBeLessThanOrEqual(0.5);
      expect(Math.abs(time.x + time.width - (row.x + row.width)), "the time ends on it").toBeLessThanOrEqual(0.5);
      for (const id of ["remind-date", "remind-time"]) {
        expect(await css(page, id, "background-color"), `${id}: the secondary's card`).toBe(await css(page, "probe-card", "background-color"));
        expect(await css(page, id, "border-top-width")).toBe("1px");
        expect(await css(page, id, "box-shadow")).not.toBe("none");
      }
      await page.getByTestId("remind-time").click();
      const chosen = page.getByTestId("remind-times").locator("[data-slot=select-item][data-selected]");
      // the list opens focused on the chosen time; move off it, so its fill is the chosen one's, not the focus highlight
      await expect(chosen).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(chosen).not.toBeFocused();
      await page.mouse.move(1, 1);
      expect(await chosen.evaluate((el) => getComputedStyle(el).justifyContent)).toBe("center");
      expect(await chosen.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-muted", "background-color"));
      await expect(chosen.locator("svg")).toBeHidden();
    });

    test("the draft's From selector fills on hover", async ({ app: page }) => {
      await focusList(page);
      await page.keyboard.press("c");
      await page.getByTestId("compose-from").hover();
      expect(await css(page, "compose-from", "background-color")).toBe(await css(page, "probe-muted", "background-color"));
    });
  });
}
