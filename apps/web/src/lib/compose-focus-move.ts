/** The focus move waiting for its element (one at a time: a newer request replaces it). */
let focusRequest = 0;
let pendingFocus: { find: () => HTMLElement | null; current: (el: HTMLElement) => boolean; done: (keepTarget?: boolean) => boolean; release?: () => void } | null = null;
export const focusMoveGeneration = (): number => focusRequest;

export interface InlineFocusMove {
  bind(root: HTMLElement | null, selector: string): boolean;
  cancel(): void;
  active(): boolean;
}

const target = (selector: string, root: HTMLElement | null) =>
  // while the editor's chunk loads, its stand-in takes the keys (and hands them over)
  (root ?? document).querySelector<HTMLElement>(selector) ?? (selector.includes("compose-body") ? (root ?? document).querySelector<HTMLElement>("[data-testid=compose-body-loading]") : null);
const focusable = (el: HTMLElement | null): el is HTMLElement => el !== null && el.isConnected && !el.closest("[inert]");

function place(el: HTMLElement) {
  el.focus({ preventScroll: true });
  if (el instanceof HTMLTextAreaElement) el.setSelectionRange(el.value.length, el.value.length);
}

/**
 * A key pressed while a focus move is still waiting for its frame (r, then Esc
 * at once) belongs where focus is going, not to the page: focus moves now, a
 * character follows it (the browser types into what is focused after keydown),
 * and any other key is replayed there (Esc collapses that draft). Before this,
 * "r, Esc, r" typed fast lost the Esc and typed the second "r" into the text.
 */
function keyDuringMove(e: KeyboardEvent) {
  const p = pendingFocus;
  if (!p || !e.isTrusted) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const el = p.find();
  if (!focusable(el)) return;
  let moved = false;
  const observe = (event: FocusEvent) => { if (event.target !== active && event.target !== document.body) moved = true; };
  document.addEventListener("focusin", observe, true);
  let allowed: boolean, current: boolean;
  try { allowed = p.done(true); current = p.current(el); } finally { p.release?.(); document.removeEventListener("focusin", observe, true); }
  if (!allowed || moved || !current || !focusable(el)) return;
  place(el);
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  el.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, bubbles: true, cancelable: true }));
}

/**
 * Puts focus on an element of the draft area once it is rendered and no longer
 * inert (an opening part is inert for a frame).
 */
export function focusSoon(selector: string, root: HTMLElement | null, frames = 12, onDone?: (fallback: boolean) => boolean | void, valid?: () => boolean, watch?: (cancel: () => void) => () => void) {
  const request = ++focusRequest;
  let cancelled = false;
  let cancelWatch = () => { cancelled = true; };
  const stopWatching = watch?.(() => cancelWatch()) ?? (() => {});
  pendingFocus?.done();
  if (request !== focusRequest || cancelled) { stopWatching(); return; }
  let raf = 0;
  let finished = false;
  const cleanup = () => {
    if (finished) return false;
    finished = true;
    cancelAnimationFrame(raf);
    stopWatching();
    document.removeEventListener("keydown", keyDuringMove, true);
    document.removeEventListener("focusin", moved, true);
    if (pendingFocus === mine) pendingFocus = null;
    return true;
  };
  const done = () => {
    if (!cleanup()) return false;
    const result = onDone?.(false);
    return request === focusRequest && (!valid || result === true);
  };
  const moved = (event: FocusEvent) => {
    if (event.target !== document.body) done();
  };
  const mine = { find: () => valid && !valid() ? null : target(selector, root), current: (el: HTMLElement) => request === focusRequest && (!root || root.isConnected) && target(selector, root) === el, done };
  pendingFocus = mine;
  document.addEventListener("keydown", keyDuringMove, true);
  document.addEventListener("focusin", moved, true);
  cancelWatch = () => { done(); };
  const tick = (left: number) => {
    raf = requestAnimationFrame(() => {
      if ((valid && !valid()) || (root && !root.isConnected)) return done();
      const el = target(selector, root);
      if (!focusable(el) && left > 0) return tick(left - 1);
      if (!cleanup()) return;
      if (focusable(el)) place(el);
      onDone?.(true);
    });
  };
  tick(frames);
}

/** One ownerless inline request, observed before it is published and bound only to its mounted slot. */
export function prepareInlineFocusMove(valid: () => boolean, terminal: () => void): InlineFocusMove {
  const request = ++focusRequest, previous = pendingFocus, initial = document.activeElement;
  let root: HTMLElement | null = null, selector: string | null = null, completedRoot: HTMLElement | null = null, completedSelector: string | null = null, raf = 0, finished = false, keydownInstalled = false;
  const cleanup = () => {
    if (finished) return false;
    finished = true;
    cancelAnimationFrame(raf);
    if (keydownInstalled) { document.removeEventListener("keydown", keyDuringMove, true); keydownInstalled = false; }
    document.removeEventListener("focusin", moved, true);
    document.removeEventListener("visibilitychange", hidden, true);
    window.removeEventListener("pagehide", pagehide, true);
    if (pendingFocus === mine) pendingFocus = null;
    root = null; selector = null;
    return true;
  };
  const done = (keepTarget = false) => {
    if (keepTarget) { completedRoot = root; completedSelector = selector; }
    if (!cleanup()) return false;
    terminal();
    return request === focusRequest && valid();
  };
  const moved = (event: FocusEvent) => { if (event.target !== initial) done(); };
  const hidden = () => { if (document.hidden) done(); };
  const pagehide = () => { done(); };
  const mine = {
    find: () => !finished && valid() && root && selector ? target(selector, root) : null,
    current: (el: HTMLElement) => request === focusRequest && valid() && !!completedRoot?.isConnected && !!completedSelector && target(completedSelector, completedRoot) === el,
    release: () => { completedRoot = null; completedSelector = null; },
    done,
  };
  const token: InlineFocusMove = {
    bind(nextRoot, nextSelector) {
      if (finished || request !== focusRequest || !valid() || !nextRoot?.isConnected) { done(); return false; }
      root = nextRoot; selector = nextSelector; return true;
    },
    cancel: () => { done(); },
    active: () => !finished && request === focusRequest && valid(),
  };
  document.addEventListener("focusin", moved, true);
  document.addEventListener("visibilitychange", hidden, true);
  window.addEventListener("pagehide", pagehide, true);
  try {
    previous?.done();
    if (finished || request !== focusRequest || !valid() || document.hidden) { done(); return token; }
    pendingFocus = mine;
    document.addEventListener("keydown", keyDuringMove, true);
    keydownInstalled = true;
    const tick = (left: number) => {
      raf = requestAnimationFrame(() => {
        if (!valid() || (root && !root.isConnected)) return done();
        const el = root && selector ? target(selector, root) : null;
        if (!focusable(el) && left > 0) return tick(left - 1);
        if (!cleanup()) return;
        if (focusable(el)) place(el);
        terminal();
      });
    };
    tick(12);
    return token;
  } catch (error) { done(); throw error; }
}

