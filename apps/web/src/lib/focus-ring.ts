/**
 * Plan 54: focus rings show only while the user moves with Tab. The browser's own :focus-visible also lights
 * a control after a shortcut (r, Esc, #) or a focus Terno moves itself, which reads as a stray blue border.
 * Tab sets <html data-focus-ring>; a pointer press or any other key that isn't navigating clears it.
 */
const NAVIGATING = new Set(["Tab", "Shift", "Control", "Alt", "Meta", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", " ", "Escape"]);

export function installFocusRing(win: Window = window): void {
  const root = win.document.documentElement;
  const set = (on: boolean) => {
    if (on !== root.hasAttribute("data-focus-ring")) root.toggleAttribute("data-focus-ring", on);
  };
  // capture: a handler that stops a key (the list's j/k, the composer's shortcuts) must not hide it from here
  win.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) set(true);
    else if (!NAVIGATING.has(e.key)) set(false);
  }, true);
  win.addEventListener("pointerdown", () => set(false), true);
}
