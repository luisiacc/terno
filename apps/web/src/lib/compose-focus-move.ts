export interface EarlyComposeInput {
  owns(el: Element | null): boolean;
  arm(key: string, target: "body" | "to"): void;
  cancel(): void;
}
type EarlyText = { text: string; start: number; end: number; direction: "forward" | "backward" | "none" };
let earlyInput: { owns(el: Element | null): boolean; take(): EarlyText; armed(el: HTMLElement): boolean; wait(resume: () => void): boolean } | null = null;

/** Native text input while source admission has no editor yet. The lease owns its lifetime. */
export function prepareEarlyComposeInput(valid: () => boolean, cancel: () => void, label: string): EarlyComposeInput {
  let receiver: HTMLTextAreaElement | null = null, destination: { key: string; target: "body" | "to" } | null = null, finished = false;
  const initial = document.activeElement;
  let composing = false, resume: (() => void) | undefined;
  const owns = (el: Element | null) => receiver !== null && el === receiver;
  const stop = () => {
    if (finished) return;
    finished = true;
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("visibilitychange", hidden, true);
    window.removeEventListener("pagehide", exit, true);
    receiver?.remove(); receiver = null; resume = undefined;
    if (earlyInput === session) earlyInput = null;
  };
  const exit = () => { stop(); cancel(); };
  const hidden = () => { if (document.hidden) exit(); };
  const key = (e: KeyboardEvent) => {
    if (!e.isTrusted || finished) return;
    if (!receiver && (initial instanceof HTMLInputElement || initial instanceof HTMLTextAreaElement || (initial instanceof HTMLElement && initial.isContentEditable))) return;
    if (!valid()) { stop(); return; }
    if (e.key === "Escape") {
      // A published, ready draft owns Escape; the pending move replays it there.
      if (destination && pendingFocus && focusable(pendingFocus.find())) return;
      e.preventDefault(); e.stopImmediatePropagation(); exit(); return;
    }
    if (receiver || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() !== "v") || e.key === "Tab") return;
    if ([...e.key].length !== 1 && e.key !== "Dead" && e.key !== "Process") return;
    receiver = document.createElement("textarea");
    receiver.maxLength = 65536;
    receiver.addEventListener("compositionstart", () => { composing = true; });
    receiver.addEventListener("compositionend", () => { composing = false; const next = resume; resume = undefined; next?.(); });
    receiver.setAttribute("aria-label", label);
    receiver.className = "sr-only";
    document.body.append(receiver);
    receiver.focus({ preventScroll: true });
    if (!valid() || document.activeElement !== receiver) { exit(); return; }
    // Keep the browser's native insertion, including Unicode, but not page shortcuts.
    e.stopImmediatePropagation();
  };
  const session = { owns, wait: (next: () => void) => { if (!composing) return false; resume = next; return true; }, armed: (el: HTMLElement) => !!destination && valid() && el.closest("[data-draft-key]")?.getAttribute("data-draft-key") === destination.key && el.dataset.testid === (destination.target === "to" ? "compose-to" : el.dataset.testid === "compose-body-loading" ? "compose-body-loading" : "compose-body"), take: () => { const value: EarlyText = { text: receiver?.value ?? "", start: receiver?.selectionStart ?? 0, end: receiver?.selectionEnd ?? 0, direction: receiver?.selectionDirection ?? "none" }; stop(); return value; } };
  earlyInput = session;
  document.addEventListener("keydown", key, true);
  document.addEventListener("visibilitychange", hidden, true);
  window.addEventListener("pagehide", exit, true);
  return { owns, arm: (key, target) => { destination = { key, target }; }, cancel: stop };
}
const takeEarlyInput = (el: HTMLElement) => earlyInput?.armed(el) ? earlyInput.take() : undefined;

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

function place(el: HTMLElement, input: EarlyText | undefined = undefined, current: () => boolean = () => true) {
  el.focus({ preventScroll: true });
  if (el instanceof HTMLTextAreaElement) el.setSelectionRange(el.value.length, el.value.length);
  if (!input?.text || !current() || document.activeElement !== el || !el.isConnected || el.closest("[inert]")) return;
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  if (field ? el.readOnly || el.disabled : !el.isContentEditable) return;
  document.execCommand("insertText", false, input.text);
  if (!current() || document.activeElement !== el || !el.isConnected) return;
  if (field) {
    const base = (el.selectionEnd ?? 0) - input.text.length;
    el.setSelectionRange(base + input.start, base + input.end, input.direction);
  } else {
    const selection = window.getSelection();
    if (!selection?.focusNode || !el.contains(selection.focusNode)) return;
    // Native character moves preserve grapheme clusters and paragraph boundaries.
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const _ of segmenter.segment(input.text.slice(input.end))) selection.modify("move", "backward", "character");
    for (const _ of segmenter.segment(input.text.slice(input.start, input.end))) selection.modify("extend", "backward", "character");
    if (input.direction !== "backward" && selection.anchorNode && selection.focusNode) selection.setBaseAndExtent(selection.focusNode, selection.focusOffset, selection.anchorNode, selection.anchorOffset);
  }
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
  if (e.isComposing) return;
  const el = p.find();
  if (!focusable(el)) return;
  if (active && active !== document.body && !earlyInput?.owns(active) && !earlyInput?.armed(el)) return;
  const text = takeEarlyInput(el);
  let moved = false;
  const observe = (event: FocusEvent) => { if (event.target !== active && event.target !== document.body) moved = true; };
  document.addEventListener("focusin", observe, true);
  let allowed: boolean, current: boolean;
  try { allowed = p.done(true); current = p.current(el); } finally { p.release?.(); document.removeEventListener("focusin", observe, true); }
  if (!allowed || moved || !current || !focusable(el)) return;
  place(el, text, () => p.current(el));
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
    if (event.target !== document.body && !earlyInput?.owns(event.target as Element)) done();
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
      if (earlyInput?.wait(() => tick(left))) return;
      const text = focusable(el) ? takeEarlyInput(el) : undefined;
      if (!cleanup()) return;
      const active = document.activeElement;
      let changed = false;
      const observe = (event: FocusEvent) => { if (event.target !== active && event.target !== document.body) changed = true; };
      document.addEventListener("focusin", observe, true);
      let allowed: boolean | void;
      try { allowed = onDone?.(!focusable(el)); } finally { document.removeEventListener("focusin", observe, true); }
      if (!changed && request === focusRequest && (!valid || allowed === true) && focusable(el)) place(el, text, () => request === focusRequest && target(selector, root) === el);
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

