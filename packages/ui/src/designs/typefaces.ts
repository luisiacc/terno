import type { FontId } from "@terno/core";

/**
 * The fonts a style draws in (plan 245): its own, or one the user gave it.
 * Every face is bundled (globals.css, fonts.test.ts); the system font is the
 * Mac's, with Geist where a platform has none.
 */
export interface Typeface {
  id: FontId;
  /** shown as is in every language; null: the system font, named in the active language */
  name: string | null;
  stack: string;
  /** font-feature-settings when a style takes this font instead of its own */
  features: string;
  /** the faces to have loaded before it paints (CSS font shorthands; empty: system fonts). Variable: one file per subset */
  faces: readonly string[];
}

const bundled = (id: FontId, name: string, family: string, features: string): Typeface => ({
  id,
  name,
  stack: `"${family}", ui-sans-serif, system-ui, sans-serif`,
  features,
  faces: [400, 500, 600, 700].map((w) => `${w} 1em "${family}"`),
});

/** In the order Settings lists them. */
export const TYPEFACES: Record<FontId, Typeface> = {
  // SF on a Mac (the system's own, in its optical sizes); the bundled Geist where SF can't go (the web build elsewhere)
  system: { id: "system", name: null, stack: '-apple-system, BlinkMacSystemFont, "Geist Variable", ui-sans-serif, system-ui, sans-serif', features: '"kern"', faces: [] },
  inter: bundled("inter", "Inter", "Inter Variable", '"kern"'),
  geist: bundled("geist", "Geist", "Geist Variable", '"kern"'),
  figtree: bundled("figtree", "Figtree", "Figtree Variable", '"cv11", "ss01"'),
  "instrument-sans": bundled("instrument-sans", "Instrument Sans", "Instrument Sans Variable", '"cv11", "ss01"'),
};

/** A design's `fonts` from the catalog: it adds only its own features. */
export function typefaceFonts(id: FontId): { typeface: FontId; sans: string; display: string; faces: readonly string[] } {
  const t = TYPEFACES[id];
  return { typeface: id, sans: t.stack, display: t.stack, faces: t.faces };
}
