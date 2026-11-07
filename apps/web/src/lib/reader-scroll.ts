import { useAppearance } from "./appearance";
import { setSentRevealer } from "./sent-reveal";

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

/** A key typed into a field or the editor writes there: it isn't the reader being scrolled. */
const typing = (target: EventTarget | null): boolean => target instanceof Element && target.closest("input, textarea, select, [contenteditable=true]") !== null;

/**
 * What covers the scroller's edges, as its scroll padding says: at the foot the snack dock and the pinned draft, at the
 * top what sticks there (the conversation's context line once its header has gone, plan 158). The element clears both.
 */
function coverOf(scroller: HTMLElement): { covered: number; coveredTop: number } {
  const style = getComputedStyle(scroller);
  return { covered: parseFloat(style.scrollPaddingBottom) || 0, coveredTop: parseFloat(style.scrollPaddingTop) || 0 };
}

/** `wanted`: how much of the element, from its top, has to show (all of it by default): a composer's foot sticks, so its first lines are enough. */
export function keepInView(el: HTMLElement, scroller: HTMLElement | null = el.closest<HTMLElement>("[data-reader-scroller]"), pad = 16, wanted?: () => number): () => void {
  cancelReaderScroll();
  if (!scroller) return () => {};
  const { motionMs, reducedMotion } = useAppearance.getState();
  if (motionMs === 0 || reducedMotion) {
    const id = requestAnimationFrame(() => {
      if (!wanted) { el.scrollIntoView({ block: "nearest" }); return; }
      const { covered, coveredTop } = coverOf(scroller);
      const r = el.getBoundingClientRect(), s = scroller.getBoundingClientRect();
      const overflow = r.top + Math.min(wanted(), r.height) - (s.bottom - pad - covered);
      if (overflow > 0) scroller.scrollTop += Math.min(overflow, r.top - (s.top + pad + coveredTop));
    });
    cancel = () => cancelAnimationFrame(id);
    return cancelReaderScroll;
  }
  const { covered, coveredTop } = coverOf(scroller);
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
  const onKey = (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && !typing(e.target) && stop();
  const step = () => {
    // read
    const r = el.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const overflow = (wanted ? r.top + Math.min(wanted(), r.height) : r.bottom) - (s.bottom - pad - covered);
    const room = r.top - (s.top + pad + coveredTop);
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

/**
 * Brings a message's top to the top of the reader (as far as the reader
 * scrolls), once it renders (a few frames at most): navigation never animates.
 */
/** What covers the reader's head once its subject scrolls away (the subject's line: its scroll-padding-top). */
export const topCover = (scroller: HTMLElement): number => parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;

export function revealMessage(id: number, pad = 16): void {
  cancelReaderScroll();
  let frame = 0;
  let left = 6;
  const step = () => {
    const el = document.querySelector<HTMLElement>(`[data-reader-scroller] article[data-message-id="${id}"]`);
    const scroller = el?.closest<HTMLElement>("[data-reader-scroller]");
    if (!el || !scroller) {
      if (--left > 0) frame = requestAnimationFrame(step);
      else if (cancel === stop) cancel = null;
      return;
    }
    if (cancel === stop) cancel = null;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pad - topCover(scroller);
  };
  const stop = () => cancelAnimationFrame(frame);
  cancel = stop;
  frame = requestAnimationFrame(step);
}

setSentRevealer(revealMessage);
