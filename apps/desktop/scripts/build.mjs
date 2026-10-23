// Bundles every process into self-contained CommonJS so the packaged app needs
// no node_modules at all (no native modules either: SQLite is node:sqlite).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "dist");
const repo = join(root, "..", "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: false,
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  // every node builtin (incl. node:sqlite, which esbuild may not know) stays external
  external: ["electron", "node:*"],
  define: { "process.env.UNICA_BUILD_VERSION": JSON.stringify(version) },
  // ESM deps that read import.meta.url get a CJS-compatible value
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
};

const entries = [
  { in: join(root, "src/main.ts"), out: "main" },
  { in: join(root, "src/backend-entry.ts"), out: "backend" },
  { in: join(root, "src/preload.ts"), out: "preload" },
  { in: join(repo, "packages/mcp/src/bin.ts"), out: "mcp/unica-mcp" },
];

const results = await Promise.all(
  entries.map((e) =>
    build({
      ...common,
      // the sandboxed preload can only require "electron" (and tiny polyfills): no banner
      ...(e.out === "preload" ? { banner: {} } : {}),
      entryPoints: { [e.out]: e.in },
      outdir: out,
      outExtension: { ".js": ".cjs" },
      metafile: true,
      define: { ...common.define, "import.meta.url": "__importMetaUrl" },
    }),
  ),
);

// Guard: nothing but electron and node builtins may be left as runtime requires.
for (const r of results) {
  for (const [file, meta] of Object.entries(r.metafile.outputs)) {
    for (const imp of meta.imports) {
      if (imp.external && !(imp.path === "electron" || imp.path.startsWith("node:") || /^[a-z_]+$/.test(imp.path))) {
        throw new Error(`${file} still requires "${imp.path}" at runtime`);
      }
    }
  }
}

const web = join(repo, "apps/web/dist");
if (!existsSync(join(web, "index.html"))) throw new Error("apps/web/dist missing: run `pnpm --filter @unica/web build` first");
cpSync(web, join(out, "renderer"), { recursive: true });
cpSync(join(repo, "packages/mcp/SKILL.md"), join(out, "mcp/SKILL.md"));
console.log(`built desktop bundles → ${out}`);
