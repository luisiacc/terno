import { CUSTOM_PREFIX, DEFAULT_THEME, type ThemeMode } from "@unica/core";
import type { AppSettings, SettingsPatch } from "@unica/core/rpc";
import { applyCustomTheme, clampMotion, motionOff, motionVars } from "@unica/ui/themes/apply";
import { toHex } from "@unica/ui/themes/color";
import { builtinTheme, resolveCustomTheme, type Theme } from "@unica/ui/themes/registry";
import { toast } from "sonner";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";

type Appearance = Pick<AppSettings, "theme" | "lightTheme" | "darkTheme" | "motionMs" | "customThemes">;

/** What theme.js reads before React (and before the backend answers) on the next launch. */
export const APPEARANCE_KEY = "unica:appearance";
export interface CachedAppearance {
  mode: AppSettings["theme"];
  light: string;
  dark: string;
  motion: number;
  /** per mode: may the macOS sidebar show the window's vibrancy */
  vibrancy: Record<ThemeMode, boolean>;
  /** a custom theme in use: its base [data-theme] and its full token map */
  custom?: Partial<Record<ThemeMode, { base: string; tokens: Record<string, string> }>>;
}

/** The resolved mode (sonner and anything else that needs "light" | "dark"). */
export const useAppearance = create<{ mode: ThemeMode; reducedMotion: boolean; motionMs: number }>(() => ({
  mode: document.documentElement.classList.contains("dark") ? "dark" : "light",
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  motionMs: 75,
}));

/** The effective animation duration right now: 0 when motion is off (setting or OS). JS animations read this. */
export function motionMs(): number {
  const { motionMs: ms, reducedMotion } = useAppearance.getState();
  return motionOff(ms, reducedMotion) ? 0 : ms;
}

const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

export function resolvedMode(theme: AppSettings["theme"]): ThemeMode {
  return theme === "dark" || (theme === "system" && systemDark()) ? "dark" : "light";
}

/** The theme for a mode; unknown, deleted or wrong-mode ids fall back to the mode's default. */
export function resolveTheme(a: Pick<Appearance, "lightTheme" | "darkTheme" | "customThemes">, mode: ThemeMode): Theme {
  const id = mode === "light" ? a.lightTheme : a.darkTheme;
  if (id.startsWith(CUSTOM_PREFIX)) {
    const custom = a.customThemes.find((t) => t.id === id.slice(CUSTOM_PREFIX.length));
    if (custom && custom.mode === mode) return resolveCustomTheme(custom);
  } else {
    const t = builtinTheme(id);
    if (t && t.mode === mode) return t;
  }
  return builtinTheme(DEFAULT_THEME[mode])!;
}

function baseId(theme: Theme, a: Pick<Appearance, "customThemes">): string {
  if (!theme.id.startsWith(CUSTOM_PREFIX)) return theme.id;
  return a.customThemes.find((t) => `${CUSTOM_PREFIX}${t.id}` === theme.id)?.extends ?? DEFAULT_THEME[theme.mode];
}

const isMacDesktop = () => window.unicaDesktop?.platform === "darwin";
let applied = "";
let unswitch = 0;

/**
 * Applies mode, theme and motion to <html> in one frame, without React:
 * class (shadcn dark: variants), data-theme, color-scheme, custom tokens via
 * CSSOM, motion variables and data-motion, data-vibrancy; then caches it for
 * theme.js and tells the desktop shell (native theme, window background,
 * vibrancy). Colors never transition while switching.
 */
export function applyAppearance(a: Appearance): void {
  const html = document.documentElement;
  const mode = resolvedMode(a.theme);
  const theme = resolveTheme(a, mode);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ms = clampMotion(a.motionMs);
  const custom = theme.id.startsWith(CUSTOM_PREFIX);
  const vibrancy = isMacDesktop() && theme.vibrancy;
  const key = JSON.stringify([mode, theme.id, custom ? theme.tokens : null, ms, reduced, vibrancy]);
  useAppearance.setState({ mode, reducedMotion: reduced, motionMs: ms });
  if (key !== applied) {
    applied = key;
    html.setAttribute("data-theme-switching", "");
    html.classList.toggle("dark", mode === "dark");
    html.dataset.theme = baseId(theme, a);
    html.style.colorScheme = mode;
    applyCustomTheme(html.style, custom ? theme : null);
    for (const [k, v] of Object.entries(motionVars(ms))) html.style.setProperty(k, v);
    html.dataset.motion = motionOff(ms, reduced) ? "off" : "on";
    if (vibrancy) html.setAttribute("data-vibrancy", "");
    else html.removeAttribute("data-vibrancy");
    // the first frame paints the new colors with transitions off; the next re-enables them
    cancelAnimationFrame(unswitch);
    unswitch = requestAnimationFrame(() => {
      unswitch = requestAnimationFrame(() => html.removeAttribute("data-theme-switching"));
    });
  }

  const light = resolveTheme(a, "light");
  const dark = resolveTheme(a, "dark");
  const cache: CachedAppearance = { mode: a.theme, light: light.id, dark: dark.id, motion: ms, vibrancy: { light: light.vibrancy, dark: dark.vibrancy } };
  for (const t of [light, dark]) {
    if (t.id.startsWith(CUSTOM_PREFIX)) (cache.custom ??= {})[t.mode] = { base: baseId(t, a), tokens: t.tokens };
  }
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(cache));
  } catch {
    /* private mode / quota: theme.js falls back to defaults */
  }
  window.unicaDesktop?.setAppearance?.({ themeSource: a.theme, background: toHex(theme.tokens.background), vibrancy });
}

/** Re-applies when the OS switches light/dark (only matters in system mode) or toggles reduced motion. */
export function installAppearanceListeners(): () => void {
  const reapply = () => {
    const s = getApp().settings;
    if (s) applyAppearance(s);
  };
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  // nativeTheme.themeSource drives prefers-color-scheme too: only follow it in system mode
  const onScheme = () => getApp().settings?.theme === "system" && reapply();
  scheme.addEventListener("change", onScheme);
  motion.addEventListener("change", reapply);
  return () => {
    scheme.removeEventListener("change", onScheme);
    motion.removeEventListener("change", reapply);
  };
}

/** Optimistic: the app repaints before the backend answers; a refusal puts the previous look back. */
export async function updateAppearance(patch: Pick<SettingsPatch, "theme" | "lightTheme" | "darkTheme" | "motionMs" | "customThemes" | "htmlMailAppearance">): Promise<AppSettings | null> {
  const before = getApp().settings;
  if (!before) return null;
  const optimistic = { ...before, ...patch } as AppSettings;
  applyAppearance(optimistic);
  setApp({ settings: optimistic });
  try {
    const next = await client.call("settings.update", patch);
    setApp({ settings: next });
    applyAppearance(next);
    return next;
  } catch (error) {
    applyAppearance(before);
    setApp({ settings: before });
    toast.error(`No se pudo cambiar la apariencia: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
