/** Plan 210: the history's order, and each table's key strictly after a line, so pages across both never repeat or skip one. */
import { describe, expect, it } from "vitest";
import { historyAfter, historyOrder, type HistoryKey } from "./today";

describe("historyOrder and historyAfter", () => {
  const k = (at: number, src: 0 | 1, id: number): HistoryKey => ({ at, src, id });

  it("newest first; at the same moment a dated item before a promise; then the higher id", () => {
    const keys = [k(1, 0, 5), k(3, 1, 1), k(3, 0, 2), k(3, 0, 9), k(2, 1, 4), k(3, 1, 7)];
    expect(keys.sort(historyOrder)).toEqual([k(3, 0, 9), k(3, 0, 2), k(3, 1, 7), k(3, 1, 1), k(2, 1, 4), k(1, 0, 5)]);
    expect(historyOrder(k(3, 0, 2), k(3, 0, 2))).toBe(0);
  });

  it("each table strictly after a line: what (closed_at, id) < the translated key takes is exactly what comes after it", () => {
    const rows = [k(3, 0, 9), k(3, 0, 2), k(3, 1, 7), k(3, 1, 1), k(2, 1, 4), k(2, 0, 3), k(1, 0, 5)].sort(historyOrder);
    const before = (r: HistoryKey, a: { at: number; id: number }) => r.at < a.at || (r.at === a.at && r.id < a.id);
    for (const [i, line] of rows.entries()) {
      const after = rows.filter((r) => before(r, historyAfter(line, r.src)));
      expect(after).toEqual(rows.slice(i + 1));
    }
  });
});
