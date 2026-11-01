import { describe, expect, it } from "vitest";
import { initialWindowSize, MIN_WINDOW } from "./window-size";

describe("a new window's size", () => {
  it("takes most of the screen: bigger than the old fixed 1400×880 on a 16-inch MacBook Pro, and it fits a 13-inch Air", () => {
    expect(initialWindowSize({ width: 1728, height: 1079 })).toEqual({ width: 1590, height: 993 });
    // the old 1400×880 overflowed this one
    expect(initialWindowSize({ width: 1440, height: 875 })).toEqual({ width: 1325, height: 805 });
  });

  it("stops growing on a big display, and never goes below the minimum", () => {
    expect(initialWindowSize({ width: 3008, height: 1667 })).toEqual({ width: 1920, height: 1200 });
    expect(initialWindowSize({ width: 800, height: 500 })).toEqual(MIN_WINDOW);
  });
});
