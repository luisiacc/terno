import type { ThemeToken } from "@unica/core";
import { contrast, parseColor, withAlpha } from "./color";
import { CAT_NAMES, type Theme } from "./registry";

export interface ContrastPair {
  fg: ThemeToken;
  bg: ThemeToken;
  /** the background is this token at 15% (soft badges) */
  tint?: boolean;
  min: 4.5 | 3;
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
  ...CAT_NAMES.map((c): ContrastPair => ({ fg: `cat-${c}-ink`, bg: `cat-${c}`, tint: true, min: 4.5 })),
  ...ui("unread", ["background", "row-selected"]),
  ...ui("row-rail", ["row-selected"]),
  ...ui("ring", ["background"]),
  ...ui("star", ["background"]),
  ...CAT_NAMES.map((c): ContrastPair => ({ fg: `cat-${c}`, bg: "background", min: 3 })),
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
    const ratio = contrast(parseColor(t[p.fg]), bg, t.background);
    if (ratio < p.min) out.push({ pair: `${p.fg} / ${p.bg}${p.tint ? " 15%" : ""}`, ratio: Math.round(ratio * 100) / 100, min: p.min });
  }
  return out;
}
