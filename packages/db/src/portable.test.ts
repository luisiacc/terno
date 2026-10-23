import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packages = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Follows value imports (type-only imports are erased) from an entry through relative files and @unica packages. */
function nodeImports(entry: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)(?!\s+type\b)[^"';]*?from\s+"([^"]+)"|import\("([^"]+)"\)/gm)) {
      const spec = (m[1] ?? m[2])!;
      if (spec.startsWith("node:")) found.push(`${file.slice(packages.length + 1)} → ${spec}`);
      else if (spec.startsWith(".")) visit(resolveFile(join(dirname(file), spec)));
      else if (spec.startsWith("@unica/")) {
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
});

it("the scan sees through to the node driver", () => {
  expect(nodeImports(join(packages, "db/src/index.ts"))).toContain("db/src/node-driver.ts → node:sqlite");
  expect(nodeImports(join(packages, "backend/src/index.ts"))).toContain("backend/src/backend.ts → node:dns/promises");
});
