import { z } from "zod";

/**
 * Theme vocabulary shared by the renderer (the registry in @unica/ui is the
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
  // Única email tokens
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
  // chrome
  "overlay",
  "shadow-color",
  "ink-anchor",
  "sidebar-translucent",
  // HTML mail
  "mail-paper",
  "mail-ink",
  "mail-link",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export const THEME_MODES = ["light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Built-in themes (values live in @unica/ui/themes/registry; a test keeps both in sync). */
export const BUILTIN_THEMES = [
  { id: "unica-light", mode: "light" },
  { id: "apple-light", mode: "light" },
  { id: "solarized-light", mode: "light" },
  { id: "gruvbox-light", mode: "light" },
  { id: "github-light", mode: "light" },
  { id: "catppuccin-latte", mode: "light" },
  { id: "unica-dark", mode: "dark" },
  { id: "dracula", mode: "dark" },
  { id: "monokai", mode: "dark" },
  { id: "tokyo-night", mode: "dark" },
  { id: "gruvbox-dark", mode: "dark" },
  { id: "nord", mode: "dark" },
  { id: "catppuccin-mocha", mode: "dark" },
] as const satisfies readonly { id: string; mode: ThemeMode }[];
export type BuiltinThemeId = (typeof BUILTIN_THEMES)[number]["id"];
export const BUILTIN_THEME_IDS = BUILTIN_THEMES.map((t) => t.id) as BuiltinThemeId[];
export const DEFAULT_THEME: Record<ThemeMode, BuiltinThemeId> = { light: "unica-light", dark: "unica-dark" };

export function builtinMode(id: string): ThemeMode | null {
  return BUILTIN_THEMES.find((t) => t.id === id)?.mode ?? null;
}

/** Custom themes are referenced from settings as `custom:<id>`. */
export const CUSTOM_PREFIX = "custom:";

const NUM = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
/**
 * Numbers only: `#rgb[a]`, `#rrggbb[aa]` or `oklch(L C H [/ a])`. Nothing that
 * could close a declaration or reach out (`;`, `{`, `url(`, `var(`) matches.
 */
export const THEME_COLOR_RE = new RegExp(String.raw`^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|oklch\(\s*${NUM}%?\s+${NUM}\s+${NUM}(?:deg)?\s*(?:\/\s*${NUM}%?\s*)?\))$`, "i");
export const themeColor = z.string().trim().max(64).regex(THEME_COLOR_RE, "Color no válido: usa #rrggbb u oklch(L C H)");

export const MAX_CUSTOM_THEMES = 20;
export const MAX_CUSTOM_THEMES_BYTES = 16 * 1024;

export const customThemeSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/, "El id solo admite a-z, 0-9 y guiones (máx. 40)"),
    name: z.string().trim().min(1).max(40),
    mode: z.enum(THEME_MODES),
    extends: z.enum(BUILTIN_THEME_IDS as [BuiltinThemeId, ...BuiltinThemeId[]]),
    tokens: z.partialRecord(z.enum(THEME_TOKENS), themeColor).refine((t) => Object.keys(t).length > 0, "El tema no cambia ningún color"),
  })
  .strict()
  .refine((t) => builtinMode(t.extends) === t.mode, { message: "El tema base debe ser del mismo modo", path: ["extends"] });
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
  .max(MAX_CUSTOM_THEMES, `Máximo ${MAX_CUSTOM_THEMES} temas`)
  .refine((list) => new Set(list.map((t) => t.id)).size === list.length, "Ids de tema repetidos")
  .refine((list) => utf8Bytes(JSON.stringify(list)) <= MAX_CUSTOM_THEMES_BYTES, "Los temas ocupan más de 16 KB");

export const MOTION_STEPS = [0, 50, 75, 100] as const;
export type MotionMs = (typeof MOTION_STEPS)[number];
