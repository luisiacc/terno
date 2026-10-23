import { describe, expect, it } from "vitest";
import { DragController, exceedsThreshold, hitTest, newIds, payloadFor, type DragEnv, type DropState, type TargetRect } from "./drag";

const RECTS: TargetRect[] = [
  { id: 1, left: 0, right: 200, top: 100, bottom: 128 },
  { id: 2, left: 0, right: 200, top: 128, bottom: 156 },
  { id: 3, left: 0, right: 200, top: 156, bottom: 184 },
];

/** Category membership: thread 10 is already in 2; the "view" is category 3. */
const MEMBERS: Record<number, number[]> = { 10: [2], 11: [], 12: [2] };

function setup(overrides: Partial<DragEnv> = {}) {
  const log: string[] = [];
  const targets: [number | null, DropState | null][] = [];
  let measured = 0;
  const env: DragEnv = {
    payload: (id) => payloadFor(id, new Set([11, 12]), [10, 11, 12]),
    targets: () => (measured++, RECTS),
    isAlready: (cat, ids) => cat === 3 || newIds(ids, cat, (id) => MEMBERS[id]).length === 0,
    start: (ids) => log.push(`start ${ids.join(",")}`),
    move: () => {},
    target: (id, state) => targets.push([id, state]),
    drop: (cat, ids, { move }) => log.push(`drop ${cat} ${ids.join(",")}${move ? " move" : ""}`),
    cancel: () => log.push("cancel"),
    ...overrides,
  };
  return { ctl: new DragController(env), log, targets, measured: () => measured };
}

describe("drag helpers", () => {
  it("starts at 4 px of movement, not before", () => {
    expect(exceedsThreshold(3, 0)).toBe(false);
    expect(exceedsThreshold(2, 2)).toBe(false); // 2.83 px
    expect(exceedsThreshold(4, 0)).toBe(true);
    expect(exceedsThreshold(3, 3)).toBe(true); // 4.24 px
  });

  it("drags the checked rows in list order when the pressed row is checked, else that row", () => {
    expect(payloadFor(12, new Set([12, 10]), [10, 11, 12])).toEqual([10, 12]);
    expect(payloadFor(11, new Set([12, 10]), [10, 11, 12])).toEqual([11]);
  });

  it("hit-tests the cached rects (edges belong to the next item)", () => {
    expect(hitTest(RECTS, 50, 110)).toBe(1);
    expect(hitTest(RECTS, 50, 128)).toBe(2);
    expect(hitTest(RECTS, 250, 110)).toBeNull();
    expect(hitTest(RECTS, 50, 90)).toBeNull();
  });

  it("only counts threads not yet in the category as new", () => {
    expect(newIds([10, 11, 12], 2, (id) => MEMBERS[id])).toEqual([11]);
    expect(newIds([10, 11], 1, (id) => MEMBERS[id])).toEqual([10, 11]);
    expect(newIds([99], 1, () => undefined)).toEqual([99]);
  });
});

describe("DragController", () => {
  it("a press that moves less than 4 px stays a click", () => {
    const { ctl, log } = setup();
    ctl.down(10, { x: 10, y: 10 });
    expect(ctl.move({ x: 12, y: 12 })).toBe(false);
    ctl.up({ x: 12, y: 12 });
    expect(log).toEqual([]);
    expect(ctl.pressed).toBe(false);
  });

  it("ignores secondary buttons and ⌘/⇧/⌃ presses", () => {
    const { ctl } = setup();
    expect(ctl.down(10, { x: 0, y: 0, button: 2 })).toBe(false);
    expect(ctl.down(10, { x: 0, y: 0, metaKey: true })).toBe(false);
    expect(ctl.down(10, { x: 0, y: 0, shiftKey: true })).toBe(false);
    expect(ctl.down(10, { x: 0, y: 0, ctrlKey: true })).toBe(false);
    expect(ctl.move({ x: 50, y: 50 })).toBe(false);
  });

  it("starts once, measures targets once, reports only target changes, and drops", () => {
    const { ctl, log, targets, measured } = setup();
    ctl.down(10, { x: 300, y: 300 });
    expect(ctl.move({ x: 304, y: 300 })).toBe(true);
    expect(ctl.move({ x: 280, y: 300 })).toBe(false); // already dragging
    expect(log).toEqual(["start 10"]);
    expect(measured()).toBe(1);
    for (const y of [105, 110, 115]) ctl.move({ x: 50, y });
    ctl.move({ x: 50, y: 160 });
    expect(targets).toEqual([
      [1, "over"],
      [3, "already"], // the current view
    ]);
    ctl.move({ x: 50, y: 110 });
    ctl.up({ x: 50, y: 110 });
    expect(log).toEqual(["start 10", "drop 1 10"]);
  });

  it("drags the checked group and passes ⌥ as a move", () => {
    const { ctl, log } = setup();
    ctl.down(12, { x: 300, y: 300 });
    ctl.move({ x: 300, y: 310 });
    ctl.move({ x: 50, y: 110 });
    ctl.up({ x: 50, y: 110, altKey: true });
    expect(log).toEqual(["start 11,12", "drop 1 11,12 move"]);
  });

  it("a drop where everything is already filed does nothing but cancel", () => {
    const { ctl, log, targets } = setup();
    ctl.down(10, { x: 300, y: 300 });
    ctl.move({ x: 300, y: 310 });
    ctl.move({ x: 50, y: 140 }); // category 2: thread 10 is already there
    expect(targets.at(-1)).toEqual([2, "already"]);
    ctl.up({ x: 50, y: 140 });
    expect(log).toEqual(["start 10", "cancel"]);
  });

  it("releasing off any target cancels", () => {
    const { ctl, log } = setup();
    ctl.down(10, { x: 300, y: 300 });
    ctl.move({ x: 300, y: 310 });
    ctl.up({ x: 600, y: 600 });
    expect(log).toEqual(["start 10", "cancel"]);
  });

  it("Esc / pointercancel / blur cancel a drag; before the threshold they just forget the press", () => {
    const { ctl, log } = setup();
    ctl.down(10, { x: 0, y: 0 });
    ctl.cancel();
    expect(log).toEqual([]);
    ctl.down(10, { x: 0, y: 0 });
    ctl.move({ x: 10, y: 0 });
    ctl.move({ x: 50, y: 110 });
    ctl.cancel();
    expect(log).toEqual(["start 10", "cancel"]);
    expect(ctl.dragging).toBe(false);
    // the pointerup that follows is ignored
    ctl.up({ x: 50, y: 110 });
    expect(log).toEqual(["start 10", "cancel"]);
  });

  it("re-measures targets after the sidebar scrolls and re-tests the pointer", () => {
    let rects = RECTS;
    const { ctl, targets } = setup({ targets: () => rects });
    ctl.down(10, { x: 300, y: 300 });
    ctl.move({ x: 300, y: 310 });
    ctl.move({ x: 50, y: 110 });
    rects = RECTS.map((r) => ({ ...r, top: r.top - 28, bottom: r.bottom - 28 }));
    ctl.refreshTargets();
    expect(targets).toEqual([
      [1, "over"],
      [2, "already"],
    ]);
  });
});
