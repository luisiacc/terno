import { t } from "@terno/i18n";
import { DEFAULT_THEME, THEME_TOKENS, type BuiltinThemeId, type CustomTheme, type ThemeMode, type ThemeToken } from "@terno/core";
import { composite, contrast, formatOklch, mixOklab, oklchToRgb, parseColor, rgbToOklch, withAlpha, type Oklch } from "./color";

/**
 * The theme registry: the source of truth for every color in the app.
 * `themes.generated.css` is generated from it (see generate.ts); a test keeps
 * the two in sync and another checks WCAG AA for every theme.
 *
 * Values are oklch "L C H [/ a]". Each theme declares the base tokens below;
 * derive() fills in the rest unless the theme overrides them.
 */
const BASE = [
  "background",
  "foreground",
  "pane",
  "card",
  "popover",
  "sidebar",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "input",
  "primary",
  "primary-foreground",
  "destructive",
  "success",
  "unread",
  "star",
  "row-hover",
  "row-selected",
  "row-selected-foreground",
  "sidebar-accent",
] as const satisfies readonly ThemeToken[];

export const CAT_NAMES = ["rose", "amber", "lime", "emerald", "cyan", "indigo", "violet", "slate"] as const;

type BaseInput = Record<(typeof BASE)[number], string>;

export interface ThemeInput {
  id: BuiltinThemeId;
  name: string;
  mode: ThemeMode;
  /** the macOS sidebar shows the window's native vibrancy through a translucent sidebar */
  vibrancy: boolean;
  tokens: BaseInput;
  /** rose, amber, lime, emerald, cyan, indigo, violet, slate */
  cats: readonly [string, string, string, string, string, string, string, string];
  /** any derived token, set explicitly */
  overrides?: Partial<Record<ThemeToken, string>>;
}

export interface Theme {
  id: string;
  name: string;
  mode: ThemeMode;
  vibrancy: boolean;
  /** every token, as a CSS color */
  tokens: Record<ThemeToken, string>;
}

const p = parseColor;

/** The lowest alpha ≥ min (in .05 steps) at which `color` reaches `ratio` on `surface` (itself composited over `base` when translucent). */
function alphaOver(color: Oklch, surface: string, base: string, ratio: number, min: number): number {
  for (let a = min; a < 1; a = Math.round((a + 0.05) * 100) / 100) {
    if (contrast(withAlpha(color, a), surface, base) >= ratio) return a;
  }
  return 1;
}

/**
 * Badge and avatar text: the category color pulled toward the theme's ink
 * anchor (60/40 in OKLab), further only if 4.5:1 on its 15% tint needs it.
 */
function inkFor(cat: Oklch, anchor: Oklch, surfaces: string[]): Oklch {
  for (let t = 0.4; t <= 1; t = Math.round((t + 0.05) * 100) / 100) {
    const ink = mixOklab(cat, anchor, t);
    if (surfaces.every((s) => contrast(ink, withAlpha(cat, 0.15), s) >= 4.5)) return ink;
  }
  return anchor;
}

/**
 * `color` stepped in lightness (away from the surfaces) until it reaches
 * `ratio` on every one of them; `fallback` if no step does.
 */
function stepUntil(color: Oklch, surfaces: string[], ratio: number, base: string, fallback: Oklch, darker: boolean): Oklch {
  for (let i = 0; i <= 60; i++) {
    const c = { ...color, l: Math.max(0, Math.min(1, color.l + (darker ? -0.01 : 0.01) * i)) };
    if (surfaces.every((s) => contrast(c, s, base) >= ratio)) return c;
  }
  return fallback;
}

/** The text tokens drawn on a translucent menu. */
export const GLASS_TEXT = ["popover-foreground", "muted-foreground", "destructive"] as const;
/** Worst-case backdrops behind a translucent menu: anything may be under it (HTML mail, images). */
export const GLASS_BACKDROPS = ["0 0 0", "1 0 0"] as const;

/** The lowest popover alpha in [.88, 1] (.02 steps) at which every glass text pair passes 4.5:1 over both backdrops. */
export function glassAlpha(popover: Oklch, texts: Oklch[]): number {
  for (let a = 0.88; a < 1; a = Math.round((a + 0.02) * 100) / 100) {
    const glass = withAlpha(popover, a);
    if (GLASS_BACKDROPS.every((b) => texts.every((t) => contrast(t, glass, formatOklch(p(b))) >= 4.5))) return a;
  }
  return 1;
}

/** Fills in every token a theme doesn't declare. */
export function derive(input: Pick<ThemeInput, "mode" | "tokens" | "cats" | "overrides">): Record<ThemeToken, string> {
  const t = input.tokens;
  const light = input.mode === "light";
  const out: Partial<Record<ThemeToken, Oklch>> = {};
  for (const k of BASE) out[k] = p(t[k]);
  CAT_NAMES.forEach((name, i) => (out[`cat-${name}`] = p(input.cats[i]!)));
  const set = (k: ThemeToken, v: Oklch | string) => {
    out[k] = typeof v === "string" ? p(v) : v;
  };
  const o = (k: ThemeToken) => out[k]!;
  for (const [k, v] of Object.entries(input.overrides ?? {})) set(k as ThemeToken, v);
  const def = (k: ThemeToken, v: () => Oklch | string) => {
    if (!out[k]) set(k, v());
  };

  def("card-foreground", () => o("foreground"));
  def("popover-foreground", () => o("foreground"));
  def("secondary", () => o("muted"));
  def("secondary-foreground", () => o("foreground"));
  def("sidebar-foreground", () => o("foreground"));
  def("sidebar-accent-foreground", () => o("foreground"));
  def("sidebar-primary", () => o("primary"));
  def("sidebar-primary-foreground", () => o("primary-foreground"));
  def("sidebar-border", () => o("border"));
  def("row-rail", () => o("primary"));
  const bg = formatOklch(o("background"));
  def("chart-1", () => o("primary"));
  def("chart-2", () => o("cat-emerald"));
  def("chart-3", () => o("cat-amber"));
  def("chart-4", () => o("cat-rose"));
  def("chart-5", () => o("cat-slate"));
  def("overlay", () => (light ? "0 0 0 / 10%" : "0 0 0 / 45%"));
  def("shadow-color", () => (light ? "0 0 0 / 10%" : "0 0 0 / 40%"));
  def("ink-anchor", () => (light ? "0.2 0.01 265" : "0.98 0 0"));
  def("mail-paper", () => (light ? o("background") : "0.97 0.003 85"));
  def("mail-ink", () => "0.24 0.01 265");
  def("mail-link", () => "0.5 0.18 265");
  def("sidebar-translucent", () => withAlpha(o("sidebar"), light ? 0.72 : 0.62));
  // plan 07
  def("hairline", () => withAlpha(o("foreground"), light ? 0.09 : 0.08));
  def("highlight", () => (light ? "1 0 0 / 16%" : "1 0 0 / 6%"));
  def("tint", () => {
    // a faint shift toward the ink, smaller until text on it still reads
    for (let t = light ? 0.035 : 0.05; t > 0; t = Math.round((t - 0.005) * 1000) / 1000) {
      const c = mixOklab(o("background"), o("foreground"), t);
      if (contrast(o("muted-foreground"), c, bg) >= 4.5 && contrast(o("foreground"), c, bg) >= 4.5) return c;
    }
    return o("background");
  });
  def("draft-foreground", () =>
    stepUntil(o("destructive"), ["background", "row-hover", "row-selected", "accent"].map((k) => formatOklch(o(k as ThemeToken))), 4.5, bg, o("foreground"), light),
  );
  // the focus ring: primary at the lowest alpha ≥ .55 that reaches 3:1 on the background, on tint groups and on the sidebar
  def("ring", () => withAlpha(o("primary"), Math.max(...[bg, formatOklch(o("tint")), formatOklch(o("sidebar"))].map((s) => alphaOver(o("primary"), s, bg, 3, 0.55)))));
  def("sidebar-ring", () => o("ring"));
  // plan 08: error and "saved" text that reads on tint groups as well as on the background and menus
  const inkSurfaces = ["background", "tint", "popover"].map((k) => formatOklch(o(k as ThemeToken)));
  def("destructive-ink", () => stepUntil(o("destructive"), inkSurfaces, 4.5, bg, o("foreground"), light));
  def("success-ink", () => stepUntil(o("success"), inkSurfaces, 4.5, bg, o("foreground"), light));
  // plan 15: unread counts and "N unread" as text, on every surface they're drawn on
  def("unread-ink", () => stepUntil(o("unread"), ["background", "pane", "sidebar", "sidebar-accent"].map((k) => formatOklch(o(k as ThemeToken))), 4.5, bg, o("foreground"), light));
  def("sidebar-glyph", () => stepUntil(o("sidebar-primary"), [formatOklch(o("sidebar")), formatOklch(o("sidebar-accent"))], 3, bg, o("muted-foreground"), light));
  def("popover-glass", () => withAlpha(o("popover"), glassAlpha(o("popover"), GLASS_TEXT.map((k) => o(k)))));
  // badges and avatars: the reader and menus, and (plan 15) rows hovered, selected and checked, drafts and panes
  // (translucent surfaces as painted: over the background)
  const opaque = (c: Oklch) => (c.alpha < 1 ? rgbToOklch(composite(oklchToRgb(c), { ...oklchToRgb(o("background")), alpha: 1 })) : c);
  const surfaces = (["background", "card", "popover", "pane", "tint", "row-hover", "row-selected", "accent"] as const).map((k) => formatOklch(opaque(o(k))));
  for (const name of CAT_NAMES) def(`cat-${name}-ink`, () => inkFor(o(`cat-${name}`), o("ink-anchor"), surfaces));

  return Object.fromEntries(THEME_TOKENS.map((k) => [k, formatOklch(o(k))])) as Record<ThemeToken, string>;
}

/** Raw inputs, kept for custom themes that extend a built-in. */
const BUILTIN_INPUTS = new Map<string, ThemeInput>();

export function defineTheme(input: ThemeInput): Theme {
  BUILTIN_INPUTS.set(input.id, input);
  return { id: input.id, name: input.name, mode: input.mode, vibrancy: input.vibrancy, tokens: derive(input) };
}

type Cats = ThemeInput["cats"];
const cats = (s: string) => s.split("|").map((x) => x.trim()) as unknown as Cats;

export const THEMES: readonly Theme[] = [
  defineTheme({
    id: "terno-light",
    name: "Terno Light",
    mode: "light",
    vibrancy: true,
    tokens: {
      background: "0.99 0.002 85",
      foreground: "0.22 0.01 265",
      pane: "0.99 0.002 85",
      card: "1 0 0",
      popover: "1 0 0",
      sidebar: "0.965 0.004 85",
      muted: "0.955 0.004 85",
      "muted-foreground": "0.5 0.012 265",
      accent: "0.945 0.012 268",
      "accent-foreground": "0.3 0.06 268",
      border: "0.22 0.01 265 / 11%",
      input: "0.22 0.01 265 / 16%",
      primary: "0.56 0.19 268",
      "primary-foreground": "0.99 0.004 268",
      destructive: "0.58 0.21 25",
      success: "0.54 0.13 160",
      unread: "0.56 0.19 268",
      star: "0.665 0.16 80",
      "row-hover": "0.965 0.004 85",
      "row-selected": "0.93 0.04 268",
      "row-selected-foreground": "0.22 0.04 268",
      "sidebar-accent": "0.22 0.01 265 / 7%",
    },
    cats: cats(".675 .12 10 | .665 .12 75 | .65 .12 130 | .645 .12 165 | .65 .1 215 | .62 .13 268 | .64 .13 300 | .62 .02 265"),
  }),
  defineTheme({
    id: "apple-light",
    name: "Apple",
    mode: "light",
    vibrancy: true,
    tokens: {
      background: "1 0 0",
      foreground: "0.232 0.004 286",
      pane: "1 0 0",
      card: "1 0 0",
      popover: "1 0 0",
      sidebar: "0.943 0 0",
      muted: "0.963 0.007 286",
      "muted-foreground": "0.49 0.008 286",
      accent: "0.932 0.007 286",
      "accent-foreground": "0.232 0.004 286",
      border: "0 0 0 / 10%",
      input: "0 0 0 / 15%",
      primary: "0.573 0.218 257",
      "primary-foreground": "1 0 0",
      destructive: "0.594 0.232 29",
      success: "0.54 0.194 147",
      unread: "0.603 0.218 257",
      star: "0.68 0.175 63",
      "row-hover": "0.971 0.003 286",
      "row-selected": "0.93 0.035 257",
      "row-selected-foreground": "0.232 0.004 286",
      "sidebar-accent": "0 0 0 / 7%",
    },
    cats: cats(".65 .238 18 | .68 .175 63 | .665 .177 90 | .645 .194 147 | .662 .133 234 | .529 .191 278 | .615 .213 312 | .648 .007 286"),
  }),
  defineTheme({
    id: "solarized-light",
    name: "Solarized Light",
    mode: "light",
    vibrancy: false,
    tokens: {
      background: "0.974 0.026 90",
      foreground: "0.309 0.052 220",
      pane: "0.974 0.026 90",
      card: "0.974 0.026 90",
      popover: "0.991 0.014 93",
      sidebar: "0.931 0.026 92",
      muted: "0.931 0.026 92",
      "muted-foreground": "0.493 0.029 222",
      accent: "0.931 0.026 92",
      "accent-foreground": "0.309 0.052 220",
      border: "0.897 0.029 92",
      input: "0.863 0.031 92",
      primary: "0.545 0.139 245",
      "primary-foreground": "0.974 0.026 90",
      destructive: "0.571 0.206 27",
      success: "0.539 0.151 119",
      unread: "0.615 0.139 245",
      star: "0.649 0.134 86",
      "row-hover": "0.95 0.026 90",
      "row-selected": "0.931 0.026 92",
      "row-selected-foreground": "0.309 0.052 220",
      "sidebar-accent": "0.897 0.029 92",
    },
    cats: cats(".592 .202 356 | .581 .173 40 | .649 .134 86 | .639 .151 119 | .634 .102 187 | .615 .139 245 | .582 .126 279 | .648 .016 197"),
  }),
  defineTheme({
    id: "gruvbox-light",
    name: "Gruvbox Light",
    mode: "light",
    vibrancy: false,
    tokens: {
      background: "0.956 0.055 96",
      foreground: "0.344 0.007 49",
      pane: "0.956 0.055 96",
      card: "0.965 0.039 101",
      popover: "0.965 0.039 101",
      sidebar: "0.922 0.055 93",
      muted: "0.894 0.057 89",
      "muted-foreground": "0.49 0.023 63",
      accent: "0.894 0.057 89",
      "accent-foreground": "0.344 0.007 49",
      border: "0.894 0.057 89",
      input: "0.825 0.051 85",
      primary: "0.471 0.082 216",
      "primary-foreground": "0.956 0.055 96",
      destructive: "0.437 0.179 28",
      success: "0.531 0.112 106",
      unread: "0.471 0.082 216",
      star: "0.618 0.128 71",
      "row-hover": "0.922 0.055 93",
      "row-selected": "0.894 0.057 89",
      "row-selected-foreground": "0.277 0 0",
      "sidebar-accent": "0.894 0.057 89",
    },
    cats: cats(".546 .203 29 | .622 .171 46 | .64 .143 78 | .631 .135 109 | .625 .094 145 | .576 .066 199 | .597 .111 352 | .619 .029 67"),
  }),
  defineTheme({
    id: "github-light",
    name: "GitHub Light",
    mode: "light",
    vibrancy: false,
    tokens: {
      background: "1 0 0",
      foreground: "0.254 0.011 254",
      pane: "1 0 0",
      card: "1 0 0",
      popover: "1 0 0",
      sidebar: "0.978 0.003 248",
      muted: "0.978 0.003 248",
      "muted-foreground": "0.495 0.022 251",
      accent: "0.957 0.005 248",
      "accent-foreground": "0.254 0.011 254",
      border: "0.881 0.013 244",
      input: "0.881 0.013 244",
      primary: "0.54 0.191 257",
      "primary-foreground": "1 0 0",
      destructive: "0.557 0.206 25",
      success: "0.524 0.14 148",
      unread: "0.54 0.191 257",
      star: "0.554 0.117 75",
      "row-hover": "0.978 0.003 248",
      "row-selected": "0.954 0.028 228",
      "row-selected-foreground": "0.254 0.011 254",
      "sidebar-accent": "0.938 0.007 248",
    },
    cats: cats(".552 .205 25 | .557 .16 45 | .554 .117 75 | .524 .14 148 | .537 .084 202 | .54 .191 257 | .563 .207 295 | .565 .019 251"),
  }),
  defineTheme({
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    mode: "light",
    vibrancy: false,
    tokens: {
      background: "0.958 0.006 265",
      foreground: "0.435 0.043 279",
      pane: "0.958 0.006 265",
      card: "0.958 0.006 265",
      popover: "0.979 0.003 265",
      sidebar: "0.933 0.009 265",
      muted: "0.933 0.009 265",
      "muted-foreground": "0.492 0.034 279",
      accent: "0.857 0.014 268",
      "accent-foreground": "0.435 0.043 279",
      border: "0.906 0.012 265",
      input: "0.857 0.014 268",
      primary: "0.555 0.25 297",
      "primary-foreground": "0.958 0.006 265",
      destructive: "0.55 0.216 20",
      success: "0.52 0.177 140",
      unread: "0.555 0.25 297",
      star: "0.644 0.149 68",
      "row-hover": "0.933 0.009 265",
      "row-selected": "0.899 0.043 299",
      "row-selected-foreground": "0.435 0.043 279",
      "sidebar-accent": "0.906 0.012 265",
    },
    cats: cats(".55 .216 20 | .657 .204 42 | .644 .149 68 | .62 .177 140 | .627 .145 235 | .559 .226 262 | .555 .25 297 | .601 .03 279"),
  }),
  defineTheme({
    id: "lumen-light",
    name: "Lumen",
    mode: "light",
    vibrancy: false,
    // plan 15: warm paper, a near-black ink for primary controls, gold for what's new
    tokens: {
      background: "1 0 0",
      foreground: "0.211 0.005 68",
      pane: "1 0 0",
      card: "1 0 0",
      popover: "1 0 0",
      sidebar: "0.986 0.002 68",
      muted: "0.967 0.003 85",
      "muted-foreground": "0.515 0.012 72",
      accent: "0.96 0.016 83",
      "accent-foreground": "0.5 0.1 74",
      border: "0.3 0.01 70 / 10%",
      input: "0.3 0.01 70 / 15%",
      primary: "0.211 0.005 68",
      "primary-foreground": "1 0 0",
      destructive: "0.56 0.19 30",
      success: "0.53 0.11 150",
      unread: "0.64 0.13 76",
      star: "0.61 0.135 74",
      "row-hover": "0.975 0.004 80",
      "row-selected": "0.955 0.022 83",
      "row-selected-foreground": "0.211 0.005 68",
      "sidebar-accent": "0.953 0.006 75",
    },
    cats: cats(".6 .14 25 | .64 .12 78 | .62 .11 125 | .58 .095 149 | .589 .079 208 | .55 .1 265 | .589 .109 306 | .58 .015 70"),
    overrides: { ring: "0.6 0.12 76" },
  }),
  defineTheme({
    id: "atelier-light",
    name: "Atelier",
    mode: "light",
    vibrancy: false,
    // plan 15: quiet paper and ink navy
    tokens: {
      background: "1 0 0",
      foreground: "0.227 0.004 85",
      pane: "1 0 0",
      card: "1 0 0",
      popover: "1 0 0",
      sidebar: "0.97 0.004 91",
      muted: "0.961 0.004 91",
      "muted-foreground": "0.515 0.013 90",
      accent: "0.954 0.006 255",
      "accent-foreground": "0.326 0.061 256",
      border: "0.227 0.004 85 / 10%",
      input: "0.227 0.004 85 / 15%",
      primary: "0.326 0.061 256",
      "primary-foreground": "1 0 0",
      destructive: "0.55 0.17 30",
      success: "0.52 0.08 145",
      unread: "0.326 0.061 256",
      star: "0.588 0.119 47",
      "row-hover": "0.975 0.003 91",
      "row-selected": "0.945 0.011 255",
      "row-selected-foreground": "0.227 0.004 85",
      "sidebar-accent": "0.934 0.007 89",
    },
    cats: cats(".57 .12 15 | .6 .11 65 | .58 .08 125 | .559 .069 144 | .554 .055 209 | .496 .079 258 | .557 .065 306 | .56 .012 90"),
  }),
  defineTheme({
    id: "terno-dark",
    name: "Terno Dark",
    mode: "dark",
    vibrancy: true,
    tokens: {
      background: "0.165 0.005 265",
      foreground: "0.95 0.004 85",
      pane: "0.165 0.005 265",
      card: "0.195 0.006 265",
      popover: "0.215 0.007 265",
      sidebar: "0.2 0.006 265",
      muted: "0.24 0.007 265",
      "muted-foreground": "0.68 0.01 265",
      accent: "0.27 0.03 268",
      "accent-foreground": "0.92 0.03 268",
      border: "1 0 0 / 8%",
      input: "1 0 0 / 12%",
      primary: "0.7 0.16 268",
      "primary-foreground": "0.16 0.03 268",
      destructive: "0.68 0.19 22",
      success: "0.72 0.13 160",
      unread: "0.72 0.15 268",
      star: "0.82 0.15 85",
      "row-hover": "1 0 0 / 4%",
      "row-selected": "0.29 0.05 268",
      "row-selected-foreground": "0.97 0.01 268",
      "sidebar-accent": "1 0 0 / 8%",
    },
    cats: cats(".72 .12 10 | .78 .12 75 | .78 .12 130 | .74 .12 165 | .76 .1 215 | .7 .13 268 | .72 .13 300 | .7 .02 265"),
  }),
  defineTheme({
    id: "dracula",
    name: "Dracula",
    mode: "dark",
    vibrancy: false,
    tokens: {
      background: "0.288 0.022 278",
      foreground: "0.977 0.008 107",
      pane: "0.288 0.022 278",
      card: "0.319 0.03 279",
      popover: "0.34 0.027 276",
      sidebar: "0.255 0.019 280",
      muted: "0.34 0.027 276",
      "muted-foreground": "0.78 0.08 270",
      accent: "0.403 0.032 278",
      "accent-foreground": "0.977 0.008 107",
      border: "0.362 0.031 280",
      input: "0.403 0.032 278",
      primary: "0.742 0.149 302",
      "primary-foreground": "0.288 0.022 278",
      destructive: "0.777 0.206 24",
      success: "0.871 0.22 148",
      unread: "0.755 0.183 347",
      star: "0.955 0.134 113",
      "row-hover": "0.319 0.03 279",
      "row-selected": "0.403 0.032 278",
      "row-selected-foreground": "0.977 0.008 107",
      "sidebar-accent": "0.34 0.027 276",
    },
    cats: cats(".725 .18 5 | .834 .124 67 | .955 .134 113 | .871 .22 148 | .883 .093 213 | .716 .13 274 | .742 .149 302 | .56 .08 270"),
  }),
  defineTheme({
    id: "monokai",
    name: "Monokai",
    mode: "dark",
    vibrancy: false,
    tokens: {
      background: "0.274 0.011 115",
      foreground: "0.977 0.008 107",
      pane: "0.274 0.011 115",
      card: "0.302 0.011 115",
      popover: "0.314 0.011 115",
      sidebar: "0.237 0.006 122",
      muted: "0.357 0.018 103",
      "muted-foreground": "0.777 0.029 97",
      accent: "0.357 0.018 103",
      "accent-foreground": "0.977 0.008 107",
      border: "0.357 0.018 103",
      input: "0.399 0.016 102",
      primary: "0.841 0.204 127",
      "primary-foreground": "0.274 0.011 115",
      destructive: "0.772 0.24 7",
      success: "0.841 0.204 127",
      unread: "0.841 0.204 127",
      star: "0.879 0.125 103",
      "row-hover": "0.306 0.011 115",
      "row-selected": "0.399 0.016 102",
      "row-selected-foreground": "0.977 0.008 107",
      "sidebar-accent": "0.357 0.018 103",
    },
    cats: cats(".642 .24 7 | .767 .168 62 | .879 .125 103 | .841 .204 127 | .827 .108 212 | .711 .15 272 | .701 .181 298 | .547 .029 97"),
  }),
  defineTheme({
    id: "tokyo-night",
    name: "Tokyo Night",
    mode: "dark",
    vibrancy: false,
    tokens: {
      background: "0.226 0.021 280",
      foreground: "0.846 0.061 275",
      pane: "0.226 0.021 280",
      card: "0.261 0.034 274",
      popover: "0.261 0.034 274",
      sidebar: "0.204 0.016 285",
      muted: "0.306 0.037 273",
      "muted-foreground": "0.701 0.068 274",
      accent: "0.306 0.037 273",
      "accent-foreground": "0.846 0.061 275",
      border: "0.282 0.036 275",
      input: "0.332 0.036 271",
      primary: "0.719 0.132 264",
      "primary-foreground": "0.226 0.021 280",
      destructive: "0.723 0.159 10",
      success: "0.795 0.139 130",
      unread: "0.719 0.132 264",
      star: "0.784 0.106 75",
      "row-hover": "0.261 0.034 274",
      "row-selected": "0.332 0.064 268",
      "row-selected-foreground": "0.846 0.061 275",
      "sidebar-accent": "0.306 0.037 273",
    },
    cats: cats(".723 .159 10 | .787 .137 51 | .784 .106 75 | .795 .139 130 | .82 .105 236 | .719 .132 264 | .751 .134 299 | .589 .062 277"),
  }),
  defineTheme({
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    mode: "dark",
    vibrancy: false,
    tokens: {
      background: "0.277 0 0",
      foreground: "0.894 0.057 89",
      pane: "0.277 0 0",
      card: "0.311 0.003 49",
      popover: "0.344 0.007 49",
      sidebar: "0.241 0.005 220",
      muted: "0.344 0.007 49",
      "muted-foreground": "0.79 0.035 76",
      accent: "0.344 0.007 49",
      "accent-foreground": "0.894 0.057 89",
      border: "0.344 0.007 49",
      input: "0.411 0.012 52",
      primary: "0.708 0.042 170",
      "primary-foreground": "0.241 0.005 220",
      destructive: "0.8 0.218 30",
      success: "0.765 0.158 111",
      unread: "0.693 0.042 170",
      star: "0.832 0.159 83",
      "row-hover": "0.311 0.003 49",
      "row-selected": "0.411 0.012 52",
      "row-selected-foreground": "0.956 0.055 96",
      "sidebar-accent": "0.344 0.007 49",
    },
    cats: cats(".66 .218 30 | .731 .182 52 | .832 .159 83 | .765 .158 111 | .756 .108 138 | .693 .042 170 | .705 .098 2 | .619 .029 67"),
  }),
  defineTheme({
    id: "nord",
    name: "Nord",
    mode: "dark",
    vibrancy: false,
    tokens: {
      background: "0.324 0.023 264",
      foreground: "0.933 0.01 262",
      pane: "0.324 0.023 264",
      card: "0.379 0.029 266",
      popover: "0.379 0.029 266",
      sidebar: "0.301 0.021 266",
      muted: "0.379 0.029 266",
      "muted-foreground": "0.797 0.044 264",
      accent: "0.416 0.032 264",
      "accent-foreground": "0.951 0.007 261",
      border: "0.379 0.029 266",
      input: "0.416 0.032 264",
      primary: "0.775 0.062 217",
      "primary-foreground": "0.324 0.023 264",
      destructive: "0.766 0.121 15",
      success: "0.768 0.075 131",
      unread: "0.775 0.062 217",
      star: "0.855 0.089 84",
      "row-hover": "0.348 0.024 266",
      "row-selected": "0.416 0.032 264",
      "row-selected-foreground": "0.951 0.007 261",
      "sidebar-accent": "0.379 0.029 266",
    },
    cats: cats(".606 .121 15 | .693 .096 38 | .855 .089 84 | .768 .075 131 | .763 .048 194 | .697 .059 249 | .692 .062 333 | .625 .041 263"),
  }),
  defineTheme({
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    mode: "dark",
    vibrancy: false,
    tokens: {
      background: "0.243 0.03 284",
      foreground: "0.879 0.043 272",
      pane: "0.243 0.03 284",
      card: "0.279 0.035 277",
      popover: "0.324 0.032 282",
      sidebar: "0.216 0.025 284",
      muted: "0.324 0.032 282",
      "muted-foreground": "0.781 0.04 274",
      accent: "0.324 0.032 282",
      "accent-foreground": "0.879 0.043 272",
      border: "0.324 0.032 282",
      input: "0.404 0.032 280",
      primary: "0.787 0.119 305",
      "primary-foreground": "0.243 0.03 284",
      destructive: "0.756 0.13 3",
      success: "0.858 0.109 143",
      unread: "0.787 0.119 305",
      star: "0.919 0.07 87",
      "row-hover": "0.296 0.031 282",
      "row-selected": "0.404 0.032 280",
      "row-selected-foreground": "0.879 0.043 272",
      "sidebar-accent": "0.324 0.032 282",
    },
    cats: cats(".756 .13 3 | .824 .101 53 | .919 .07 87 | .858 .109 143 | .847 .083 210 | .766 .111 260 | .787 .119 305 | .687 .037 275"),
  }),
  defineTheme({
    id: "lumen-dark",
    name: "Lumen",
    mode: "dark",
    vibrancy: false,
    tokens: {
      background: "0.19 0.006 70",
      foreground: "0.95 0.005 85",
      pane: "0.19 0.006 70",
      card: "0.215 0.006 70",
      popover: "0.235 0.007 70",
      sidebar: "0.215 0.006 70",
      muted: "0.26 0.007 70",
      "muted-foreground": "0.72 0.012 75",
      accent: "0.29 0.035 80",
      "accent-foreground": "0.87 0.09 85",
      border: "1 0 0 / 8%",
      input: "1 0 0 / 12%",
      primary: "0.94 0.006 85",
      "primary-foreground": "0.19 0.006 70",
      destructive: "0.68 0.19 22",
      success: "0.72 0.13 160",
      unread: "0.8 0.13 82",
      star: "0.82 0.14 82",
      "row-hover": "1 0 0 / 4%",
      "row-selected": "0.29 0.035 80",
      "row-selected-foreground": "0.96 0.01 85",
      "sidebar-accent": "1 0 0 / 7%",
    },
    cats: cats(".72 .13 30 | .8 .12 82 | .78 .12 130 | .74 .1 150 | .76 .08 208 | .72 .1 265 | .74 .1 306 | .72 .015 75"),
    overrides: { ring: "0.8 0.13 82 / 80%" },
  }),
  defineTheme({
    id: "atelier-dark",
    name: "Atelier",
    mode: "dark",
    vibrancy: false,
    tokens: {
      background: "0.2 0.012 255",
      foreground: "0.94 0.006 85",
      pane: "0.2 0.012 255",
      card: "0.225 0.013 255",
      popover: "0.245 0.014 255",
      sidebar: "0.18 0.011 255",
      muted: "0.265 0.014 255",
      "muted-foreground": "0.72 0.012 85",
      accent: "0.29 0.03 255",
      "accent-foreground": "0.9 0.03 255",
      border: "1 0 0 / 8%",
      input: "1 0 0 / 12%",
      primary: "0.76 0.07 255",
      "primary-foreground": "0.2 0.03 255",
      destructive: "0.68 0.16 30",
      success: "0.72 0.1 145",
      unread: "0.76 0.07 255",
      star: "0.74 0.12 50",
      "row-hover": "1 0 0 / 4%",
      "row-selected": "0.3 0.035 255",
      "row-selected-foreground": "0.96 0.006 85",
      "sidebar-accent": "1 0 0 / 7%",
    },
    cats: cats(".72 .11 15 | .76 .1 70 | .76 .08 125 | .74 .07 144 | .75 .06 209 | .72 .08 258 | .74 .07 306 | .7 .012 90"),
  }),
];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** A theme's name as shown: Terno's own two in the active language, the rest (product names, the user's own) as they are. */
export function themeName(theme: Pick<Theme, "id" | "name">): string {
  if (theme.id === "terno-light") return t("ui.theme.ternoLight");
  if (theme.id === "terno-dark") return t("ui.theme.ternoDark");
  return theme.name;
}

export function builtinTheme(id: string): Theme | undefined {
  return BY_ID.get(id);
}

export function themesFor(mode: ThemeMode): Theme[] {
  return THEMES.filter((t) => t.mode === mode);
}

/** A custom theme over its built-in base: its tokens, then everything derived from them that it didn't set. */
export function resolveCustomTheme(custom: CustomTheme): Theme {
  const base = BY_ID.get(custom.extends) ?? BY_ID.get(DEFAULT_THEME[custom.mode])!;
  const input = BUILTIN_INPUTS.get(base.id)!;
  const own = Object.fromEntries(Object.entries(custom.tokens).map(([k, v]) => [k, formatOklch(parseColor(v!))]));
  const tokens = { ...input.tokens } as BaseInput;
  const overrides: Partial<Record<ThemeToken, string>> = { ...input.overrides };
  for (const [k, v] of Object.entries(own)) {
    if ((BASE as readonly string[]).includes(k)) tokens[k as keyof BaseInput] = v;
    else overrides[k as ThemeToken] = v;
  }
  const catList = CAT_NAMES.map((n, i) => own[`cat-${n}`] ?? input.cats[i]!) as unknown as Cats;
  // custom colors render exactly: no native vibrancy behind them
  return { id: `custom:${custom.id}`, name: custom.name, mode: custom.mode, vibrancy: false, tokens: derive({ mode: custom.mode, tokens, cats: catList, overrides }) };
}
