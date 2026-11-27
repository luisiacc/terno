/**
 * A right-click inside a mail's frame doesn't leave its document, so the frame replays it on the `<iframe>` (mail-body):
 * the replay remembers what was under the pointer, for the menu to read back (plan 284: the link it's about).
 */
const origins = new WeakMap<Event, Element>();

/** Replays a right-click from inside a frame on `on` (at `x`, `y` in the page), remembering `source`. */
export function replayMenu(on: Element, source: Element, x: number, y: number): void {
  const replay = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
  origins.set(replay, source);
  on.dispatchEvent(replay);
}

/** What a right-click was on: inside the frame it was replayed from, or its own target. */
export function menuOrigin(event: Event): Element | null {
  return origins.get(event) ?? (event.target as Element | null);
}
