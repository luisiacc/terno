import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps full-message and section construction outside the static reader imports", () => {
  const body = readFileSync("apps/web/src/components/mail-body.tsx", "utf8");
  for (const path of ["mail-body.tsx", "reader.tsx", "mail-reader-view.tsx"]) {
    const source = readFileSync(`apps/web/src/components/${path}`, "utf8");
    const imports = [...source.matchAll(/^import\s+[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm)].map((match) => match[1]);
    expect(imports).not.toContain("./full-message");
    expect(imports).not.toContain("./mail-sections");
    expect(imports).not.toContain("./mail-graphic");
  }
  expect(body).toContain('lazy(() => import("./full-message"))');
});
