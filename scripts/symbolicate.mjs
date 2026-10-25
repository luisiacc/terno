#!/usr/bin/env node
// pnpm diag:symbolicate <crash.json | export.zip entry> [--maps <dir>]
//
// Resolves a crash record's frames (minified file, line, column) to source
// lines through the maps archived at build time: apps/desktop/.maps/<version>-<sha>/
// for the desktop app (from the record's build), apps/web/.maps/<build>/ for
// the web. Works offline, on records from any machine that ran that build.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The archive for a build id ("0.1.0+abc1234"), desktop first. */
export function archiveFor(build) {
  const flat = String(build).replace("+", "-");
  for (const dir of [join(repo, "apps/desktop/.maps", flat), join(repo, "apps/web/.maps", flat), join(repo, "apps/web/.maps", String(build))]) if (existsSync(dir)) return dir;
  return null;
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const maps = new Map();
function mapFor(archive, file) {
  const candidates = [file, `dist/${file}`, file.replace(/^dist\//, ""), `dist/renderer/${file.replace(/^renderer\//, "")}`].map((f) => join(archive, `${f}.map`));
  let path = candidates.find((p) => existsSync(p));
  if (!path) path = walk(archive).find((p) => basename(p) === `${basename(file)}.map`);
  if (!path) return null;
  if (!maps.has(path)) maps.set(path, new TraceMap(readFileSync(path, "utf8")));
  return maps.get(path);
}

/** Each frame with its source position (or as it was, when no map covers it). */
export function symbolicate(record, archive) {
  const frames = record.error?.frames ?? [];
  return frames.map((f) => {
    const map = f.line ? mapFor(archive, f.file) : null;
    if (!map) return { ...f };
    // V8 columns are 1-based, source maps 0-based
    const pos = originalPositionFor(map, { line: f.line, column: Math.max(0, (f.col ?? 1) - 1) });
    return pos.source ? { ...f, source: pos.source.replace(/^(\.\.\/)+/, ""), sourceLine: pos.line, sourceCol: pos.column, name: pos.name ?? undefined } : { ...f };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const mapsArg = args.includes("--maps") ? args[args.indexOf("--maps") + 1] : null;
  if (!file) {
    console.error("usage: pnpm diag:symbolicate <crash.json> [--maps <archive dir>]");
    process.exit(2);
  }
  const record = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
  const archive = mapsArg ? resolve(process.cwd(), mapsArg) : archiveFor(record.context?.build);
  if (!archive) {
    console.error(`no archived maps for build ${record.context?.build}: pass --maps <dir>`);
    process.exit(1);
  }
  console.log(`${record.error?.name ?? record.kind} · ${record.code} · ${record.context?.build} · ${record.proc}\n`);
  for (const f of symbolicate(record, archive)) {
    const at = `${f.file}:${f.line ?? "?"}:${f.col ?? "?"}`;
    console.log(f.source ? `  at ${f.name ?? f.fn ?? "?"}  ${f.source}:${f.sourceLine}:${f.sourceCol}   (${at})` : `  at ${f.fn ?? "?"}  ${at}`);
  }
}
