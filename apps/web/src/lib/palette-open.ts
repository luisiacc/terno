import { create } from "zustand";
import { getApp, setApp } from "~/state/app";
import { askOffered } from "./ai";
import { draftKeyOf } from "./draft-commands";
import type { PalettePage } from "./palette-commands";

/**
 * Plan 88: the draft the palette was opened from (an object property: the React Compiler note on module lets). Plan 162:
 * and what had the keys, for them to go back to when it closes and nothing else took them.
 */
export const paletteFrom: { draftKey: string | null; focus: HTMLElement | null } = { draftKey: null, focus: null };

/** Plan 162: closed, the keys go back where they were when it opened, unless something since took them (a source opened). */
/**
 * Dismissed (Esc, ×, a click outside: nothing run), the keys leave it at once, not at the end of the dialog's exit: a key
 * pressed right after Esc (⌘K, Esc, R) is the app's, never the closing field's (the owner: every page focuses its field, so
 * the keys were still in it while it faded). Not when a command closes it: one places the caret itself (a snippet selects
 * its first gap), and an early focus would put it back where it was.
 */
export function handBackKeysNow(): void {
  const at = document.activeElement;
  if (!(at instanceof HTMLElement) || !at.closest("[data-slot=dialog-content], [role=dialog]")) return;
  const to = paletteFrom.focus;
  if (to?.isConnected) to.focus({ preventScroll: true });
  else at.blur();
}

export function returnPaletteFocus(): void {
  const to = paletteFrom.focus;
  // the dialog's own return (`finalFocus`) reads it first; this catches a close it doesn't see through
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (paletteFrom.focus === to) paletteFrom.focus = null;
      const at = document.activeElement;
      if (to?.isConnected && (!at || at === document.body)) to.focus({ preventScroll: true });
    }),
  );
}

/** The dialog's return of focus as it closes: what had the keys when it opened, if it's still there, else its default. */
export const paletteReturn = (): HTMLElement | true => (paletteFrom.focus?.isConnected ? paletteFrom.focus : true);

/** Plan 141: what the root's last row asked, for the page to take up when it's there. Esc on the page stops an answer first. */
export const askFrom: { question: string | null } = { question: null };
export const paletteKeys: { escape: (() => boolean) | null; /** ⌘⇧K on Ask: a step back inside it first (a shown source) */ toggle: (() => boolean) | null } = { escape: null, toggle: null };

/**
 * The page the palette shows: set by whoever opens it (⌘K the root, ⌘; the snippets), changed inside it. `entry` is the
 * page it opened on (plan 162): Ask opened with ⌘⇧K has no All commands behind it, so its Esc closes, one step back to the
 * mail, as every AI surface's Esc is one step.
 */
export const usePalettePage = create<{ page: PalettePage; entry: PalettePage }>(() => ({ page: "root", entry: "root" }));
export const setPalettePage = (page: PalettePage): void => usePalettePage.setState({ page });

/** Where Esc (or Back) goes from `page`: a page, or null to close the palette. */
export function paletteBack(page: PalettePage, entry: PalettePage): PalettePage | null {
  if (entry === "ask") return page === "askHistory" ? "ask" : page === "ask" ? null : "root";
  return "root";
}

function open(page: PalettePage): void {
  paletteFrom.draftKey = draftKeyOf(document.activeElement);
  paletteFrom.focus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  usePalettePage.setState({ page, entry: page });
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
  if (!askOffered(getApp())) return;
  if (getApp().dialog === "palette") {
    if (usePalettePage.getState().page === "ask") return void (paletteKeys.toggle?.() || setApp({ dialog: null }));
    return setPalettePage("ask");
  }
  if (getApp().dialog !== null) return;
  open("ask");
}
