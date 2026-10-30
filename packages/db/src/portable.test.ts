import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packages = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Follows value imports (type-only imports are erased) from an entry through relative files and @terno packages. */
function nodeImports(entry: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "transform" });
    for (const m of src.matchAll(/\b(?:import|export)\s+[^"';]*?from\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g)) {
      const spec = (m[1] ?? m[2] ?? m[3])!;
      if (spec.startsWith("node:")) found.push(`${file.slice(packages.length + 1)} → ${spec}`);
      else if (spec.startsWith(".")) visit(resolveFile(join(dirname(file), spec)));
      else if (spec.startsWith("@terno/")) {
        const [, pkg, ...sub] = spec.split("/");
        const manifest = JSON.parse(readFileSync(join(packages, pkg!, "package.json"), "utf8")) as { exports: Record<string, string> };
        visit(join(packages, pkg!, manifest.exports[sub.length ? `./${sub.join("/")}` : "."]!));
      }
    }
  };
  visit(entry);
  return found;
}

function resolveFile(base: string): string {
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  throw new Error(`cannot resolve ${base}`);
}

it("the portable layers (core, store contracts, db without the node driver, the backend and providers the web worker hosts) import no node: modules", () => {
  expect(nodeImports(join(packages, "db/src/portable.ts"))).toEqual([]);
  expect(nodeImports(join(packages, "db/src/wasm.ts"))).toEqual([]);
  expect(nodeImports(join(packages, "store/src/index.ts"))).toEqual([]);
  expect(nodeImports(join(packages, "store/src/instant/index.ts"))).toEqual([]);
  expect(nodeImports(join(packages, "backend/src/portable.ts"))).toEqual([]);
  expect(nodeImports(join(packages, "mail/src/portable.ts"))).toEqual([]);
  expect(nodeImports(join(packages, "idb/src/index.ts"))).toEqual([]);
});

it("the scan sees through to the node driver", () => {
  expect(nodeImports(join(packages, "db/src/index.ts"))).toContain("db/src/node-driver.ts → node:sqlite");
  expect(nodeImports(join(packages, "backend/src/index.ts"))).toContain("backend/src/backend.ts → node:dns/promises");
});

it("follows runtime imports but not erased inline import types", () => {
  const root = mkdtempSync(join(tmpdir(), "terno-portable-"));
  const entry = join(root, "entry.ts");
  const scan = (source: string) => { writeFileSync(entry, source); return nodeImports(entry); };
  try {
    writeFileSync(join(root, "native.ts"), 'import { Readable } from "node:stream"; export { Readable };');
    expect.soft(scan('type P = import("./native").Readable; export interface Q { p: import("./native").Readable }')).toEqual([]);
    expect.soft(scan('import type { Readable } from "./native"; export type { Readable } from "./native";')).toEqual([]);
    expect.soft(scan('export { ProviderError } from "@terno/mail/portable";')).toEqual([]);
    expect.soft(scan('export { ProviderError } from "@terno/mail";')).toContain("mail/src/compose.ts → node:stream");
    for (const source of [
      'import { Readable } from "./native"; void Readable;',
      'import { Readable } from "./native"; type T = Readable;',
      'export { Readable } from "./native";',
      'export * from "./native";',
      'void import("./native");',
      'import "./native";',
      'import { type Readable } from "./native";',
    ]) expect.soft(scan(source), source).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
