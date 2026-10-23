/** What the renderer last applied: the native theme, the window background and whether the sidebar shows vibrancy. */
export interface Appearance {
  themeSource: "system" | "light" | "dark";
  /** opaque #rrggbb */
  background: string;
  vibrancy: boolean;
}

/**
 * Validates an appearance message from the renderer (or appearance.json).
 * The window background must be opaque: `#rrggbbaa` (or `#rgb[a]`) is
 * accepted and its alpha dropped, so one translucent token can't make main
 * ignore the whole message. Anything else is refused.
 */
export function parseAppearance(value: unknown): Appearance | null {
  const v = value as Partial<Appearance> | null;
  if (!v || typeof v !== "object") return null;
  if (v.themeSource !== "system" && v.themeSource !== "light" && v.themeSource !== "dark") return null;
  if (typeof v.vibrancy !== "boolean") return null;
  if (typeof v.background !== "string") return null;
  let hex = v.background.trim().toLowerCase();
  if (/^#[0-9a-f]{3,4}$/.test(hex)) hex = `#${Array.from(hex.slice(1, 4), (c) => c + c).join("")}`;
  if (/^#[0-9a-f]{8}$/.test(hex)) hex = hex.slice(0, 7);
  if (!/^#[0-9a-f]{6}$/.test(hex)) return null;
  return { themeSource: v.themeSource, background: hex, vibrancy: v.vibrancy };
}
