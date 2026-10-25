// Bundles every process into self-contained CommonJS so the packaged app needs
// no node_modules at all (no native modules either: SQLite is node:sqlite).
// Every bundle (main, backend, preload, MCP and the renderer) gets an external
// source map and a debug id; the maps then move to .maps/<version>-<sha>/,
// outside dist/ and release/, before anything is packaged or signed.
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
// TERNO_BUILD_OUT: a test build goes elsewhere, so dist/ (what dist:mac packages) is never a test build
const out = process.env.TERNO_BUILD_OUT || join(root, "dist");
const repo = join(root, "..", "..");
// TERNO_VERSION: a test build's own version (the update test builds two from one tree)
const version = process.env.TERNO_VERSION || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
/**
 * A test build's own world (its update feed, profile and app name), baked in
 * because Squirrel relaunches an updated app without our environment. JSON
 * in TERNO_TEST_BUILD; a release is built without it (release.mjs refuses).
 */
const testBuild = process.env.TERNO_TEST_BUILD ? JSON.parse(process.env.TERNO_TEST_BUILD) : undefined;
if (testBuild && !(typeof testBuild.feed === "string" && typeof testBuild.userData === "string" && typeof testBuild.appData === "string" && typeof testBuild.appName === "string")) {
  throw new Error("TERNO_TEST_BUILD needs feed, userData, appData and appName");
}
if (testBuild && !process.env.TERNO_BUILD_OUT) throw new Error("a test build needs TERNO_BUILD_OUT: dist/ is what dist:mac packages");
const { archiveMaps, assertNoMaps, injectDebugIds, resetArchive } = await import(join(repo, "scripts/sourcemaps.mjs"));

/** The commit this build is from (and whether the tree had changes on top). */
function buildSha() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: repo }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo }).toString().trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}
const sha = process.env.TERNO_BUILD_SHA || buildSha();
// public by design (it can only submit events); without it the reporter is never loaded
const dsn = process.env.TERNO_SENTRY_DSN ?? "";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: "external",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  // every node builtin (incl. node:sqlite, which esbuild may not know) stays external
  external: ["electron", "node:*"],
  define: {
    "process.env.TERNO_BUILD_VERSION": JSON.stringify(version),
    "process.env.TERNO_BUILD_SHA": JSON.stringify(sha),
    "process.env.TERNO_SENTRY_DSN": JSON.stringify(dsn),
    ...(testBuild ? { __TERNO_TEST_BUILD__: JSON.stringify(testBuild) } : {}),
  },
  // ESM deps that read import.meta.url get a CJS-compatible value
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
};

const entries = [
  { in: join(root, "src/main.ts"), out: "main" },
  { in: join(root, "src/backend-entry.ts"), out: "backend" },
  { in: join(root, "src/preload.ts"), out: "preload" },
  // the Sentry pipe, required by main only when a report is about to go
  { in: join(root, "src/diag/reporter.ts"), out: "reporter" },
  // electron-updater, required by main only once the updater has work to do
  { in: join(root, "src/updates/engine.ts"), out: "updater" },
  { in: join(repo, "packages/mcp/src/bin.ts"), out: "mcp/terno-mcp" },
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

// Guard: nothing but electron and node builtins may be left as runtime requires;
// the sandboxed preload can require electron alone (a node: import there kills the bridge at runtime).
for (const r of results) {
  for (const [file, meta] of Object.entries(r.metafile.outputs)) {
    for (const imp of meta.imports) {
      if (file.endsWith("preload.cjs") && imp.external && imp.path !== "electron") {
        throw new Error(`the sandboxed preload must require only electron, not "${imp.path}"`);
      }
      if (imp.external && !(imp.path === "electron" || imp.path.startsWith("node:") || /^[a-z_]+$/.test(imp.path))) {
        throw new Error(`${file} still requires "${imp.path}" at runtime`);
      }
    }
  }
}

// dev mode loads the renderer from the Vite dev server instead
if (!process.argv.includes("--no-renderer")) {
  const web = join(repo, "apps/web/dist");
  if (!existsSync(join(web, "index.html"))) throw new Error("apps/web/dist missing: run `pnpm --filter @terno/web build` first");
  cpSync(web, join(out, "renderer"), { recursive: true });
}
cpSync(join(repo, "packages/mcp/SKILL.md"), join(out, "mcp/SKILL.md"));
// package.mjs refuses to package a test build as a release, or the other way round
if (testBuild) writeFileSync(join(out, "test-build.json"), JSON.stringify(testBuild));

// debug ids in, maps out: what ships has none, the archive has them all (with each minified file beside its map)
const archive = testBuild ? `${out}.maps` : join(root, ".maps", `${version}-${sha}`);
resetArchive(archive);
const tagged = injectDebugIds(out);
const moved = archiveMaps(out, archive, "dist");
assertNoMaps(out);
// what dist:mac uploads (when a Sentry token is set): this build's archive and release name
if (!testBuild) writeFileSync(join(root, ".maps", "LATEST"), JSON.stringify({ release: `terno@${version}+${sha}`, archive }));
console.log(`built desktop bundles → ${out} (${version}+${sha}${dsn ? ", reports on" : ""}); ${moved} source maps (${tagged.length} tagged) → ${archive}`);
