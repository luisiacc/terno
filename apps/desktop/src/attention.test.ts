import { describe, expect, it } from "vitest";
import { DesktopAttention, parseBadge } from "./attention";

describe("the Dock badge in main", () => {
  it("a badge is a safe integer ≥ 0", () => {
    expect(parseBadge(0)).toBe(0);
    expect(parseBadge(12)).toBe(12);
    for (const bad of [-1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) expect(parseBadge(bad)).toBeNull();
  });

  it("its text only when it changes, cleared at 0", () => {
    const badges: string[] = [];
    const a = new DesktopAttention({ setBadge: (t) => badges.push(t) });
    a.badge(3);
    a.badge(3);
    a.badge(12_345);
    a.badge(0);
    a.badge("junk");
    expect(badges).toEqual(["3", "9999+", ""]);
    expect(a.badgeText).toBe("");
  });
});
