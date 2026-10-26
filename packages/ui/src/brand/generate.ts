/**
 * Plan 19: every file derived from the logo in brand/, as text. The CLI
 * (scripts/gen-brand.ts, `pnpm brand`) writes these and rasterizes the
 * images; a test compares the checked-in files with what this returns.
 * Pure: no file system, so the test runs it as is.
 */

import { DEFAULT_DESIGN } from "@terno/core";
import { designById } from "../designs/index";
import { toHex } from "../themes/color";
import { builtinTheme } from "../themes/registry";

export interface Shape {
  tag: "rect" | "path";
  attrs: Record<string, string>;
}

export interface ParsedSvg {
  attrs: Record<string, string>;
  shapes: Shape[];
}

/** The icon, by role: the tile, the solid T over it, the translucent envelope under it. */
export interface IconParts {
  /** the viewBox side (100) */
  size: number;
  tile: { fill: string; rx: number };
  primary: Shape[];
  secondary: Shape[];
}

/** The source files, by name in brand/ */
export type Sources = Record<string, string>;

export const SOURCE_FILES = ["terno-icon.svg", "terno-mark-blue.svg", "terno-mark-white.svg", "terno-wordmark.svg", "terno-lockup.svg", "terno-lockup-white.svg"] as const;
/** what the generated files are drawn from (the wordmark and lockups are used as they are, by the README) */
export const DERIVED_FROM = ["terno-icon.svg", "terno-mark-blue.svg"] as const;

const attrsOf = (s: string): Record<string, string> => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));

/** Flat SVGs only (rects and paths in the root): anything else is a different logo, and must fail rather than draw wrong. */
export function parseSvg(svg: string): ParsedSvg {
  const root = /^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (!root) throw new Error("not a single <svg> element");
  const body = root[2]!;
  const shapes: Shape[] = [];
  const rest = body.replace(/<(rect|path)\b([^>]*?)\/>/g, (_, tag: string, attrs: string) => {
    shapes.push({ tag: tag as Shape["tag"], attrs: attrsOf(attrs) });
    return "";
  });
  if (rest.trim()) throw new Error(`unsupported SVG content: ${rest.trim().slice(0, 80)}`);
  return { attrs: attrsOf(root[1]!), shapes };
}

const opacityOf = (s: Shape): number => Number(s.attrs["stroke-opacity"] ?? s.attrs["fill-opacity"] ?? s.attrs.opacity ?? 1);

export function iconParts(svg: string): IconParts {
  const { attrs, shapes } = parseSvg(svg);
  const [x, y, w, h] = (attrs.viewBox ?? "").split(/\s+/).map(Number);
  if (x !== 0 || y !== 0 || !w || w !== h) throw new Error(`the icon's viewBox must be a square at 0 0, got "${attrs.viewBox}"`);
  const [tile, ...mark] = shapes;
  if (!tile || tile.tag !== "rect" || Number(tile.attrs.width) !== w || Number(tile.attrs.height) !== h || !tile.attrs.fill) throw new Error("the icon's first shape must be its tile: a filled rect covering the viewBox");
  const primary = mark.filter((s) => opacityOf(s) === 1);
  const secondary = mark.filter((s) => opacityOf(s) < 1);
  if (!primary.length || !secondary.length) throw new Error("the icon needs solid shapes (the T) and translucent ones (the envelope)");
  return { size: w, tile: { fill: tile.attrs.fill, rx: Number(tile.attrs.rx ?? 0) }, primary, secondary };
}

const num = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Apple's continuous-corner rounded rectangle (the iOS 7 / Big Sur icon
 * shape): each corner is three cubic curves reaching 1.528 r along its edges,
 * not a circular arc. Coefficients from PaintCode's reconstruction of UIKit's.
 */
export function continuousRect(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.min(radius, Math.min(w, h) / 2 / 1.52866483);
  // one corner, as (distance back along the edge arriving at it, distance in along the next edge)
  const corner: [string, ...[number, number][]][] = [
    ["L", [1.52866471, 0]],
    ["C", [1.08849323, 0], [0.86840689, 0], [0.66993427, 0.065496]],
    ["L", [0.63149399, 0.074911]],
    ["C", [0.37282392, 0.16905899], [0.16906013, 0.37282401], [0.07491176, 0.63149399]],
    ["L", [0.06549569, 0.66993493]],
    ["C", [0, 0.86840701], [0, 1.08849299], [0, 1.52866483]],
  ];
  const right = x + w;
  const bottom = y + h;
  const at: ((u: number, v: number) => [number, number])[] = [
    (u, v) => [right - u * r, y + v * r], // top right, arriving along the top edge
    (u, v) => [right - v * r, bottom - u * r], // bottom right, along the right edge
    (u, v) => [x + u * r, bottom - v * r], // bottom left, along the bottom edge
    (u, v) => [x + v * r, y + u * r], // top left, along the left edge
  ];
  let d = `M${num(x + 1.52866483 * r)} ${num(y)}`;
  for (const map of at) for (const [cmd, ...pts] of corner) d += cmd + pts.map(([u, v]) => map(u, v).map(num).join(" ")).join(" ");
  return `${d}Z`;
}

const shapeXml = (s: Shape, override: Record<string, string> = {}): string => {
  const attrs = { ...s.attrs, ...override };
  return `<${s.tag} ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}/>`;
};

/** the mark's shapes in the icon's own units, envelope first (it is drawn under the T) */
const markXml = (p: IconParts): string => [...p.secondary, ...p.primary].map((s) => shapeXml(s)).join("");

/** Apple's macOS icon grid: the body is 824 × 824 of the 1024 canvas, corner radius 185.4. */
export const MAC_GRID = { canvas: 1024, body: 824, radius: 185.4 } as const;

/** The macOS app icon on Apple's grid, with the template's soft shadow in the margin. */
export function macIconSvg(p: IconParts): string {
  const { canvas, body, radius } = MAC_GRID;
  const inset = (canvas - body) / 2;
  const d = continuousRect(inset, inset, body, body, radius);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">`,
    `<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="125%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="black" flood-opacity="0.3"/></filter></defs>`,
    `<path d="${d}" fill="${p.tile.fill}" filter="url(#shadow)"/>`,
    `<g transform="translate(${inset} ${inset}) scale(${num(body / p.size)})">${markXml(p)}</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

/** A full-bleed square (no corners: iOS and Android mask it), the mark scaled about the center. */
export function squareIconSvg(p: IconParts, scale: number): string {
  const c = p.size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 ${p.size} ${p.size}"><rect width="${p.size}" height="${p.size}" fill="${p.tile.fill}"/><g transform="translate(${c} ${c}) scale(${scale}) translate(${-c} ${-c})">${markXml(p)}</g></svg>\n`;
}

/** "#2F5BFF" → "srgb:0.18431,0.35686,1.00000,1.00000" (Icon Composer's color notation) */
export function iconComposerColor(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`expected #rrggbb, got ${hex}`);
  return `srgb:${[m[1], m[2], m[3]].map((c) => (parseInt(c!, 16) / 255).toFixed(5)).join(",")},1.00000`;
}

const layerSvg = (p: IconParts, shapes: Shape[]): string => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 ${p.size} ${p.size}">${shapes.map((s) => shapeXml(s)).join("")}</svg>\n`;

/**
 * The Icon Composer document macOS 26 draws with Liquid Glass: the tile's
 * color as the fill, the T over the envelope as two layers on the full
 * canvas (the system masks the canvas to its shape and makes the dark,
 * clear and tinted appearances from it).
 */
export function iconComposer(p: IconParts): Record<string, string> {
  const json = {
    fill: { solid: iconComposerColor(p.tile.fill) },
    groups: [
      {
        // front to back
        layers: [
          { "image-name": "t.svg", name: "T" },
          { "image-name": "envelope.svg", name: "Envelope" },
        ],
        shadow: { kind: "neutral", opacity: 0.5 },
        translucency: { enabled: true, value: 0.5 },
      },
    ],
    "supported-platforms": { circles: ["watchOS"], squares: "shared" },
  };
  return {
    "icon.json": `${JSON.stringify(json, null, 2)}\n`,
    "Assets/t.svg": layerSvg(p, p.primary),
    "Assets/envelope.svg": layerSvg(p, p.secondary),
  };
}

const camel = (k: string): string => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** The mark for the UI: its geometry with every color as currentColor, as a TypeScript module. */
export function markModule(markSvg: string): string {
  const { attrs, shapes } = parseSvg(markSvg);
  const props = shapes.map((s) => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(s.attrs)) {
      out[camel(k)] = (k === "fill" || k === "stroke") && v !== "none" ? "currentColor" : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    return { tag: s.tag, props: out };
  });
  return [
    "// Generated from brand/terno-mark-blue.svg by `pnpm brand`. Do not edit.",
    `export const MARK_VIEWBOX = ${JSON.stringify(attrs.viewBox)};`,
    "",
    `export const MARK_SHAPES = ${JSON.stringify(props, null, 2)} as const;`,
    "",
  ].join("\n");
}

/** Where each output goes, relative to the repo root. */
export const OUT = {
  macSvg: "apps/desktop/resources/icon.svg",
  macPng: "apps/desktop/resources/icon.png",
  icns: "apps/desktop/resources/icon.icns",
  iconComposer: "apps/desktop/resources/icon.icon",
  assetsCar: "apps/desktop/resources/Assets.car",
  public: "apps/web/public",
  mark: "packages/ui/src/brand/mark.generated.ts",
  manifest: "brand/generated.json",
} as const;

/** The web's icons: file in public/ → what it draws, at which size. */
export const WEB_ICONS = {
  "favicon-32.png": { size: 32, art: "tile" },
  "apple-touch-icon.png": { size: 180, art: "square" },
  "icon-192.png": { size: 192, art: "tile" },
  "icon-512.png": { size: 512, art: "tile" },
  "icon-maskable-512.png": { size: 512, art: "maskable" },
} as const;

/** the iconset iconutil turns into an .icns: name → pixels */
export const ICONSET: Record<string, number> = {
  "icon_16x16.png": 16,
  "icon_16x16@2x.png": 32,
  "icon_32x32.png": 32,
  "icon_32x32@2x.png": 64,
  "icon_128x128.png": 128,
  "icon_128x128@2x.png": 256,
  "icon_256x256.png": 256,
  "icon_256x256@2x.png": 512,
  "icon_512x512.png": 512,
  "icon_512x512@2x.png": 1024,
};

/** the maskable icon's mark scale: inside the 80 % safe circle with room to spare */
export const MASKABLE_SCALE = 0.85;

/** Every text output, by path from the repo root. */
export function textOutputs(src: Sources): Record<string, string> {
  const icon = src["terno-icon.svg"]!;
  const p = iconParts(icon);
  const out: Record<string, string> = {
    [OUT.macSvg]: macIconSvg(p),
    [`${OUT.public}/favicon.svg`]: icon,
    [OUT.mark]: markModule(src["terno-mark-blue.svg"]!),
    [`${OUT.public}/manifest.webmanifest`]: webManifest(),
  };
  for (const [name, text] of Object.entries(iconComposer(p))) out[`${OUT.iconComposer}/${name}`] = text;
  return out;
}

/** The default design's palette backgrounds: the browser's theme color in light and dark. */
export function themeColors(): { light: string; dark: string } {
  const { palette } = designById(DEFAULT_DESIGN);
  const bg = (id: string) => toHex(builtinTheme(id)!.tokens.background);
  return { light: bg(palette.light), dark: bg(palette.dark) };
}

/** The web app manifest (served by both builds; only the web build links it). */
export function webManifest(): string {
  const { light } = themeColors();
  const icon = (src: string, size: number, purpose?: string) => ({ src, sizes: `${size}x${size}`, type: "image/png", ...(purpose ? { purpose } : {}) });
  const manifest = {
    name: "Terno",
    short_name: "Terno",
    start_url: "./",
    display: "standalone",
    background_color: light,
    theme_color: light,
    lang: "en",
    icons: [icon("icon-192.png", 192), icon("icon-512.png", 512), icon("icon-maskable-512.png", 512, "maskable")],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The art each raster is drawn from. */
export function rasterArt(src: Sources): Record<"tile" | "square" | "maskable" | "mac", string> {
  const p = iconParts(src["terno-icon.svg"]!);
  return { tile: src["terno-icon.svg"]!, square: squareIconSvg(p, 1), maskable: squareIconSvg(p, MASKABLE_SCALE), mac: macIconSvg(p) };
}

/** The binary outputs the manifest pins, by path from the repo root. */
export const BINARY_OUTPUTS: readonly string[] = [OUT.macPng, OUT.icns, OUT.assetsCar, ...Object.keys(WEB_ICONS).map((f) => `${OUT.public}/${f}`)];
