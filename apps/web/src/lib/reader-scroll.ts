import { useAppearance } from "./appearance";

/**
 * The reader's one scroll scheduler: keeps an element that is growing (an
 * expanding message, an inline draft opening) in view for the length of its
 * transition. Each frame reads geometry first, then writes scrollTop once; it
 * never pushes the element's top out of view. It stops on the user's own
 * scrolling (wheel, touch, pointer, scroll keys), when another call starts,
 * when the thread changes (cancelReaderScroll) and when the time is up. With
 * motion off it is one scrollIntoView({block: "nearest"}) after layout.
 */
let cancel: (() => void) | null = null;

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function cancelReaderScroll(): void {
  cancel?.();
  cancel = null;
}

export function keepInView(el: HTMLElement, scroller: HTMLElement | null = el.closest<HTMLElement>("[data-reader-scroller]"), pad = 16): () => void {
  cancelReaderScroll();
  if (!scroller) return () => {};
  const { motionMs, reducedMotion } = useAppearance.getState();
  if (motionMs === 0 || reducedMotion) {
    const id = requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
    cancel = () => cancelAnimationFrame(id);
    return cancelReaderScroll;
  }
  // the transition (slow ≤ 100 ms) plus two frames for layout to settle
  const until = performance.now() + Math.min(100, Math.round(motionMs * 1.33)) + 34;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    scroller.removeEventListener("wheel", stop);
    scroller.removeEventListener("touchstart", stop);
    scroller.removeEventListener("pointerdown", stop);
    window.removeEventListener("keydown", onKey, true);
    if (cancel === stop) cancel = null;
  };
  const onKey = (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && stop();
  const step = () => {
    // read
    const r = el.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const overflow = r.bottom - (s.bottom - pad);
    const room = r.top - (s.top + pad);
    // write
    if (overflow > 0 && room > 0) scroller.scrollTop += Math.min(overflow, room);
    if (performance.now() < until) frame = requestAnimationFrame(step);
    else stop();
  };
  scroller.addEventListener("wheel", stop, { passive: true });
  scroller.addEventListener("touchstart", stop, { passive: true });
  scroller.addEventListener("pointerdown", stop);
  window.addEventListener("keydown", onKey, true);
  cancel = stop;
  frame = requestAnimationFrame(step);
  return stop;
}
