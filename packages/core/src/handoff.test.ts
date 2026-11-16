import { describe, expect, it } from "vitest";
import { HANDOFF_ITEMS_MAX, mergeHandoffs, parseHandoff, type Handoff } from "./handoff";

/**
 * Codex's code review of plan 210's iteration 4: a second Hand to… into a forward that already hands something on joins it as
 * a row of its own, so the confirmed send closes both; handing the same row again replaces it; past the bound, refused.
 */
describe("mergeHandoffs", () => {
  const form: Handoff = { items: [{ source: "dated", id: 1, revision: 2, named: true }, { source: "dated", id: 9, revision: 1 }] };
  const bus: Handoff = { items: [{ source: "dated", id: 3, revision: 5, named: true }] };

  it("nothing handed yet: the hand-off as it is", () => {
    expect(mergeHandoffs(null, form)).toEqual(form);
  });

  it("another item joins as a row of its own, the first kept as it was", () => {
    const both = mergeHandoffs(form, bus)!;
    expect(both).toEqual({ items: [...form.items, { source: "dated", id: 3, revision: 5, named: true, row: 1 }] });
    // it reads back as it was saved
    expect(parseHandoff(JSON.stringify(both))).toEqual(both);
  });

  it("the same row handed again takes its new resolution in place of the old; an item in both is kept once, as now resolved", () => {
    const both = mergeHandoffs(form, bus)!;
    expect(mergeHandoffs(both, { items: [{ source: "dated", id: 1, revision: 4, named: true }] })).toEqual({ items: [{ source: "dated", id: 3, revision: 5, named: true }, { source: "dated", id: 1, revision: 4, named: true, row: 1 }] });
    // the bus's row names the form's member too: it's in the bus's row only
    expect(mergeHandoffs(form, { items: [...bus.items, { source: "dated", id: 9, revision: 3 }] })).toEqual({
      items: [{ source: "dated", id: 1, revision: 2, named: true }, { source: "dated", id: 3, revision: 5, named: true, row: 1 }, { source: "dated", id: 9, revision: 3, row: 1 }],
    });
  });

  it("past the bound it's refused, never cut", () => {
    const full: Handoff = { items: Array.from({ length: HANDOFF_ITEMS_MAX }, (_, i) => ({ source: "dated" as const, id: 100 + i, revision: 0, ...(i === 0 && { named: true }) })) };
    expect(mergeHandoffs(full, bus)).toBeNull();
  });
});
