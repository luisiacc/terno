/** Plan 252: which icons fill the disc, and the box each is drawn by. */
import { describe, expect, it } from "vitest";
import { classify, FIT_PX, WHOLE } from "./icon-fit";

const N = FIT_PX;
type Rgba = [number, number, number, number];
const CLEAR: Rgba = [0, 0, 0, 0];

/** An N × N image painted pixel by pixel (by pixel centers). */
function paint(at: (x: number, y: number) => Rgba): Uint8ClampedArray {
  const out = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out.set(at(x + 0.5, y + 0.5), (y * N + x) * 4);
  return out;
}
const circle = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r;
/** a square of side s at (x0, y0) with corners of radius k */
const rounded = (x0: number, y0: number, s: number, k: number) => (x: number, y: number) => {
  if (x < x0 || y < y0 || x > x0 + s || y > y0 + s) return false;
  const dx = Math.max(x0 + k - x, x - (x0 + s - k), 0);
  const dy = Math.max(y0 + k - y, y - (y0 + s - k), 0);
  return Math.hypot(dx, dy) <= k;
};
const BLUE: Rgba = [10, 102, 194, 255];
const WHITE: Rgba = [255, 255, 255, 255];

describe("classify", () => {
  it("a circle fills the disc", () => {
    const fit = classify(paint((x, y) => (circle(24, 24, 24)(x, y) ? BLUE : CLEAR)), N);
    expect(fit).toEqual({ fill: true, ring: false, box: [0, 0, 1, 1] });
  });

  it("a circle inside its own padding: the box is the circle", () => {
    const fit = classify(paint((x, y) => (circle(24, 24, 16)(x, y) ? BLUE : CLEAR)), N);
    expect(fit.fill).toBe(true);
    expect(fit.box).toEqual([8 / N, 8 / N, 32 / N, 32 / N]);
  });

  it("a full-bleed square and a rounded one, their mark in the middle, fill", () => {
    const mark = circle(24, 24, 10);
    expect(classify(paint((x, y) => (mark(x, y) ? WHITE : BLUE)), N).fill).toBe(true);
    const tile = rounded(4, 4, 40, 9);
    const fit = classify(paint((x, y) => (mark(x, y) ? WHITE : tile(x, y) ? BLUE : CLEAR)), N);
    expect(fit.fill).toBe(true);
    expect(fit.box).toEqual([4 / N, 4 / N, 40 / N, 40 / N]);
  });

  it("a square whose mark reaches its corners stays a mark (a crop would cut it)", () => {
    const fit = classify(paint((x, y) => (x > 3 && x < 14 && y > 3 && y < 14 ? WHITE : BLUE)), N);
    expect(fit.fill).toBe(false);
    expect(fit.box).toEqual([0, 0, 1, 1]);
  });

  it("a rounded tile on a gradient fills: its corners are background, however far the gradient goes (Codex review)", () => {
    const tile = rounded(0, 0, 48, 10);
    const mark = circle(24, 24, 10);
    const fit = classify(paint((x, y) => (mark(x, y) ? WHITE : tile(x, y) ? [Math.round(40 + x * 4), 60, Math.round(240 - y * 4), 255] : CLEAR)), N);
    expect(fit.fill).toBe(true);
  });

  it("a transparent glyph is a mark, trimmed to what it draws", () => {
    // a ring, like a "G" or a knot: holes inside the circle
    const fit = classify(paint((x, y) => (circle(24, 24, 18)(x, y) && !circle(24, 24, 11)(x, y) ? BLUE : CLEAR)), N);
    expect(fit).toEqual({ fill: false, ring: false, box: [6 / N, 6 / N, 36 / N, 36 / N] });
  });

  it("a wide logo is a mark", () => {
    const fit = classify(paint((x, y) => (y > 16 && y < 32 ? BLUE : CLEAR)), N);
    expect(fit.fill).toBe(false);
    expect(fit.box).toEqual([0, 16 / N, 1, 16 / N]);
  });

  it("a white tile or a black disc gets a hairline; a colored one doesn't", () => {
    const mark = circle(24, 24, 8);
    expect(classify(paint((x, y) => (mark(x, y) ? BLUE : WHITE)), N)).toMatchObject({ fill: true, ring: true });
    expect(classify(paint((x, y) => (circle(24, 24, 24)(x, y) ? [0, 0, 0, 255] : CLEAR)), N)).toMatchObject({ fill: true, ring: true });
    expect(classify(paint((x, y) => (mark(x, y) ? WHITE : BLUE)), N).ring).toBe(false);
  });

  it("an empty image is the whole image as a mark", () => {
    expect(classify(paint(() => CLEAR), N)).toBe(WHOLE);
  });
});
