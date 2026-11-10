import { describe, expect, it } from "vitest";
import { anchorAt, anchoredOffset, rowStart, TOP_LABEL } from "./row-offsets";

// two due reminders on top, the Reminders label above them and a 9 px gap after them; no offer
const spacing = { lead: 0, top: 2, topGap: 9, groups: [] as number[] };

describe("row offsets (plan 169)", () => {
  it("lays rows out as the virtualizer does: the label, the reminders, the gap, Today's headings", () => {
    expect(rowStart(0, 64, spacing)).toBe(TOP_LABEL);
    expect(rowStart(2, 64, spacing)).toBe(TOP_LABEL + 128 + 9);
    expect(rowStart(3, 64, { lead: 40, top: 0, topGap: 0, groups: [0, 2] })).toBe(40 + TOP_LABEL + 192 + TOP_LABEL);
  });

  it("a style switch keeps the first visible row at the same depth: only the rows scale, the label and the gap don't", () => {
    // a quarter into row 10 at 64 px
    const y = rowStart(10, 64, spacing) + 16;
    const anchor = anchorAt(y, 100, 64, spacing);
    expect(anchor).toEqual({ index: 10, into: 16 });
    expect(anchoredOffset(anchor, 64, 84, spacing)).toBe(rowStart(10, 84, spacing) + 21);
  });

  it("a viewport in the gap under a row anchors the next, the row actually on screen (Codex review, round 2)", () => {
    // the second reminder ends at 28 + 128 = 156; mail starts at 165
    const anchor = anchorAt(160, 100, 64, spacing);
    expect(anchor).toEqual({ index: 2, into: -5 });
    // the space above it stays as it was
    expect(anchoredOffset(anchor, 64, 84, spacing)).toBe(rowStart(2, 84, spacing) - 5);
  });

  it("above the first row, the first row is the anchor, and what's above it keeps its height", () => {
    const offer = { ...spacing, lead: 48 };
    expect(anchorAt(0, 100, 64, offer)).toEqual({ index: 0, into: -(48 + TOP_LABEL) });
    expect(anchoredOffset(anchorAt(10, 100, 64, offer), 64, 84, offer)).toBe(10);
  });
});
