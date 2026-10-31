import { create } from "zustand";
import { getApp, setApp } from "~/state/app";
import { draftKeyOf } from "./draft-commands";
import type { PalettePage } from "./palette-commands";

/** Plan 88: the draft the palette was opened from (an object property: the React Compiler note on module lets). */
export const paletteFrom: { draftKey: string | null } = { draftKey: null };

/** The page the palette shows: set by whoever opens it (⌘K the root, ⌘; the snippets), changed inside it. */
export const usePalettePage = create<{ page: PalettePage }>(() => ({ page: "root" }));
export const setPalettePage = (page: PalettePage): void => usePalettePage.setState({ page });

function open(page: PalettePage): void {
  paletteFrom.draftKey = draftKeyOf(document.activeElement);
  setPalettePage(page);
  setApp({ dialog: "palette" });
}

/** ⌘K: opens the palette, remembering the draft that had focus; closes it when it's open. */
export function togglePalette(): void {
  if (getApp().dialog === "palette") return setApp({ dialog: null });
  open("root");
}

/**
 * Plan 89, ⌘;: the palette on its snippets page (insert into the focused
 * draft, or a new message from one). Open on another page it switches there,
 * keeping the draft it was opened from (focus is in the palette by then); on
 * the snippets page it closes.
 */
export function toggleSnippets(): void {
  if (getApp().dialog === "palette") {
    if (usePalettePage.getState().page === "snippets") return setApp({ dialog: null });
    return setPalettePage("snippets");
  }
  if (getApp().dialog !== null) return;
  open("snippets");
}
