import { describe, expect, it } from "vitest";
import { badgeText } from "./attention";

describe("badgeText", () => {
  it("clears at 0, shows the number up to 9,999, then 9999+", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(-3)).toBe("");
    expect(badgeText(Number.NaN)).toBe("");
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9999)).toBe("9999");
    expect(badgeText(10_000)).toBe("9999+");
    expect(badgeText(250_000)).toBe("9999+");
  });
});
