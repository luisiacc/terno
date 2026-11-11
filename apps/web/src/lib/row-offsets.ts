/**
 * Where the list's rows sit in its scroller, as its virtualizer lays them out (thread-list.tsx's estimateSize and
 * paddingStart): rows of one height, and between them space of a fixed height whatever theirs (plan 174).
 */

/** Today's section heading's line */
export const TOP_LABEL = 28;

/** Plan 177: the Inbox's section heading's line (Pinned, Reminders, the Inbox under them): more room above its words (the owner) */
export const INBOX_LABEL = 36;

/**
 * The fixed space: the offer above the rows (`lead`) and the section headings, each `label` tall and the index of the
 * row it stands above (`groups`: the Inbox's sections, or Today's; never both).
 */
export interface RowSpacing { lead: number; label: number; groups: readonly number[] }

/** Where row `i` starts */
export function rowStart(i: number, h: number, s: RowSpacing): number {
  return s.lead + i * h + s.label * s.groups.filter((at) => at <= i).length;
}

/** Plan 177: Pinned, Reminders, and (once either leads) the rest of the Inbox under its own name */
export type TopSectionKind = "pinned" | "reminders" | "inbox";

/** The Inbox's top as the rows show it: how many lead, how many of them are pinned, and each section's heading */
export interface TopSections {
  top: number;
  pinned: number;
  headings: readonly { kind: TopSectionKind; at: number }[];
}

export const NO_SECTIONS: TopSections = { top: 0, pinned: 0, headings: [] };

/**
 * Plan 177: the top's sections over the rows on screen (an optimistic edit may have taken some out since the top was
 * read): the leading rows among its pins, then the leading rows among the rest of it. Pinned first, then Reminders,
 * then the rest of the Inbox under a heading of its own (the owner: it replaced the hairline that closed the top).
 */
export function topSections(rows: readonly { id: number }[], top: { ids: readonly number[]; pinned: number }): TopSections {
  if (top.ids.length === 0) return NO_SECTIONS;
  const pins = new Set(top.ids.slice(0, top.pinned));
  const rest = new Set(top.ids.slice(top.pinned));
  let pinned = 0;
  while (pinned < rows.length && pins.has(rows[pinned]!.id)) pinned++;
  let end = pinned;
  while (end < rows.length && rest.has(rows[end]!.id)) end++;
  if (end === 0) return NO_SECTIONS;
  const headings: { kind: TopSectionKind; at: number }[] = [];
  if (pinned > 0) headings.push({ kind: "pinned", at: 0 });
  if (end > pinned) headings.push({ kind: "reminders", at: pinned });
  if (end < rows.length) headings.push({ kind: "inbox", at: end });
  return { top: end, pinned, headings };
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
