// @vitest-environment jsdom
/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "./components/button";
import { ICONS } from "./iconset/catalog";
import { generateIcon, generateIndex } from "./iconset/generate";
import { Check, Star } from "./icons";

const SIZE = "[&_svg:not([class*='size-'])]:";

describe("icons (plan 92)", () => {
  it("generated modules are up to date (run `pnpm --filter @terno/ui gen:icons`)", () => {
    const dir = join(import.meta.dirname, "iconset");
    expect(readFileSync(join(import.meta.dirname, "icons.ts"), "utf8")).toBe(generateIndex());
    const names = Object.keys(ICONS) as (keyof typeof ICONS)[];
    expect(readdirSync(join(dir, "generated")).sort()).toEqual(names.map((n) => `${n}.ts`).sort());
    for (const n of names) expect(readFileSync(join(dir, "generated", `${n}.ts`), "utf8"), n).toBe(generateIcon(n));
  });

  it("one module per icon, its factory pure: a bundle keeps only the icons a chunk uses, in that chunk", () => {
    expect(generateIcon("Trash2")).toContain("export const Trash2 = /* @__PURE__ */ icon(Delete02Icon,");
    expect(generateIndex()).toContain('export { Trash2 } from "./iconset/generated/Trash2";');
  });

  it("draws an svg.icon whose shapes carry no stroke width of their own (the design's line reaches them)", () => {
    const html = renderToStaticMarkup(<Star className="size-3" />);
    expect(html).toMatch(/^<svg[^>]* class="icon size-3"/);
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/<path[^>]*>/g)!.every((p) => !p.includes("stroke-width"))).toBe(true);
    expect(renderToStaticMarkup(<Check aria-label="Done" />)).not.toContain("aria-hidden");
  });

  it("an icon beside a label follows the label's size; icon-only buttons keep their glyph", () => {
    for (const size of ["default", "xs", "sm", "lg"] as const) {
      const cls = buttonVariants({ size });
      expect(cls, size).toContain(`${SIZE}size-[1.15em]`);
      expect(cls, size).not.toMatch(/:size-(3|3\.5|4)(\s|$)/);
    }
    expect(buttonVariants({ size: "icon" })).toContain(`${SIZE}size-4`);
    expect(buttonVariants({ size: "icon-sm" })).toContain(`${SIZE}size-4`);
    expect(buttonVariants({ size: "icon-xs" })).toContain(`${SIZE}size-3`);
  });
});
