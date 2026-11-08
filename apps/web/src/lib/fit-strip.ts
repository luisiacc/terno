/**
 * Which items fit on a strip's one row (Lumen's filter chips). What's in `pinned` is
 * always there (`pinned`, their widths and gaps). The rest follow in order
 * while they fit; what doesn't goes behind "More" (whose width is reserved only
 * when something overflows). The selected one is never hidden: it takes
 * the last visible place. Widths only, so it doesn't care about direction.
 */
export function fitStrip(o: { widths: readonly number[]; available: number; pinned: number; more: number; gap: number; selected: number }): { visible: number[]; overflow: number[] } {
  const { widths, available, pinned, more, gap, selected } = o;
  const all = widths.map((_, i) => i);
  const total = pinned + widths.reduce((n, w) => n + w + gap, 0);
  if (total <= available) return { visible: all, overflow: [] };
  const room = available - pinned - more - gap;
  const visible: number[] = [];
  let used = 0;
  for (const i of all) {
    if (used + widths[i]! + gap > room) break;
    visible.push(i);
    used += widths[i]! + gap;
  }
  if (selected >= 0 && !visible.includes(selected)) {
    // the selected one takes the end of the row, displacing as many as it needs
    const need = widths[selected]! + gap;
    while (visible.length && used + need > room) used -= widths[visible.pop()!]! + gap;
    if (used + need <= room || visible.length === 0) visible.push(selected);
  }
  const shown = new Set(visible);
  return { visible, overflow: all.filter((i) => !shown.has(i)) };
}
