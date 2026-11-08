/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FLOAT_INSET } from "@terno/ui/lib/float-inset";
import { READ_MAX_CSS } from "./pane-lines";

/** Plan 160: the shared lines are tokens, used by name; no component writes the arithmetic again. */
const ROOT = join(import.meta.dirname, "../../../..");
const GLOBALS = readFileSync(join(ROOT, "packages/ui/src/styles/globals.css"), "utf8");

function sources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const dir of ["apps/web/src", "packages/ui/src/components"]) {
    for (const f of readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })) {
      if (!/\.(tsx?|css)$/.test(f) || /\.test\.tsx?$/.test(f)) continue;
      const rel = relative(ROOT, join(ROOT, dir, f));
      if (rel === "apps/web/src/lib/pane-lines.ts") continue;
      out.push({ rel, text: readFileSync(join(ROOT, dir, f), "utf8") });
    }
  }
  return out;
}

describe("the shared lines (plan 160)", () => {
  it("the tokens script reads agree with globals.css", () => {
    // the frame's document is in the body type: 35em there is 35 of its size here
    expect(READ_MAX_CSS).toBe("35em");
    expect(GLOBALS).toContain("--read-max: calc(35 * var(--type-body-size));");
    expect(GLOBALS).toContain(`--float-inset: ${FLOAT_INSET}px;`);
  });

  it("no component repeats the reading column, the measure or the pane's top row", () => {
    const hits: string[] = [];
    for (const { rel, text } of sources()) {
      text.split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/max-w-\(--reader-max\)\s+px-\(--reader-pad-x\)/.test(line)) hits.push(`${rel}:${i + 1} the reading column: use READING_COLUMN`);
        if (/\b35em\b/.test(line)) hits.push(`${rel}:${i + 1} the measure: use READ_MEASURE or --read-max`);
        if (/h-\[52px\]/.test(line)) hits.push(`${rel}:${i + 1} the pane's top row: use h-(--pane-bar)`);
        if (/--reader-col\b/.test(line)) hits.push(`${rel}:${i + 1} one reading column: --reader-col is gone`);
      });
    }
    expect(hits).toEqual([]);
  });
});
