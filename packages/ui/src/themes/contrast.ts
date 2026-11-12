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
  // the surfaces fields sit on (panes, the list's header, cards, menus and dialogs, Settings' tint groups)
  ...(["foreground", "muted-foreground"] as const).flatMap((fg) =>
    (["background", "pane", "card", "popover", "tint"] as const).map((over): ContrastPair => ({ fg, bg: "field", min: 4.5, overToken: over })),
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
  // plan 193: a one-line row's preview, on every fill a row has
  ...text("row-preview", ["background", "pane", "row-hover", "row-selected"]),
  // plan 158: a search's match on a row, in the row's ink on a wash of the star's gold; lighter on the cursor and on a checked row, whose fills are deeper
  ...(["pane", "background", "row-hover"] as const).map((over): ContrastPair => ({ fg: "foreground", bg: "star", alpha: 0.25, min: 4.5, overToken: over })),
  { fg: "row-selected-foreground", bg: "star", alpha: 0.14, min: 4.5, overToken: "row-selected" },
  // plan 161: a gap a model left, in the same wash, on an AI card (tint) and in a composer (card or background)
  ...(["tint", "card"] as const).map((over): ContrastPair => ({ fg: "foreground", bg: "star", alpha: 0.25, min: 4.5, overToken: over })),
  // plan 163: words the model put in a gap the user left, in the primary's 15% wash (the owner's answers: a step up from 12%), in a composer (card, tint or background)
  ...(["card", "tint", "background"] as const).map((over): ContrastPair => ({ fg: "foreground", bg: "primary", alpha: 0.15, min: 4.5, overToken: over })),
  // plan 162 (after ai162-r04): a note for AI in a composer's body, its words and its "For AI" label on the primary's 5% wash
  ...(["foreground", "muted-foreground"] as const).flatMap((fg) => (["card", "tint", "background"] as const).map((over): ContrastPair => ({ fg, bg: "primary", alpha: 0.05, min: 4.5, overToken: over }))),
  // plan 181: the words on an AI card, on its fill (the tint at 65 % in light, the primary's 5 % in dark, globals.css
  // `ai-card`) over the reader, Lumen's reader card and a dialog; each pair is checked in every palette, both modes
  ...(["foreground", "muted-foreground"] as const).flatMap((fg) =>
    (["background", "card", "popover"] as const).flatMap((over): ContrastPair[] => [
      { fg, bg: "tint", alpha: 0.65, min: 4.5, overToken: over },
      { fg, bg: "primary", alpha: 0.05, min: 4.5, overToken: over },
    ]),
  ),
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
  /** a mode where it's held this way (plan 173: light's selection is the owner's lighter step) */
  mode?: "light" | "dark";
}
export const RATED_PALETTES = ["lumen-light", "lumen-dark", "atelier-light", "atelier-dark", "terno-light", "terno-dark", "graphite-light", "graphite-dark"] as const;
export const SURFACE_STEPS: readonly SurfaceStep[] = [
  { a: "row-selected", b: "background", min: 1.18, mode: "dark", why: "the open row stands out from the list" },
  { a: "row-selected", b: "row-hover", min: 1.1, mode: "dark", why: "a row under the pointer doesn't look open" },
  // the owner's decision (plan 173): light's selection is a soft step, its hover a softer one, still in that order
  { a: "row-selected", b: "background", min: 1.15, mode: "light", why: "the open row stands out from the list (light: the owner's softer step)" },
  { a: "row-selected", b: "row-hover", min: 1.08, mode: "light", why: "a row under the pointer doesn't look open (light)" },
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
  /** checked only in these palettes */
  only?: readonly string[];
}

/**
 * Owner's decision (2026-11-08, plan 160): a field keeps plan 118's lighter fill, the ink at 7 % (FIELD_WASH), not the
 * deeper wash this suite once tuned it to for 1.35:1 ("these fields are very dark, i think the color they had before i
 * liked way more, don't care about color accessibility"). The owner accepts the lower step: at 7 % a field stands 1.11 to
 * 1.23:1 off the list, and the segmented control (its track the field in light, its thumb the field in dark) the same.
 * This floor only keeps a field from vanishing; the text on it still holds 4.5:1 (CONTRAST_PAIRS).
 */
export const FIELD_FLOOR = 1.1;
/**
 * Owner's decision (2026-11-10, plan 181: "Whisper", picked from four looks): an AI card has no ring, only a breath of fill:
 * Settings' tint at 65 % in light (globals.css `ai-card`), the accent's 5 % wash in dark. The owner accepts the soft step:
 * as built it stands 1.05 to 1.09:1 off the page in light and 1.05 to 1.14:1 in dark. This floor only keeps the card from
 * vanishing; its header (the accent's glyph, the title in the ink) marks it too, and the text on it holds AA (CONTRAST_PAIRS).
 */
export const AI_CARD_FLOOR = 1.04;
export const AI_CARD_FILL_LIGHT: Layer = { token: "tint", alpha: 0.65 };
export const AI_CARD_FILL_DARK: Layer = { token: "primary", alpha: 0.05 };
/**
 * Plan 161 (the owner): the Undo ring's drained part, a faint track of the secondary ink (globals.css `--countdown-track`), so
 * the whole outline is always there and a little drained reads as a countdown, not a gap. Over the pill's own card fill, on the dock or a sent message (plan 182).
 */
export const SNACK_TRACK: Layer = { token: "muted-foreground", alpha: 0.4 };
/** the floor it holds, and the ring's own step above it (a track never reads as the time left) */
export const SNACK_TRACK_FLOOR = 1.8;
export const SNACK_PILL: readonly Layer[] = ["popover", "card"];
/** Plan 160: the row under the pointer; the selection a step above it */
export const HOVER_FLOOR = 1.15;
/**
 * Owner's decision (2026-11-09, plan 173): in light mode the open row and the sidebar's selection are a soft tint again
 * ("at least in light mode the selected-item whether is row or sidebar items should be lighter, it looks ugly now"), at
 * about 1.17:1 off the list and 1.13:1 off the sidebar, the hover a step under it. The owner accepts the lower step: the
 * selection is also what the reader shows. Dark keeps plan 160's floors; the text on these fills still holds AA.
 */
export const SELECTION_FLOOR_LIGHT = 1.12;
export const HOVER_FLOOR_LIGHT = 1.05;
export const BOUNDARY_STEPS: readonly BoundaryStep[] = [
  { edge: ["pane", "row-selected"], behind: ["pane"], min: TINT_FLOOR, mode: "dark", why: "the open row, on the list" },
  { edge: ["pane", "row-selected"], behind: ["pane"], min: SELECTION_FLOOR_LIGHT, mode: "light", why: "the open row, on the list (light)" },
  // a hover is under the pointer that made it, and must stay a step under the selection (SURFACE_STEPS): a lower floor
  { edge: ["pane", "row-hover"], behind: ["pane"], min: HOVER_FLOOR, mode: "dark", why: "the row under the pointer, on the list" },
  { edge: ["pane", "row-hover"], behind: ["pane"], min: HOVER_FLOOR_LIGHT, mode: "light", why: "the row under the pointer, on the list (light)" },
  { edge: ["sidebar", "sidebar-accent"], behind: ["sidebar"], min: TINT_FLOOR, mode: "dark", why: "the sidebar's selection" },
  { edge: ["sidebar", "sidebar-accent"], behind: ["sidebar"], min: SELECTION_FLOOR_LIGHT, mode: "light", why: "the sidebar's selection (light)" },
  // the owner's decision: a field and the segmented control drawn in it at FIELD_FLOOR, not TINT_FLOOR (their fill is plan 118's)
  { edge: ["pane", "field"], behind: ["pane"], min: FIELD_FLOOR, why: "the search field on the list's header" },
  { edge: ["pane", "field", "card"], behind: ["pane", "field"], min: FIELD_FLOOR, why: "the chosen segment's thumb on its track (light)", mode: "light" },
  { edge: ["pane", "background", "field"], behind: ["pane", "background"], min: FIELD_FLOOR, why: "the chosen segment's thumb on its track (dark)", mode: "dark" },
  { edge: ["background", "draft-edge"], behind: ["background"], min: HAIRLINE_FLOOR, why: "a composer card's ring on the reader" },
  { edge: ["$draft", "draft-edge"], behind: ["$draft"], min: HAIRLINE_FLOOR, why: "a composer's field dividers on its card" },
  // plan 161: the keyboard's place in a menu, the palette and Ask's sources: a hover's step everywhere, and in Graphite,
  // where a state is only ever grey, the selection's (its dark one as far as its fixed #9E9E9E still reads on it)
  { edge: ["popover", "menu-highlight"], behind: ["popover"], min: HOVER_FLOOR, why: "the keyboard's place in a menu or the palette" },
  { edge: ["popover", "menu-highlight"], behind: ["popover"], min: TINT_FLOOR, why: "Graphite: the keyboard's place, at the selection's floor", only: ["graphite-light", "graphite-dark"], except: { "graphite-dark": { min: 1.26, why: "the blueprint's #9E9E9E on it at 4.5:1" } } },
  // plan 161: a tint card in a dialog (Settings) is ringed in dark, where its tint is 1.01 to 1.05:1 off the popover
  { edge: ["popover", "card-edge"], behind: ["popover"], min: HAIRLINE_FLOOR, why: "a tint card's ring in a dialog (dark)", mode: "dark" },
  // plan 181: an AI card's fill, on the reader (its background, or Lumen's reader card) and in a dialog (Filters' AI box)
  ...(["background", "card", "popover"] as const).flatMap((under): BoundaryStep[] => [
    { edge: [under, AI_CARD_FILL_LIGHT], behind: [under], min: AI_CARD_FLOOR, mode: "light", why: `an AI card's fill on ${under} (light)` },
    { edge: [under, AI_CARD_FILL_DARK], behind: [under], min: AI_CARD_FLOOR, mode: "dark", why: `an AI card's fill on ${under} (dark)` },
  ]),
  // pass 3: Today's digest row, ringed at rest in the same edge so it reads as a row to open, on the list
  { edge: ["pane", "card-edge"], behind: ["pane"], min: HAIRLINE_FLOOR, why: "the digest's row, ringed on Today's list" },
  // plan 161, the owner: the Undo ring's drained track on its pill (--border was 1.00 to 1.61:1, and read as a broken outline)
  { edge: [...SNACK_PILL, SNACK_TRACK], behind: SNACK_PILL, min: SNACK_TRACK_FLOOR, why: "the Undo ring's drained track on its pill" },
];

/** The contrast across a boundary as drawn. */
export function boundaryStep(theme: Pick<Theme, "tokens">, step: Pick<BoundaryStep, "edge" | "behind">, draft: ThemeToken = "background"): number {
  return contrast(composite(theme, step.edge, draft), composite(theme, step.behind, draft));
}
