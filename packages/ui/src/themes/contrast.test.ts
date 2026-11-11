/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, parseColor, withAlpha } from "./color";
import { AI_CARD_FILL_DARK, AI_CARD_FILL_LIGHT, BOUNDARY_STEPS, boundaryStep, composite, contrastFailures, CONTRAST_PAIRS, CONTROL_EDGES, FIELD_WASH, RATED_PALETTES, SNACK_PILL, SNACK_TRACK, SNACK_TRACK_FLOOR, STAR_ON_ROWS, SURFACE_STEPS, surfaceStep } from "./contrast";
import { DESIGNS } from "../designs/index";
import { AI_MIN_CHROMA, resolveCustomTheme, THEMES } from "./registry";

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
    for (const { a, b, min, why } of SURFACE_STEPS.filter((s) => !s.mode || s.mode === theme.mode)) expect(surfaceStep(theme, a, b), `${id} ${a} / ${b}: ${why}`).toBeGreaterThanOrEqual(min);
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
    // plan 160: a field's two inks on the list's own surface (pane) too
    // plan 161: a model's gap, the match's wash over an AI card and a composer
    // plan 163: a fill, the primary's wash, on a composer's three surfaces
    // plan 162 (after ai162-r04): a note for AI's words and its label, on the primary's 5% wash, on the same three
    // plan 181: an AI card's two inks on its two fills (light's, dark's) over the reader, Lumen's card and a dialog
    expect(CONTRAST_PAIRS).toHaveLength(2 + 4 + 49 + 2 + 4 + 2 + 6 + 4 + 3 + 3 + 4 + 40 + 2 + 5 + 1 + 1 + 1 + 8 + 1 + 2 + 1 + 2 + 2 + 2 + 2 + 3 + 6 + 12);
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
  // the owner's decision (plan 160, 2026-11-08): plan 118's lighter fill in every palette, not a wash deepened to TINT_FLOOR
  it("is the palette's field token, the ink at 7% in every palette", () => {
    const globals = readFileSync(join(import.meta.dirname, "../styles/globals.css"), "utf8");
    expect(globals).toContain("--color-field: var(--field);");
    expect(FIELD_WASH).toBe(0.07);
    for (const theme of THEMES) {
      const field = parseColor(theme.tokens.field);
      expect(field.alpha, theme.id).toBe(FIELD_WASH);
      expect({ ...field, alpha: 1 }, theme.id).toEqual({ ...parseColor(theme.tokens.foreground), alpha: 1 });
    }
  });
});

describe("boundaries as drawn (plan 160)", () => {
  // every palette (any can be chosen in any design: Codex review), under every draft surface a design gives a composer
  const drafts = [...new Set(DESIGNS.map((d) => (d.surfaces.draft === "card" ? "card" : d.surfaces.draft === "tint" ? "tint" : "background")))];
  it.each(THEMES.map((t) => [t.id, t] as const))("%s holds every boundary's floor", (id, theme) => {
    for (const draft of drafts)
      for (const step of BOUNDARY_STEPS.filter((s) => (!s.mode || s.mode === theme.mode) && (!s.only || s.only.includes(id)))) expect(boundaryStep(theme, step, draft), `${id} (draft on ${draft}): ${step.why}`).toBeGreaterThanOrEqual(step.except?.[id]?.min ?? step.min);
  });

  it("the Undo ring's track is what the dock draws, at its floor and well under the ring itself, in every palette (plan 161)", () => {
    const globals = readFileSync(join(import.meta.dirname, "../styles/globals.css"), "utf8");
    const layer = SNACK_TRACK as { token: string; alpha: number };
    expect(/@utility snack-surface \{[^}]*--snack-track: ([^;]+);/.exec(globals)?.[1]).toBe(`color-mix(in oklab, var(--${layer.token}) ${Math.round(layer.alpha * 100)}%, transparent)`);
    for (const theme of THEMES) {
      const track = boundaryStep(theme, { edge: [...SNACK_PILL, SNACK_TRACK], behind: SNACK_PILL });
      const ring = boundaryStep(theme, { edge: [...SNACK_PILL, "primary"], behind: SNACK_PILL });
      expect(track, theme.id).toBeGreaterThanOrEqual(SNACK_TRACK_FLOOR);
      // a track, faint: never read as the time left
      expect(track, theme.id).toBeLessThanOrEqual(ring / 2);
    }
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

  it("a custom theme's field keeps its text readable on the list's own surface (Codex review)", () => {
    // a list a step off white: the field's placeholder still reads on it
    const custom = resolveCustomTheme({ id: "custom-x", name: "x", extends: "github-light", mode: "light", tokens: { pane: "oklch(0.96 0 0)" } } as never);
    const t = custom.tokens;
    const fieldOnPane = composite(custom, ["pane", "field"]);
    expect(contrast(t["muted-foreground"], fieldOnPane, t.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastFailures(custom)).toEqual([]);
  });

  it("a broken palette fails its floor with the ratio", () => {
    const theme = { tokens: { ...THEMES.find((t) => t.id === "graphite-light")!.tokens, "row-selected": "oklch(0.98 0 0)" } };
    const step = BOUNDARY_STEPS.find((s) => s.mode === "light" && s.why.startsWith("the open row"))!;
    expect(boundaryStep(theme, step)).toBeLessThan(step.min);
  });

  // the owner's decision (plan 181): an AI card is a breath of fill, drawn with the layers checked here, and never deepened
  it("draws an AI card with the fills the suite checks (plan 181)", () => {
    const globals = readFileSync(join(import.meta.dirname, "../styles/globals.css"), "utf8");
    const card = globals.slice(globals.indexOf("@utility ai-card {"), globals.indexOf("@utility", globals.indexOf("@utility ai-card {") + 1));
    const mix = (l: typeof AI_CARD_FILL_LIGHT) => typeof l === "object" && `color-mix(in oklab, var(--${l.token}) ${l.alpha * 100}%, transparent)`;
    expect(card).not.toMatch(/box-shadow|outline|border(-(?!radius)[a-z-]+)?:/);
    expect(card.split("&:is(.dark *)")[0]).toContain(`background-color: ${mix(AI_CARD_FILL_LIGHT)};`);
    expect(card.split("&:is(.dark *)")[1]).toContain(`background-color: ${mix(AI_CARD_FILL_DARK)};`);
  });
  // Codex review of plan 181: what's painted on the card is over its translucent fill, itself over the reader's surface
  it.each(THEMES.map((t) => t.id))("%s holds AA for a model's gap on an AI card (plan 181)", (id) => {
    const theme = THEMES.find((t) => t.id === id)!;
    const fill = theme.mode === "light" ? AI_CARD_FILL_LIGHT : AI_CARD_FILL_DARK;
    // gaps are Reply ready's, in the reader: on its background, or Lumen's reader card
    for (const under of ["background", "card"] as const) {
      const gap = composite(theme, [under, fill, { token: "star", alpha: 0.25 }]);
      expect(contrast(theme.tokens.foreground, gap, theme.tokens.background), `${id}: a gap on the card over ${under}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it.each(THEMES.map((t) => t.id))("%s keeps its AI cards soft (plan 181)", (id) => {
    const theme = THEMES.find((t) => t.id === id)!;
    for (const step of BOUNDARY_STEPS.filter((s) => s.why.startsWith("an AI card's fill") && s.mode === theme.mode)) {
      expect(boundaryStep(theme, step), `${id}: ${step.why}`).toBeLessThanOrEqual(1.16);
    }
  });

  // plan 181 (the owner: "nice colors for the icon, instead of just black and white"): the AI mark has colour in every palette
  it.each(THEMES.map((t) => t.id))("%s gives the AI mark a colour, never an ink or a grey (plan 181)", (id) => {
    const tokens = THEMES.find((t) => t.id === id)!.tokens;
    const ai = parseColor(tokens.ai);
    expect(ai.c).toBeGreaterThanOrEqual(AI_MIN_CHROMA);
    // the accent itself where it has colour, so a palette's mark matches its own
    if (parseColor(tokens.primary).c >= AI_MIN_CHROMA) expect(tokens.ai).toBe(tokens.primary);
  });

  // the owner's decision (plan 173): light's selections are a soft step, so none drifts back to plan 160's heavy fill
  it.each(THEMES.filter((t) => t.mode === "light").map((t) => t.id))("%s keeps its selections soft (plan 173)", (id) => {
    const theme = THEMES.find((t) => t.id === id)!;
    const ceiling = 1.22;
    for (const why of ["the open row", "the sidebar's selection"]) {
      const step = BOUNDARY_STEPS.find((s) => s.mode === "light" && s.why.startsWith(why))!;
      expect(boundaryStep(theme, step), `${id}: ${step.why}`).toBeLessThanOrEqual(ceiling);
    }
  });
});
