import { useSyncExternalStore } from "react";
import { create } from "zustand";

/**
 * The rich composer's seam (plan 16), in the entry chunk and free of
 * ProseMirror: the editor (lazy) registers a controller per draft; the
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
  /** focus the editor, its caret where it was (or at the end the first time) */
  focus(where?: "end" | "keep"): void;
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
  notify();
  // a focus asked for before the editor existed (the chunk was still loading)
  const pending = pendingFocus.get(key);
  if (pending) {
    pendingFocus.delete(key);
    c.focus(pending);
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

const pendingFocus = new Map<string, "end" | "keep">();
/**
 * Puts focus in a draft's body: now if its editor is there, else as soon as
 * it mounts (the editor chunk may still be loading). A later request for
 * another draft replaces nothing: each draft keeps its own.
 */
export function focusBody(key: string, where: "end" | "keep" = "end"): void {
  const c = controllers.get(key);
  if (c) c.focus(where);
  else pendingFocus.set(key, where);
}
export const cancelFocusBody = (key: string): boolean => pendingFocus.delete(key);

// ── the format bar's visibility, remembered on this device

const SHOWN_KEY = "terno:format-bar";
function readShown(): boolean {
  try {
    return localStorage.getItem(SHOWN_KEY) !== "hidden";
  } catch {
    return true;
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
