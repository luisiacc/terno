import type { ThemeToken } from "@terno/core";
import { composite, contrast, oklchToRgb, parseColor, withAlpha } from "./color";
import { CAT_NAMES, GLASS_BACKDROPS, GLASS_TEXT, type Theme } from "./registry";

export interface ContrastPair {
  fg: ThemeToken;
  bg: ThemeToken;
  /** the background is this token at 15% (soft badges) */
  tint?: boolean;
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
  ...text("primary", ["background", "popover"]),
  ...text("accent-foreground", ["accent"]),
  ...text("row-selected-foreground", ["row-selected"]),
  ...text("destructive", ["background", "popover"]),
  ...text("success", ["background"]),
  ...text("mail-ink", ["mail-paper"]),
  ...text("mail-link", ["mail-paper"]),
  ...CAT_NAMES.map((c): ContrastPair => ({ fg: `cat-${c}-ink`, bg: `cat-${c}`, tint: true, min: 4.5 })),
  ...ui("unread", ["background", "row-selected"]),
  ...ui("row-rail", ["row-selected"]),
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
  ...CAT_NAMES.flatMap((c) => (["pane", "tint", "row-hover", "row-selected", "accent"] as const).map((over): ContrastPair => ({ fg: `cat-${c}-ink`, bg: `cat-${c}`, tint: true, min: 4.5, overToken: over }))),
  // plan 34: an invalid recipient chip's mark (its dotted underline and alert glyph) on the chip's fill
  ...ui("destructive", ["muted"]),
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
    const bg = p.tint ? withAlpha(parseColor(t[p.bg]), 0.15) : parseColor(t[p.bg]);
    // a token backdrop that is itself translucent is painted over the theme background
    const under = p.overToken ? composite(oklchToRgb(parseColor(t[p.overToken])), { ...oklchToRgb(parseColor(t.background)), alpha: 1 }) : (p.over ?? t.background);
    const ratio = contrast(parseColor(t[p.fg]), bg, under);
    const over = p.over ?? p.overToken;
    if (ratio < p.min) out.push({ pair: `${p.fg} / ${p.bg}${p.tint ? " 15%" : ""}${over ? ` over ${over}` : ""}`, ratio: Math.round(ratio * 100) / 100, min: p.min });
  }
  return out;
}
