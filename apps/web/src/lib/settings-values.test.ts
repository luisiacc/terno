import { describe, expect, it } from "vitest";
import { parseSyncWindow } from "./settings-values";

describe("sync window", () => {
  it("takes whole days in the contract's range, as typed", () => {
    expect(parseSyncWindow("7")).toEqual({ days: 7 });
    expect(parseSyncWindow(" 365 ")).toEqual({ days: 365 });
    expect(parseSyncWindow("3650")).toEqual({ days: 3650 });
  });

  it("explains anything else instead of clamping it", () => {
    for (const bad of ["", "6", "0", "3651", "-30", "30.5", "1e3", "abc"]) expect(parseSyncWindow(bad)).toHaveProperty("error", "Escribe un número de días entre 7 y 3650.");
  });
});
