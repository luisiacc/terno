/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * App and design-system code use tokens only: no literal colors, no literal
 * durations (everything runs on --motion), no translucent text (alpha text
 * can't be contrast-tested). The registry (src/themes) is the one place colors live.
 */
const ROOT = join(import.meta.dirname, "../../../..");
const SCANNED = ["packages/ui/src", "apps/web/src"];
const EXEMPT = [/\/themes\//, /\.test\.tsx?$/, /themes\.generated\.css$/];

const CODE_RULES: [string, RegExp][] = [
  ["hex color", /(?<![\w&/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/],
  ["color function", /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/],
  ["white/black utility", /\b(?:bg|text|border|ring|fill|stroke|outline|from|to|via|shadow|decoration|divide|caret)-(?:white|black)\b/],
  ["literal duration utility", /\b(?:duration|delay)-(?:\d|\[)/],
  ["translucent text", /\btext-(?:foreground|sidebar-foreground|popover-foreground|card-foreground|muted-foreground)\/\d/],
  ["WAAPI literal duration", /\.animate\([^)]*duration:\s*\d/],
  // glyphs and text at reduced opacity can't be contrast-tested: use muted-foreground (state variants like disabled: are fine)
  ["reduced opacity", /(?<![:\w\-[])opacity-(?:[1-9]\d?)\b/],
];
const CSS_RULES: [string, RegExp][] = [
  ["hex color", /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/],
  ["color function", /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/],
  // durations only where the motion variables are defined
  ["literal duration", /^(?!\s*--motion[\w-]*:).*\b\d+(?:\.\d+)?m?s\b/],
];

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((f) => /\.(tsx?|css)$/.test(f) && !EXEMPT.some((re) => re.test(f)));
}

function scan(paths: string[]): string[] {
  const hits: string[] = [];
  for (const file of paths) {
    const rules = file.endsWith(".css") ? CSS_RULES : CODE_RULES;
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const [name, re] of rules) if (re.test(line)) hits.push(`${relative(ROOT, join(ROOT, file))}:${i + 1} ${name}: ${line.trim().slice(0, 120)}`);
      });
  }
  return hits;
}

describe("no hard-coded colors or durations", () => {
  it.each(SCANNED)("%s uses tokens only", (dir) => {
    const list = files(dir);
    expect(list.length).toBeGreaterThan(5);
    expect(scan(list)).toEqual([]);
  });

  it("catches what it should", () => {
    const rules = CODE_RULES.map(([, re]) => re);
    const caught = (s: string) => rules.some((re) => re.test(s));
    for (const bad of ['className="bg-white"', "color: #1f2330", "bg-black/10", "duration-150", "delay-75", "text-foreground/80", "text-sidebar-foreground/50", "rgb(0 0 0)", "el.animate(k, { duration: 200 })", 'className="opacity-70"', "<X className=\"size-3 opacity-60\" />"]) expect(caught(bad), bad).toBe(true);
    for (const ok of ['keys: "g #"', "duration-fast", "bg-overlay", "text-muted-foreground", "toast(x, { duration: 8000 })", "border-border/60", "disabled:opacity-50", "hover:opacity-100", "opacity-0", "data-disabled:opacity-50"]) expect(caught(ok), ok).toBe(false);
  });
});
