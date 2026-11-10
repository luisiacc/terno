import { describe, expect, it } from "vitest";
import { anchorAt, anchoredOffset, rowStart, TOP_LABEL, topSections } from "./row-offsets";

// two due reminders on top, the Reminders heading above them and a 9 px gap after them; no offer
const spacing = { lead: 0, top: 2, topGap: 9, groups: [0] as number[] };

describe("row offsets (plan 174)", () => {
  it("lays rows out as the virtualizer does: the heading, the reminders, the gap, Today's headings", () => {
    expect(rowStart(0, 64, spacing)).toBe(TOP_LABEL);
    expect(rowStart(2, 64, spacing)).toBe(TOP_LABEL + 128 + 9);
    expect(rowStart(3, 64, { lead: 40, top: 0, topGap: 0, groups: [0, 2] })).toBe(40 + TOP_LABEL + 192 + TOP_LABEL);
  });

  it("a style switch keeps the first visible row at the same depth: only the rows scale, the heading and the gap don't", () => {
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

describe("the Inbox's top sections (plan 177)", () => {
  const rows = (...ids: number[]) => ids.map((id) => ({ id }));

  it("pins only, reminders only, both, nothing", () => {
    expect(topSections(rows(1, 2, 9), { ids: [1, 2], pinned: 2 })).toEqual({ top: 2, pinned: 2, headings: [{ kind: "pinned", at: 0 }] });
    expect(topSections(rows(3, 9), { ids: [3], pinned: 0 })).toEqual({ top: 1, pinned: 0, headings: [{ kind: "reminders", at: 0 }] });
    expect(topSections(rows(1, 3, 4, 9), { ids: [1, 3, 4], pinned: 1 })).toEqual({ top: 3, pinned: 1, headings: [{ kind: "pinned", at: 0 }, { kind: "reminders", at: 1 }] });
    expect(topSections(rows(9), { ids: [], pinned: 0 }).headings).toEqual([]);
  });

  it("follows the rows on screen: one taken out since (archived) shortens its section; an empty section has no heading", () => {
    expect(topSections(rows(2, 3, 9), { ids: [1, 2, 3], pinned: 2 })).toEqual({ top: 2, pinned: 1, headings: [{ kind: "pinned", at: 0 }, { kind: "reminders", at: 1 }] });
    expect(topSections(rows(3, 9), { ids: [1, 3], pinned: 1 })).toEqual({ top: 1, pinned: 0, headings: [{ kind: "reminders", at: 0 }] });
    expect(topSections(rows(9), { ids: [1, 3], pinned: 1 })).toEqual({ top: 0, pinned: 0, headings: [] });
  });

  it("lays both sections out: Pinned's heading, its rows, Reminders' heading, its rows, the gap", () => {
    const { top, headings } = topSections(rows(1, 2, 3, 9), { ids: [1, 2, 3], pinned: 2 });
    const s = { lead: 0, top, topGap: 9, groups: headings.map((h) => h.at) };
    expect(rowStart(0, 64, s)).toBe(TOP_LABEL);
    expect(rowStart(2, 64, s)).toBe(TOP_LABEL + 128 + TOP_LABEL);
    expect(rowStart(3, 64, s)).toBe(2 * TOP_LABEL + 192 + 9);
  });
});
