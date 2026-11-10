/**
 * Where the list's rows sit in its scroller, as its virtualizer lays them out (thread-list.tsx's estimateSize and
 * paddingStart): rows of one height, and between them space of a fixed height whatever theirs (plan 169).
 */

/** A section label's line: the Reminders label above the due ones, Today's headings */
export const TOP_LABEL = 28;

/** The fixed space: the offer above the rows (`lead`), the due reminders on top and the gap after them, Today's groups */
export interface RowSpacing { lead: number; top: number; topGap: number; groups: readonly number[] }

/** Where row `i` starts */
export function rowStart(i: number, h: number, s: RowSpacing): number {
  const head = s.top > 0 || s.groups.includes(0) ? TOP_LABEL : 0;
  return s.lead + head + i * h + (s.topGap > 0 && i >= s.top ? s.topGap : 0) + TOP_LABEL * s.groups.filter((at) => at >= 1 && at <= i).length;
}

/**
 * The row a viewport starting at `y` keeps through a change of row height: the first one it shows, and how far into it
 * the viewport starts (negative: the fixed space above it). A viewport starting in the space under a row anchors the
 * next, the row actually on screen.
 */
export function anchorAt(y: number, count: number, h: number, s: RowSpacing): { index: number; into: number } {
  let lo = 0;
  let hi = count - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rowStart(mid, h, s) <= y) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const index = y >= rowStart(found, h, s) + h && found + 1 < count ? found + 1 : found;
  return { index, into: y - rowStart(index, h, s) };
}

/** Where a viewport anchored that way starts once rows are `h` tall: the row's share scaled, the fixed space as it is */
export function anchoredOffset(anchor: { index: number; into: number }, oldH: number, h: number, s: RowSpacing): number {
  const { index, into } = anchor;
  return Math.max(0, rowStart(index, h, s) + (into <= 0 ? into : into <= oldH ? into * (h / oldH) : h + into - oldH));
}
