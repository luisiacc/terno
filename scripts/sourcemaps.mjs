// Source maps for every bundle that ships, kept out of what ships.
//
// injectDebugIds: each .js/.cjs with a sibling .map gets a debug id (a UUID
// from its content) in three places: a registration snippet appended to the
// code (`_sentryDebugIds[stack] = id`, read at runtime to tag reports), a
// `//# debugId=` comment, and the map's `debugId`. Appending never moves a
// mapped line, so the maps stay exact.
//
// archiveMaps: moves every .map out of the build into an archive folder,
// with a copy of its minified file beside it (what `sentry sourcemap
// upload` and `pnpm diag:symbolicate` read). Runs before packaging and
// signing: the signed app never contains a map.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const CODE = /\.(c|m)?js$/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** A v4-shaped UUID from the file's content: the same build gives the same ids. */
export function debugIdFor(content) {
  const h = createHash("sha256").update(content).digest("hex");
  const v = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const snippet = (id) =>
  `\n;!function(){try{var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="${id}")}catch(e){}}();\n//# debugId=${id}\n`;

/** Returns the files it tagged (relative to dir). Files already tagged are left alone. */
export function injectDebugIds(dir) {
  const tagged = [];
  for (const file of walk(dir)) {
    if (!CODE.test(file) || !existsSync(`${file}.map`)) continue;
    const code = readFileSync(file, "utf8");
    if (/\/\/# debugId=/.test(code)) continue;
    const id = debugIdFor(code);
    writeFileSync(file, code + snippet(id));
    const map = JSON.parse(readFileSync(`${file}.map`, "utf8"));
    map.debugId = id;
    map.debug_id = id;
    writeFileSync(`${file}.map`, JSON.stringify(map));
    tagged.push(relative(dir, file));
  }
  return tagged;
}

/** Moves every map under `dir` to `archive/<prefix>/…`, each with its code beside it. */
export function archiveMaps(dir, archive, prefix = "") {
  let moved = 0;
  for (const file of walk(dir)) {
    if (!file.endsWith(".map")) continue;
    const rel = join(prefix, relative(dir, file));
    const target = join(archive, rel);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(file, target);
    const code = file.slice(0, -4);
    if (existsSync(code)) copyFileSync(code, target.slice(0, -4));
    moved++;
  }
  return moved;
}

/** No map may be left in a tree that ships. */
export function assertNoMaps(dir) {
  const left = walk(dir).filter((f) => f.endsWith(".map"));
  if (left.length) throw new Error(`source maps left in ${dir}: ${left.map((f) => relative(dir, f)).join(", ")}`);
}

export function resetArchive(archive) {
  rmSync(archive, { recursive: true, force: true });
  mkdirSync(archive, { recursive: true });
}
