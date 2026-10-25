/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Plan 15: sizes, families and radii come from the design (the shared scale,
 * the radius ladder, the type roles), so no surface silently ignores it. Raw
 * pixel radii above 4 px and font families are refused in app and UI code;
 * pixel text sizes only for the few fixed-purpose micro labels below.
 */
const ROOT = join(import.meta.dirname, "../../../..");
const SCANNED = ["packages/ui/src", "apps/web/src"];
const EXEMPT = [/\/designs\//, /\/themes\//, /\.test\.tsx?$/, /\.generated\.css$/];

/** file → pixel text sizes it may use, and why */
const TEXT_PX: Record<string, string[]> = {
  // the 7 px file type on an attachment's glyph, the 10 px "auto" mark and suggestion key
  "apps/web/src/components/reader.tsx": ["7px", "10px"],
  // the initials in the 22 px avatar of the quick reply bar; the 10 px quote toggle
  "apps/web/src/components/inline-draft.tsx": ["9.5px", "10px"],
  // the Style cards' mini-mocks (a picture of a window, not text to read)
  "apps/web/src/components/settings/appearance-tab.tsx": ["8px", "13px"],
  // the print preview draws the document at its own scale
  "apps/web/src/components/print-sheet.tsx": ["12.5px"],
  // the HTML mail blocked-content note matches the mail's own size
  "apps/web/src/components/mail-body.tsx": ["11.5px"],
  // the report preview is a monospace dump
  "apps/web/src/components/diag/report-preview.tsx": ["11px"],
};

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((f) => /\.(tsx?|css)$/.test(f) && !EXEMPT.some((re) => re.test(f)));
}

function scan(): string[] {
  const hits: string[] = [];
  for (const dir of SCANNED) {
    for (const file of files(dir)) {
      const rel = relative(ROOT, join(ROOT, file));
      readFileSync(join(ROOT, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          for (const m of line.matchAll(/rounded(?:-[a-z]{1,2})?-\[(\d+(?:\.\d+)?)px\]/g)) if (Number(m[1]) > 4) hits.push(`${rel}:${i + 1} radius ${m[0]}: use the ladder (rounded-md…) or calc() on it`);
          for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?px)\]/g)) if (!TEXT_PX[rel]?.includes(m[1]!)) hits.push(`${rel}:${i + 1} text size ${m[0]}: use the scale (text-xs…) or a type role`);
          for (const m of line.matchAll(/font-\[(?:family-name:)?[^\]]*\]|font-family:/g)) hits.push(`${rel}:${i + 1} font family ${m[0]}: use font-sans, font-mono or a type role`);
        });
    }
  }
  return hits;
}

describe("designs reach every surface (plan 15)", () => {
  it("no raw pixel radii above 4 px, font families or unlisted pixel text sizes outside designs", () => {
    expect(scan()).toEqual([]);
  });
});
