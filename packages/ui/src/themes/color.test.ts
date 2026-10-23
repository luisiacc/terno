import { describe, expect, it } from "vitest";
import { composite, contrast, formatOklch, inGamut, mixOklab, oklchToRgb, parseColor, parseHex, rgbToOklch, toHex } from "./color";

describe("color conversion", () => {
  it("converts sRGB references to oklch", () => {
    const white = rgbToOklch(parseHex("#fff"));
    expect(white.l).toBeCloseTo(1, 3);
    expect(white.c).toBeCloseTo(0, 3);
    const black = rgbToOklch(parseHex("#000"));
    expect(black.l).toBeCloseTo(0, 6);
    // CSS Color 4 reference: #ff0000 = oklch(62.8% 0.2577 29.23)
    const red = rgbToOklch(parseHex("#ff0000"));
    expect(red.l).toBeCloseTo(0.628, 3);
    expect(red.c).toBeCloseTo(0.258, 3);
    expect(red.h).toBeCloseTo(29.2, 1);
    const blue = parseColor("#0000ff");
    expect(blue.l).toBeCloseTo(0.452, 3);
    expect(blue.h).toBeCloseTo(264.05, 1);
  });

  it("round-trips oklch → sRGB → oklch inside the gamut", () => {
    for (const s of ["0.56 0.19 268", "0.99 0.002 85", "0.22 0.01 265", "0.7 0.1 215", "0.5 0.05 30"]) {
      const c = parseColor(s);
      expect(inGamut(c)).toBe(true);
      const back = rgbToOklch(oklchToRgb(c));
      expect(back.l).toBeCloseTo(c.l, 4);
      expect(back.c).toBeCloseTo(c.c, 4);
      if (c.c > 0.01) expect(back.h).toBeCloseTo(c.h, 1);
    }
    expect(toHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(toHex(parseColor("#4f46e5"))).toBe("#4f46e5");
  });

  it("clips out-of-gamut colors per channel", () => {
    const vivid = parseColor("0.7 0.4 145");
    expect(inGamut(vivid)).toBe(false);
    const rgb = oklchToRgb(vivid);
    for (const v of [rgb.r, rgb.g, rgb.b]) expect(v >= 0 && v <= 1).toBe(true);
  });

  it("parses every accepted syntax", () => {
    expect(parseColor("oklch(50% 0.1 200deg / 40%)")).toEqual({ l: 0.5, c: 0.1, h: 200, alpha: 0.4 });
    expect(parseColor("1 0 0 / 9%")).toEqual({ l: 1, c: 0, h: 0, alpha: 0.09 });
    expect(parseColor("#00000080").alpha).toBeCloseTo(0.502, 3);
    expect(() => parseColor("red")).toThrow();
    expect(formatOklch({ l: 0.5612345, c: 0.19, h: 268.04, alpha: 0.6 })).toBe("oklch(0.561 0.19 268 / 0.6)");
  });
});

describe("contrast", () => {
  it("matches WCAG references", () => {
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrast("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrast("#fff", "#fff")).toBeCloseTo(1, 5);
    // symmetric
    expect(contrast("#ffffff", "#777777")).toBeCloseTo(4.48, 2);
  });

  it("composites translucent colors over their backdrop", () => {
    const half = composite({ r: 0, g: 0, b: 0, alpha: 0.5 }, { r: 1, g: 1, b: 1, alpha: 1 });
    expect(half.r).toBeCloseTo(0.5, 6);
    expect(half.alpha).toBe(1);
    // a 9% white border over a dark background is barely different from it
    expect(contrast("1 0 0 / 9%", "0.17 0.006 265")).toBeLessThan(1.5);
    // translucent background: composited over the base first
    expect(contrast("#000", "0 0 0 / 0%", "#fff")).toBeCloseTo(21, 5);
  });

  it("mixes in OKLab", () => {
    const a = parseColor("0.7 0.12 10");
    const b = parseColor("0.2 0.01 265");
    const m = mixOklab(a, b, 0.4);
    expect(m.l).toBeCloseTo(0.5, 6);
    expect(mixOklab(a, b, 0)).toMatchObject({ l: a.l });
    expect(mixOklab(a, b, 1).l).toBeCloseTo(b.l, 6);
  });
});
