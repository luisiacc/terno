/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, parseColor, withAlpha } from "./color";
import { BOUNDARY_STEPS, boundaryStep, composite, contrastFailures, CONTRAST_PAIRS, CONTROL_EDGES, FIELD_WASH, RATED_PALETTES, STAR_ON_ROWS, SURFACE_STEPS, surfaceStep } from "./contrast";
import { DESIGNS } from "../designs/index";
import { THEMES } from "./registry";

describe("WCAG AA in every built-in theme", () => {
  it.each(THEMES.map((t) => [t.id, t] as const))("%s passes every pair", (_id, theme) => {
    const failures = contrastFailures(theme).map((f) => `${theme.id}: ${f.pair} = ${f.ratio} (needs ${f.min})`);
    expect(failures).toEqual([]);
  });

  it.each(["lumen-light", "lumen-dark", "atelier-light", "atelier-dark"])("%s keeps its star readable on hovered, selected and checked rows", (id) => {
    expect(contrastFailures(THEMES.find((t) => t.id === id)!, STAR_ON_ROWS)).toEqual([]);
  });

  it.each(["graphite-light", "graphite-dark"])("%s draws unchecked boxes and off switches at 3:1", (id) => {
    const theme = THEMES.find((t) => t.id === id)!;
    expect(contrastFailures(theme, CONTROL_EDGES)).toEqual([]);
    // the off switch's track is 80% of it in dark (switch.tsx)
    if (theme.mode === "dark") expect(contrast(withAlpha(parseColor(theme.tokens["control-edge"]), 0.8), theme.tokens.popover, theme.tokens.background)).toBeGreaterThanOrEqual(3);
  });

  it("control-edge is input, and its hover the ink at 30%, in every other palette, so no other design's controls moved", () => {
    for (const theme of THEMES.filter((t) => !t.id.startsWith("graphite-"))) {
      expect(theme.tokens["control-edge"], theme.id).toBe(theme.tokens.input);
      expect(parseColor(theme.tokens["control-edge-hover"]), theme.id).toEqual(withAlpha(parseColor(theme.tokens.foreground), 0.3));
    }
  });

  it.each(RATED_PALETTES)("%s keeps its states apart (plan 158)", (id) => {
    const theme = THEMES.find((t) => t.id === id)!;
    for (const { a, b, min, why } of SURFACE_STEPS) expect(surfaceStep(theme, a, b), `${id} ${a} / ${b}: ${why}`).toBeGreaterThanOrEqual(min);
  });

  it("checks the pairs the plan requires", () => {
    // 9 + 9 fg/muted-fg surfaces, 8 single text pairs + 2 on the mail paper, 8 badge inks, 4 UI pairs (plan 158: no rail on the open row), 8 dots;
    // plan 07: fg + muted-fg on tint, the draft label on 4 surfaces, sidebar glyphs on 2, 3 menu texts over black and white
    // plan 08: error and "saved" inks on background, tint (and menus); the ring on tint and the sidebar, an on switch on tint; sidebar text
    // plan 15: unread ink on 4 surfaces, 8 badge inks over 5 row/draft surfaces, the sidebar's accent as text on 2
    // plan 34: an invalid recipient chip's mark on the chip
    // plan 66: a hovered sidebar row's four inks and its glyph
    // plan 120: the date picker's chosen day on the primary's wash in its popover
    // plan 94: a filled button's text on its hover fill
    // plan 118: a field's text and placeholder on its wash over 4 surfaces
    // plan 122: a past time's clock on the card
    // plan 125: the danger button's text on both stops of its fill; a key's text on its field wash over a highlighted row;
    // the link button on panes and cards
    // plan 158: a menu's chosen row, its two inks; a search's match on a row, in each of a row's states
    expect(CONTRAST_PAIRS).toHaveLength(2 + 4 + 49 + 2 + 4 + 2 + 6 + 4 + 3 + 3 + 4 + 40 + 2 + 5 + 1 + 1 + 1 + 8 + 1 + 2 + 1 + 2 + 2);
  });

  it("reports a failing pair with its ratio", () => {
    const broken = { tokens: { ...THEMES[0]!.tokens, "muted-foreground": "oklch(0.8 0 0)" } };
    const f = contrastFailures(broken);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]).toMatchObject({ pair: "muted-foreground / background", min: 4.5 });
    expect(f[0]!.ratio).toBeLessThan(2);
  });
});

describe("the field's wash (plans 118, 160)", () => {
  it("is the palette's field token, the ink at 7% or deeper", () => {
    const globals = readFileSync(join(import.meta.dirname, "../styles/globals.css"), "utf8");
    expect(globals).toContain("--color-field: var(--field);");
    for (const theme of THEMES) {
      const field = parseColor(theme.tokens.field);
      expect(field.alpha, theme.id).toBeGreaterThanOrEqual(FIELD_WASH);
      expect({ ...field, alpha: 1 }, theme.id).toEqual({ ...parseColor(theme.tokens.foreground), alpha: 1 });
    }
  });
});

describe("boundaries as drawn (plan 160)", () => {
  // every palette (any can be chosen in any design: Codex review), under every draft surface a design gives a composer
  const drafts = [...new Set(DESIGNS.map((d) => (d.surfaces.draft === "card" ? "card" : d.surfaces.draft === "tint" ? "tint" : "background")))];
  it.each(THEMES.map((t) => [t.id, t] as const))("%s holds every boundary's floor", (id, theme) => {
    for (const draft of drafts)
      for (const step of BOUNDARY_STEPS.filter((s) => !s.mode || s.mode === theme.mode)) expect(boundaryStep(theme, step, draft), `${id} (draft on ${draft}): ${step.why}`).toBeGreaterThanOrEqual(step.except?.[id]?.min ?? step.min);
  });

  it("composites translucent layers in order, over the background", () => {
    const theme = { tokens: { ...THEMES[0]!.tokens, background: "oklch(1 0 0)", foreground: "oklch(0 0 0)", pane: "oklch(1 0 0)" } };
    // the ink at 50% over white, then nothing: a mid grey; at 50% twice: darker still
    const once = composite(theme, ["pane", { token: "foreground", alpha: 0.5 }]);
    const twice = composite(theme, ["pane", { token: "foreground", alpha: 0.5 }, { token: "foreground", alpha: 0.5 }]);
    expect(once.l).toBeLessThan(1);
    expect(twice.l).toBeLessThan(once.l);
    expect(contrast(once, "oklch(1 0 0)")).toBeGreaterThan(2);
  });

  it("a broken palette fails its floor with the ratio", () => {
    const theme = { tokens: { ...THEMES.find((t) => t.id === "graphite-light")!.tokens, "row-selected": "oklch(0.98 0 0)" } };
    const step = BOUNDARY_STEPS.find((s) => s.why.startsWith("the open row"))!;
    expect(boundaryStep(theme, step)).toBeLessThan(step.min);
  });
});
