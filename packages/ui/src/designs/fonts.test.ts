/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Plan 15: the designs' faces are bundled. Nothing points at a font service,
 * and every face the stylesheet imports resolves to local files.
 */
const require = createRequire(import.meta.url);
const globals = readFileSync(join(import.meta.dirname, "../styles/globals.css"), "utf8");
const imports = [...globals.matchAll(/@import "(@fontsource[^"]+)";/g)].map((m) => m[1]!);

describe("bundled fonts", () => {
  it("imports Geist, Figtree, Instrument Sans and Instrument Serif (normal and italic)", () => {
    expect(imports).toEqual([
      "@fontsource-variable/geist",
      "@fontsource-variable/geist-mono",
      "@fontsource-variable/figtree",
      "@fontsource-variable/instrument-sans",
      "@fontsource/instrument-serif/400.css",
      "@fontsource/instrument-serif/400-italic.css",
    ]);
  });

  it.each(imports)("%s: local woff2 files only, latin subsets with a unicode-range, nothing remote", (spec) => {
    const css = readFileSync(require.resolve(spec.endsWith(".css") ? spec : `${spec}/index.css`), "utf8");
    expect(css).not.toMatch(/https?:|fonts\.googleapis|fonts\.gstatic|@import/);
    const faces = css.split("@font-face").slice(1);
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face).toMatch(/src: url\(\.\/files\/[\w-]+\.woff2\)/);
      expect(face).toMatch(/unicode-range:/);
      // swap: text is never invisible while a face loads (plan 15, R7)
      expect(face).toMatch(/font-display: swap/);
    }
    // Spanish (á é ñ ¿ ¡ « ») is inside the latin subset: U+0000-00FF
    expect(css).toMatch(/unicode-range: U\+0000-00FF/);
  });
});
