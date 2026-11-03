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
import { addRecipients, expect, focusList, openRow, test, timeText, typeTime } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

// the real components, rendered to markup in a process of their own (helpers/controls-markup.ts says why)
// (run from packages/ui, whose tsconfig compiles the components' JSX)
const ui = new URL("../../../packages/ui/", import.meta.url);
const tsx = createRequire(new URL("package.json", ui)).resolve("tsx/cli");
const markup = execFileSync(process.execPath, [tsx, fileURLToPath(new URL("./helpers/controls-markup.ts", import.meta.url))], { cwd: fileURLToPath(ui), encoding: "utf8" });

// no shadow: none, or Tailwind's shadow-none (each layer transparent and empty)
const FLAT = /^(none|rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)*)$/;
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

    // plan 125: BoardUI's unavailable field, the field's own wash with its text muted, no opacity (a grouped one too)
    test("a disabled field keeps the field's wash, its text muted, at full opacity", async ({ app: page }) => {
      const field = await css(page, "probe-field", "background-color");
      const muted = await css(page, "probe-muted-ink", "color");
      expect(await css(page, "disabled-input", "background-color")).toBe(field);
      expect(await css(page, "disabled-input", "color")).toBe(muted);
      expect(await css(page, "disabled-input", "opacity")).toBe("1");
      expect(await css(page, "disabled-group", "background-color")).toBe(field);
      expect(await css(page, "disabled-group", "opacity")).toBe("1");
      expect(await css(page, "disabled-group-input", "color")).toBe(muted);
    });

    // plan 125: BoardUI's danger, solid and lit from the top; unavailable buttons are fills, not faded
    test("the danger button is solid, from the red to its shade, in its own text", async ({ app: page }) => {
      const stops = [await css(page, "danger", "--tw-gradient-from"), await css(page, "danger", "--tw-gradient-to")].map((s) => s.trim());
      expect(stops).toEqual([await css(page, "probe-danger", "background-color"), await css(page, "probe-danger-shade", "background-color")]);
      expect(await css(page, "danger", "background-image")).toContain("linear-gradient");
      expect(await css(page, "danger", "color")).toBe(await css(page, "probe-danger-ink", "color"));
      expect(await css(page, "danger", "box-shadow")).not.toBe("none");
    });

    test("unavailable buttons take the muted fill (the outline the field wash), muted text, no shadow, no opacity", async ({ app: page }) => {
      const muted = await css(page, "probe-muted-ink", "color");
      for (const id of ["primary-off", "danger-off"]) {
        expect(await css(page, id, "background-color"), id).toBe(await css(page, "probe-muted", "background-color"));
        expect(await css(page, id, "background-image"), id).toBe("none");
        expect(await css(page, id, "color"), id).toBe(muted);
        expect(await css(page, id, "box-shadow"), id).toMatch(FLAT);
        expect(await css(page, id, "opacity"), id).toBe("1");
      }
      expect(await css(page, "outline-off", "background-color")).toBe(await css(page, "probe-field", "background-color"));
      expect(await css(page, "outline-off", "border-top-width")).toBe("1px");
      expect(await css(page, "outline-off", "color")).toBe(muted);
      expect(await css(page, "outline-off", "opacity")).toBe("1");
    });

    test("a busy button keeps its width and its fill, with a spinner", async ({ app: page }) => {
      const [idle, busy] = [(await page.getByTestId("idle").boundingBox())!, (await page.getByTestId("busy").boundingBox())!];
      expect(busy.width).toBe(idle.width);
      expect(await css(page, "busy", "background-image")).toBe(await css(page, "idle", "background-image"));
      await expect(page.getByTestId("busy").locator("[data-slot=spinner]")).toBeVisible();
      await expect(page.getByTestId("busy")).toHaveAttribute("aria-busy", "true");
    });

    test("an indeterminate checkbox draws a dash on the checked fill; the tick is 2 px", async ({ app: page }) => {
      const box = page.getByTestId("indeterminate");
      expect(await css(page, "indeterminate", "background-color")).toBe(await css(page, "checked", "background-color"));
      const marks = await box.locator("svg").evaluateAll((svgs) => svgs.map((s) => getComputedStyle(s).display));
      expect(marks, "the tick hidden, the dash shown").toEqual(["none", "block"]);
      const tick = await page.getByTestId("checked").locator("svg path").first().evaluate((p) => getComputedStyle(p).strokeWidth);
      expect(tick).toBe("2px");
    });

    test("the skeleton is a tint of the ink; a key sits on the field wash", async ({ app: page }) => {
      expect(await css(page, "skeleton", "background-color")).toBe(await css(page, "probe-ink-tint", "background-color"));
      expect(await css(page, "kbd", "background-color")).toBe(await css(page, "probe-field", "background-color"));
      expect(await css(page, "kbd", "color")).toBe(await css(page, "probe-muted-ink", "color"));
    });

    test("the dialog's footer is a plain row inside the panel's inset: no band", async ({ app: page }) => {
      expect(await css(page, "dialog-footer", "background-color")).toBe("rgba(0, 0, 0, 0)");
      expect(await css(page, "dialog-footer", "border-top-width")).toBe("0px");
      const [host, footer] = [(await page.getByTestId("dialog-footer-host").boundingBox())!, (await page.getByTestId("dialog-footer").boundingBox())!];
      expect(host.y + host.height - (footer.y + footer.height), "24 px above the panel's bottom").toBe(24);
      expect(host.x + host.width - (footer.x + footer.width), "24 px in from its end").toBe(24);
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
      // the probes are read, never pointed at: the sidebar under them stays reachable
      await page.evaluate(() => document.getElementById("controls-probe")!.style.setProperty("pointer-events", "none"));
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

    // plan 121: BoardUI's date-picker trigger, the date and time as wide as the rows above them
    test("the date and time: BoardUI's date trigger, both on the rows' width", async ({ app: page }) => {
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
      expect(await css(page, "remind-date", "background-color"), "the secondary's card").toBe(await css(page, "probe-card", "background-color"));
      expect(await css(page, "remind-date", "border-top-width")).toBe("1px");
      expect(await css(page, "remind-date", "box-shadow")).not.toBe("none");
    });

    // plan 122: BoardUI's Time Field, typed segment by segment, in the theme's secondary chrome
    test("the time is BoardUI's Time Field: typed segment by segment, the focused one in the primary", async ({ app: page }) => {
      await openRow(page, 1);
      await page.getByTestId("action-remind").click();
      const popover = page.getByTestId("remind-popover");
      await popover.getByTestId("remind-pick").click();
      const field = popover.getByTestId("remind-time");
      await page.mouse.move(1, 1);
      // the theme's secondary, as the date beside it: the card, a 1 px border, a shadow (no grey wash)
      expect(await css(page, "remind-time", "background-color"), "the card").toBe(await css(page, "probe-card", "background-color"));
      expect(await css(page, "remind-time", "background-color")).toBe(await css(page, "remind-date", "background-color"));
      expect(await css(page, "remind-time", "border-top-width")).toBe("1px");
      expect(await css(page, "remind-time", "box-shadow")).not.toBe("none");
      await typeTime(field, 2, 30, "PM");
      expect(await timeText(field)).toBe("2:30 PM");
      const minute = field.locator("[role=spinbutton]").nth(1);
      await minute.click();
      await page.keyboard.press("ArrowUp");
      expect(await timeText(field)).toBe("2:31 PM");
      expect(await minute.evaluate((el) => getComputedStyle(el).backgroundColor), "the focused segment").toBe(await css(page, "probe-primary", "background-color"));
    });

    // plan 122 review: a cleared time sets nothing; Enter in the time sets it; a past one shows the error border
    test("the Time Field: cleared it sets nothing, Enter sets it, a past time is marked", async ({ app: page }) => {
      await openRow(page, 1);
      await page.getByTestId("action-remind").click();
      const popover = page.getByTestId("remind-popover");
      await popover.getByTestId("remind-pick").click();
      const field = popover.getByTestId("remind-time");
      // today (E2E_NOW is 9:30 AM) at 9:00 AM: past, the field's border in the error color
      await popover.getByTestId("remind-date").click();
      await page.locator('[data-slot=calendar] button[data-day="2026-10-22"]').click();
      await typeTime(field, 9, 0, "AM");
      await expect(popover.getByTestId("remind-past")).toBeVisible();
      expect(await css(page, "remind-time", "border-top-color")).toBe(await css(page, "probe-destructive", "border-top-color"));
      // cleared: Set is off, and Enter does nothing
      await typeTime(field, 4, 0, "PM");
      await field.locator("[role=spinbutton]").first().click();
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      await expect(popover.getByTestId("remind-set")).toBeDisabled();
      // the cleared hour, focused: its dashes in the primary's own text color, on the primary
      const hour = field.locator("[role=spinbutton]").first();
      await expect(hour).toHaveAttribute("data-placeholder", "true");
      expect(await hour.evaluate((el) => getComputedStyle(el).color)).toBe(await css(page, "probe-primary-ink-on", "color"));
      await page.keyboard.press("Enter");
      await expect(popover).toBeVisible();
      // whole again and in the future: Enter sets it
      await typeTime(field, 4, 0, "PM");
      await expect(popover.getByTestId("remind-set")).toBeEnabled();
      await page.keyboard.press("Enter");
      await expect(popover).toBeHidden();
      await expect(page.locator("[data-testid=snack]").filter({ hasText: "4:00 PM" })).toBeVisible();
    });

    test("Send later's time: Enter schedules it", async ({ app: page }) => {
      await focusList(page);
      await page.keyboard.press("c");
      await addRecipients(page, "compose-to", "ana@example.com");
      await page.getByTestId("compose-send-later").click();
      const popover = page.getByTestId("send-later-popover");
      await popover.getByTestId("send-later-custom").click();
      await typeTime(popover.getByTestId("send-later-time"), 10, 15, "AM");
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-testid=snack]").filter({ hasText: "10:15 AM" })).toBeVisible();
    });

    // plan 125: BoardUI's alert dialog, its footer a plain row inside the panel, the confirm the solid danger
    test("a confirm dialog: one surface, the actions inside its inset, the danger confirm solid", async ({ app: page }) => {
      await page.locator("[data-testid^=nav-category-]").first().click({ button: "right" });
      await page.getByTestId("category-menu-delete").click();
      const dialog = page.getByTestId("category-delete-dialog");
      await expect(dialog).toBeVisible();
      await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      const footer = dialog.locator("[data-slot=alert-dialog-footer]");
      expect(await footer.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopWidth])).toEqual(["rgba(0, 0, 0, 0)", "0px"]);
      const [panel, row] = [(await dialog.boundingBox())!, (await footer.boundingBox())!];
      expect(panel.y + panel.height - (row.y + row.height), "the footer sits 24 px above the panel's bottom, inside its corners").toBeCloseTo(24, 0);
      expect(await dialog.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
      const confirm = page.getByTestId("category-delete-dialog-confirm");
      expect(await confirm.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
      expect(await confirm.evaluate((el) => getComputedStyle(el).color)).toBe(await css(page, "probe-danger-ink", "color"));
      expect(await confirm.evaluate((el) => getComputedStyle(el).getPropertyValue("--tw-gradient-from").trim())).toBe(await css(page, "probe-danger", "background-color"));
    });

    // plan 125: the dialog's close is the round CloseButton on the title's first line, the header leaving it room
    test("a dialog's close sits in its header row, at the panel's inset", async ({ app: page }) => {
      await focusList(page);
      await page.keyboard.press("?");
      const dialog = page.getByTestId("shortcuts-dialog");
      await expect(dialog).toBeVisible();
      await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      const close = dialog.getByRole("button", { name: "Close" });
      const title = dialog.locator("[data-slot=dialog-title]");
      const [panel, c, t] = [(await dialog.boundingBox())!, (await close.boundingBox())!, (await title.boundingBox())!];
      const line = parseFloat(await title.evaluate((el) => getComputedStyle(el).lineHeight));
      expect(Math.abs(c.y + c.height / 2 - (t.y + line / 2)), "centred on the title's first line").toBeLessThanOrEqual(0.5);
      expect(panel.x + panel.width - (c.x + c.width), "at the 24 px inset").toBeCloseTo(24, 0);
      expect(await close.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius) >= el.getBoundingClientRect().width / 2), "round").toBe(true);
      expect(await dialog.locator("[data-slot=dialog-header]").evaluate((el) => getComputedStyle(el).paddingInlineEnd)).toBe("32px");
    });

    // plan 125: BoardUI's menu rows, by a real right-click menu
    test("menu rows are medium, 2 px apart; separators run to the panel's edges", async ({ app: page }) => {
      await page.getByTestId("thread-row").first().click({ button: "right" });
      const menu = page.locator("[data-slot=context-menu-content]");
      await expect(menu).toBeVisible();
      await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      const [reply, all] = [menu.getByTestId("menu-reply"), menu.getByTestId("menu-reply-all")];
      expect(await reply.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("500");
      const [a, b] = [(await reply.boundingBox())!, (await all.boundingBox())!];
      expect(b.y - (a.y + a.height), "2 px between rows").toBeCloseTo(2, 1);
      const sep = menu.locator("[role=separator]").first();
      const [panel, line] = [(await menu.boundingBox())!, (await sep.boundingBox())!];
      expect(line.x, "from the panel's start").toBeCloseTo(panel.x, 1);
      expect(line.width, "to its end").toBeCloseTo(panel.width, 1);
    });

    // plan 125: BoardUI's tooltip has a caret, in the panel's fill
    test("a tooltip is medium text with a caret", async ({ app: page }) => {
      await focusList(page);
      await page.keyboard.press("c");
      await page.getByTestId("compose-send-later").hover();
      const tip = page.locator("[data-slot=tooltip-content]");
      await expect(tip).toBeVisible();
      expect(await tip.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("500");
      const arrow = tip.locator("[data-slot=tooltip-arrow]");
      await expect(arrow).toBeVisible();
      expect(await arrow.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-popover", "background-color"));
      // the caret points at the trigger: it reaches past the tooltip's edge on the trigger's side
      const [t, c] = [(await tip.boundingBox())!, (await arrow.boundingBox())!];
      if ((await arrow.getAttribute("data-side")) === "bottom") expect(c.y).toBeLessThan(t.y);
      else expect(c.y + c.height).toBeGreaterThan(t.y + t.height);
    });

    // plan 125: BoardUI's select, below its trigger, the chosen row filled, the chevron turned
    test("a select opens below its trigger, the chosen row filled with no check, its chevron turned", async ({ app: page }) => {
      await focusList(page);
      await page.keyboard.press("c");
      const trigger = page.getByTestId("compose-from");
      await trigger.click();
      const popup = page.locator("[data-slot=select-content]");
      await expect(popup).toBeVisible();
      await popup.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      const [tr, pop] = [(await trigger.boundingBox())!, (await popup.boundingBox())!];
      expect(pop.y - (tr.y + tr.height), "4 px below the trigger, not over it").toBeCloseTo(4, 0);
      expect(pop.width).toBeGreaterThanOrEqual(tr.width - 0.5);
      const chosen = popup.locator("[role=option][aria-selected=true]");
      await page.mouse.move(1, 1);
      expect(await chosen.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-muted", "background-color"));
      await expect(chosen.locator("svg")).toHaveCount(0);
      const turned = await trigger.locator("svg").last().evaluate((el) => getComputedStyle(el).rotate);
      expect(turned).toBe("180deg");
    });

    // plan 125: BoardUI's calendar marks today with a dot in the primary, its number in the ink
    test("the date picker marks today with a dot", async ({ app: page }) => {
      await openRow(page, 1);
      await page.getByTestId("action-remind").click();
      const popover = page.getByTestId("remind-popover");
      await popover.getByTestId("remind-pick").click();
      await popover.getByTestId("remind-date").click();
      await page.mouse.move(1, 1);
      // tomorrow is chosen by default: today rests unfilled
      const today = page.locator("[data-slot=calendar] button[data-today]");
      const dot = await today.evaluate((el) => ({ bg: getComputedStyle(el, "::after").backgroundColor, w: getComputedStyle(el, "::after").width, color: getComputedStyle(el).color }));
      expect(dot).toEqual({ bg: await css(page, "probe-primary", "background-color"), w: "4px", color: await css(page, "probe-foreground", "color") });
    });

    test("the draft's From selector fills on hover", async ({ app: page }) => {
      await focusList(page);
      await page.keyboard.press("c");
      await page.getByTestId("compose-from").hover();
      expect(await css(page, "compose-from", "background-color")).toBe(await css(page, "probe-muted", "background-color"));
    });
  });
}
