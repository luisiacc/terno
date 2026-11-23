import { describe, expect, it } from "vitest";
import { fontItems, matchFonts } from "~/lib/fonts";

describe("the font field's list (plan 248)", () => {
  const items = fontItems(["Avenir Next", "Futura", "Georgia", "Gill Sans", "Times New Roman"]);

  it("is Terno's five, then the computer's", () => {
    expect(items.map((i) => i.font)).toEqual(["system", "inter", "geist", "figtree", "instrument-sans", "local:Avenir Next", "local:Futura", "local:Georgia", "local:Gill Sans", "local:Times New Roman"]);
    expect(fontItems(null)).toHaveLength(5);
  });

  it("finds by what's typed, case and accents aside: names that start with it first, then those that contain it", () => {
    expect(matchFonts(items, "").length).toBe(items.length);
    expect(matchFonts(items, "  GÉO ").map((i) => i.name)).toEqual(["Georgia"]);
    expect(matchFonts(items, "ge").map((i) => i.name)).toEqual(["Geist", "Georgia"]);
    expect(matchFonts(items, "an").map((i) => i.name)).toEqual(["Instrument Sans", "Gill Sans", "Times New Roman"]);
    expect(matchFonts(items, "zz")).toEqual([]);
  });
});
