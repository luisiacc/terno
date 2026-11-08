/** One line of a wheel that counts in lines: the scroller's own line, or its type's when that's "normal". */
function lineOf(el: HTMLElement): number {
  const style = getComputedStyle(el);
  return parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.2;
}

/**
 * A wheel over something laid on a scroller from outside it (an overlay's buttons, an offer over its top) moves that
 * scroller as a wheel over its rows would: pixels as they are, lines and pages in the scroller's own measure.
 */
export function forwardWheel(e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">, scroller: HTMLElement | null | undefined): void {
  if (!scroller || (!e.deltaX && !e.deltaY)) return;
  const line = e.deltaMode === 1 ? lineOf(scroller) : 0;
  const x = e.deltaMode === 1 ? line : e.deltaMode === 2 ? scroller.clientWidth : 1;
  const y = e.deltaMode === 1 ? line : e.deltaMode === 2 ? scroller.clientHeight : 1;
  scroller.scrollLeft += e.deltaX * x;
  scroller.scrollTop += e.deltaY * y;
}
