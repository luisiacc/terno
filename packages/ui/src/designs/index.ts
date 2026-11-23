import { DEFAULT_DESIGN, isFontId, type DesignId, type FontId } from "@terno/core";
import { atelier } from "./atelier";
import { graphite } from "./graphite";
import { luma } from "./luma";
import { lumen } from "./lumen";
import { macos } from "./macos";
import { relief } from "./relief";
import { TYPEFACES } from "./typefaces";
import type { DesignDefinition } from "./types";

export type { DesignDefinition, DesignVariants, TypeRole } from "./types";

/**
 * Every design, in the order Settings, first run and the palette show them (plan 173, the owner: Graphite second, macOS
 * last; plan 208: Relief beside Graphite, the two greys together). A test keeps it in sync with @terno/core DESIGN_IDS.
 */
export const DESIGNS: readonly DesignDefinition[] = [lumen, graphite, relief, atelier, luma, macos];

const BY_ID = new Map<string, DesignDefinition>(DESIGNS.map((d) => [d.id, d]));

/** A design by id; anything unknown is the default design. */
export function designById(id: string | null | undefined): DesignDefinition {
  return BY_ID.get(id ?? "") ?? BY_ID.get(DEFAULT_DESIGN)!;
}

export function isKnownDesign(id: string): id is DesignId {
  return BY_ID.has(id);
}

/**
 * The design as it draws with the font the user gave it (plan 245): the font's stacks, faces and features, every other
 * value the design's. No font, an unknown one or the design's own is the design itself.
 */
export function withFont(design: DesignDefinition, font: string | null | undefined): DesignDefinition {
  if (!isFontId(font) || font === design.fonts.typeface) return design;
  // one object per pair, so components keep a stable design between renders
  const key = `${design.id}:${font}`;
  let out = WITH_FONT.get(key);
  if (!out) {
    const t = TYPEFACES[font];
    out = { ...design, fonts: { typeface: font, sans: t.stack, display: t.stack, features: t.features, faces: t.faces } };
    WITH_FONT.set(key, out);
  }
  return out;
}
const WITH_FONT = new Map<string, DesignDefinition>();

/** The `data-font` that draws a design from `withFont` beside its `data-design` (undefined: its own font). */
export function fontAttr(design: DesignDefinition): FontId | undefined {
  return design.fonts.typeface === BY_ID.get(design.id)?.fonts.typeface ? undefined : design.fonts.typeface;
}
