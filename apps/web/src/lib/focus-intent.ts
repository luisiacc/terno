/**
 * Plan 161: the user's own moves (a key, a press), counted. A focus the app means to move later, once something has
 * drawn (a preview ready, a source's message), notes the count when it decides, and yields if the user moved since.
 */
export const focusIntent = { seq: 0, installed: false };

export function installFocusIntent(): void {
  if (focusIntent.installed || typeof window === "undefined") return;
  focusIntent.installed = true;
  const moved = () => void focusIntent.seq++;
  window.addEventListener("keydown", moved, true);
  window.addEventListener("pointerdown", moved, true);
}
