/**
 * Plan 16: the composer's colors as the editor shows them, in every built-in
 * palette, on each surface a design draws a draft on (tint, background,
 * card): every text color and the highlight inks, on the surface and on every
 * highlight, hold 4.5:1. Light palettes show the mail's own values.
 */
import { HIGHLIGHT_DARK, HIGHLIGHT_HEX, HIGHLIGHT_INK, HIGHLIGHT_INK_DARK, HIGHLIGHTS, TEXT_COLORS, TEXT_DARK, TEXT_HEX } from "@terno/richtext/palette";
import { describe, expect, it } from "vitest";
import { composite, contrast, oklchToRgb, parseColor } from "./color";
import { THEMES } from "./registry";

describe("composer colors (plan 16)", () => {
  it.each(THEMES.map((t) => [t.id, t] as const))("%s: every text color and highlight reads on the draft surfaces", (_id, theme) => {
    const dark = theme.mode === "dark";
    const ink = dark ? TEXT_DARK : TEXT_HEX;
    const wash = dark ? HIGHLIGHT_DARK : HIGHLIGHT_HEX;
    const washInk = dark ? HIGHLIGHT_INK_DARK : HIGHLIGHT_INK;
    const base = { ...oklchToRgb(parseColor(theme.tokens.background)), alpha: 1 };
    const failures: string[] = [];
    for (const surface of ["tint", "background", "card"] as const) {
      const bg = composite(oklchToRgb(parseColor(theme.tokens[surface])), base);
      for (const c of TEXT_COLORS) {
        const r = contrast(ink[c], bg);
        if (r < 4.5) failures.push(`${c} on ${surface}: ${r.toFixed(2)}`);
        for (const h of HIGHLIGHTS) {
          const rh = contrast(ink[c], wash[h]);
          if (rh < 4.5) failures.push(`${c} on ${h}: ${rh.toFixed(2)}`);
        }
      }
    }
    for (const h of HIGHLIGHTS) if (contrast(washInk, wash[h]) < 4.5) failures.push(`ink on ${h}`);
    expect(failures).toEqual([]);
  });
});
