import type { ThemeToken } from "@unica/core";
import { contrast, parseColor, withAlpha } from "./color";
import { CAT_NAMES, GLASS_BACKDROPS, GLASS_TEXT, type Theme } from "./registry";

export interface ContrastPair {
  fg: ThemeToken;
  bg: ThemeToken;
  /** the background is this token at 15% (soft badges) */
  tint?: boolean;
  min: 4.5 | 3;
  /** what the (translucent) background sits on, instead of the theme background: e.g. a menu over a white HTML mail */
  over?: string;
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
  // translucent menus: their text over anything (black or white) behind them
  ...GLASS_TEXT.flatMap((fg) => GLASS_BACKDROPS.map((over): ContrastPair => ({ fg, bg: "popover-glass", min: 4.5, over: `oklch(${over})` }))),
];

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
    const ratio = contrast(parseColor(t[p.fg]), bg, p.over ?? t.background);
    if (ratio < p.min) out.push({ pair: `${p.fg} / ${p.bg}${p.tint ? " 15%" : ""}${p.over ? ` over ${p.over}` : ""}`, ratio: Math.round(ratio * 100) / 100, min: p.min });
  }
  return out;
}
