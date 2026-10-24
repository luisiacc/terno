import { describe, expect, it } from "vitest";
import { addRange, extend, menuTargets, pick, prune, range, targetsOf, toggle, type Order } from "./selection";

/** 1,000 loaded rows: ids 101…1100; only a window of ~30 would be in the DOM. */
const order = (ids: number[]): Order => ({ ids, index: new Map(ids.map((id, i) => [id, i])) });
const ROWS = order(Array.from({ length: 1000 }, (_, i) => 101 + i));
const set = (...ids: number[]) => new Set(ids);
const sorted = (s: ReadonlySet<number>) => [...s].sort((a, b) => a - b);

describe("selection model", () => {
  it("toggle flips one row and never mutates the input", () => {
    const a = set(1, 2);
    expect(toggle(a, 2)).toEqual(set(1));
    expect(toggle(a, 3)).toEqual(set(1, 2, 3));
    expect(a).toEqual(set(1, 2));
  });

  it("a range is in list order whichever end comes first, across rows the virtualizer unmounted", () => {
    expect(range(ROWS, 105, 101)).toEqual([101, 102, 103, 104, 105]);
    // 900 rows apart: positions come from the loaded list, not the DOM
    const far = range(ROWS, 150, 1049);
    expect(far).toHaveLength(900);
    expect([far[0], far.at(-1)]).toEqual([150, 1049]);
  });

  it("a range whose anchor left the list (or was never loaded) collapses to the clicked row", () => {
    expect(range(ROWS, 99_999, 120)).toEqual([120]);
    expect(range(ROWS, 120, 99_999)).toEqual([120]);
    expect(addRange(set(), ROWS, null, 130)).toEqual(set(130));
  });

  it("⇧-click adds the anchor→row range to what is already checked", () => {
    expect(addRange(set(500), ROWS, 103, 101)).toEqual(set(500, 101, 102, 103));
  });

  it("⇧J/⇧K extend from the anchor and shrink when moving back toward it", () => {
    let s = { checked: set(), cursor: 110 as number | null, anchor: null as number | null };
    s = extend(s.checked, ROWS, s.anchor, s.cursor, 1);
    expect([sorted(s.checked), s.cursor, s.anchor]).toEqual([[110, 111], 111, 110]);
    s = extend(s.checked, ROWS, s.anchor, s.cursor, 1);
    expect(sorted(s.checked)).toEqual([110, 111, 112]);
    s = extend(s.checked, ROWS, s.anchor, s.cursor, -1);
    expect(sorted(s.checked)).toEqual([110, 111]);
    s = extend(s.checked, ROWS, s.anchor, s.cursor, -1);
    s = extend(s.checked, ROWS, s.anchor, s.cursor, -1);
    // past the anchor: the range now runs upward
    expect([sorted(s.checked), s.cursor]).toEqual([[109, 110], 109]);
  });

  it("extending keeps rows checked elsewhere (⌘-click) and stops at the ends of the list", () => {
    let s = extend(set(900), ROWS, 1099, 1099, 1);
    expect([sorted(s.checked), s.cursor]).toEqual([[900, 1099, 1100], 1100]);
    s = extend(s.checked, ROWS, s.anchor, s.cursor, 1);
    expect(s.cursor).toBe(1100);
    expect(extend(set(), order([]), null, null, 1).checked).toEqual(set());
  });

  it("an anchor that left the view restarts the extension at the cursor", () => {
    const s = extend(set(), ROWS, 99_999, 200, 1);
    expect([sorted(s.checked), s.anchor]).toEqual([[200, 201], 200]);
  });

  it("rows that left the view are pruned; an unchanged selection writes nothing", () => {
    const after = order([101, 103, 104]);
    expect(prune(set(101, 102, 104), after.index)).toEqual(set(101, 104));
    expect(prune(set(101, 104), after.index)).toBeNull();
    expect(prune(set(), after.index)).toBeNull();
  });

  it("pick selects loaded rows by state (* a, * r, * u, * s)", () => {
    const items = [
      { id: 1, unread: true, starred: false },
      { id: 2, unread: false, starred: true },
      { id: 3, unread: false, starred: false },
    ];
    expect(pick(items)).toEqual(set(1, 2, 3));
    expect(pick(items, (t) => !t.unread)).toEqual(set(2, 3));
    expect(pick(items, (t) => t.unread)).toEqual(set(1));
    expect(pick(items, (t) => t.starred)).toEqual(set(2));
  });

  it("actions target the checked rows in list order, else the open thread", () => {
    expect(targetsOf(set(105, 101), 300, ROWS)).toEqual([101, 105]);
    expect(targetsOf(set(), 300)).toEqual([300]);
    expect(targetsOf(set(), null)).toEqual([]);
  });

  it("right-click acts on the selection only when the row is part of it", () => {
    expect(menuTargets(102, set(101, 102, 103), ROWS)).toEqual([101, 102, 103]);
    expect(menuTargets(500, set(101, 102, 103), ROWS)).toEqual([500]);
    expect(menuTargets(500, set(), ROWS)).toEqual([500]);
  });
});
