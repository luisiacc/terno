/**
 * The font families installed on this computer (plan 248), for Settings → Appearance → Font. Read once, the first time
 * the font field opens (nothing runs before), and kept for the window's life. The list never leaves the renderer.
 *
 * `queryLocalFonts()` is Chromium's: the desktop app has it with no prompt (Electron approves permission requests
 * when the app sets no handler); a browser may ask, refuse, or not have it. Then there's no list (null) and the field
 * takes a typed name instead.
 */
import { isLocalFamily } from "@terno/core";
import { TYPEFACES } from "@terno/ui/designs/typefaces";

interface LocalFontData {
  family: string;
}
type QueryLocalFonts = () => Promise<readonly LocalFontData[]>;

let families: Promise<readonly string[] | null> | null = null;

/** Sorted, each family once; hidden system families (".SF NS"), names that aren't plain and Terno's own names left out. */
export function familiesFrom(fonts: readonly LocalFontData[]): string[] {
  const builtIn = new Set(Object.values(TYPEFACES).flatMap((t) => (t.name ? [t.name.toLowerCase()] : [])));
  const seen = new Set<string>();
  for (const { family } of fonts) {
    if (!family || family.startsWith(".") || !isLocalFamily(family) || builtIn.has(family.toLowerCase())) continue;
    seen.add(family);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function installedFamilies(): Promise<readonly string[] | null> {
  if (families) return families;
  const query = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  families = query
    ? query().then(
        (fonts) => familiesFrom(fonts),
        () => null,
      )
    : Promise.resolve(null);
  // a refusal can be lifted (the browser's site settings): the next opening asks again
  void families.then((list) => {
    if (!list) families = null;
  });
  return families;
}

/** Tests: forget what was read. */
export function resetInstalledFamilies(): void {
  families = null;
}
