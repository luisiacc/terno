/**
 * The fonts Settings → Appearance → Font lists (plans 245, 248): Terno's own, then the computer's, and how typing finds
 * among them. Plain data, no DOM.
 */
import { FONT_IDS, localFamily, localFont, type FontId, type StyleFont } from "@terno/core";
import { t } from "@terno/i18n";
import { TYPEFACES } from "@terno/ui/designs/typefaces";

/** A font's name (plan 245): the bundled ones by their own names, the system font in the active language. */
export function fontName(id: FontId): string {
  return TYPEFACES[id].name ?? t("settings.appearance.font.system");
}

/** A font in the list: Terno's own (built in), an installed family, or a typed name the computer can't list. */
export interface FontItem {
  font: StyleFont;
  name: string;
  kind: "builtIn" | "installed" | "typed";
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** The fonts that match what's typed, ignoring case and accents: names that start with it first, then the rest that contain it. */
export function matchFonts(items: readonly FontItem[], query: string): FontItem[] {
  const q = fold(query.trim());
  if (!q) return [...items];
  const starts: FontItem[] = [];
  const contains: FontItem[] = [];
  for (const item of items) {
    const name = fold(item.name);
    if (name.startsWith(q)) starts.push(item);
    else if (name.includes(q)) contains.push(item);
  }
  return [...starts, ...contains];
}

/** Terno's five, then the installed families. */
export function fontItems(families: readonly string[] | null): FontItem[] {
  return [...FONT_IDS.map((id): FontItem => ({ font: id, name: fontName(id), kind: "builtIn" })), ...(families ?? []).map((family): FontItem => ({ font: localFont(family), name: family, kind: "installed" }))];
}

/** A font as a row of the list. */
export const fontItem = (font: StyleFont): FontItem => {
  const family = localFamily(font);
  return family === null ? { font, name: fontName(font as FontId), kind: "builtIn" } : { font, name: family, kind: "installed" };
};

