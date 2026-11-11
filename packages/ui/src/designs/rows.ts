import type { DesignDefinition } from "./types";

/** Plan 187: lines of preview under a three-line row's subject (the setting's values, PreviewLines in @terno/core/rpc). */
export type RowLines = 0 | 1 | 2;

/**
 * Plan 187 (the owner): with no preview, the sender's and the subject's lines sit this far apart (the row's `mt-1.5`),
 * and the row is that much taller, so its padding is a one-line row's.
 */
export const NO_PREVIEW_GAP = 6;

/** A rem leading in px (the root is 16 px; designs.test.ts keeps rowSnippet's leading in rem). */
const remPx = (rem: string) => parseFloat(rem) * 16;

/**
 * Plan 187: the preview lines a list's rows show. Where the line says why a row is there it stays: a search's match,
 * an action preview's reason (at least one line), a category's Review answers (exactly one: they are one line).
 */
export function previewLinesFor(setting: RowLines, list: { review: boolean; results: boolean; previewing: boolean }): RowLines {
  if (list.review) return 1;
  if (list.results || list.previewing) return setting === 0 ? 1 : setting;
  return setting;
}

/**
 * A list's row height in px, the one place it's worked out (the list's virtualizer and first run's preview): one-line
 * rows (compact, List's wide) are the design's; a three-line row is the design's (for one preview line) plus or minus
 * one preview leading per line, its padding unchanged (with none, the gap above the subject added).
 */
export function rowHeight(design: DesignDefinition, shape: { compact: boolean; wide: boolean; results: boolean; lines: RowLines }): number {
  if (shape.compact) return design.rows.compact;
  if (shape.wide) return design.rows.wide;
  return design.rows[shape.results ? "results" : "comfortable"] + (shape.lines - 1) * remPx(design.type.rowSnippet.leading) + (shape.lines === 0 ? NO_PREVIEW_GAP : 0);
}
