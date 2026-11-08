/**
 * Plan 161, pass 3 (Codex review): an Esc that dismisses an input method's candidates isn't one for the page. Safari fires
 * `compositionend` before that Esc's `keydown`, so `isComposing` is already false on it: a composition counts until a
 * moment after it ends, as Base UI's own dismissal waits (5 ms, the least that holds in WebKit).
 */
const ime = { composing: false, settle: 0 as ReturnType<typeof setTimeout> | 0 };

if (typeof document !== "undefined") {
  document.addEventListener("compositionstart", () => {
    clearTimeout(ime.settle);
    ime.composing = true;
  }, true);
  document.addEventListener("compositionend", () => {
    clearTimeout(ime.settle);
    ime.settle = setTimeout(() => {
      ime.composing = false;
    }, 5);
  }, true);
}

/** This key belongs to an input method: leave it alone. */
export const imeKey = (e: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean => e.isComposing || e.keyCode === 229 || ime.composing;
