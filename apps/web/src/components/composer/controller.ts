import type { SnippetValues } from "@terno/core";
import type { BodyText } from "./body-text";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

/**
 * The rich composer's seam (plan 16), free of ProseMirror: the editor
 * registers a controller per draft; the
 * action row's Link button, the format bar and focus requests reach it here.
 */

export type Align = "left" | "center" | "right";
export type FormatCommand =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "orderedList"
  | "bulletList"
  | "indent"
  | "outdent"
  | "quote"
  | "clear";

/** What the toolbar shows at the caret, or for the selection. */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  font: "serif" | "mono" | null;
  size: "small" | "large" | "huge" | null;
  color: string | null;
  highlight: string | null;
  align: Align;
  list: "bullet" | "ordered" | null;
  quote: boolean;
  link: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canIndent: boolean;
  canOutdent: boolean;
  editable: boolean;
}

export const EMPTY_FORMAT: FormatState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  font: null,
  size: null,
  color: null,
  highlight: null,
  align: "left",
  list: null,
  quote: false,
  link: false,
  canUndo: false,
  canRedo: false,
  canIndent: false,
  canOutdent: false,
  editable: true,
};

export interface ComposerController {
  run(command: FormatCommand): void;
  setFont(value: FormatState["font"]): void;
  setSize(value: FormatState["size"]): void;
  /** focus: false keeps focus where it is (a palette staying open while the user picks) */
  setColor(value: string | null, focus?: boolean): void;
  setHighlight(value: string | null, focus?: boolean): void;
  setAlign(value: Align): void;
  /** opens the link popover for the selection (⌘K, the Link button) */
  openLink(): void;
  /** plan 76: files dropped on the text (images at the pointer, the rest attach) */
  dropFiles(files: File[], coords: { x: number; y: number }): void;
  /** plan 76: shows where images dropped at these coordinates would go (null hides it) */
  dropCaret(coords: { x: number; y: number } | null): void;
  /**
   * Plan 93: a snippet at the caret, its variables filled, as one undo step
   * (null when the draft can't change now); `undo` takes it back while it is
   * still the text's last change.
   */
  insertSnippet(html: string, text: string, values: SnippetValues): { undo(): boolean } | null;
  /** plan 93: the text as the editor has it now, without images (Save as snippet…) */
  snapshot(): { html: string; text: string };
  /**
   * Plan 133: model text into the document as one undo step: over everything (`replace`) or after it (`below`), the
   * caret on its first placeholder, else at its end. Never through `fillText`: a literal `{first_name}` stays literal.
   * Returns the document it made (what `undoGenerated` checks), or null when the draft can't change now.
   */
  insertGenerated(text: string, how: "replace" | "below", placeholder?: string, gaps?: readonly string[]): { doc: unknown; before: unknown } | null;
  /** plan 133: takes it back while the document is still that one; returns the document it restored, null if it isn't */
  undoGenerated(doc: unknown): { doc: unknown } | null;
  /**
   * Plan 161: the document exactly as `insertGenerated` found it (its `before`), whatever was typed since, as one undo
   * step of its own (⌘Z brings the edited text back). Null when the draft can't change now.
   */
  restoreGenerated(before: unknown): { doc: unknown } | null;
  /** plan 161: the document reads the same as this one (a write's `before`, say), in O(1) unless their sizes match */
  sameDoc(doc: unknown): boolean;
  /** plan 161: selects the first place this text is, and shows it; false when it isn't there */
  selectText(text: string): boolean;
  /** plan 163: the body as its blocks read, up to `limit` characters, never serializing (body-text.ts) */
  bodyText(limit?: number): BodyText;
  /** plan 163: a fill begins: its gaps (document ranges) are mapped from now on, and show their fills as they come */
  startFill(run: string, gaps: readonly { from: number; to: number }[]): boolean;
  /** plan 163: one gap's fill so far */
  streamFill(run: string, n: number, text: string, done: boolean): void;
  /**
   * Plan 163: every gap nobody touched gets its fill (finished ones only, with `done`), keeping the placeholder's marks,
   * as one undo step; a gap left as typed is marked as one. Null when the run isn't this editor's (rebuilt without it) or
   * the draft can't change now. `gaps` are where every unspoiled gap was in `before`, for Fill again.
   */
  commitFill(run: string, fills: readonly (string | null)[], o?: { onlyDone?: boolean }): { doc: unknown; before: unknown; gaps: { from: number; to: number }[]; applied: number; left: string[] } | null;
  /** plan 163: Fill again: `base` (the document before the first fill) with its gaps filled anew, over everything, one undo step */
  refill(base: unknown, gaps: readonly { from: number; to: number }[], fills: readonly (string | null)[]): { doc: unknown; before: unknown; applied: number; left: string[] } | null;
  /** plan 163: a fill run ends without filling (stopped, failed) */
  endFill(run: string): void;
  /** plan 163: the run filling in this editor now, if any */
  fillRun(): string | null;
  /** plan 163: finished fills of the run filling now, by gap (null: unfinished or spoiled) */
  fillsSoFar(run: string): (string | null)[];
  /** plan 163: the tint on what was filled goes (the strip went) */
  clearFilled(): void;
  /** plan 133: an opaque identity of the document: a change of anything but the selection changes it, in O(1) */
  docToken(): unknown;
  /** plan 133: told after every change of the document, at once */
  subscribeDoc(listener: () => void): () => void;
  /** plan 133: the document has nothing in it */
  empty(): boolean;
  /** plan 133: a suggestion made before a preview came up goes */
  dismissGhost(): void;
  /** focus the editor, its caret where it was (or at the end the first time); "last": at the end, always (a click on the page under the text) */
  focus(where?: "end" | "keep" | "last"): void;
  /** the editable root */
  dom: HTMLElement;
  getState(): FormatState;
  subscribe(listener: () => void): () => void;
}

const controllers = new Map<string, ComposerController>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
const subscribeControllers = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function registerController(key: string, c: ComposerController): () => void {
  controllers.set(key, c);
  const pending = pendingFocus.get(key);
  let consumed = false;
  try {
    notify();
    // a focus asked for before the editor existed
    if (pending && pendingFocus.get(key) === pending) {
      pendingFocus.delete(key);
      pending.stop();
      consumed = true;
      c.focus(pending.where);
    }
  } catch (error) {
    if (controllers.get(key) === c) controllers.delete(key);
    if (consumed && pending && !pending.cancelled && !pendingFocus.has(key)) {
      pendingFocus.set(key, pending);
      pending.start();
    }
    notify();
    throw error;
  }
  return () => {
    if (controllers.get(key) !== c) return;
    controllers.delete(key);
    notify();
  };
}

export const controllerFor = (key: string | null | undefined): ComposerController | null => (key ? (controllers.get(key) ?? null) : null);

/** The draft's controller, once its editor is mounted. */
export function useController(key: string | null | undefined): ComposerController | null {
  // the controller itself is the snapshot (a lookup after a version read would be memoized by the compiler)
  return useSyncExternalStore(subscribeControllers, () => controllerFor(key));
}

const noop = () => () => {};
/** The toolbar's state; re-renders only when it changes. */
export function useFormatState(c: ComposerController | null): FormatState {
  return useSyncExternalStore(c ? c.subscribe : noop, c ? c.getState : () => EMPTY_FORMAT);
}

type PendingFocus = { where: "end" | "keep"; cancelled: boolean; start: () => void; stop: () => void };
const pendingFocus = new Map<string, PendingFocus>();
/** Puts focus in a draft now, or when its editor registers. */
export function focusBody(key: string, where: "end" | "keep" = "end", watch?: (cancel: () => void) => () => void): () => void {
  const old = pendingFocus.get(key);
  if (old) { old.cancelled = true; old.stop(); pendingFocus.delete(key); }
  const c = controllers.get(key);
  if (c) { c.focus(where); return () => {}; }
  let stop = () => {};
  const pending: PendingFocus = { where, cancelled: false, start: () => { stop = watch?.(cancel) ?? (() => {}); }, stop: () => { stop(); stop = () => {}; } };
  const cancel = () => {
    pending.cancelled = true;
    pending.stop();
    if (pendingFocus.get(key) === pending) pendingFocus.delete(key);
  };
  pendingFocus.set(key, pending);
  pending.start();
  return cancel;
}
export const cancelFocusBody = (key: string): boolean => {
  const pending = pendingFocus.get(key);
  if (!pending) return false;
  pending.cancelled = true; pending.stop(); pendingFocus.delete(key);
  return true;
};

// ── the format bar's visibility, remembered on this device

const SHOWN_KEY = "terno:format-bar";
function readShown(): boolean {
  try {
    // quiet until asked for (plan 158): only someone who opened it keeps it open
    return localStorage.getItem(SHOWN_KEY) === "shown";
  } catch {
    return false;
  }
}
export const useFormatBar = create<{ shown: boolean }>(() => ({ shown: readShown() }));
export function toggleFormatBar(): void {
  const shown = !useFormatBar.getState().shown;
  useFormatBar.setState({ shown });
  try {
    localStorage.setItem(SHOWN_KEY, shown ? "shown" : "hidden");
  } catch {
    // private mode: remembered for this session only
  }
}

/** A popover or menu is open (the format bar's, a link's): Esc closes it, not the draft. */
export const popupOpen = (): boolean => document.querySelector("[data-slot=popover-content][data-open], [data-slot=dropdown-menu-content][data-open]") !== null;
