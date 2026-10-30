import { CUSTOM_PREFIX, DEFAULT_DESIGN, DEFAULT_THEME, DESIGN_PALETTE, isDesignId, type DesignId, type ThemeMode } from "@terno/core";
import type { AppSettings, SettingsPatch } from "@terno/core/rpc";
import { applyCustomTheme, clampMotion, motionOff, motionVars, opaqueBackground } from "@terno/ui/themes/apply";
import { toHex } from "@terno/ui/themes/color";
import { builtinTheme, resolveCustomTheme, type Theme } from "@terno/ui/themes/registry";
import { designById } from "@terno/ui/designs/index";
import { flushSync } from "react-dom";
import { captureDesignAnchors, loadDesignFaces } from "~/lib/design";
import { t } from "@terno/i18n";
import { snack } from "~/lib/snack";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";

type Appearance = Pick<AppSettings, "theme" | "design" | "lightTheme" | "darkTheme" | "motionMs" | "customThemes"> & { layout?: AppSettings["layout"] };
export type Layout = AppSettings["layout"];
export const isLayout = (v: unknown): v is Layout => v === "split" || v === "list";

/** What theme.js reads before React (and before the backend answers) on the next launch. */
export const APPEARANCE_KEY = "terno:appearance";
export interface CachedAppearance {
  /** 2 since designs (plan 15): theme.js moves anything older to Lumen */
  v: 2;
  mode: AppSettings["theme"];
  design: DesignId;
  light: string;
  dark: string;
  motion: number;
  /** per mode: may the macOS sidebar show the window's vibrancy */
  vibrancy: Record<ThemeMode, boolean>;
  /** plan 24: theme.js paints data-layout from it, so a List user never sees a Split frame at launch */
  layout?: Layout;
  /** a custom theme in use: its base [data-theme] and its full token map */
  custom?: Partial<Record<ThemeMode, { base: string; tokens: Record<string, string> }>>;
}

/** The resolved mode (anything that needs "light" | "dark"). */
export const useAppearance = create<{ mode: ThemeMode; design: DesignId; layout: Layout; reducedMotion: boolean; motionMs: number; themeKey: string }>(() => ({
  mode: document.documentElement.classList.contains("dark") ? "dark" : "light",
  /** what theme.js painted, so the first render matches it */
  design: isDesignId(document.documentElement.dataset.design) ? document.documentElement.dataset.design : DEFAULT_DESIGN,
  /** plan 24: what theme.js painted too */
  layout: isLayout(document.documentElement.dataset.layout) ? document.documentElement.dataset.layout : "split",
  /** changes whenever the painted colors change (theme id or custom tokens) */
  themeKey: "",
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

/** The palette for a mode: "Style colors" is the design's own; unknown, deleted or wrong-mode ids fall back to it too. */
export function resolveTheme(a: Pick<Appearance, "design" | "lightTheme" | "darkTheme" | "customThemes">, mode: ThemeMode): Theme {
  const id = mode === "light" ? a.lightTheme : a.darkTheme;
  const own = builtinTheme(designById(a.design).palette[mode])!;
  if (id === DESIGN_PALETTE) return own;
  if (id.startsWith(CUSTOM_PREFIX)) {
    const custom = a.customThemes.find((t) => t.id === id.slice(CUSTOM_PREFIX.length));
    if (custom && custom.mode === mode) return resolveCustomTheme(custom);
  } else {
    const t = builtinTheme(id);
    if (t && t.mode === mode) return t;
  }
  return own;
}

function baseId(theme: Theme, a: Pick<Appearance, "customThemes">): string {
  if (!theme.id.startsWith(CUSTOM_PREFIX)) return theme.id;
  return a.customThemes.find((t) => `${CUSTOM_PREFIX}${t.id}` === theme.id)?.extends ?? DEFAULT_THEME[theme.mode];
}

const isMacDesktop = () => window.ternoDesktop?.platform === "darwin";
const REDUCED_TRANSPARENCY = "(prefers-reduced-transparency: reduce)";

/** The sidebar shows the window's vibrancy only on macOS, with a theme that allows it, and when the OS doesn't ask for less transparency. */
export function sidebarVibrancy(macDesktop: boolean, themeVibrancy: boolean, reducedTransparency: boolean): boolean {
  return macDesktop && themeVibrancy && !reducedTransparency;
}
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
  const design = designById(a.design);
  const layout: Layout = a.layout ?? "split";
  // the design may keep its sidebar opaque (Atelier's and Lumen's paper) whatever the palette allows
  const vibrancy = sidebarVibrancy(isMacDesktop(), theme.vibrancy && design.vibrancy, matchMedia(REDUCED_TRANSPARENCY).matches);
  const key = JSON.stringify([mode, design.id, theme.id, custom ? theme.tokens : null, ms, reduced, vibrancy, layout]);
  const designChanged = useAppearance.getState().design !== design.id || html.dataset.design !== design.id;
  // a layout switch (plan 24) changes the list's width and row heights: the same capture and restore as a design switch
  const layoutChanged = useAppearance.getState().layout !== layout || html.dataset.layout !== layout;
  if (key !== applied) {
    applied = key;
    // what must stay put across a design switch is measured before anything changes (plan 15, R3)
    const restore = designChanged || layoutChanged ? captureDesignAnchors() : null;
    html.setAttribute("data-theme-switching", "");
    // CSS first, so the structure React commits below is measured with its own tokens
    html.dataset.design = design.id;
    html.dataset.layout = layout;
    html.classList.toggle("dark", mode === "dark");
    html.dataset.theme = baseId(theme, a);
    html.style.colorScheme = mode;
    applyCustomTheme(html.style, custom ? theme : null);
    for (const [k, v] of Object.entries(motionVars(ms))) html.style.setProperty(k, v);
    const wasOff = html.dataset.motion === "off";
    html.dataset.motion = motionOff(ms, reduced) ? "off" : "on";
    if (wasOff && html.dataset.motion === "on") settleReplays();
    if (vibrancy) html.setAttribute("data-vibrancy", "");
    else html.removeAttribute("data-vibrancy");
    if (restore) {
      // the variants' structure commits in this same task, before paint: one frame, styles and structure in agreement
      flushSync(() => useAppearance.setState({ design: design.id, layout }));
      restore();
    }
    // the first frame paints the new colors with transitions off; the next re-enables them
    cancelAnimationFrame(unswitch);
    unswitch = requestAnimationFrame(() => {
      unswitch = requestAnimationFrame(() => html.removeAttribute("data-theme-switching"));
    });
  }

  // after the DOM: listeners (the mail iframe) read the painted colors
  useAppearance.setState({ mode, design: design.id, layout, reducedMotion: reduced, motionMs: ms, themeKey: `${theme.id}:${custom ? JSON.stringify(theme.tokens) : ""}` });

  const light = resolveTheme(a, "light");
  const dark = resolveTheme(a, "dark");
  const cache: CachedAppearance = { v: 2, mode: a.theme, design: design.id, layout, light: light.id, dark: dark.id, motion: ms, vibrancy: { light: light.vibrancy && design.vibrancy, dark: dark.vibrancy && design.vibrancy } };
  for (const t of [light, dark]) {
    if (t.id.startsWith(CUSTOM_PREFIX)) (cache.custom ??= {})[t.mode] = { base: baseId(t, a), tokens: t.tokens };
  }
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(cache));
  } catch {
    /* private mode / quota: theme.js falls back to defaults */
  }
  // only when it changes: the shell re-dressing the window (vibrancy, background) for nothing can flash it
  const shell = { themeSource: a.theme, background: opaqueBackground(theme), vibrancy };
  const shellKey = JSON.stringify(shell);
  if (shellKey !== sentShell) {
    sentShell = shellKey;
    window.ternoDesktop?.setAppearance?.(shell);
  }
}

/** What the desktop shell was last told (applyAppearance runs on every appearance save). */
let sentShell: string | null = null;

/**
 * Motion coming back on lifts `animation: none`, and every element with an entrance animation (an open dialog, its
 * backdrop) would play it again: the screen flashes. Those are finished before the frame paints (getAnimations()
 * brings the styles up to date first); loops (spinners) keep running.
 */
function settleReplays(): void {
  if (typeof document.getAnimations !== "function" || typeof CSSAnimation === "undefined") return;
  for (const anim of document.getAnimations()) {
    if (anim instanceof CSSAnimation && Number.isFinite(anim.effect?.getComputedTiming().iterations ?? Infinity)) anim.finish();
  }
}

/** Re-applies when the OS switches light/dark (only matters in system mode) or toggles reduced motion. */
export function installAppearanceListeners(): () => void {
  const reapply = () => {
    const s = getApp().settings;
    if (s) applyAppearance(s);
  };
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const transparency = matchMedia(REDUCED_TRANSPARENCY);
  // nativeTheme.themeSource drives prefers-color-scheme too: only follow it in system mode
  const onScheme = () => getApp().settings?.theme === "system" && reapply();
  scheme.addEventListener("change", onScheme);
  motion.addEventListener("change", reapply);
  transparency.addEventListener("change", reapply);
  return () => {
    transparency.removeEventListener("change", reapply);
    scheme.removeEventListener("change", onScheme);
    motion.removeEventListener("change", reapply);
  };
}

type AppearancePatch = Pick<SettingsPatch, "theme" | "design" | "lightTheme" | "darkTheme" | "motionMs" | "customThemes" | "htmlMailAppearance" | "layout">;
const APPEARANCE_FIELDS = ["theme", "design", "lightTheme", "darkTheme", "motionMs", "customThemes", "htmlMailAppearance", "layout"] as const;

/** Appearance changes not yet acknowledged, oldest first (each one is sent after the previous answered). */
const pending: { patch: AppearancePatch }[] = [];
let queue: Promise<unknown> = Promise.resolve();
/** The appearance the backend last confirmed (bootstrap, or an answer to settings.update). */
let confirmed: Pick<AppSettings, (typeof APPEARANCE_FIELDS)[number]> | null = null;

/**
 * Records a settings snapshot from the backend and returns it with the
 * appearance changes still on their way laid over it. Every settings answer
 * goes through here, so an older snapshot never paints over a newer choice.
 */
export function reconcileSettings(settings: AppSettings): AppSettings {
  confirmed = Object.fromEntries(APPEARANCE_FIELDS.map((k) => [k, settings[k]])) as typeof confirmed;
  return pending.reduce<AppSettings>((s, p) => ({ ...s, ...p.patch }) as AppSettings, settings);
}

function show(settings: AppSettings): void {
  setApp({ settings });
  applyAppearance(settings);
}

/** Settings changed outside this window's edits (an import, a storage switch): stored, reconciled and painted. */
export function adoptSettings(settings: AppSettings): void {
  show(reconcileSettings(settings));
}

/**
 * Optimistic and serialized: the app repaints at once, changes are persisted
 * one at a time in order, and each answer (or refusal) is reconciled against
 * the changes still pending. A refusal drops only its own change.
 */
/** The latest design choice: a slower font wait that finishes after a newer choice is dropped (plan 15, R2). */
let designSeq = 0;
/** How long a design switch waits for its faces (local files; normally a few ms). */
export const DESIGN_FONT_WAIT_MS = 300;

export async function updateAppearance(patch: AppearancePatch): Promise<AppSettings | null> {
  if (patch.design !== undefined) {
    // every choice counts, back to the current design included: it cancels one still waiting for its faces
    const seq = ++designSeq;
    if (patch.design !== getApp().settings?.design) await loadDesignFaces(designById(patch.design), DESIGN_FONT_WAIT_MS);
    if (seq !== designSeq) return null;
  }
  return commitAppearance(patch);
}

function commitAppearance(patch: AppearancePatch): Promise<AppSettings | null> {
  const current = getApp().settings;
  if (!current) return Promise.resolve(null);
  const entry = { patch };
  pending.push(entry);
  show({ ...current, ...patch } as AppSettings);
  const done = queue.then(async () => {
    try {
      const next = await client.call("settings.update", patch);
      pending.splice(pending.indexOf(entry), 1);
      show(reconcileSettings(next));
      return next;
    } catch (error) {
      pending.splice(pending.indexOf(entry), 1);
      const base = { ...getApp().settings!, ...confirmed } as AppSettings;
      show(pending.reduce<AppSettings>((s, p) => ({ ...s, ...p.patch }) as AppSettings, base));
      snack.error(t("settings.appearance.failed", { error: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  });
  queue = done;
  return done;
}

export interface MailColors {
  /** the theme itself: mail that brings no colors of its own */
  themed: { bg: string; fg: string; link: string };
  /** the light card designed mail sits on, so it is never inverted */
  paper: { bg: string; fg: string; link: string };
}

/**
 * The iframe can't see the app's CSS variables: its colors are read from the
 * painted theme and passed in as literals (hex: the iframe's CSP has no say on colors).
 */
export function mailColors(): MailColors {
  const cs = getComputedStyle(document.documentElement);
  const hex = (token: string, fallback: string) => {
    try {
      return toHex(cs.getPropertyValue(`--${token}`).trim() || fallback);
    } catch {
      return toHex(fallback);
    }
  };
  const ink = builtinTheme(DEFAULT_THEME.light)!.tokens;
  return {
    themed: { bg: hex("background", ink.background), fg: hex("foreground", ink.foreground), link: hex("primary", ink.primary) },
    paper: { bg: hex("mail-paper", ink["mail-paper"]), fg: hex("mail-ink", ink["mail-ink"]), link: hex("mail-link", ink["mail-link"]) },
  };
}
