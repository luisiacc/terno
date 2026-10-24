import { describe, expect, it } from "vitest";
import { LISTED, unlistedBindings } from "./shortcut-sections";

describe("shortcuts dialog", () => {
  it("lists every bound command (or leaves it out on purpose)", () => {
    expect(unlistedBindings()).toEqual([]);
    for (const c of ["list.selectAll", "list.extendNext", "list.extendPrev", "thread.markRead", "thread.toggleRead", "thread.move", "action.undo", "list.menu"] as const) expect(LISTED.has(c)).toBe(true);
  });
});
