/**
 * The color math behind the theme registry and its tests: oklch ↔ sRGB,
 * per-channel gamut clipping (what Chromium does when it paints an oklch
 * color on an sRGB surface), alpha compositing and WCAG 2 contrast.
 * Pure functions, no DOM.
 */

export interface Oklch {
  l: number;
  c: number;
  h: number;
  /** 0–1 */
  alpha: number;
}

/** sRGB, gamma-encoded, 0–1 per channel. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

const NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const OKLCH_RE = new RegExp(String.raw`^oklch\(\s*${NUM}(%?)\s+${NUM}\s+${NUM}(?:deg)?\s*(?:\/\s*${NUM}(%?)\s*)?\)$`, "i");
const SHORT_RE = new RegExp(String.raw`^${NUM}\s+${NUM}\s+${NUM}(?:\s*\/\s*${NUM}(%?))?$`);

/**
 * Parses `#rgb[a]`, `#rrggbb[aa]`, `oklch(L C H [/ a])` or the registry's
 * shorthand `"L C H [/ a]"` (alpha may be a percentage). Throws on anything else.
 */
export function parseColor(input: string): Oklch {
  const s = input.trim();
  if (s.startsWith("#")) return rgbToOklch(parseHex(s));
  let m = OKLCH_RE.exec(s);
  if (m) {
    const l = Number(m[1]) / (m[2] ? 100 : 1);
    const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
    return { l, c: Number(m[3]), h: Number(m[4]), alpha };
  }
  m = SHORT_RE.exec(s);
  if (m) {
    const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]), alpha };
  }
  throw new Error(`Unsupported color: ${input}`);
}

export function parseHex(hex: string): Rgb {
  let h = hex.replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) throw new Error(`Bad hex color: ${hex}`);
  if (h.length <= 4) h = [...h].map((ch) => ch + ch).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), alpha: h.length === 8 ? n(6) : 1 };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** OKLab (L, a, b) → linear sRGB, unclipped. */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function toOklab(c: Oklch): [number, number, number] {
  const rad = (c.h * Math.PI) / 180;
  return [c.l, c.c * Math.cos(rad), c.c * Math.sin(rad)];
}

function fromOklab(L: number, a: number, b: number, alpha: number): Oklch {
  const c = Math.hypot(a, b);
  let h = c < 1e-7 ? 0 : (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h, alpha };
}

/** oklch → gamma-encoded sRGB, each channel clipped to the gamut. */
export function oklchToRgb(c: Oklch): Rgb {
  const [r, g, b] = oklabToLinear(...toOklab(c));
  return { r: clamp01(toGamma(clamp01(r))), g: clamp01(toGamma(clamp01(g))), b: clamp01(toGamma(clamp01(b))), alpha: c.alpha };
}

export function rgbToOklch(c: Rgb): Oklch {
  const [L, a, b] = linearToOklab(toLinear(c.r), toLinear(c.g), toLinear(c.b));
  return fromOklab(L, a, b, c.alpha);
}

/** Is the color inside sRGB without clipping (small tolerance for float error)? */
export function inGamut(c: Oklch, eps = 1e-4): boolean {
  return oklabToLinear(...toOklab(c)).every((v) => v >= -eps && v <= 1 + eps);
}

/** Source-over in gamma-encoded sRGB, the way browsers composite. The result is opaque if the backdrop is. */
export function composite(top: Rgb, backdrop: Rgb): Rgb {
  const a = top.alpha + backdrop.alpha * (1 - top.alpha);
  if (a === 0) return { r: 0, g: 0, b: 0, alpha: 0 };
  const mix = (t: number, b: number) => (t * top.alpha + b * backdrop.alpha * (1 - top.alpha)) / a;
  return { r: mix(top.r, backdrop.r), g: mix(top.g, backdrop.g), b: mix(top.b, backdrop.b), alpha: a };
}

/** WCAG 2 relative luminance of an opaque sRGB color. */
export function luminance(c: Rgb): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

type ColorLike = string | Oklch | Rgb;
function asRgb(c: ColorLike): Rgb {
  if (typeof c === "string") return oklchToRgb(parseColor(c));
  return "r" in c ? c : oklchToRgb(c);
}

/**
 * WCAG contrast ratio of `fg` over `bg`. Translucent colors are composited:
 * `bg` over `base` (default white) first, then `fg` over the result.
 */
export function contrast(fg: ColorLike, bg: ColorLike, base: ColorLike = "#ffffff"): number {
  const backdrop = composite(asRgb(bg), { ...asRgb(base), alpha: 1 });
  const front = composite(asRgb(fg), backdrop);
  const [a, b] = [luminance(front), luminance(backdrop)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `#rrggbb` (or `#rrggbbaa` when translucent). */
export function toHex(c: ColorLike): string {
  const rgb = asRgb(c);
  const h = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}${rgb.alpha < 1 ? h(rgb.alpha) : ""}`;
}

/** Mixes in OKLab (straight line, hue-stable for near-neutral partners): `t` is the share of `b`. */
export function mixOklab(a: Oklch, b: Oklch, t: number): Oklch {
  const [L1, a1, b1] = toOklab(a);
  const [L2, a2, b2] = toOklab(b);
  const k = (x: number, y: number) => x + (y - x) * t;
  return fromOklab(k(L1, L2), k(a1, a2), k(b1, b2), k(a.alpha, b.alpha));
}

const round = (x: number, digits: number) => Number(x.toFixed(digits));

/** CSS `oklch(L C H [/ a])` with stable rounding (the generated CSS diffs cleanly). */
export function formatOklch(c: Oklch): string {
  const body = `${round(c.l, 3)} ${round(c.c, 3)} ${round(c.h, 1)}`;
  return c.alpha < 1 ? `oklch(${body} / ${round(c.alpha, 3)})` : `oklch(${body})`;
}

export function withAlpha(c: Oklch, alpha: number): Oklch {
  return { ...c, alpha };
}
