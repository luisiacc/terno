import { composite, luminance, oklabToRgb, rgbToOklab, type Oklab, type Rgb } from "@terno/ui/themes/color";

/**
 * Plan 295: a designed mail in a dark theme, rewritten onto the theme's palette instead of shown on light paper.
 *
 * `darkenMail` walks the mail's elements once, in document order, carrying each one's background and ink as written and
 * as mapped (its own color over its parent's, else inherited). Only inline styles and legacy color attributes exist here:
 * the sanitizer drops <style>. It decides before it writes, so a mail that should keep its paper is left untouched, and a
 * converted one can be put back exactly (`undo`), which is how a palette change or "Show original" repaints in place.
 */

/** The theme's colors the mail is mapped onto, as CSS colors (hex from `mailColors`). */
export interface DarkPalette {
  /** the reader's page: the mail's own page becomes this */
  background: string;
  /** a raised surface: a white card on a grey page */
  card: string;
  foreground: string;
  /** quiet text */
  muted: string;
  link: string;
  border: string;
}

export type DarkReason = "too-large" | "already-dark" | "background-picture" | "image-only" | "stays-light" | "no-colors";
export type DarkResult = { converted: true; undo: () => void } | { converted: false; reason: DarkReason };

// ── color helpers (0–1 sRGB, the shared OKLab math) ───────────────────────────

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (lo: number, hi: number, x: number) => {
  const t = clamp((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};
const chroma = (c: Oklab) => Math.hypot(c.a, c.b);
const mixLab = (x: Oklab, y: Oklab, t: number): Oklab => ({ l: lerp(x.l, y.l, t), a: lerp(x.a, y.a, t), b: lerp(x.b, y.b, t) });
const over = (top: Rgb, back: Rgb): Rgb => (top.alpha >= 1 ? top : composite(top, back));
function ratio(x: Rgb, y: Rgb): number {
  const a = luminance(x), b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const h2 = (v: number) => Math.round(clamp(v) * 255).toString(16).padStart(2, "0");
const hex = (c: Rgb) => `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
const same = (x: Rgb, y: Rgb) => Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) < 0.004;

// ── colors as mail writes them ─────────────────────────────────────────────────

const NAMES: Record<string, string> = {};
"aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32"
  .split(" ")
  .forEach((v, i, all) => {
    if (i % 2 === 0) NAMES[v] = all[i + 1]!;
  });

function hexRgb(h: string): Rgb | null {
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(h)) return null;
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), alpha: h.length === 8 ? n(6) : 1 };
}

function fromHsl(h: number, s: number, l: number, alpha: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0), g: f(8), b: f(4), alpha };
}

const COLOR = /^(rgb|hsl)a?\(\s*([-\d.]+)(%|deg)?[\s,]+([-\d.]+)(%?)[\s,]+([-\d.]+)(%?)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/;
/** System colors as they resolve on light paper (Outlook and Word write `windowtext`); under the dark frame they'd flip */
const SYSTEM: Record<string, string> = { windowtext: "000000", canvastext: "000000", buttontext: "000000", fieldtext: "000000", window: "ffffff", canvas: "ffffff", field: "ffffff", buttonface: "f0f0f0", graytext: "6d6d6d" };
const parsed = new Map<string, Rgb | null>();

/** A color as mail writes it, in CSS or a legacy attribute ("ffffff" without its #). null: no color of its own (transparent, inherit, a variable…). */
export function mailColor(value: string | null | undefined): Rgb | null {
  if (!value) return null;
  const hit = parsed.get(value);
  if (hit !== undefined) return hit;
  const v = value.trim().toLowerCase();
  let out: Rgb | null = null;
  if (v[0] === "#") out = hexRgb(v.slice(1));
  else if (v.startsWith("rgb") || v.startsWith("hsl")) {
    const m = COLOR.exec(v);
    if (m) {
      const alpha = m[8] === undefined ? 1 : clamp(Number(m[8]) / (m[9] ? 100 : 1));
      if (m[1] === "rgb") {
        const ch = (n: string, pct: string | undefined) => clamp(Number(n) / (pct === "%" ? 100 : 255));
        out = { r: ch(m[2]!, m[3]), g: ch(m[4]!, m[5]), b: ch(m[6]!, m[7]), alpha };
      } else out = fromHsl(((Number(m[2]) % 360) + 360) % 360, clamp(Number(m[4]) / 100), clamp(Number(m[6]) / 100), alpha);
    }
  } else if (v in NAMES) out = hexRgb(NAMES[v]!);
  else if (v in SYSTEM) out = hexRgb(SYSTEM[v]!);
  else out = hexRgb(v);
  if (out && (out.alpha === 0 || [out.r, out.g, out.b].some(Number.isNaN))) out = null;
  // (bounded: a session reads many mails)
  if (parsed.size > 4000) parsed.clear();
  parsed.set(value, out);
  return out;
}

// ── the mapping ────────────────────────────────────────────────────────────────

const WHITE: Rgb = { r: 1, g: 1, b: 1, alpha: 1 };
const BLACK: Rgb = { r: 0, g: 0, b: 0, alpha: 1 };
/** the paper's ink and link: what unstyled text and links were in the light rendering */
const PAPER_INK: Rgb = { r: 0.118, g: 0.129, b: 0.153, alpha: 1 };
const PAPER_LINK: Rgb = { r: 0.102, g: 0.333, b: 0.82, alpha: 1 };
/** a surface this light (OKLab L) is page-like: the page itself or a panel on it */
const LIGHT = 0.88;
/** below this a surface is dark: text on it was written light */
const DARK = 0.45;
/** AA is 4.5:1; the margin absorbs the rounding to 8-bit hex */
const AA = 4.6;
const MAX_ELEMENTS = 40_000;

interface Theme {
  bg: Rgb; fg: Rgb; link: Rgb; border: Rgb;
  bgL: Oklab; cardL: Oklab; fgL: Oklab; mutedL: Oklab;
  /** the theme's own step from its background to its card */
  lift: number;
}

function theme(p: DarkPalette): Theme {
  const need = (s: string): Rgb => mailColor(s) ?? BLACK;
  const bg = { ...need(p.background), alpha: 1 };
  const card = over(need(p.card), bg), fg = over(need(p.foreground), bg), muted = over(need(p.muted), bg);
  const bgL = rgbToOklab(bg), cardL = rgbToOklab(card);
  return { bg, fg, link: over(need(p.link), bg), border: need(p.border), bgL, cardL, fgL: rgbToOklab(fg), mutedL: rgbToOklab(muted), lift: Math.max(cardL.l - bgL.l, 0.035) };
}

/** The theme's neutral at a lightness, along background → card → foreground, so every grey carries the theme's tint. */
function ramp(t: Theme, l: number): Oklab {
  if (l <= t.bgL.l) return { l, a: t.bgL.a, b: t.bgL.b };
  if (l <= t.cardL.l && t.cardL.l > t.bgL.l) return { ...mixLab(t.bgL, t.cardL, (l - t.bgL.l) / (t.cardL.l - t.bgL.l)), l };
  const from = t.cardL.l > t.bgL.l ? t.cardL : t.bgL;
  if (l >= t.fgL.l) return { l, a: t.fgL.a, b: t.fgL.b };
  return { ...mixLab(from, t.fgL, (l - from.l) / (t.fgL.l - from.l)), l };
}

/** Where a neutral surface of lightness `l` lands; `pageL` is the mail's own page (white unless it wraps itself in a light grey). */
function surfaceLightness(t: Theme, l: number, pageL: number): number {
  const top = t.bgL.l + 1.6 * t.lift;
  const mid = t.bgL.l + 0.17;
  // the page is the reader's background; every other light surface is raised from it by how far it stood from the page
  if (l >= LIGHT) return t.bgL.l + t.lift * Math.min(1.6, Math.abs(l - pageL) / 0.03);
  // mid greys are the lightest surfaces of the dark rendering
  if (l >= 0.5) return lerp(top, mid, (LIGHT - l) / (LIGHT - 0.5));
  // dark bands (a black footer) stay bands: a well slightly under the page
  if (l >= 0.3) return lerp(mid, t.bgL.l - 0.025, (0.5 - l) / 0.2);
  return Math.max(0.1, lerp(t.bgL.l - 0.025, t.bgL.l - 0.06, (0.3 - l) / 0.3));
}

/** How much a background is a color of its own (a brand band, a button) rather than a tinted neutral. */
const vivid = (c: Oklab) => smooth(0.05, 0.11, chroma(c));

function mapSurface(t: Theme, src: Rgb, pageL: number, cache: Map<string, Rgb>): Rgb {
  const key = hex(src);
  const hit = cache.get(key);
  if (hit) return hit;
  const s = rgbToOklab(src);
  const w = vivid(s);
  let out: Rgb;
  // a brand color stays exactly itself
  if (w >= 0.999) out = src;
  else {
    const l = lerp(surfaceLightness(t, s.l, pageL), s.l, w);
    const tint = ramp(t, l);
    // a pastel keeps its hue as a dusky tint (a touch quieter than written: a cream page at full chroma turns olive); a true grey takes only the theme's
    const own = smooth(0.006, 0.02, chroma(s));
    const keep = lerp(0.7, 1, w);
    const k = 1 - Math.max(w, own * 0.5);
    out = oklabToRgb({ l, a: tint.a * k + s.a * own * keep, b: tint.b * k + s.b * own * keep });
  }
  cache.set(key, out);
  return out;
}

/** Moves a color's lightness away from `bg` until it reaches `min` contrast (hue kept, chroma as far as the gamut allows). */
function ensureContrast(c: Rgb, bg: Rgb, min: number): Rgb {
  if (ratio(c, bg) >= min) return c;
  const s = rgbToOklab(c);
  const up = luminance(bg) < 0.18;
  let lo = s.l, hi = up ? 1 : 0, best = up ? WHITE : BLACK;
  for (let i = 0; i < 10; i++) {
    const l = (lo + hi) / 2;
    const cand = oklabToRgb({ ...s, l });
    if (ratio(cand, bg) >= min) {
      best = cand;
      hi = l;
    } else lo = l;
  }
  return best;
}

/**
 * The ink for text that was `ink` on `was` and now sits on `now`: neutral text takes the theme's foreground or muted by
 * how strongly it stood out before; text in a color of its own keeps its hue. Always at least AA on the new surface.
 */
function mapInk(t: Theme, ink: Rgb, was: Rgb, now: Rgb, link: boolean, cache: Map<string, Rgb>): Rgb {
  // a surface the mapping left alone (a brand band) keeps its text as written
  if (same(was, now)) return ink;
  const key = `${hex(ink)}${hex(was)}${hex(now)}${link ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const before = ratio(ink, was);
  const nowDark = rgbToOklab(now).l < 0.6;
  let out: Rgb;
  // hidden on purpose (a preheader in the page's color): it stays hidden
  if (before < 1.25) out = now;
  else if (link) out = ensureContrast(nowDark ? t.link : PAPER_LINK, now, AA);
  else {
    const s = rgbToOklab(ink);
    const w = smooth(0.04, 0.1, chroma(s));
    const strength = clamp((before - 3) / 8);
    const neutral: Oklab = nowDark ? mixLab(t.mutedL, t.fgL, strength) : { l: lerp(0.45, 0.2, strength), a: 0, b: 0 };
    if (w <= 0.001) out = oklabToRgb(neutral);
    else {
      // its own hue, lifted to about the contrast it had (between AA and 7:1)
      const own = ensureContrast(ink, now, clamp(before, AA, 7));
      out = w >= 0.999 ? own : oklabToRgb(mixLab(neutral, rgbToOklab(own), w));
    }
    out = ensureContrast(out, now, AA);
  }
  cache.set(key, out);
  return out;
}

/** A line (a border, a thin filled cell): a hairline takes the theme's border, a strong rule stays strong, a colored one keeps its color. */
function mapLine(t: Theme, line: Rgb, was: Rgb, now: Rgb): Rgb {
  if (same(was, now)) return line;
  const s = rgbToOklab(line);
  const before = ratio(line, was);
  // a border in its surface's color is a spacer: it follows the surface
  if (before < 1.08) return now;
  const w = vivid(s);
  if (w >= 0.999) return line;
  const nowL = rgbToOklab(now);
  let neutral: Rgb;
  if (before < 1.7) {
    neutral = over(t.border, now);
    if (Math.abs(rgbToOklab(neutral).l - nowL.l) < 0.045) neutral = oklabToRgb(ramp(t, nowL.l + (nowL.l < 0.6 ? 0.07 : -0.07)));
  } else neutral = oklabToRgb(mixLab(nowL, nowL.l < 0.6 ? t.fgL : { l: 0.15, a: 0, b: 0 }, lerp(0.22, 0.6, clamp((before - 1.7) / 10))));
  return w <= 0.001 ? neutral : oklabToRgb(mixLab(rgbToOklab(neutral), s, w));
}

// ── reading the mail ───────────────────────────────────────────────────────────

/** builders leave `url('')` behind */
const EMPTY_URL = /^url\(\s*["']?\s*["']?\s*\)$/;
const NO_IMAGE = new Set(["", "none", "initial", "unset", "inherit", "revert"]);
const COLOR_IN_CSS = /#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)|\b[a-z]{3,20}\b/gi;
const SIDES = ["top", "right", "bottom", "left"] as const;
const HAS_COLOR = /colou?r|background|border|fill/i;
/** values that name no color of their own */
const NO_COLOR = new Set(["", "transparent", "inherit", "initial", "unset", "revert", "revert-layer", "currentcolor", "none"]);
/** A color the mail sets that the parser can't read (a newer notation, a legacy oddity): the browser still paints it. */
const unreadable = (v: string | null | undefined) => !!v && !NO_COLOR.has(v.trim().toLowerCase()) && !mailColor(v);
/** color notations the mail parser doesn't read */
const OTHER_COLOR = /\b(?:oklch|oklab|lab|lch|hwb|color|color-mix|light-dark)\(/i;

function px(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(v);
  return m ? Number(m[1]) : null;
}

/** The characters an element holds itself (not its children's). */
function ownText(el: Element): number {
  let n = 0;
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 3) continue;
    const s = c.nodeValue!;
    // whitespace runs (most of table markup) count nothing, cheaply
    if (s.length < 3 && !s.trim()) continue;
    n += s.trim().length;
  }
  return n;
}

/** A small filled box that is a link, sits in one, or holds nothing but one. */
function isButton(el: Element): boolean {
  // a bar across the mail ("View in your browser") is a band, never a button
  const wide = (e: Element | null) => {
    if (!e) return false;
    const width = e.getAttribute("width") || (e as HTMLElement).style?.width || "";
    return /^\s*(?:9\d|100)(?:\.\d+)?%/.test(width) || (px(width) ?? 0) >= 400;
  };
  if (wide(el)) return false;
  const row = el.parentElement;
  if ((el.localName === "td" || el.localName === "th") && row && row.children.length === 1 && wide(el.closest("table"))) return false;
  if (el.localName === "a" || el.closest("a")) return true;
  const text = (el.textContent ?? "").trim();
  if (text.length > 60 || el.querySelector("img[width], table table")) return false;
  const links = el.querySelectorAll("a");
  return links.length === 1 && (links[0]!.textContent ?? "").trim().length >= text.length * 0.9;
}

/** The mail's own page: a full-width light grey wrapper around (nearly) everything; white otherwise. */
function pageLightness(root: HTMLElement): number {
  let el: Element = root;
  const total = Math.max(1, (root.textContent ?? "").length);
  for (let depth = 0; depth < 10; depth++) {
    let next: HTMLElement | null = null;
    for (const child of el.children) {
      if ((child.textContent ?? "").length >= total * 0.8) {
        next = child as HTMLElement;
        break;
      }
    }
    if (!next) return 1;
    const width = next.style?.width || next.getAttribute("width") || "";
    const maxWidth = next.style?.maxWidth;
    if (px(width) !== null || (maxWidth && maxWidth !== "none" && !maxWidth.endsWith("%"))) return 1;
    const bg = mailColor(next.style?.backgroundColor) ?? mailColor(next.getAttribute("bgcolor"));
    if (bg && bg.alpha >= 1) {
      const s = rgbToOklab(bg);
      return s.l >= LIGHT && chroma(s) < 0.02 ? s.l : 1;
    }
    el = next;
  }
  return 1;
}

/**
 * A declaration to write. Always without `!important`: inline, it replaces the sender's own declaration whatever its
 * priority (no sheet competes in the reader), and the full message view's themed sheet can still take over a section.
 * Shorthands are written as their longhands, so `undo` can put back mixed sides exactly.
 */
type Write = [el: HTMLElement, prop: string, value: string];
const sides = (el: HTMLElement, value: string): Write[] => SIDES.map((side) => [el, `border-${side}-color`, value]);
/** past this many call-to-action checks in one mail, the rest are surfaces (each reads its subtree) */
const MAX_BUTTON_CHECKS = 100;

/**
 * Rewrites the light designed mail under `root` onto the dark palette, in place. `converted: false` (nothing written)
 * when it should keep its paper; otherwise `undo` puts back exactly the declarations it replaced.
 */
export function darkenMail(root: HTMLElement, palette: DarkPalette): DarkResult {
  // (a live collection: counted without building an array, so a huge mail bails out cheaply)
  const all = root.getElementsByTagName("*") as HTMLCollectionOf<HTMLElement>;
  const n = all.length;
  if (n > MAX_ELEMENTS) return { converted: false, reason: "too-large" };
  const t = theme(palette);
  const pageL = pageLightness(root);
  const surfaces = new Map<string, Rgb>();
  const inks = new Map<string, Rgb>();

  // per element, in document order (a parent always before its children); slot n is the root: white paper, the paper's ink
  const index = new Map<Element, number>();
  const wasBg: Rgb[] = [], nowBg: Rgb[] = [];
  const wasInk: Rgb[] = [], nowInk: Rgb[] = [];
  /** left as written: drawn art, anything over a background picture */
  const kept = new Uint8Array(n + 1);
  const hidden = new Uint8Array(n + 1);
  wasBg[n] = WHITE;
  nowBg[n] = t.bg;
  wasInk[n] = PAPER_INK;
  nowInk[n] = t.fg;

  const writes: Write[] = [];
  let buttonChecks = 0;
  let text = 0, textDark = 0, textPicture = 0, textLightAfter = 0, bigImages = 0, colors = 0;

  for (let i = 0; i < n; i++) {
    const el = all[i]!;
    index.set(el, i);
    const parent = el.parentElement;
    const p = parent && parent !== root ? (index.get(parent) ?? n) : n;
    const tag = el.localName;
    const s = el.style as CSSStyleDeclaration | undefined;
    const styled = s !== undefined && el.hasAttribute("style") && HAS_COLOR.test(el.getAttribute("style")!);
    // (font-size:0 is no sign: builders zero a cell and size the text inside it)
    hidden[i] = hidden[p] || (s && (s.display === "none" || s.visibility === "hidden")) ? 1 : 0;

    // its own colors, as written
    let bg: Rgb | null = null, ink: Rgb | null = null;
    let picture = false, gradient: string | null = null;
    if (styled) {
      bg = mailColor(s.backgroundColor);
      ink = mailColor(s.color);
      // a color it can't know (a variable, `oklch()`): what's painted there can't be judged, so it stays as written
      if (/var\(/i.test(el.getAttribute("style")!) || unreadable(s.backgroundColor) || unreadable(s.color)) picture = true;
      const image = s.backgroundImage;
      if (image && !NO_IMAGE.has(image)) {
        if (image.includes("url(")) picture = !EMPTY_URL.test(image);
        else if (image.includes("gradient(")) gradient = image;
      }
      if (s.getPropertyValue("-webkit-text-fill-color") || s.getPropertyValue("background-clip") === "text") picture = true;
    }
    if (!bg && el.hasAttribute("bgcolor")) {
      bg = mailColor(el.getAttribute("bgcolor"));
      if (!bg && unreadable(el.getAttribute("bgcolor"))) picture = true;
    }
    if (!ink && (tag === "font" || tag === "basefont") && el.hasAttribute("color")) {
      ink = mailColor(el.getAttribute("color"));
      if (!ink && unreadable(el.getAttribute("color"))) picture = true;
    }
    // a table's columns paint under its cells, which the walk can't see: such a table stays as written
    if (tag === "table") {
      for (const col of el.querySelectorAll<HTMLElement>(":scope > col, :scope > colgroup, :scope > colgroup > col")) {
        if (col.hasAttribute("bgcolor") || /background/i.test(col.getAttribute("style") ?? "")) picture = true;
      }
    }
    if (el.hasAttribute("background") && (tag === "table" || tag === "td" || tag === "th" || tag === "tr" || tag === "tbody")) picture = true;
    // a gradient's stops through the surface mapping, written opaque (each was composited over its backdrop to be mapped).
    // Only see-through stops: just its fill. A stop it can't read, or stops that end up apart (a brand gradient, or one that
    // goes from light to a color the mapping keeps): no one ink is sure to read on all of it, so it stays as written, an
    // island like a picture
    let grad: { css: string; was: Rgb; now: Rgb } | null = null;
    if (gradient && !kept[p]) {
      const stops: Rgb[] = [], mapped: Rgb[] = [];
      // (its stops paint over its own fill, if it has one)
      const under = bg ? over(bg, wasBg[p]!) : wasBg[p]!;
      let unread = OTHER_COLOR.test(gradient);
      const css = gradient.replace(COLOR_IN_CSS, (m) => {
        const c = mailColor(m);
        if (!c) {
          if (m[0] === "#" || m.endsWith(")")) unread = true;
          return m;
        }
        const solid = over(c, under);
        const to = mapSurface(t, solid, pageL, surfaces);
        stops.push(solid);
        mapped.push(to);
        return hex(to);
      });
      if (unread) picture = true;
      else if (stops.length) {
        let lo = 0, hi = 0;
        for (let j = 1; j < mapped.length; j++) {
          if (luminance(mapped[j]!) < luminance(mapped[lo]!)) lo = j;
          if (luminance(mapped[j]!) > luminance(mapped[hi]!)) hi = j;
        }
        // (close enough that the ink judged against the hardest stop reads on the other too)
        if (ratio(mapped[lo]!, mapped[hi]!) > 1.5) picture = true;
        else {
          // the text over it is judged against its hardest stop: the lightest on a dark mapping
          const k = luminance(mapped[hi]!) < 0.18 ? hi : lo;
          grad = { css, was: stops[k]!, now: mapped[k]! };
        }
      }
    }
    if (bg || ink || gradient) colors++;

    const own = hidden[i] ? 0 : ownText(el);
    text += own;

    // left as written: drawn art, and anything over a background picture (its text was colored for the picture)
    if (kept[p] || tag === "svg" || picture) {
      kept[i] = 1;
      wasBg[i] = bg ? over(bg, wasBg[p]!) : wasBg[p]!;
      nowBg[i] = wasBg[i]!;
      wasInk[i] = ink ? over(ink, wasBg[i]!) : wasInk[p]!;
      nowInk[i] = wasInk[i]!;
      if (!kept[p]) {
        // the island starts here: pin what it used to inherit, never over what it sets itself (even a color the parser
        // can't read). Drawn art too: its strokes were drawn for that page
        const style = styled ? el.getAttribute("style")! : "";
        const ownBg = bg || el.hasAttribute("bgcolor") || /(?:^|;)\s*background(?:-color)?\s*:/i.test(style);
        const ownInk = ink || /(?:^|;)\s*color\s*:/i.test(style) || ((tag === "font" || tag === "basefont") && el.hasAttribute("color"));
        if (!ownBg) writes.push([el, "background-color", hex(wasBg[i]!)]);
        if (!ownInk && !same(nowInk[p]!, wasInk[i]!)) writes.push([el, "color", hex(wasInk[i]!)]);
      }
      if (tag === "a" && !ink) writes.push([el, "color", hex(PAPER_LINK)]);
      textPicture += own;
      if (rgbToOklab(nowBg[i]!).l >= 0.6) textLightAfter += own;
      continue;
    }

    // the surface
    wasBg[i] = wasBg[p]!;
    nowBg[i] = nowBg[p]!;
    if (grad) {
      wasBg[i] = grad.was;
      nowBg[i] = grad.now;
      writes.push([el, "background-image", grad.css]);
      if (bg) writes.push([el, "background-color", hex(grad.now)]);
    } else if (bg) {
      const solid = over(bg, wasBg[p]!);
      // a cell a few pixels thin is a drawn line, not a surface
      const h = px(s?.height) ?? px(el.getAttribute("height")), w = px(s?.width) ?? px(el.getAttribute("width"));
      const thin = (h !== null && h <= 3) || (w !== null && w <= 3) || tag === "hr";
      // a black button on a light surface is the mail's call to action: it becomes the theme's light button, not a dark well
      const sl = rgbToOklab(solid);
      const button = !thin && sl.l < 0.4 && chroma(sl) < 0.04 && rgbToOklab(wasBg[p]!).l > 0.8 && rgbToOklab(nowBg[p]!).l < 0.5 && buttonChecks++ < MAX_BUTTON_CHECKS && isButton(el);
      // a fill the same as its parent's goes where the parent's went (a link filled like the button cell it sits in)
      const to = !thin && same(solid, wasBg[p]!) ? nowBg[p]! : thin ? mapLine(t, solid, wasBg[p]!, nowBg[p]!) : button ? oklabToRgb(mixLab(t.bgL, t.fgL, 0.9)) : mapSurface(t, solid, pageL, surfaces);
      wasBg[i] = solid;
      nowBg[i] = to;
      if (!same(solid, to) || bg.alpha < 1) writes.push([el, "background-color", hex(to)]);
    }

    // the ink: where the mail names one, where the surface changed under inherited text, and a link's default
    const link = tag === "a" && !ink;
    wasInk[i] = ink ? over(ink, wasBg[i]!) : link ? PAPER_LINK : wasInk[p]!;
    if (ink || bg || grad || link) {
      const to = mapInk(t, wasInk[i]!, wasBg[i]!, nowBg[i]!, link, inks);
      nowInk[i] = to;
      const inherited = link ? t.link : nowInk[p]!;
      if (ink || !same(to, inherited)) writes.push([el, "color", hex(to)]);
    } else nowInk[i] = nowInk[p]!;

    // lines
    if (styled) {
      for (const side of SIDES) {
        const prop = `border-${side}-color`;
        const v = s.getPropertyValue(prop);
        if (!v || v === "currentcolor" || v === "initial") continue;
        const c = mailColor(v);
        if (!c) continue;
        writes.push([el, prop, hex(mapLine(t, over(c, wasBg[i]!), wasBg[i]!, nowBg[i]!))]);
      }
    }
    if (el.hasAttribute("bordercolor")) {
      // (a side the style names already outranks the attribute, and was mapped above)
      const c = mailColor(el.getAttribute("bordercolor"));
      if (c) writes.push(...sides(el, hex(mapLine(t, c, wasBg[i]!, nowBg[i]!))).filter(([, prop]) => !(styled && s.getPropertyValue(prop))));
    }
    if (tag === "hr" && el.hasAttribute("color")) {
      const c = mailColor(el.getAttribute("color"));
      if (c) {
        const to = hex(mapLine(t, c, wasBg[p]!, nowBg[p]!));
        // (what the style names outranks the attribute, and was mapped above)
        if (!(styled && s.getPropertyValue("background-color"))) writes.push([el, "background-color", to]);
        writes.push(...sides(el, to).filter(([, prop]) => !(styled && s.getPropertyValue(prop))));
      }
    }

    if (tag === "img" && !hidden[i]) {
      const w = px(el.getAttribute("width")) ?? px(s?.width);
      if (w !== null && w >= 400) bigImages++;
    }
    if (own) {
      if (rgbToOklab(wasBg[i]!).l < DARK) textDark += own;
      if (rgbToOklab(nowBg[i]!).l >= 0.6) textLightAfter += own;
    }
  }

  const share = (x: number) => (text ? x / text : 0);
  // keep the paper?
  // nothing to convert: the themed (simple) rendering already handles a mail without colors
  if (!colors && !writes.length) return { converted: false, reason: "no-colors" };
  // a mail that is already dark is shown as written
  if (share(textDark) > 0.6) return { converted: false, reason: "already-dark" };
  // text laid over background pictures can't be judged without their pixels
  if (share(textPicture) > 0.35) return { converted: false, reason: "background-picture" };
  // a mail of sliced pictures: only the gaps between them would turn dark
  if (bigImages >= 2 && text < 280) return { converted: false, reason: "image-only" };
  // most of the text would stay on light, brand-colored surfaces: a half-dark mail is worse than paper
  if (share(textLightAfter) > 0.5) return { converted: false, reason: "stays-light" };

  // the declarations replaced, in order, to put back in reverse
  const before: [HTMLElement, string, string, string][] = [];
  for (const [el, prop, value] of writes) {
    before.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, value);
  }
  return { converted: true, undo: () => restore(before) };
}

function restore(before: readonly [HTMLElement, string, string, string][]): void {
  for (let i = before.length - 1; i >= 0; i--) {
    const [el, prop, value, priority] = before[i]!;
    if (value) el.style.setProperty(prop, value, priority);
    else el.style.removeProperty(prop);
  }
}

// ── pictures ───────────────────────────────────────────────────────────────────

export type PictureFix = "invert" | "plate" | null;

/**
 * What a picture needs on the dark page, from its pixels (RGBA, any size) and the luminance behind it: a dark,
 * near-monochrome see-through glyph (a logo, a wordmark, an icon) turns light; a see-through one with dark parts and
 * colors of its own sits on a soft light plate; an opaque picture brings its own ground and is left.
 */
export function pictureFix(pixels: ArrayLike<number>, ground: number): PictureFix {
  let n = 0, clear = 0, ink = 0, dark = 0, colorful = 0, inkLum = 0;
  // tones (16 lightness steps) and colors (6 levels a channel) of the ink: a logo has a few, a photo a spread
  const tones = new Map<number, number>(), hues = new Map<number, number>();
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    n++;
    if (pixels[i + 3]! < 38) { clear++; continue; }
    ink++;
    const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
    const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    inkLum += y;
    if (y < 0.12) dark++;
    const tone = Math.min(15, Math.floor(Math.sqrt(y) * 16));
    tones.set(tone, (tones.get(tone) ?? 0) + 1);
    const hue = Math.floor(r / 43) * 36 + Math.floor(g / 43) * 6 + Math.floor(b / 43);
    hues.set(hue, (hues.get(hue) ?? 0) + 1);
    colorful += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  }
  // opaque: it brings its own ground; still on a light surface: it reads as drawn
  if (!ink || clear / n < 0.12 || ground > 0.35) return null;
  const top = (counts: Map<number, number>, k: number) => [...counts.values()].sort((a, b) => b - a).slice(0, k).reduce((x, c) => x + c, 0) / ink;
  const darkShare = dark / ink;
  const mean = inkLum / ink;
  const stands = (Math.max(mean, ground) + 0.05) / (Math.min(mean, ground) + 0.05) >= 3;
  // a dark glyph turns light only where it doesn't already read (a black wordmark on a kept green band does)
  // a photo cut out on a see-through ground (an avatar, a product) is left as it is: a negative or a plate would spoil it
  if (colorful / ink < 0.15 && darkShare > 0.4) return stands || top(tones, 2) < 0.8 ? null : "invert";
  if (top(hues, 5) < 0.8) return null;
  // a mixed one: its ink already stands out, or its dark parts read on this ground (not a dark page)
  if (stands && darkShare < 0.3) return null;
  return darkShare > 0.15 && ground < 0.1 ? "plate" : null;
}

/** past this many pixels a picture is a photo or a banner, never a logo to fix (and reading it costs a full decode) */
const MAX_PICTURE_AREA = 1_000_000;
/** what a picture is drawn at to be read: a few thousand pixels say enough */
const SAMPLE = 48;

/**
 * Reads a loaded picture of a darkened mail and fixes it if the dark page would hide it (`pictureFix`). A picture whose
 * pixels can't be read (not CORS-approved) or that is a tracking pixel is left. Returns an undo, or null when untouched.
 */
export function darkenPicture(img: HTMLImageElement, plate: string, canvas: HTMLCanvasElement, root: HTMLElement, page: string): (() => void) | null {
  const w = img.naturalWidth, h = img.naturalHeight;
  // a tracking pixel; a large picture (a photo or banner: reading it decodes it whole, on this thread); a JPEG (opaque, so
  // never fixed); one from elsewhere not asked for in CORS mode (unreadable): nothing to read, or nothing it could change
  if (!img.complete || w * h < 100 || w * h > MAX_PICTURE_AREA || /\.jpe?g(?:[?#]|$)/i.test(img.src)) return null;
  if (!img.hasAttribute("crossorigin") && /^https?:/i.test(img.src) && new URL(img.src).origin !== img.ownerDocument.defaultView?.location.origin) return null;
  const scale = Math.min(1, SAMPLE / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  let pixels: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    // tainted (a picture the server didn't allow to be read) or undecodable
    return null;
  }
  const fix = pictureFix(pixels, groundBehind(img, root, page));
  if (!fix) return null;
  const corners = ["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => [`border-${c}-radius`, "6px"]);
  const props: Record<string, string> = fix === "invert" ? { filter: "invert(1) hue-rotate(180deg) brightness(0.94)" } : { "background-color": plate, ...Object.fromEntries(corners), "box-shadow": `0 0 0 6px ${plate}` };
  const before: [HTMLElement, string, string, string][] = [];
  for (const [prop, value] of Object.entries(props)) {
    before.push([img, prop, img.style.getPropertyValue(prop), img.style.getPropertyPriority(prop)]);
    img.style.setProperty(prop, value, "important");
  }
  return () => restore(before);
}

/** a mail's pictures read at most (a sliced newsletter has dozens; past this, the rest are left as they are) */
const MAX_PICTURES = 60;

/**
 * `darkenPicture` for each picture of a darkened mail: the loaded ones now, the rest as they load. Returns the undo of
 * all of it (fixes put back, listeners gone).
 */
export function darkenPictures(root: HTMLElement, plate: string, page: string): () => void {
  const canvas = root.ownerDocument.createElement("canvas");
  const undo: (() => void)[] = [];
  const pending = new Map<HTMLImageElement, () => void>();
  for (const img of [...root.querySelectorAll("img")].slice(0, MAX_PICTURES)) {
    const read = () => {
      pending.delete(img);
      const fix = darkenPicture(img, plate, canvas, root, page);
      if (fix) undo.push(fix);
    };
    if (img.complete) read();
    else {
      img.addEventListener("load", read, { once: true });
      pending.set(img, read);
    }
  }
  return () => {
    for (const [img, read] of pending) img.removeEventListener("load", read);
    pending.clear();
    for (const fix of undo.splice(0).reverse()) fix();
  };
}

/**
 * The luminance of the nearest surface the mail paints behind an element, as converted; with none, the page the mail now
 * sits on (`page`: the frame's own background may not be repainted yet).
 */
function groundBehind(el: Element, root: HTMLElement, page: string): number {
  const view = el.ownerDocument.defaultView;
  for (let e = el.parentElement; e && view && e !== root; e = e.parentElement) {
    const c = mailColor(view.getComputedStyle(e).backgroundColor);
    if (c && c.alpha > 0.5) return luminance(c);
  }
  return luminance(mailColor(page) ?? WHITE);
}
