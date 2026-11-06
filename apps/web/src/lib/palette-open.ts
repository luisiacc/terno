import { create } from "zustand";
import { getApp, setApp } from "~/state/app";
import { draftKeyOf } from "./draft-commands";
import type { PalettePage } from "./palette-commands";

/** Plan 88: the draft the palette was opened from (an object property: the React Compiler note on module lets). */
export const paletteFrom: { draftKey: string | null } = { draftKey: null };

/** Plan 141: what the root's last row asked, for the page to take up when it's there. Esc on the page stops an answer first. */
export const askFrom: { question: string | null } = { question: null };
export const paletteKeys: { escape: (() => boolean) | null } = { escape: null };

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
 * Plan 93, ⌘;: the palette on its snippets page (insert into the focused
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

/** Plan 141, ⌘⇧K: the palette on Ask: the last conversation for 30 minutes, else empty. On that page it closes. */
export function toggleAsk(): void {
  if (getApp().settings?.ask?.enabled === false) return;
  if (getApp().dialog === "palette") {
    if (usePalettePage.getState().page === "ask") return setApp({ dialog: null });
    return setPalettePage("ask");
  }
  if (getApp().dialog !== null) return;
  open("ask");
}
