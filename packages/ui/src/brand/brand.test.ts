/// <reference types="node" />
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINARY_OUTPUTS, DERIVED_FROM, ICONSET, MAC_GRID, OUT, SOURCE_FILES, WEB_ICONS, continuousRect, iconParts, parseSvg, rasterRecipe, textOutputs, themeColors, type Shape } from "./generate";
import { MARK_SHAPES } from "./mark.generated";

const ROOT = join(import.meta.dirname, "../../../..");
const read = (rel: string) => readFileSync(join(ROOT, rel));
const src = Object.fromEntries(SOURCE_FILES.map((f) => [f, read(`brand/${f}`).toString("utf8")]));
const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");
const manifest = JSON.parse(read(OUT.manifest).toString("utf8")) as { actool: string; recipe: string; sources: Record<string, string>; outputs: Record<string, string> };

/** a PNG's width and height, from its IHDR */
const pngSize = (buf: Buffer): [number, number] => {
  expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
};

describe("brand assets are what `pnpm brand` makes of brand/ (plan 19)", () => {
  it("every text output is up to date", () => {
    for (const [rel, text] of Object.entries(textOutputs(src))) expect(read(rel).toString("utf8"), rel).toBe(text);
  });

  it("the images were drawn from today's sources, and nobody edited them since", () => {
    expect(Object.keys(manifest.sources).sort()).toEqual(DERIVED_FROM.map((f) => `brand/${f}`).sort());
    for (const [rel, hash] of Object.entries(manifest.sources)) expect(sha(read(rel)), `${rel} changed: run \`pnpm brand\``).toBe(hash);
    expect(Object.keys(manifest.outputs).sort()).toEqual([...BINARY_OUTPUTS].sort());
    for (const [rel, hash] of Object.entries(manifest.outputs)) expect(sha(read(rel)), `${rel} differs from what \`pnpm brand\` wrote`).toBe(hash);
    expect(parseInt(manifest.actool)).toBeGreaterThanOrEqual(26);
    // how they are drawn (grid, scales, sizes, the Icon Composer document) is pinned too, not just what from
    expect(sha(rasterRecipe(src)), "the drawing recipe changed: run `pnpm brand`").toBe(manifest.recipe);
  });

  it("each web icon has the size it claims", () => {
    for (const [file, { size }] of Object.entries(WEB_ICONS)) expect(pngSize(read(`${OUT.public}/${file}`)), file).toEqual([size, size]);
    expect(pngSize(read(OUT.macPng))).toEqual([1024, 1024]);
    expect(Object.values(ICONSET).sort((a, b) => a - b)).toEqual([16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]);
  });
});

describe("the logo's sources", () => {
  /** geometry only: the variants differ in color, opacity and viewBox by design */
  const geometry = (shapes: Shape[]) => shapes.map((s) => ({ tag: s.tag, ...Object.fromEntries(Object.entries(s.attrs).filter(([k]) => !/fill|stroke$|opacity/.test(k))) }));
  const icon = iconParts(src["terno-icon.svg"]!);
  const mark = geometry([...icon.secondary, ...icon.primary]);

  it("the icon splits into its tile, the solid T and the translucent envelope", () => {
    expect(icon.size).toBe(100);
    expect(icon.tile.fill).toMatch(/^#[0-9A-F]{6}$/i);
    expect(icon.primary.map((s) => s.tag)).toEqual(["rect", "rect"]);
    expect(icon.secondary.map((s) => s.tag)).toEqual(["rect", "path"]);
  });

  it("every variant draws the same mark, so no surface shows an older one", () => {
    for (const f of ["terno-mark-blue.svg", "terno-mark-white.svg"]) expect(geometry(parseSvg(src[f]!).shapes), f).toEqual(mark);
    for (const f of ["terno-lockup.svg", "terno-lockup-white.svg"]) expect(geometry(parseSvg(src[f]!).shapes.slice(1, 5)), f).toEqual(mark);
    expect(MARK_SHAPES.map((s) => s.tag)).toEqual(mark.map((s) => s.tag));
    // the UI's mark is all currentColor: the design colors it
    for (const s of MARK_SHAPES) for (const [k, v] of Object.entries(s.props)) if (k === "fill" || k === "stroke") expect(["none", "currentColor"]).toContain(v);
  });

  it("a logo of another structure fails instead of drawing wrong", () => {
    expect(() => parseSvg(`<svg viewBox="0 0 100 100"><g><rect width="100" height="100"/></g></svg>`)).toThrow(/unsupported/);
    expect(() => iconParts(`<svg viewBox="0 0 100 100"><rect x="18" y="28" width="64" height="12" fill="#FFFFFF"/></svg>`)).toThrow(/tile/);
    expect(() => iconParts(`<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#2F5BFF"/><rect x="18" y="28" width="64" height="12" fill="#FFFFFF"/></svg>`)).toThrow(/translucent/);
  });
});

describe("the macOS icon shape", () => {
  const points = (d: string) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

  it("is Apple's continuous-corner square, inside its box and symmetric", () => {
    const { canvas, body, radius } = MAC_GRID;
    const inset = (canvas - body) / 2;
    const d = continuousRect(inset, inset, body, body, radius);
    const n = points(d);
    const xs = n.filter((_, i) => i % 2 === 0);
    const ys = n.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBe(inset);
    expect(Math.max(...xs)).toBe(inset + body);
    expect(Math.min(...ys)).toBe(inset);
    expect(Math.max(...ys)).toBe(inset + body);
    // mirrored left to right: every x has its partner about the center
    const mirrored = new Set(xs.map((x) => Math.round((canvas - x) * 10)));
    for (const x of xs) expect(mirrored.has(Math.round(x * 10))).toBe(true);
    // the curve leaves the edge 1.528 r from the corner, not r as a circular corner would
    expect(d.startsWith(`M${Math.round((inset + 1.52866483 * radius) * 100) / 100} ${inset}`)).toBe(true);
  });

  it("the drawn icon sits on the grid: the body inset 100 px of 1024", () => {
    const svg = read(OUT.macSvg).toString("utf8");
    expect(svg).toContain(`viewBox="0 0 1024 1024"`);
    expect(svg).toContain(`translate(100 100) scale(8.24)`);
  });
});

describe("the web references what exists", () => {
  const html = read("apps/web/index.html").toString("utf8");

  it("index.html links icons in public/, and its theme colors are the default palettes' backgrounds", () => {
    const links = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="\.\/([^"]+)"(?: sizes="(\d+)x\d+")?/g)];
    expect(links.map((m) => m[1])).toEqual(["favicon-32.png", "favicon.svg", "apple-touch-icon.png"]);
    for (const [, file, size] of links) {
      expect(existsSync(join(ROOT, OUT.public, file!)), file).toBe(true);
      if (size) expect(pngSize(read(`${OUT.public}/${file}`))).toEqual([Number(size), Number(size)]);
    }
    expect(pngSize(read(`${OUT.public}/apple-touch-icon.png`))).toEqual([180, 180]);
    const { light, dark } = themeColors();
    expect(html).toContain(`<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)" />`);
    expect(html).toContain(`<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)" />`);
  });

  it("the manifest's icons exist at their sizes, one of them maskable", () => {
    const m = JSON.parse(read(`${OUT.public}/manifest.webmanifest`).toString("utf8")) as { icons: { src: string; sizes: string; purpose?: string }[]; theme_color: string };
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const i of m.icons) {
      const n = Number(i.sizes.split("x")[0]);
      expect(pngSize(read(`${OUT.public}/${i.src}`)), i.src).toEqual([n, n]);
    }
    expect(m.theme_color).toBe(themeColors().light);
  });
});
