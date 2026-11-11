import { describe, expect, it } from "vitest";
import { designById, DESIGNS } from "./index";
import { previewLinesFor, rowHeight } from "./rows";

const plain = { review: false, results: false, previewing: false };

describe("plan 187: the preview's lines and a list's row height", () => {
  it("a mailbox shows the setting; a search and an action preview at least one line; Review exactly one", () => {
    for (const n of [0, 1, 2] as const) {
      expect(previewLinesFor(n, plain)).toBe(n);
      expect(previewLinesFor(n, { ...plain, review: true })).toBe(1);
      expect(previewLinesFor(n, { ...plain, results: true })).toBe(n === 0 ? 1 : n);
      expect(previewLinesFor(n, { ...plain, previewing: true })).toBe(n === 0 ? 1 : n);
    }
  });

  it("one line is the design's height, as before; each line more or less is one preview leading", () => {
    for (const d of DESIGNS) {
      const leading = parseFloat(d.type.rowSnippet.leading) * 16;
      for (const results of [false, true]) {
        const base = d.rows[results ? "results" : "comfortable"];
        expect(rowHeight(d, { compact: false, wide: false, results, lines: 1 }), d.id).toBe(base);
        expect(rowHeight(d, { compact: false, wide: false, results, lines: 0 }), d.id).toBe(base - leading);
        expect(rowHeight(d, { compact: false, wide: false, results, lines: 2 }), d.id).toBe(base + leading);
      }
    }
  });

  it("one-line rows (compact, List's wide) don't change with it; compact wins over wide", () => {
    for (const d of DESIGNS) {
      for (const lines of [0, 1, 2] as const) {
        expect(rowHeight(d, { compact: true, wide: false, results: false, lines })).toBe(d.rows.compact);
        expect(rowHeight(d, { compact: true, wide: true, results: true, lines })).toBe(d.rows.compact);
        expect(rowHeight(d, { compact: false, wide: true, results: false, lines })).toBe(d.rows.wide);
      }
    }
  });

  it("the table in the plan", () => {
    const h = (id: string, lines: 0 | 1 | 2) => rowHeight(designById(id), { compact: false, wide: false, results: false, lines });
    expect([h("lumen", 0), h("lumen", 1), h("lumen", 2)]).toEqual([58, 76, 94]);
    expect([h("graphite", 0), h("graphite", 1), h("graphite", 2)]).toEqual([64, 84, 104]);
    expect([h("macos", 0), h("macos", 1), h("macos", 2)]).toEqual([46, 64, 82]);
  });
});
