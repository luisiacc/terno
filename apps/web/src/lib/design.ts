/**
 * The design in effect (plan 15) and the few React-level decisions it makes.
 * Everything stylistic is CSS variables ([data-design] on <html>); components
 * read a variant only where their structure differs, through `variant()`, so
 * a new variant value doesn't compile until every component handles it.
 */
import type { DesignDefinition } from "@terno/ui/designs/index";
import { designById } from "@terno/ui/designs/index";
import { useAppearance } from "~/lib/appearance";
import type { DesignId } from "@terno/core";
import { t } from "@terno/i18n";

/** The design in effect; components re-render when it changes. */
export function useDesign(): DesignDefinition {
  return designById(useAppearance((s) => s.design));
}

/** The design in effect, outside React. */
export function currentDesign(): DesignDefinition {
  return designById(useAppearance.getState().design);
}

/** Picks the implementation for a variant value: the map must cover every value. */
export function variant<V extends string, T>(value: V, impl: Record<V, T>): T {
  return impl[value];
}

/**
 * A layout that must survive a design switch (the list's first visible row,
 * the reader's message under the toolbar): `capture` runs before anything
 * changes and returns what puts it back once the new CSS and structure are in.
 */
type Capture = () => (() => void) | void;
const anchors = new Set<Capture>();

export function registerDesignAnchor(capture: Capture): () => void {
  anchors.add(capture);
  return () => void anchors.delete(capture);
}

export function captureDesignAnchors(): () => void {
  const restores = [...anchors].map((c) => c());
  return () => {
    for (const r of restores) r?.();
  };
}

/** Waits (at most `capMs`) for a design's faces: local files, normally a few ms. A late or missing face swaps in when it arrives. */
export async function loadDesignFaces(design: DesignDefinition, capMs: number): Promise<void> {
  const fonts = (globalThis.document as Document | undefined)?.fonts;
  if (!fonts || design.fonts.faces.length === 0) return;
  // Spanish and latin-ext letters ask for the subsets text will need
  const sample = "Aa ñáéíóú¿¡ ŁĞő";
  const all = Promise.all(design.fonts.faces.map((f) => fonts.load(f, sample))).then(
    () => undefined,
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, capMs)))]);
  clearTimeout(timer);
}

/** A design's name and one-line description, in the active language. */
export function designName(id: DesignId): string {
  return id === "macos" ? t("design.macos") : id === "atelier" ? t("design.atelier") : t("design.lumen");
}

export function designDescription(id: DesignId): string {
  return id === "macos" ? t("design.macos.description") : id === "atelier" ? t("design.atelier.description") : t("design.lumen.description");
}
