/**
 * Plan 169: the math of dragging a block within a column of blocks (the sidebar's categories, its accounts). Pure:
 * lib/sortable-install.ts measures the blocks and moves them. A block is any height (an open account is its row and
 * its folders); the column is in one coordinate space (tops measured together, so a scroll moves them alike).
 */

export interface Block {
  top: number;
  height: number;
}

/** How far the dragged block may go: from the first block's top to the last one's bottom, never out of its group. */
export function clampDy(blocks: readonly Block[], from: number, dy: number): number {
  const self = blocks[from]!;
  const first = blocks[0]!;
  const last = blocks.at(-1)!;
  return Math.min(Math.max(dy, first.top - self.top), last.top + last.height - (self.top + self.height));
}

/**
 * Where the dragged block lands: past every neighbour whose middle its leading edge has crossed (half a row for rows
 * alike; a short row over a tall open account goes once it's halfway along it, and never flips back and forth).
 */
export function slotOf(blocks: readonly Block[], from: number, dy: number): number {
  const self = blocks[from]!;
  const top = self.top + dy;
  const bottom = top + self.height;
  const mid = (b: Block) => b.top + b.height / 2;
  let to = from;
  for (let j = from + 1; j < blocks.length; j++) if (bottom > mid(blocks[j]!)) to = j;
  for (let j = from - 1; j >= 0; j--) if (top < mid(blocks[j]!)) to = j;
  return to;
}

/** The space between two blocks (the column's own gap, zero for rows that touch). */
function gapOf(blocks: readonly Block[]): number {
  return blocks.length > 1 ? Math.max(0, blocks[1]!.top - blocks[0]!.top - blocks[0]!.height) : 0;
}

/** Each block's offset while the gap is at `to`: the ones it passed step aside by its height; the dragged one is 0. */
export function shiftsFor(blocks: readonly Block[], from: number, to: number): number[] {
  const step = blocks[from]!.height + gapOf(blocks);
  return blocks.map((_, j) => (j === from ? 0 : from < j && j <= to ? -step : to <= j && j < from ? step : 0));
}

/** The list with the item at `from` taken out and put at `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
