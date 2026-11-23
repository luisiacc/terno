import { DEFAULT_DESIGN, isStyleFont, localFamily, type DesignId, type FontId } from "@terno/core";
import type { CSSProperties } from "react";
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
 * value the design's. A family installed on the computer (plan 248) leads the design's own stack, so a family that's
 * gone draws the style's font (whose faces it keeps). No font, an invalid one or the design's own is the design.
 */
export function withFont(design: DesignDefinition, font: string | null | undefined): DesignDefinition {
  const own = BY_ID.get(design.id) ?? design;
  if (!isStyleFont(font) || font === own.fonts.typeface) return own;
  // one object per pair, so components keep a stable design between renders
  const key = `${own.id}:${font}`;
  let out = WITH_FONT.get(key);
  if (!out) {
    const family = localFamily(font);
    if (family !== null) {
      const name = `"${family}"`;
      // the style's own faces stay: a family that's gone draws them (Codex critique #3)
      out = { ...own, fonts: { typeface: "local", family, sans: `${name}, ${own.fonts.sans}`, display: `${name}, ${own.fonts.display}`, features: "normal", faces: own.fonts.faces } };
    } else {
      const t = TYPEFACES[font as FontId];
      out = { ...own, fonts: { typeface: t.id, sans: t.stack, display: t.stack, features: t.features, faces: t.faces } };
    }
    WITH_FONT.set(key, out);
    // typed names are endless: the oldest pairs go (Codex critique #10); the bundled ones are few and come back the same
    if (WITH_FONT.size > 64) WITH_FONT.delete(WITH_FONT.keys().next().value!);
  }
  return out;
}
const WITH_FONT = new Map<string, DesignDefinition>();

/**
 * What draws a design from `withFont` beside its `data-design` (plan 248): `data-font` (none: its own font) and, for
 * an installed family, its quoted name as `--local-font`, which the generated `[data-font="local"]` blocks put in front
 * of the design's own stack. Spread onto the element that carries `data-design`.
 */
export interface FontPaint {
  "data-font"?: FontId | "local";
  /** `--local-font` only */
  style?: CSSProperties;
}

export function fontPaint(design: DesignDefinition): FontPaint {
  const { typeface, family } = design.fonts;
  if (typeface === BY_ID.get(design.id)?.fonts.typeface) return {};
  if (typeface === "local") return { "data-font": "local", style: { "--local-font": `"${family}"` } as CSSProperties };
  return { "data-font": typeface };
}
