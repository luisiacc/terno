/**
 * Plan 54: focus rings show only while the user moves with Tab. The browser's own :focus-visible also lights
 * a control after a shortcut (r, Esc, #) or a focus Terno moves itself, which reads as a stray blue border.
 * Tab (and F6, which moves between regions) sets <html data-focus-ring>; a pointer press, a shortcut chord
 * (Cmd, Ctrl or Alt with any key) or any other key that isn't navigating clears it.
 */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);
const MOVES = new Set(["Tab", "F6"]);
const NAVIGATING = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", " ", "Escape"]);

export function installFocusRing(win: Window = window): void {
  const root = win.document.documentElement;
  const set = (on: boolean) => {
    if (on !== root.hasAttribute("data-focus-ring")) root.toggleAttribute("data-focus-ring", on);
  };
  // capture: a handler that stops a key (the list's j/k, the composer's shortcuts) must not hide it from here
  win.addEventListener("keydown", (e) => {
    if (MODIFIERS.has(e.key)) return;
    // a chord is a shortcut (Cmd+Enter sends, Cmd+Tab leaves the app), never navigation
    if (e.metaKey || e.ctrlKey || e.altKey) set(false);
    else if (MOVES.has(e.key)) set(true);
    else if (!NAVIGATING.has(e.key)) set(false);
  }, true);
  win.addEventListener("pointerdown", () => set(false), true);
}
