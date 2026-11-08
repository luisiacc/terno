import type { ThemeToken } from "@terno/core";
import { composite as compositeRgb, contrast, formatOklch, oklchToRgb, parseColor, rgbToOklch, withAlpha, type Oklch, type Rgb } from "./color";
import { CAT_NAMES, FIELD_WASH, GLASS_BACKDROPS, GLASS_TEXT, HAIRLINE_FLOOR, TINT_FLOOR, type Theme } from "./registry";

export { FIELD_WASH, HAIRLINE_FLOOR, TINT_FLOOR };

export interface ContrastPair {
  fg: ThemeToken;
  bg: ThemeToken;
  /** the background is this token at 15% (soft badges) */
  tint?: boolean;
  /** the background is this token at this alpha (plan 118: a field's ink wash) */
  alpha?: number;
  min: 4.5 | 3;
  /** what the (translucent) background sits on, instead of the theme background: e.g. a menu over a white HTML mail */
  over?: string;
  /** the same, as a token: a badge's tint over a selected row (itself over the theme background when translucent) */
  overToken?: ThemeToken;
}


const text = (fg: ThemeToken, bgs: ThemeToken[]): ContrastPair[] => bgs.map((bg) => ({ fg, bg, min: 4.5 }));
const ui = (fg: ThemeToken, bgs: ThemeToken[]): ContrastPair[] => bgs.map((bg) => ({ fg, bg, min: 3 }));

/**
 * Every pair WCAG AA must hold for, in every theme (text 4.5:1, UI 3:1).
 * Translucent tokens are composited over the theme background. Borders and
 * inputs are decorative and exempt.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...text("foreground", ["background", "pane", "card", "popover", "muted", "row-hover", "accent", "sidebar", "sidebar-accent"]),
  ...text("muted-foreground", ["background", "pane", "card", "popover", "muted", "row-hover", "row-selected", "sidebar", "sidebar-accent"]),
  ...text("primary-foreground", ["primary"]),
  // plan 125: BoardUI's link button (Button variant="link") on panes and cards (on the tint it fails AA in three palettes: links there are the ink)
  ...text("primary", ["background", "popover", "pane", "card"]),
  ...text("accent-foreground", ["accent"]),
  ...text("row-selected-foreground", ["row-selected"]),
  ...text("destructive", ["background", "popover"]),
  ...text("success", ["background"]),
  ...text("mail-ink", ["mail-paper"]),
  ...text("mail-link", ["mail-paper"]),
  ...CAT_NAMES.map((c): ContrastPair => ({ fg: `cat-${c}-ink`, bg: `cat-${c}`, tint: true, min: 4.5 })),
  ...ui("unread", ["background", "row-selected"]),
  ...ui("ring", ["background"]),
  ...ui("star", ["background"]),
  ...CAT_NAMES.map((c): ContrastPair => ({ fg: `cat-${c}`, bg: "background", min: 3 })),
  // plan 07: the pairs as they are drawn
  ...text("foreground", ["tint"]),
  ...text("muted-foreground", ["tint"]),
  ...text("draft-foreground", ["background", "row-hover", "row-selected", "accent"]),
  ...ui("sidebar-glyph", ["sidebar", "sidebar-accent"]),
  // plan 08: settings draw on tint groups and in a sidebar
  ...text("destructive-ink", ["background", "tint", "popover"]),
  ...text("success-ink", ["background", "tint"]),
  ...ui("ring", ["tint", "sidebar"]),
  ...ui("primary", ["tint"]),
  ...text("sidebar-foreground", ["sidebar", "sidebar-accent"]),
  ...text("sidebar-accent-foreground", ["sidebar-accent"]),
  // plan 15: "N unread" and unread counts as text; avatars and badges on rows hovered, selected and checked, on drafts and panes
  ...text("unread-ink", ["background", "pane", "sidebar", "sidebar-accent"]),
  ...text("sidebar-primary-ink", ["sidebar", "sidebar-accent"]),
  // plan 94: a filled button under the pointer
  ...text("primary-foreground", ["primary-hover"]),
  // plan 66: a hovered sidebar row's text, counts and glyph, its translucent fill painted over the sidebar
  ...(["sidebar-foreground", "sidebar-accent-foreground", "muted-foreground", "unread-ink"] as const).map((fg): ContrastPair => ({ fg, bg: "sidebar-hover", min: 4.5, overToken: "sidebar" })),
  { fg: "sidebar-glyph", bg: "sidebar-hover", min: 3, overToken: "sidebar" },
  ...CAT_NAMES.flatMap((c) => (["pane", "tint", "row-hover", "row-selected", "accent"] as const).map((over): ContrastPair => ({ fg: `cat-${c}-ink`, bg: `cat-${c}`, tint: true, min: 4.5, overToken: over }))),
  // plan 34: an invalid recipient chip's mark (its dotted underline and alert glyph) on the chip's fill
  ...ui("destructive", ["muted"]),
  // plan 122: a past time's clock in the Time Field, on the card it is drawn on
  ...ui("destructive", ["card"]),
  // plan 120: the date picker's chosen day, its text on the primary's 15% wash in the popover
  { fg: "foreground", bg: "primary", tint: true, min: 4.5, overToken: "popover" },
  // plan 118: a field's text and placeholder on its wash of ink (globals.css --color-field: the `field` token, plan 160), on
  // the surfaces fields sit on (panes, cards, menus and dialogs, Settings' tint groups)
  ...(["foreground", "muted-foreground"] as const).flatMap((fg) =>
    (["background", "card", "popover", "tint"] as const).map((over): ContrastPair => ({ fg, bg: "field", min: 4.5, overToken: over })),
  ),
  // plan 125: BoardUI's danger button, its text on both stops of its fill
  ...text("destructive-foreground", ["destructive", "destructive-shade"]),
  // plan 125: a key (Kbd) on the field wash, its text full ink on a highlighted row (the palette's chosen command)
  { fg: "foreground", bg: "field", min: 4.5, overToken: "menu-highlight" },
  // plan 158: a menu's and the palette's chosen row, its text and secondary text
  ...text("popover-foreground", ["menu-highlight"]),
  ...text("muted-foreground", ["menu-highlight"]),
  // plan 158: a reader toolbar's and a reply bar's quiet controls
  ...text("foreground-soft", ["background", "card"]),
  // plan 158: a search's match on a row, in the row's ink on a wash of the star's gold; lighter on the cursor and on a checked row, whose fills are deeper
  ...(["pane", "background", "row-hover"] as const).map((over): ContrastPair => ({ fg: "foreground", bg: "star", alpha: 0.25, min: 4.5, overToken: over })),
  { fg: "row-selected-foreground", bg: "star", alpha: 0.14, min: 4.5, overToken: "row-selected" },
  // translucent menus: their text over anything (black or white) behind them
  ...GLASS_TEXT.flatMap((fg) => GLASS_BACKDROPS.map((over): ContrastPair => ({ fg, bg: "popover-glass", min: 4.5, over: `oklch(${over})` }))),
];

/**
 * Stars on hovered, selected and checked rows. The older palettes' gold sits
 * at 2.4–3:1 there (it was only ever checked on the background); the plan 15
 * palettes hold it, and the older ones are left as they are rather than
 * repainting every existing design.
 */
export const STAR_ON_ROWS: readonly ContrastPair[] = ui("star", ["row-hover", "row-selected", "accent"]);

/**
 * Plan 137: an unchecked box's edge and an off switch's track, on the surfaces controls sit on. The older palettes draw
 * these in `input`, a faint wash well under 3:1, left as it is rather than repainting every design; Graphite's holds it.
 */
export const CONTROL_EDGES: readonly ContrastPair[] = (["control-edge", "control-edge-hover"] as const).flatMap((edge) => ui(edge, ["background", "card", "popover"]));

/**
 * Plan 158: states that have to be told apart at a glance, in the palettes the UI rating covers. WCAG has no number for
 * these; they're what held up when designers looked. Translucent surfaces are painted over the background first.
 */
export interface SurfaceStep {
  a: ThemeToken;
  b: ThemeToken;
  min: number;
  why: string;
}
export const RATED_PALETTES = ["lumen-light", "lumen-dark", "atelier-light", "atelier-dark", "terno-light", "terno-dark", "graphite-light", "graphite-dark"] as const;
export const SURFACE_STEPS: readonly SurfaceStep[] = [
  { a: "row-selected", b: "background", min: 1.18, why: "the open row stands out from the list" },
  { a: "row-selected", b: "row-hover", min: 1.1, why: "a row under the pointer doesn't look open" },
  { a: "menu-highlight", b: "popover", min: 1.18, why: "the keyboard's place in a menu or the palette" },
  { a: "input", b: "background", min: 1.35, why: "a composer's and a field's edge" },
  { a: "border", b: "background", min: 1.25, why: "a hairline that still separates" },
];

/** The contrast between two surfaces, each painted over the background when translucent. */
export function surfaceStep(theme: Pick<Theme, "tokens">, a: ThemeToken, b: ThemeToken): number {
  const t = theme.tokens;
  const paint = (k: ThemeToken) => rgbToOklch(compositeRgb(oklchToRgb(parseColor(t[k])), { ...oklchToRgb(parseColor(t.background)), alpha: 1 }));
  return contrast(paint(a), formatOklch(paint(b)), t.background);
}

export interface ContrastFailure {
  pair: string;
  ratio: number;
  min: number;
}

/** The pairs a theme fails (empty = AA). Custom themes show these as warnings. */
export function contrastFailures(theme: Pick<Theme, "tokens">, pairs: readonly ContrastPair[] = CONTRAST_PAIRS): ContrastFailure[] {
  const t = theme.tokens;
  const out: ContrastFailure[] = [];
  for (const p of pairs) {
    const alpha = p.tint ? 0.15 : p.alpha;
    const bg = alpha !== undefined ? withAlpha(parseColor(t[p.bg]), alpha) : parseColor(t[p.bg]);
    // a token backdrop that is itself translucent is painted over the theme background
    const under = p.overToken ? compositeRgb(oklchToRgb(parseColor(t[p.overToken])), { ...oklchToRgb(parseColor(t.background)), alpha: 1 }) : (p.over ?? t.background);
    const ratio = contrast(parseColor(t[p.fg]), bg, under);
    const over = p.over ?? p.overToken;
    if (ratio < p.min) out.push({ pair: `${p.fg} / ${p.bg}${alpha !== undefined ? ` ${Math.round(alpha * 100)}%` : ""}${over ? ` over ${over}` : ""}`, ratio: Math.round(ratio * 100) / 100, min: p.min });
  }
  return out;
}

/**
 * Plan 160: one layer of what's drawn, from the bottom up: a token as it is (translucent ones keep their alpha), or a
 * token at an alpha (the field's wash of ink). "$draft" is the design's draft surface (card, tint or the background).
 */
export type Layer = ThemeToken | "$draft" | { token: ThemeToken; alpha: number };

/** What the eye sees where these layers are painted, bottom first, over the theme's background. */
export function composite(theme: Pick<Theme, "tokens">, layers: readonly Layer[], draft: ThemeToken = "background"): Oklch {
  const t = theme.tokens;
  let rgb: Rgb = { ...oklchToRgb(parseColor(t.background)), alpha: 1 };
  for (const layer of layers) {
    const c = typeof layer === "string" ? parseColor(t[layer === "$draft" ? draft : layer]) : withAlpha(parseColor(t[layer.token]), layer.alpha);
    rgb = compositeRgb(oklchToRgb(c), rgb);
  }
  return rgbToOklch(rgb);
}

/**
 * Plan 160: boundaries that repeat a cue shown another way (WCAG 1.4.11 asks 3:1 only of what nothing else marks): the
 * selected row is also what the reader shows, the segmented thumb's label changes too, a field has its placeholder and
 * glyph, a card its content. Each is checked as drawn (its layers over what's behind it), against a floor written down
 * from what the eye needed in the rating's screenshots: 1.35:1 for a tint, 1.5:1 for a hairline. What carries
 * information nothing else gives (a checkbox's edge) stays at 3:1 (CONTROL_EDGES).
 */
export interface BoundaryStep {
  /** the boundary's side that's drawn, and what's behind it, bottom first */
  edge: readonly Layer[];
  behind: readonly Layer[];
  min: number;
  why: string;
  /** a mode where it's drawn this way (the segmented control's thumb differs) */
  mode?: "light" | "dark";
  /** a palette held lower, and why (a design's blueprint fixes the ink that bounds it) */
  except?: Partial<Record<string, { min: number; why: string }>>;
}

/**
 * Graphite's blueprint (plan 137) fixes its secondary ink at #5D5D5D and #9E9E9E: a field's placeholder in it reads at 4.5:1
 * on the field (over menus and dialogs too) only up to this wash, so its field, and the thumb drawn in it, stop there
 */
const GRAPHITE_FIELD = { "graphite-light": { min: 1.32, why: "the blueprint's #5D5D5D on the field" }, "graphite-dark": { min: 1.2, why: "the blueprint's #9E9E9E on the field over a menu" } };
/** Plan 160: the row under the pointer; the selection a step above it */
export const HOVER_FLOOR = 1.15;
export const BOUNDARY_STEPS: readonly BoundaryStep[] = [
  { edge: ["pane", "row-selected"], behind: ["pane"], min: TINT_FLOOR, why: "the open row, on the list" },
  // a hover is under the pointer that made it, and must stay a step under the selection (SURFACE_STEPS): a lower floor
  { edge: ["pane", "row-hover"], behind: ["pane"], min: HOVER_FLOOR, why: "the row under the pointer, on the list" },
  { edge: ["sidebar", "sidebar-accent"], behind: ["sidebar"], min: TINT_FLOOR, why: "the sidebar's selection" },
  { edge: ["pane", "field"], behind: ["pane"], min: TINT_FLOOR, why: "the search field on the list's header", except: GRAPHITE_FIELD },
  { edge: ["pane", "field", "card"], behind: ["pane", "field"], min: TINT_FLOOR, why: "the chosen segment's thumb on its track (light)", mode: "light", except: GRAPHITE_FIELD },
  { edge: ["pane", "background", "field"], behind: ["pane", "background"], min: TINT_FLOOR, why: "the chosen segment's thumb on its track (dark)", mode: "dark", except: GRAPHITE_FIELD },
  { edge: ["background", "draft-edge"], behind: ["background"], min: HAIRLINE_FLOOR, why: "a composer card's ring on the reader" },
  { edge: ["$draft", "draft-edge"], behind: ["$draft"], min: HAIRLINE_FLOOR, why: "a composer's field dividers on its card" },
];

/** The contrast across a boundary as drawn. */
export function boundaryStep(theme: Pick<Theme, "tokens">, step: Pick<BoundaryStep, "edge" | "behind">, draft: ThemeToken = "background"): number {
  return contrast(composite(theme, step.edge, draft), composite(theme, step.behind, draft));
}
