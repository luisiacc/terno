/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { generateThemesCss } from "./generate";
import { THEMES } from "./registry";

const file = join(import.meta.dirname, "../styles/themes.generated.css");

describe("generated theme CSS", () => {
  it("is up to date with the registry (run `pnpm --filter @terno/ui gen:themes`)", () => {
    expect(readFileSync(file, "utf8")).toBe(generateThemesCss());
  });

  it("has one block per theme and :root falls back to Terno claro", () => {
    const css = generateThemesCss();
    for (const t of THEMES) expect(css).toContain(`[data-theme="${t.id}"] {`);
    expect(css).toMatch(/^:root,\n\[data-theme="terno-light"\] \{/m);
    expect(css.match(/color-scheme: dark;/g)).toHaveLength(9);
  });

  it("stays small: ≤ 8 KB gzip", () => {
    expect(gzipSync(readFileSync(file)).length).toBeLessThanOrEqual(8 * 1024);
  });

  it("is imported by globals.css, which no longer hard-codes theme values", () => {
    const globals = readFileSync(join(import.meta.dirname, "../styles/globals.css"), "utf8");
    expect(globals).toContain('@import "./themes.generated.css";');
    expect(globals).not.toMatch(/--background:\s*oklch/);
    expect(globals).not.toMatch(/^\.dark\s*\{/m);
  });
});
