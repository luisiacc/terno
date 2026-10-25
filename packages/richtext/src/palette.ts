/**
 * The composer's colors (plan 16 §3). Mail carries the fixed hex; the editor
 * shows each token through a CSS variable per theme mode, so a red word reads
 * in Terno Dark as well as on white. Every text color holds ≥ 4.5:1 on white,
 * on every highlight, and the same once a recipient's dark mode inverts both
 * (palette.test.ts): any pairing the toolbar allows is AA.
 */

export const TEXT_COLORS = ["gray", "red", "orange", "green", "blue", "purple", "pink"] as const;
export type TextColor = (typeof TEXT_COLORS)[number];

export const HIGHLIGHTS = ["yellow", "green", "blue", "pink", "orange", "gray"] as const;
export type Highlight = (typeof HIGHLIGHTS)[number];

/** what mail carries */
export const TEXT_HEX: Record<TextColor, string> = {
  gray: "#5a5e63",
  red: "#b3261e",
  orange: "#9a4700",
  green: "#116b2f",
  blue: "#1557b0",
  purple: "#7627bb",
  pink: "#b0175a",
};

export const HIGHLIGHT_HEX: Record<Highlight, string> = {
  yellow: "#fff2a8",
  green: "#ccf0d2",
  blue: "#d2e3fc",
  pink: "#fbd3e9",
  orange: "#fee0c2",
  gray: "#e8eaed",
};

/** a highlighted run always says its text color, so a dark mode that lightens default text can't put it on a light wash */
export const HIGHLIGHT_INK = "#202124";

/** "#abc", "#aabbcc", "rgb(1, 2, 3)", "rgba(1, 2, 3, 1)" → "#aabbcc"; anything else (named, translucent) → null */
export function toHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (!rgb) return null;
  if (rgb[4] !== undefined && !/^(1|1\.0+|100%)$/.test(rgb[4])) return null;
  const hex = [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"));
  return `#${hex.join("")}`;
}

const byHex = <T extends string>(table: Record<T, string>) => {
  const map = new Map<string, T>();
  for (const [token, hex] of Object.entries(table) as [T, string][]) map.set(hex, token);
  return (value: string): T | null => {
    const hex = toHex(value);
    return hex ? (map.get(hex) ?? null) : null;
  };
};

/** a CSS color back to its token: only exact palette values (Terno's own mail and copies) */
export const textColorOf = byHex(TEXT_HEX);
export const highlightOf = byHex(HIGHLIGHT_HEX);

// ── contrast (WCAG relative luminance), for the palette's own tests and the toolbar's swatches

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** what a full-inversion dark mode (Gmail's on iOS, Outlook's "invert") paints a color as */
export function inverted(hex: string): string {
  const n = 0xffffff ^ Number.parseInt(hex.slice(1), 16);
  return `#${n.toString(16).padStart(6, "0")}`;
}

// ── fonts and sizes

export const FONTS = ["serif", "mono"] as const;
export type Font = (typeof FONTS)[number];
/** the family stacks mail carries ("Sans Serif" is the recipient's default: no style at all) */
export const FONT_CSS: Record<Font, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'SF Mono', Menlo, Consolas, 'Courier New', monospace",
};

/** a CSS font-family list → a font token (Sans Serif and anything unknown → null) */
export function fontOf(family: string): Font | null {
  const f = family.toLowerCase();
  if (/monospace|courier|menlo|consolas|monaco|sf mono/.test(f)) return "mono";
  if (/sans-serif/.test(f)) return null;
  if (/serif|georgia|times|garamond|palatino/.test(f)) return "serif";
  return null;
}

export const SIZES = ["small", "large", "huge"] as const;
export type Size = (typeof SIZES)[number];
/** relative, so they keep their proportion to whatever size the recipient reads in (and never compound: one size per run) */
export const SIZE_CSS: Record<Size, string> = { small: "0.8em", large: "1.4em", huge: "2em" };

/** a CSS font-size → a size token: Terno's own ems, keywords, and Gmail's <font size> steps */
export function sizeOf(value: string): Size | null {
  const v = value.trim().toLowerCase();
  for (const s of SIZES) if (SIZE_CSS[s] === v) return s;
  if (v === "x-small" || v === "small" || v === "xx-small" || v === "smaller") return "small";
  if (v === "large" || v === "x-large" || v === "larger") return "large";
  if (v === "xx-large" || v === "xxx-large") return "huge";
  const em = /^([\d.]+)(em|rem)$/.exec(v);
  if (em) {
    const n = Number(em[1]);
    return n < 0.95 ? "small" : n >= 1.75 ? "huge" : n > 1.1 ? "large" : null;
  }
  return null;
}

/** <font size="1…7"> (Gmail's own drafts and Outlook) */
export function fontSizeAttrOf(value: string): Size | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n <= 2 ? "small" : n >= 6 ? "huge" : n >= 4 ? "large" : null;
}

export const MAX_INDENT = 8;
/** one indent step, in mail and in the editor */
export const INDENT_PX = 40;
