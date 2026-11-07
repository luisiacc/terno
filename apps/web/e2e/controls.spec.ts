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
import { addRecipients, expect as baseExpect, focusList, openRow, test, timeText, typeTime, scenario, freshStart, freshNoDrafts } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

// the real components, rendered to markup in a process of their own (helpers/controls-markup.ts says why)
// (run from packages/ui, whose tsconfig compiles the components' JSX)
const ui = new URL("../../../packages/ui/", import.meta.url);
const tsx = createRequire(new URL("package.json", ui)).resolve("tsx/cli");
let rendered: string | undefined;
const markup = () => (rendered ??= execFileSync(process.execPath, [tsx, fileURLToPath(new URL("./helpers/controls-markup.ts", import.meta.url))], { cwd: fileURLToPath(ui), encoding: "utf8" }));

// no shadow: none, or Tailwind's shadow-none (each layer transparent and empty)
const FLAT = /^(none|rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)*)$/;
const css = (page: Page, id: string, prop: string) => page.getByTestId(id).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

/** One control's states, read off the page. `expect` is soft and carries the control's name, so one failure names it and the rest still run. */
type Probe = (page: Page, mode: "light" | "dark", expect: typeof softExpect) => Promise<void>;
const softExpect = baseExpect.configure({ soft: true });

// plan 139: all on one page, per design and mode (they read the page: one page each repeated a backend and a load 25 times)
const PROBES: [string, Probe][] = [
  ["an invalid outline button keeps the error border, hovered too", async (page, mode, expect) => {
    const want = await css(page, "probe-destructive", "border-top-color");
    expect(await css(page, "invalid-outline", "border-top-color")).toBe(want);
    await page.getByTestId("invalid-outline").hover();
    expect(await css(page, "invalid-outline", "border-top-color")).toBe(want);
  }],

  ["a focused field group keeps its focus border while hovered", async (page, mode, expect) => {
    await page.getByTestId("group-input").focus();
    await page.getByTestId("group").hover();
    expect(await css(page, "group", "border-top-color")).toBe(await css(page, "probe-ring", "border-top-color"));
  }],

  // plan 125: BoardUI's unavailable field, the field's own wash with its text muted, no opacity (a grouped one too)
  ["a disabled field keeps the field's wash, its text muted, at full opacity", async (page, mode, expect) => {
    const field = await css(page, "probe-field", "background-color");
    const muted = await css(page, "probe-muted-ink", "color");
    expect(await css(page, "disabled-input", "background-color")).toBe(field);
    expect(await css(page, "disabled-input", "color")).toBe(muted);
    expect(await css(page, "disabled-input", "opacity")).toBe("1");
    expect(await css(page, "disabled-group", "background-color")).toBe(field);
    expect(await css(page, "disabled-group", "opacity")).toBe("1");
    expect(await css(page, "disabled-group-input", "color")).toBe(muted);
  }],

  // plan 125: BoardUI's danger, solid and lit from the top; unavailable buttons are fills, not faded
  ["the danger button is solid, from the red to its shade, in its own text", async (page, mode, expect) => {
    const stops = [await css(page, "danger", "--tw-gradient-from"), await css(page, "danger", "--tw-gradient-to")].map((s) => s.trim());
    expect(stops).toEqual([await css(page, "probe-danger", "background-color"), await css(page, "probe-danger-shade", "background-color")]);
    expect(await css(page, "danger", "background-image")).toContain("linear-gradient");
    expect(await css(page, "danger", "color")).toBe(await css(page, "probe-danger-ink", "color"));
    expect(await css(page, "danger", "box-shadow")).not.toBe("none");
  }],

  ["a button group is one bordered control on the card, at the control height, split by a hairline, with no fill of its own items", async (page, mode, expect) => {
    expect(await css(page, "button-group", "background-color")).toBe(await css(page, "probe-card", "background-color"));
    expect(await css(page, "button-group", "border-top-width")).toBe("1px");
    expect(await css(page, "button-group", "height")).toBe("32px");
    expect(await css(page, "button-group", "box-shadow")).not.toMatch(FLAT);
    expect(await css(page, "button-group-item", "background-color")).toBe("rgba(0, 0, 0, 0)");
    expect(await css(page, "button-group-item", "border-right-width")).toBe("1px");
    expect(await page.getByTestId("button-group-icon").evaluate((el) => el.getBoundingClientRect().width === el.getBoundingClientRect().height)).toBe(true);
  }],

  ["unavailable buttons take the muted fill (the outline the field wash), muted text, no shadow, no opacity", async (page, mode, expect) => {
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
  }],

  ["a busy button keeps its width and its fill, with a spinner", async (page, mode, expect) => {
    const [idle, busy] = [(await page.getByTestId("idle").boundingBox())!, (await page.getByTestId("busy").boundingBox())!];
    expect(busy.width).toBe(idle.width);
    expect(await css(page, "busy", "background-image")).toBe(await css(page, "idle", "background-image"));
    await expect(page.getByTestId("busy").locator("[data-slot=spinner]")).toBeVisible();
    await expect(page.getByTestId("busy")).toHaveAttribute("aria-busy", "true");
    // its label is hidden by opacity, not visibility: it still names the button (Codex code review #1)
    await expect(page.getByTestId("busy")).toHaveAccessibleName("Remove all");
  }],

  ["an indeterminate checkbox draws a dash on the checked fill; the tick is 2 px", async (page, mode, expect) => {
    const box = page.getByTestId("indeterminate");
    expect(await css(page, "indeterminate", "background-color")).toBe(await css(page, "checked", "background-color"));
    const marks = await box.locator("svg").evaluateAll((svgs) => svgs.map((s) => getComputedStyle(s).display));
    expect(marks, "the tick hidden, the dash shown").toEqual(["none", "block"]);
    const tick = await page.getByTestId("checked").locator("svg path").first().evaluate((p) => getComputedStyle(p).strokeWidth);
    expect(tick).toBe("2px");
  }],

  ["the skeleton is a tint of the ink; a key sits on the field wash", async (page, mode, expect) => {
    expect(await css(page, "skeleton", "background-color")).toBe(await css(page, "probe-ink-tint", "background-color"));
    expect(await css(page, "kbd", "background-color")).toBe(await css(page, "probe-field", "background-color"));
    expect(await css(page, "kbd", "color")).toBe(await css(page, "probe-muted-ink", "color"));
  }],

  ["the dialog's footer is a plain row inside the panel's inset: no band", async (page, mode, expect) => {
    expect(await css(page, "dialog-footer", "background-color")).toBe("rgba(0, 0, 0, 0)");
    expect(await css(page, "dialog-footer", "border-top-width")).toBe("0px");
    const [host, footer] = [(await page.getByTestId("dialog-footer-host").boundingBox())!, (await page.getByTestId("dialog-footer").boundingBox())!];
    expect(host.y + host.height - (footer.y + footer.height), "24 px above the panel's bottom").toBe(24);
    expect(host.x + host.width - (footer.x + footer.width), "24 px in from its end").toBe(24);
  }],

  // plan 125, phase 2a: BoardUI's radio and its card, the swatches, the number field, the pager, the disclosures and the
  // progress bar, at rest
  ["a chosen radio is the primary lit from the top, a white centre in it; unchosen, white over the input border", async (page, mode, expect) => {
    const dot = (id: string, pseudo?: string) =>
      page.getByTestId(id).locator("[data-slot=radio-dot]").evaluate((el, ps) => {
        const s = getComputedStyle(el, ps);
        return { bg: s.backgroundColor, image: s.backgroundImage, border: s.borderTopColor, scale: s.scale };
      }, pseudo);
    const [on, off, centre, offCentre] = [await dot("radio-on"), await dot("radio-off"), await dot("radio-on", "::after"), await dot("radio-off", "::after")];
    expect(on.bg).toBe(await css(page, "probe-primary", "background-color"));
    expect(on.image).toContain("linear-gradient");
    expect(centre.bg).toBe(await css(page, "probe-primary-ink-on-bg", "background-color"));
    expect(centre.scale).toBe("1");
    expect(off.bg).toBe(await css(page, "probe-card", "background-color"));
    expect(off.border).toBe(await css(page, "probe-control-edge", "border-top-color"));
    expect(offCentre.scale).toBe("0");
    // plan 137: hovered, the edge firms up on its own token
    // (the probe panel is fixed and runs past the window: bring this radio into it)
    await page.getByTestId("radio-off").evaluate((el) => {
      const panel = document.getElementById("controls-probe")!;
      panel.style.top = `${panel.offsetTop + 200 - el.getBoundingClientRect().top}px`;
    });
    await page.getByTestId("radio-off").hover();
    await expect.poll(async () => (await dot("radio-off")).border).toBe(await css(page, "probe-control-edge-hover", "border-top-color"));
    await expect(page.getByTestId("radio-on")).toHaveAttribute("aria-checked", "true");
  }],

  ["a radio card takes the primary edge when chosen; at rest, the border on the card", async (page, mode, expect) => {
    expect(await css(page, "radio-card-on", "border-top-color")).toBe(await css(page, "probe-primary-border", "border-top-color"));
    expect(await css(page, "radio-card-on", "box-shadow")).not.toMatch(FLAT);
    expect(await css(page, "radio-card-off", "border-top-color")).toBe(await css(page, "probe-border", "border-top-color"));
    expect(await css(page, "radio-card-off", "background-color")).toBe(await css(page, "probe-card", "background-color"));
  }],

  ["swatches are filled with their colour, 24 px, the chosen one ringed inside its edge", async (page, mode, expect) => {
    expect(await css(page, "swatch-on", "background-color")).toBe(await css(page, "probe-cat-rose", "background-color"));
    expect((await page.getByTestId("swatch-on").boundingBox())!.width).toBe(24);
    const ring = (id: string) => page.getByTestId(id).locator("span[aria-hidden]").last().evaluate((el) => getComputedStyle(el).opacity);
    expect([await ring("swatch-on"), await ring("swatch-off")]).toEqual(["1", "0"]);
  }],

  ["the number field is the filled field, its − and + quiet at its end", async (page, mode, expect) => {
    const field = page.getByTestId("number-input").locator("xpath=..");
    expect(await field.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-field", "background-color"));
    expect(await field.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgba(0, 0, 0, 0)");
    expect(await css(page, "number-input", "color")).toBe(await css(page, "probe-foreground", "color"));
    const steppers = field.locator("button");
    await expect(steppers).toHaveCount(2);
    expect(await steppers.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).toEqual(["Decrease", "Increase"]);
    expect(await steppers.first().evaluate((el) => getComputedStyle(el).color)).toBe(await css(page, "probe-muted-ink", "color"));
  }],

  ["the pager: secondary Previous and Next, the range between them in muted text", async (page, mode, expect) => {
    const nav = page.locator("#controls-probe nav[data-slot=pagination]");
    const [previous, next, range] = [nav.locator("[data-slot=pagination-previous]"), nav.locator("[data-slot=pagination-next]"), nav.locator("span[aria-live]")];
    await expect(range).toHaveText("1–25 of 80");
    expect(await range.evaluate((el) => getComputedStyle(el).color)).toBe(await css(page, "probe-muted-ink", "color"));
    // on the first page Previous is unavailable: the outline's field wash
    expect(await previous.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-field", "background-color"));
    expect(await next.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-card", "background-color"));
  }],

  ["a disclosure's chevron sits at its end, pointing up when open", async (page, mode, expect) => {
    const chevron = (id: string) => page.getByTestId(id).locator("svg").evaluate((el) => ({ rotate: getComputedStyle(el).rotate, last: el.parentElement!.lastElementChild === el }));
    expect(await chevron("collapsible-open")).toEqual({ rotate: "180deg", last: true });
    expect(await chevron("accordion-closed")).toEqual({ rotate: "none", last: true });
    await expect(page.getByTestId("collapsible-open")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("accordion-closed")).toHaveAttribute("aria-expanded", "false");
  }],

  ["the progress bar is a 4 px track on the field wash, the fill in the primary", async (page, mode, expect) => {
    const track = page.getByTestId("progress").getByRole("progressbar");
    expect(await track.evaluate((el) => ({ h: el.getBoundingClientRect().height, bg: getComputedStyle(el).backgroundColor }))).toEqual({ h: 4, bg: await css(page, "probe-field", "background-color") });
    expect(await track.locator("[data-slot=progress-fill]").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-primary", "background-color"));
    await expect(track).toHaveAccessibleName("Work");
    await expect(track).toHaveAttribute("aria-valuenow", "40");
  }],

  ["the icon button: ghost is the quiet muted glyph, secondary the bordered card; both named", async (page, mode, expect) => {
    expect(await css(page, "icon-ghost", "background-color")).toBe("rgba(0, 0, 0, 0)");
    expect(await css(page, "icon-ghost", "color")).toBe(await css(page, "probe-muted-ink", "color"));
    await expect(page.getByTestId("icon-ghost")).toHaveAccessibleName("Archive");
    expect(await css(page, "icon-secondary", "background-color")).toBe(await css(page, "probe-card", "background-color"));
    expect(await css(page, "icon-secondary", "border-top-color")).toBe(await css(page, "probe-border", "border-top-color"));
    expect(await css(page, "icon-secondary", "width")).toBe("32px");
  }],

  ["a chip is medium caption text on the field wash, its × the round close named after it", async (page, mode, expect) => {
    expect(await css(page, "chip", "background-color")).toBe(await css(page, "probe-field", "background-color"));
    expect(await css(page, "chip", "color")).toBe(await css(page, "probe-foreground", "color"));
    expect([await css(page, "chip", "height"), await css(page, "chip", "font-weight")]).toEqual(["24px", "500"]);
    const remove = page.getByTestId("chip-remove");
    await expect(remove).toHaveAccessibleName("Remove Work");
    expect(await remove.evaluate((el) => ({ w: el.getBoundingClientRect().width, round: Number.parseFloat(getComputedStyle(el).borderRadius) >= 8 }))).toEqual({ w: 16, round: true });
  }],

  ["the search field: the filled field, a round clear once it has text, the key hint while empty", async (page, mode, expect) => {
    expect(await css(page, "search-full", "background-color")).toBe(await css(page, "probe-field", "background-color"));
    const field = page.getByTestId("search-full").locator("..");
    const clear = field.getByRole("button", { name: "Clear search" });
    await expect(clear).toHaveAttribute("tabindex", "-1");
    expect(await clear.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-field", "background-color"));
    await expect(page.getByTestId("search-hint")).toBeVisible();
    await expect(page.getByTestId("search-empty").locator("..").getByRole("button")).toHaveCount(0);
  }],

  ["an announcement sits on the tint: its title the ink, its text muted, its close round on the field wash", async (page, mode, expect) => {
    expect(await css(page, "announcement", "background-color")).toBe(await css(page, "probe-tint", "background-color"));
    expect(await css(page, "announcement-title", "color")).toBe(await css(page, "probe-foreground", "color"));
    expect(await css(page, "announcement-title", "font-weight")).toBe("500");
    expect(await page.getByTestId("announcement").locator("p").nth(1).evaluate((el) => getComputedStyle(el).color)).toBe(await css(page, "probe-muted-ink", "color"));
    await expect(page.getByTestId("announcement-close")).toHaveAccessibleName("Close");
    expect(await css(page, "announcement-close", "background-color")).toBe(await css(page, "probe-field", "background-color"));
  }],

  ["a link button is the accent with no box; the toast's surface is the solid popover", async (page, mode, expect) => {
    expect(await css(page, "link", "color")).toBe(await css(page, "probe-primary-ink", "color"));
    expect([await css(page, "link", "background-color"), await css(page, "link", "padding-left")]).toEqual(["rgba(0, 0, 0, 0)", "0px"]);
    expect(Number.parseFloat(await css(page, "link", "height"))).toBeLessThan(24);
    expect(await css(page, "snack-surface", "background-color")).toBe(await css(page, "probe-popover", "background-color"));
  }],

  ["the primary's gradient runs between primary-hover and primary, the fills its text is checked on", async (page, mode, expect) => {
    const stops = [await css(page, "primary", "--tw-gradient-from"), await css(page, "primary", "--tw-gradient-to")].map((s) => s.trim());
    const fills = [await css(page, "probe-primary-hover", "background-color"), await css(page, "probe-primary", "background-color")];
    expect(stops.sort()).toEqual(fills.sort());
    // hovered: no gradient, the plain hover fill
    await page.getByTestId("primary").hover();
    expect(await css(page, "primary", "background-image")).toBe("none");
  }],

  // plan 120: BoardUI's segmented control, tabs, avatar and divider
  ["the segmented control: a track with a raised thumb, corners concentric", async (page, mode, expect) => {
    await segmented(page, "segmented", "segmented-on", "segmented-off", mode, expect);
  }],

  ["tabs: the default list is the segmented track; a line tab is chosen in the primary, underlined", async (page, mode, expect) => {
    expect(await css(page, "tabs", "background-color")).toBe(await css(page, mode === "light" ? "probe-field" : "probe-background", "background-color"));
    expect(await css(page, "tab-on", "background-color")).toBe(await css(page, mode === "light" ? "probe-card" : "probe-muted", "background-color"));
    expect(await css(page, "line-tab-on", "color")).toBe(await css(page, "probe-primary-ink", "color"));
    const after = await page.getByTestId("line-tab-on").evaluate((el) => ({ bg: getComputedStyle(el, "::after").backgroundColor, opacity: getComputedStyle(el, "::after").opacity }));
    expect(after).toEqual({ bg: await css(page, "probe-primary", "background-color"), opacity: "1" });
  }],

  ["the avatar is round with no ring, 36 px when large; the divider is a hairline", async (page, mode, expect) => {
    const avatar = await page.getByTestId("avatar").evaluate((el) => ({ w: el.getBoundingClientRect().width, ring: getComputedStyle(el, "::after").content }));
    expect(avatar).toEqual({ w: 36, ring: "none" });
    expect(await css(page, "separator", "background-color")).toBe(await css(page, "probe-hairline", "background-color"));
    expect(await css(page, "separator", "height")).toBe(await css(page, "probe-hairline", "height"));
  }],
];

for (const design of DESIGN_IDS) for (const mode of ["light", "dark"] as const) {
  test.describe(`the controls keep their states, ${design} ${mode} (plan 118)`, () => {
    test.use({ design });
    test("every control, its states and its names", async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await baseExpect(page.locator("html")).toHaveAttribute("data-design", design);
      await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), markup());
      const top = await page.evaluate(() => document.getElementById("controls-probe")!.style.top);
      for (const [name, probe] of PROBES) {
        await test.step(name, () => probe(page, mode, baseExpect.configure({ soft: true, message: name })));
        // what a probe hovered, focused or scrolled into the window goes back
        await page.mouse.move(1, 1);
        await page.evaluate((t) => {
          (document.activeElement as HTMLElement | null)?.blur();
          document.getElementById("controls-probe")!.style.top = t;
        }, top);
      }
    });
  });
}

async function segmented(page: Page, track: string, on: string, off: string, mode: "light" | "dark", expect: typeof softExpect = baseExpect) {
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
    const probes = async (page: Page) => {
      await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), markup());
      // the probes are read, never pointed at: the sidebar under them stays reachable
      await page.evaluate(() => document.getElementById("controls-probe")!.style.setProperty("pointer-events", "none"));
    };
    test.beforeEach(async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await probes(page);
    });

    test("Send's half, a draft's From, the segmented choices", async ({ app: page, server }) => {
      await scenario("Send's schedule half, open, keeps its hover fill when the pointer leaves (no gradient over it)", async () => {
        await focusList(page);
        await page.keyboard.press("c");
        await page.getByTestId("compose-send-later").click();
        await page.mouse.move(1, 1);
        await baseExpect(page.getByTestId("compose-send-later")).toHaveAttribute("aria-expanded", "true");
        baseExpect(await css(page, "compose-send-later", "background-image")).toBe("none");
        baseExpect(await css(page, "compose-send-later", "background-color")).toBe(await css(page, "probe-primary-hover", "background-color"));
      });
      await scenario("the draft's From selector fills on hover", async () => {
        await freshNoDrafts(page, server);
        await probes(page);
        await focusList(page);
        await page.keyboard.press("c");
        await page.getByTestId("compose-from").hover();
        baseExpect(await css(page, "compose-from", "background-color")).toBe(await css(page, "probe-muted", "background-color"));
      });
      await scenario("the print sheet's and the remind popover's choices are the segmented control", async () => {
        await freshNoDrafts(page, server);
        await probes(page);
        await openRow(page, 1);
        await page.getByTestId("action-remind").click();
        await segmented(page, "remind-kind", "remind-kind-always", "remind-kind-noReply", mode);
        await page.keyboard.press("Escape");
        await page.keyboard.press("ControlOrMeta+p");
        await segmented(page, "print-content", "print-content-headers", "print-content-body", mode);
      });
      await scenario("Send later's time: Enter schedules it", async () => {
        await freshNoDrafts(page, server);
        await probes(page);
        await focusList(page);
        await page.keyboard.press("c");
        await addRecipients(page, "compose-to", "ana@example.com");
        await page.getByTestId("compose-send-later").click();
        const popover = page.getByTestId("send-later-popover");
        await popover.getByTestId("send-later-custom").click();
        await typeTime(popover.getByTestId("send-later-time"), 10, 15, "AM");
        await page.keyboard.press("Enter");
        await baseExpect(page.locator("[data-testid=snack]").filter({ hasText: "10:15 AM" })).toBeVisible();
      });
    });

    // plan 120: the print sheet's and the remind popover's own segmented controls are the shared one
    test("the date picker and the Time Field", async ({ app: page, server }) => {
      await scenario("the date picker's today keeps readable text when hovered and when chosen", async () => {
        await openRow(page, 1);
        await page.getByTestId("action-remind").click();
        const popover = page.getByTestId("remind-popover");
        await popover.getByTestId("remind-pick").click();
        await popover.getByTestId("remind-date").click();
        const today = page.locator("[data-slot=calendar] button[data-today]");
        const ink = await css(page, "probe-foreground", "color");
        await today.hover();
        baseExpect(await today.evaluate((el) => getComputedStyle(el).color)).toBe(ink);
        await today.click();
        await popover.getByTestId("remind-date").click();
        await baseExpect(today).toHaveAttribute("data-selected", "true");
        await page.mouse.move(1, 1);
        baseExpect(await today.evaluate((el) => getComputedStyle(el).color)).toBe(ink);
      });
      await scenario("the date picker's chosen day keeps readable text outside its month", async () => {
        await freshNoDrafts(page, server);
        await probes(page);
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
        await baseExpect(day).toHaveAttribute("data-outside", "true");
        await baseExpect(day).toHaveAttribute("data-selected", "true");
        await page.mouse.move(1, 1);
        baseExpect(await day.evaluate((el) => getComputedStyle(el).color)).toBe(await css(page, "probe-foreground", "color"));
      });
      await scenario("the date and time: BoardUI's date trigger, both on the rows' width", async () => {
        await freshNoDrafts(page, server);
        await probes(page);
        await openRow(page, 1);
        await page.getByTestId("action-remind").click();
        const popover = page.getByTestId("remind-popover");
        await popover.getByTestId("remind-pick").click();
        const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
        const row = await box("remind-pick");
        const date = await box("remind-date");
        const time = await box("remind-time");
        baseExpect(Math.abs(date.x - row.x), "the date starts on the row's edge").toBeLessThanOrEqual(0.5);
        baseExpect(Math.abs(time.x + time.width - (row.x + row.width)), "the time ends on it").toBeLessThanOrEqual(0.5);
        baseExpect(await css(page, "remind-date", "background-color"), "the secondary's card").toBe(await css(page, "probe-card", "background-color"));
        baseExpect(await css(page, "remind-date", "border-top-width")).toBe("1px");
        baseExpect(await css(page, "remind-date", "box-shadow")).not.toBe("none");
      });
      await scenario("the time is BoardUI's Time Field: typed segment by segment, the focused one in the primary", async () => {
        await freshNoDrafts(page, server);
        await probes(page);
        await openRow(page, 1);
        await page.getByTestId("action-remind").click();
        const popover = page.getByTestId("remind-popover");
        await popover.getByTestId("remind-pick").click();
        const field = popover.getByTestId("remind-time");
        await page.mouse.move(1, 1);
        // the theme's secondary, as the date beside it: the card, a 1 px border, a shadow (no grey wash)
        baseExpect(await css(page, "remind-time", "background-color"), "the card").toBe(await css(page, "probe-card", "background-color"));
        baseExpect(await css(page, "remind-time", "background-color")).toBe(await css(page, "remind-date", "background-color"));
        baseExpect(await css(page, "remind-time", "border-top-width")).toBe("1px");
        baseExpect(await css(page, "remind-time", "box-shadow")).not.toBe("none");
        await typeTime(field, 2, 30, "PM");
        baseExpect(await timeText(field)).toBe("2:30 PM");
        const minute = field.locator("[role=spinbutton]").nth(1);
        await minute.click();
        await page.keyboard.press("ArrowUp");
        baseExpect(await timeText(field)).toBe("2:31 PM");
        baseExpect(await minute.evaluate((el) => getComputedStyle(el).backgroundColor), "the focused segment").toBe(await css(page, "probe-primary", "background-color"));
      });
      await scenario("the Time Field: cleared it sets nothing, Enter sets it, a past time is marked", async () => {
        await freshNoDrafts(page, server);
        await probes(page);
        await openRow(page, 1);
        await page.getByTestId("action-remind").click();
        const popover = page.getByTestId("remind-popover");
        await popover.getByTestId("remind-pick").click();
        const field = popover.getByTestId("remind-time");
        // today (E2E_NOW is 9:30 AM) at 9:00 AM: past, the field's border in the error color
        await popover.getByTestId("remind-date").click();
        await page.locator('[data-slot=calendar] button[data-day="2026-10-22"]').click();
        await typeTime(field, 9, 0, "AM");
        await baseExpect(popover.getByTestId("remind-past")).toBeVisible();
        baseExpect(await css(page, "remind-time", "border-top-color")).toBe(await css(page, "probe-destructive", "border-top-color"));
        // cleared: Set is off, and Enter does nothing
        await typeTime(field, 4, 0, "PM");
        await field.locator("[role=spinbutton]").first().click();
        await page.keyboard.press("Backspace");
        await page.keyboard.press("Backspace");
        await baseExpect(popover.getByTestId("remind-set")).toBeDisabled();
        // the cleared hour, focused: its dashes in the primary's own text color, on the primary
        const hour = field.locator("[role=spinbutton]").first();
        await baseExpect(hour).toHaveAttribute("data-placeholder", "true");
        baseExpect(await hour.evaluate((el) => getComputedStyle(el).color)).toBe(await css(page, "probe-primary-ink-on", "color"));
        await page.keyboard.press("Enter");
        await baseExpect(popover).toBeVisible();
        // whole again and in the future: Enter sets it
        await typeTime(field, 4, 0, "PM");
        await baseExpect(popover.getByTestId("remind-set")).toBeEnabled();
        await page.keyboard.press("Enter");
        await baseExpect(popover).toBeHidden();
        await baseExpect(page.locator("[data-testid=snack]").filter({ hasText: "4:00 PM" })).toBeVisible();
      });
      await scenario("the date picker marks today with a dot", async () => {
        await freshNoDrafts(page, server);
        await probes(page);
        await openRow(page, 1);
        await page.getByTestId("action-remind").click();
        const popover = page.getByTestId("remind-popover");
        await popover.getByTestId("remind-pick").click();
        await popover.getByTestId("remind-date").click();
        await page.mouse.move(1, 1);
        // tomorrow is chosen by default: today rests unfilled
        const today = page.locator("[data-slot=calendar] button[data-today]");
        const dot = await today.evaluate((el) => ({ bg: getComputedStyle(el, "::after").backgroundColor, w: getComputedStyle(el, "::after").width, color: getComputedStyle(el).color }));
        baseExpect(dot).toEqual({ bg: await css(page, "probe-primary", "background-color"), w: "4px", color: await css(page, "probe-foreground", "color") });
      });
    });

    // plan 120 review: a chosen day shown as another month's (December 1 in November's last row) is the ink too
    // plan 121: BoardUI's date-picker trigger, the date and time as wide as the rows above them
    // plan 122: BoardUI's Time Field, typed segment by segment, in the theme's secondary chrome
    // plan 122 review: a cleared time sets nothing; Enter in the time sets it; a past one shows the error border
    // plan 125: BoardUI's alert dialog, its footer a plain row inside the panel, the confirm the solid danger
    test("restyled surfaces: a confirm, a close, menu rows, a tooltip, a select", async ({ app: page }) => {
      await scenario("a confirm dialog: one surface, the actions inside its inset, the danger confirm solid", async () => {
        await page.locator("[data-testid^=nav-category-]").first().click({ button: "right" });
        await page.getByTestId("category-menu-delete").click();
        const dialog = page.getByTestId("category-delete-dialog");
        await baseExpect(dialog).toBeVisible();
        await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
        const footer = dialog.locator("[data-slot=alert-dialog-footer]");
        baseExpect(await footer.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopWidth])).toEqual(["rgba(0, 0, 0, 0)", "0px"]);
        const [panel, row] = [(await dialog.boundingBox())!, (await footer.boundingBox())!];
        baseExpect(panel.y + panel.height - (row.y + row.height), "the footer sits 24 px above the panel's bottom, inside its corners").toBeCloseTo(24, 0);
        baseExpect(await dialog.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
        const confirm = page.getByTestId("category-delete-dialog-confirm");
        baseExpect(await confirm.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
        baseExpect(await confirm.evaluate((el) => getComputedStyle(el).color)).toBe(await css(page, "probe-danger-ink", "color"));
        baseExpect(await confirm.evaluate((el) => getComputedStyle(el).getPropertyValue("--tw-gradient-from").trim())).toBe(await css(page, "probe-danger", "background-color"));
      });
      await scenario("a dialog's close sits in its header row, at the panel's inset", async () => {
        await freshStart(page);
        await probes(page);
        await focusList(page);
        await page.keyboard.press("?");
        const dialog = page.getByTestId("shortcuts-dialog");
        await baseExpect(dialog).toBeVisible();
        await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
        const close = dialog.getByRole("button", { name: "Close" });
        const title = dialog.locator("[data-slot=dialog-title]");
        const [panel, c, t] = [(await dialog.boundingBox())!, (await close.boundingBox())!, (await title.boundingBox())!];
        const line = parseFloat(await title.evaluate((el) => getComputedStyle(el).lineHeight));
        baseExpect(Math.abs(c.y + c.height / 2 - (t.y + line / 2)), "centred on the title's first line").toBeLessThanOrEqual(0.5);
        baseExpect(panel.x + panel.width - (c.x + c.width), "at the 24 px inset").toBeCloseTo(24, 0);
        baseExpect(await close.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius) >= el.getBoundingClientRect().width / 2), "round").toBe(true);
        baseExpect(await dialog.locator("[data-slot=dialog-header]").evaluate((el) => getComputedStyle(el).paddingInlineEnd)).toBe("32px");
      });
      await scenario("menu rows are medium, 2 px apart; separators run to the panel's edges", async () => {
        await freshStart(page);
        await probes(page);
        await page.getByTestId("thread-row").first().click({ button: "right" });
        const menu = page.locator("[data-slot=context-menu-content]");
        await baseExpect(menu).toBeVisible();
        await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
        const [archive, trash] = [menu.getByTestId("menu-archive"), menu.getByTestId("menu-trash")];
        baseExpect(await archive.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("500");
        const [a, b] = [(await archive.boundingBox())!, (await trash.boundingBox())!];
        baseExpect(b.y - (a.y + a.height), "2 px between rows").toBeCloseTo(2, 1);
        const sep = menu.locator("[role=separator]").first();
        const [panel, line] = [(await menu.boundingBox())!, (await sep.boundingBox())!];
        baseExpect(line.x, "from the panel's start").toBeCloseTo(panel.x, 1);
        baseExpect(line.width, "to its end").toBeCloseTo(panel.width, 1);
      });
      await scenario("a tooltip is medium text with a caret", async () => {
        await freshStart(page);
        await probes(page);
        await focusList(page);
        await page.keyboard.press("c");
        await page.getByTestId("compose-send-later").hover();
        const tip = page.locator("[data-slot=tooltip-content]");
        await baseExpect(tip).toBeVisible();
        baseExpect(await tip.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("500");
        const arrow = tip.locator("[data-slot=tooltip-arrow]");
        await baseExpect(arrow).toBeVisible();
        baseExpect(await arrow.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-popover", "background-color"));
        // the caret points at the trigger: it reaches past the tooltip's edge on the trigger's side
        const [t, c] = [(await tip.boundingBox())!, (await arrow.boundingBox())!];
        if ((await arrow.getAttribute("data-side")) === "bottom") baseExpect(c.y).toBeLessThan(t.y);
        else baseExpect(c.y + c.height).toBeGreaterThan(t.y + t.height);
      });
      await scenario("a select opens below its trigger, the chosen row filled with no check, its chevron turned", async () => {
        await freshStart(page);
        await probes(page);
        await focusList(page);
        await page.keyboard.press("c");
        const trigger = page.getByTestId("compose-from");
        await trigger.click();
        const popup = page.locator("[data-slot=select-content]");
        await baseExpect(popup).toBeVisible();
        await popup.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
        const [tr, pop] = [(await trigger.boundingBox())!, (await popup.boundingBox())!];
        baseExpect(pop.y - (tr.y + tr.height), "4 px below the trigger, not over it").toBeCloseTo(4, 0);
        baseExpect(pop.width).toBeGreaterThanOrEqual(tr.width - 0.5);
        const chosen = popup.locator("[role=option][aria-selected=true]");
        await page.mouse.move(1, 1);
        baseExpect(await chosen.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await css(page, "probe-muted", "background-color"));
        await baseExpect(chosen.locator("svg")).toHaveCount(0);
        const turned = await trigger.locator("svg").last().evaluate((el) => getComputedStyle(el).rotate);
        baseExpect(turned).toBe("180deg");
      });
    });

    // plan 125: the dialog's close is the round CloseButton on the title's first line, the header leaving it room
    // plan 125: BoardUI's menu rows, by a real right-click menu
    // plan 125: BoardUI's tooltip has a caret, in the panel's fill
    // plan 125: BoardUI's select, below its trigger, the chosen row filled, the chevron turned
    // plan 125: BoardUI's calendar marks today with a dot in the primary, its number in the ink
  });
}
