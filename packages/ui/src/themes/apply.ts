import { MOTION_STEPS, THEME_TOKENS, type MotionMs } from "@unica/core";
import type { Theme } from "./registry";

/** The slowest any animation may run, whatever the setting. */
export const MAX_MOTION_MS = 100;

export interface MotionVars {
  "--motion": string;
  "--motion-fast": string;
  "--motion-base": string;
  "--motion-slow": string;
}

export function clampMotion(ms: unknown): MotionMs {
  return (MOTION_STEPS as readonly unknown[]).includes(ms) ? (ms as MotionMs) : 75;
}

/**
 * The motion setting M as CSS variables: fast ≈ ⅔M (hover, press, tooltips,
 * every exit), base = M (popovers, menus), slow = 4⁄3 M capped at 100 ms
 * (dialogs, toasts). theme.js computes the same numbers before first paint.
 */
export function motionVars(ms: number): MotionVars {
  const m = Math.max(0, Math.min(MAX_MOTION_MS, ms));
  const px = (v: number) => `${Math.round(v)}ms`;
  return { "--motion": px(m), "--motion-fast": px(m * 0.66), "--motion-base": px(m), "--motion-slow": px(Math.min(m * 1.33, MAX_MOTION_MS)) };
}

/** Motion is off when the setting is 0 or the OS asks for reduced motion. */
export function motionOff(ms: number, reducedMotion: boolean): boolean {
  return ms === 0 || reducedMotion;
}

/**
 * Custom theme tokens go onto an element's inline style through CSSOM, one
 * validated property at a time: never by concatenating CSS text. `null`
 * removes every token (back to the [data-theme] block).
 */
export function applyCustomTheme(style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">, theme: Pick<Theme, "tokens"> | null): void {
  for (const k of THEME_TOKENS) {
    if (theme) style.setProperty(`--${k}`, theme.tokens[k]);
    else style.removeProperty(`--${k}`);
  }
}
