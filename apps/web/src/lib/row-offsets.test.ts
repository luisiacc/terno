import { describe, expect, it } from "vitest";
import { anchorAt, anchoredOffset, INBOX_LABEL, rowStart, TOP_LABEL, topSections } from "./row-offsets";

// two due reminders on top, the Reminders heading above them and the Inbox's under them; no offer
const spacing = { lead: 0, label: TOP_LABEL, groups: [0, 2] as number[] };

describe("row offsets (plan 174)", () => {
  it("lays rows out as the virtualizer does: the heading, the reminders, the Inbox's heading, Today's headings", () => {
    expect(rowStart(0, 64, spacing)).toBe(TOP_LABEL);
    expect(rowStart(2, 64, spacing)).toBe(2 * TOP_LABEL + 128);
    expect(rowStart(3, 64, { lead: 40, label: TOP_LABEL, groups: [0, 2] })).toBe(40 + TOP_LABEL + 192 + TOP_LABEL);
  });

  it("a style switch keeps the first visible row at the same depth: only the rows scale, the headings don't", () => {
    // a quarter into row 10 at 64 px
    const y = rowStart(10, 64, spacing) + 16;
    const anchor = anchorAt(y, 100, 64, spacing);
    expect(anchor).toEqual({ index: 10, into: 16 });
    expect(anchoredOffset(anchor, 64, 84, spacing)).toBe(rowStart(10, 84, spacing) + 21);
  });

  it("a viewport in the heading under a row anchors the next, the row actually on screen (Codex review, round 2)", () => {
    // the second reminder ends at TOP_LABEL + 128; the Inbox's heading under it, mail after
    const y = TOP_LABEL + 128 + 5;
    const anchor = anchorAt(y, 100, 64, spacing);
    expect(anchor).toEqual({ index: 2, into: 5 - TOP_LABEL });
    // the space above it stays as it was
    expect(anchoredOffset(anchor, 64, 84, spacing)).toBe(rowStart(2, 84, spacing) + 5 - TOP_LABEL);
  });

  it("above the first row, the first row is the anchor, and what's above it keeps its height", () => {
    const offer = { ...spacing, lead: 48 };
    expect(anchorAt(0, 100, 64, offer)).toEqual({ index: 0, into: -(48 + TOP_LABEL) });
    expect(anchoredOffset(anchorAt(10, 100, 64, offer), 64, 84, offer)).toBe(10);
  });
});

describe("the Inbox's top sections (plan 179)", () => {
  const rows = (...ids: number[]) => ids.map((id) => ({ id }));

  it("pins only, reminders only, both, nothing; the rest of the Inbox under its own heading once either leads", () => {
    expect(topSections(rows(1, 2, 9), { ids: [1, 2], pinned: 2 })).toEqual({ top: 2, pinned: 2, headings: [{ kind: "pinned", at: 0 }, { kind: "inbox", at: 2 }] });
    expect(topSections(rows(3, 9), { ids: [3], pinned: 0 })).toEqual({ top: 1, pinned: 0, headings: [{ kind: "reminders", at: 0 }, { kind: "inbox", at: 1 }] });
    expect(topSections(rows(1, 3, 4, 9), { ids: [1, 3, 4], pinned: 1 })).toEqual({ top: 3, pinned: 1, headings: [{ kind: "pinned", at: 0 }, { kind: "reminders", at: 1 }, { kind: "inbox", at: 3 }] });
    expect(topSections(rows(9), { ids: [], pinned: 0 }).headings).toEqual([]);
    // nothing else in the Inbox: no heading over nothing
    expect(topSections(rows(1, 2), { ids: [1, 2], pinned: 2 }).headings).toEqual([{ kind: "pinned", at: 0 }]);
  });

  it("follows the rows on screen: one taken out since (archived) shortens its section; an empty section has no heading", () => {
    expect(topSections(rows(2, 3, 9), { ids: [1, 2, 3], pinned: 2 })).toEqual({ top: 2, pinned: 1, headings: [{ kind: "pinned", at: 0 }, { kind: "reminders", at: 1 }, { kind: "inbox", at: 2 }] });
    expect(topSections(rows(3, 9), { ids: [1, 3], pinned: 1 })).toEqual({ top: 1, pinned: 0, headings: [{ kind: "reminders", at: 0 }, { kind: "inbox", at: 1 }] });
    expect(topSections(rows(9), { ids: [1, 3], pinned: 1 })).toEqual({ top: 0, pinned: 0, headings: [] });
  });

  it("lays the sections out: Pinned's heading, its rows, Reminders' heading, its rows, the Inbox's heading, the mail", () => {
    const { headings } = topSections(rows(1, 2, 3, 9), { ids: [1, 2, 3], pinned: 2 });
    const s = { lead: 0, label: INBOX_LABEL, groups: headings.map((h) => h.at) };
    expect(rowStart(0, 64, s)).toBe(INBOX_LABEL);
    expect(rowStart(2, 64, s)).toBe(INBOX_LABEL + 128 + INBOX_LABEL);
    expect(rowStart(3, 64, s)).toBe(3 * INBOX_LABEL + 192);
  });
});
