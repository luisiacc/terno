import { t } from "@terno/i18n";
import { z } from "zod";

/**
 * Theme vocabulary shared by the renderer (the registry in @terno/ui is the
 * source of truth for values), the RPC contract and the backend (which only
 * validates ids). Token names are the CSS custom properties without `--`.
 */
export const THEME_TOKENS = [
  // shadcn (names kept; only values change)
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  // Terno email tokens
  "pane",
  "row-hover",
  "row-selected",
  "row-selected-foreground",
  "row-rail",
  "unread",
  "star",
  "success",
  "cat-rose",
  "cat-amber",
  "cat-lime",
  "cat-emerald",
  "cat-cyan",
  "cat-indigo",
  "cat-violet",
  "cat-slate",
  // readable text on a category's soft (15%) background
  "cat-rose-ink",
  "cat-amber-ink",
  "cat-lime-ink",
  "cat-emerald-ink",
  "cat-cyan-ink",
  "cat-indigo-ink",
  "cat-violet-ink",
  "cat-slate-ink",
  // plan 07: separators, faint surfaces, raised highlights, the draft label, sidebar glyphs, translucent menus
  "hairline",
  "tint",
  "highlight",
  "draft-foreground",
  "sidebar-glyph",
  "popover-glass",
  // plan 08: error and "saved" text that reads on tint groups too
  "destructive-ink",
  "success-ink",
  // plan 15: "N unread" text and unread counts drawn as text; the sidebar's accent as text (the Local pill)
  "unread-ink",
  "sidebar-primary-ink",
  // chrome
  "overlay",
  "shadow-color",
  "ink-anchor",
  "sidebar-translucent",
  // plan 66: a sidebar row under the pointer, a step softer than the selected one
  "sidebar-hover",
  // HTML mail
  "mail-paper",
  "mail-ink",
  "mail-link",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export const THEME_MODES = ["light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Built-in themes (values live in @terno/ui/themes/registry; a test keeps both in sync). */
export const BUILTIN_THEMES = [
  { id: "terno-light", mode: "light" },
  { id: "apple-light", mode: "light" },
  { id: "solarized-light", mode: "light" },
  { id: "gruvbox-light", mode: "light" },
  { id: "github-light", mode: "light" },
  { id: "catppuccin-latte", mode: "light" },
  { id: "lumen-light", mode: "light" },
  { id: "atelier-light", mode: "light" },
  { id: "terno-dark", mode: "dark" },
  { id: "dracula", mode: "dark" },
  { id: "monokai", mode: "dark" },
  { id: "tokyo-night", mode: "dark" },
  { id: "gruvbox-dark", mode: "dark" },
  { id: "nord", mode: "dark" },
  { id: "catppuccin-mocha", mode: "dark" },
  { id: "lumen-dark", mode: "dark" },
  { id: "atelier-dark", mode: "dark" },
] as const satisfies readonly { id: string; mode: ThemeMode }[];
export type BuiltinThemeId = (typeof BUILTIN_THEMES)[number]["id"];
export const BUILTIN_THEME_IDS = BUILTIN_THEMES.map((t) => t.id) as BuiltinThemeId[];
export const DEFAULT_THEME: Record<ThemeMode, BuiltinThemeId> = { light: "terno-light", dark: "terno-dark" };

/** Ids of the default themes from when the app was called Única: settings, custom themes and exports saved then still name them. */
export const LEGACY_THEME_IDS: Readonly<Record<string, BuiltinThemeId>> = { "unica-light": "terno-light", "unica-dark": "terno-dark" };

/** A theme id as it is named now (legacy ids map to their successors; anything else is returned as is). */
export function canonicalThemeId(id: string): string {
  return Object.hasOwn(LEGACY_THEME_IDS, id) ? LEGACY_THEME_IDS[id]! : id;
}

export function builtinMode(id: string): ThemeMode | null {
  return BUILTIN_THEMES.find((t) => t.id === id)?.mode ?? null;
}

/** Custom themes are referenced from settings as `custom:<id>`. */
export const CUSTOM_PREFIX = "custom:";

const NUM = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
/**
 * Numbers only: `#rgb[a]`, `#rrggbb[aa]` or `oklch(L C H [/ a])`. Nothing that
 * could close a declaration or reach out (`;`, `{`, `url(`, `var(`) matches.
 * Issue messages are built when a check fails, so the renderer (which shows
 * them) gets its own language.
 */
export const THEME_COLOR_RE = new RegExp(String.raw`^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|oklch\(\s*${NUM}%?\s+${NUM}\s+${NUM}(?:deg)?\s*(?:\/\s*${NUM}%?\s*)?\))$`, "i");
export const themeColor = z.string().trim().max(64).regex(THEME_COLOR_RE, { error: () => t("errors.theme.color") });

export const MAX_CUSTOM_THEMES = 20;
export const MAX_CUSTOM_THEMES_BYTES = 16 * 1024;

export const customThemeSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/, { error: () => t("errors.theme.id") }),
    name: z.string().trim().min(1).max(40),
    mode: z.enum(THEME_MODES),
    extends: z.preprocess((v) => (typeof v === "string" ? canonicalThemeId(v) : v), z.enum(BUILTIN_THEME_IDS as [BuiltinThemeId, ...BuiltinThemeId[]])),
    tokens: z.partialRecord(z.enum(THEME_TOKENS), themeColor).refine((tokens) => Object.keys(tokens).length > 0, { error: () => t("errors.theme.noColors") }),
  })
  .strict()
  .refine((theme) => builtinMode(theme.extends) === theme.mode, { error: () => t("errors.theme.baseMode"), path: ["extends"] });
export type CustomTheme = z.output<typeof customThemeSchema>;

function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export const customThemesSchema = z
  .array(customThemeSchema)
  .max(MAX_CUSTOM_THEMES, { error: () => t("errors.theme.max", { max: MAX_CUSTOM_THEMES }) })
  .refine((list) => new Set(list.map((theme) => theme.id)).size === list.length, { error: () => t("errors.theme.duplicateIds") })
  .refine((list) => utf8Bytes(JSON.stringify(list)) <= MAX_CUSTOM_THEMES_BYTES, { error: () => t("errors.theme.tooBig") });

/**
 * Designs (plan 15): typography, shape, density and component variants; the
 * values live in @terno/ui/designs (a test keeps both lists in sync).
 */
export const DESIGN_IDS = ["macos", "atelier", "lumen"] as const;
export type DesignId = (typeof DESIGN_IDS)[number];
export const DEFAULT_DESIGN: DesignId = "lumen";
/** lightTheme/darkTheme: "the design's own palette" ("Style colors"), the default */
export const DESIGN_PALETTE = "design";

export function isDesignId(v: unknown): v is DesignId {
  return typeof v === "string" && (DESIGN_IDS as readonly string[]).includes(v);
}

export const MOTION_STEPS = [0, 50, 75, 100] as const;
export type MotionMs = (typeof MOTION_STEPS)[number];
