/**
 * Plan 21: the sidebar's and the list's widths, chosen by dragging their
 * edges and remembered on this device. CSS does the layout (globals.css
 * `app-panes` clamps these variables against the window on every frame);
 * this module keeps the limits, the stored widths and the math a drag or a
 * key press needs. Unset, each pane is its design's default.
 */
import { create } from "zustand";

export type Pane = "sidebar" | "list";

/** px; globals.css repeats them in `app-panes` (a unit test keeps the two in step). The reader's minimum is the design's (`layout.readerMin`). */
export const LIMITS: Record<Pane, { min: number; max: number }> = {
  sidebar: { min: 200, max: 360 },
  list: { min: 300, max: 640 },
};
/** ← → move by STEP, with Shift by BIG_STEP */
export const STEP = 16;
export const BIG_STEP = 64;

export const PANES_KEY = "terno:panes";
/** the CSS variable each pane's chosen width goes in (on <html>) */
export const PANE_VAR: Record<Pane, string> = { sidebar: "--pane-sidebar", list: "--pane-list" };

export type PaneWidths = Record<Pane, number | null>;

const valid = (pane: Pane, v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= LIMITS[pane].min && v <= LIMITS[pane].max ? Math.round(v) : null);

/** What was stored, each pane on its own: anything unreadable or out of range is that pane's default. */
export function parsePanes(raw: string | null): PaneWidths {
  try {
    const v = (raw === null ? null : JSON.parse(raw)) as { v?: unknown; sidebar?: unknown; list?: unknown } | null;
    if (!v || typeof v !== "object" || v.v !== 1) return { sidebar: null, list: null };
    return { sidebar: valid("sidebar", v.sidebar), list: valid("list", v.list) };
  } catch {
    return { sidebar: null, list: null };
  }
}

/** localStorage, if this context has one (reading the global itself can throw) */
function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPanes(storage: Pick<Storage, "getItem"> | null = local()): PaneWidths {
  try {
    return parsePanes(storage?.getItem(PANES_KEY) ?? null);
  } catch {
    return { sidebar: null, list: null };
  }
}

export function savePanes(w: PaneWidths, storage: Pick<Storage, "setItem" | "removeItem"> | null = local()): void {
  try {
    if (w.sidebar === null && w.list === null) storage?.removeItem(PANES_KEY);
    else storage?.setItem(PANES_KEY, JSON.stringify({ v: 1, sidebar: w.sidebar, list: w.list }));
  } catch {
    // full or unavailable storage: the width holds for this session
  }
}

/**
 * The widest a pane can be in this window: its own max, and what leaves the
 * reader its room (the sidebar also leaves the list its min). Never below the
 * pane's min (a window narrower than all three mins shrinks the reader).
 */
export function maxWidth(pane: Pane, viewport: number, sidebarNow: number, readerMin: number): number {
  const room = pane === "sidebar" ? viewport - readerMin - LIMITS.list.min : viewport - readerMin - sidebarNow;
  return Math.max(LIMITS[pane].min, Math.min(LIMITS[pane].max, Math.floor(room)));
}

export function clampWidth(pane: Pane, width: number, viewport: number, sidebarNow: number, readerMin: number): number {
  return Math.round(Math.max(LIMITS[pane].min, Math.min(maxWidth(pane, viewport, sidebarNow, readerMin), width)));
}

/** A key on a focused handle: the width it asks for, "reset", or null (not ours). */
export function keyWidth(key: string, shift: boolean, now: number, max: number, pane: Pane): number | "reset" | null {
  if (key === "ArrowRight") return Math.min(max, now + (shift ? BIG_STEP : STEP));
  if (key === "ArrowLeft") return Math.max(LIMITS[pane].min, now - (shift ? BIG_STEP : STEP));
  if (key === "Home") return LIMITS[pane].min;
  if (key === "End") return max;
  if (key === "Enter") return "reset";
  return null;
}

export const usePanes = create<PaneWidths>(() => loadPanes());

/** Writes a pane's width to its variable (null: the design's default). The layout follows in the next frame; nothing renders. */
export function previewWidth(pane: Pane, width: number | null): void {
  const style = document.documentElement.style;
  if (width === null) style.removeProperty(PANE_VAR[pane]);
  else style.setProperty(PANE_VAR[pane], `${width}px`);
}

/** The pane's width from now on (null: back to the design's default): applied, kept and stored once. */
export function commitWidth(pane: Pane, width: number | null): void {
  previewWidth(pane, width);
  if (usePanes.getState()[pane] === width) return;
  usePanes.setState({ [pane]: width });
  savePanes(usePanes.getState());
}

// the stored widths are on <html> before React's first commit: no frame at the default
if (typeof document !== "undefined") for (const pane of ["sidebar", "list"] as const) previewWidth(pane, usePanes.getState()[pane]);
