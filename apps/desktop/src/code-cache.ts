import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { constants, Script } from "node:vm";

/**
 * Plan 156: runs a CommonJS bundle through V8's code cache. Compiling `backend.cjs` takes about 350 ms in Electron's
 * utility process and 8 ms with the cache, and the whole launch waits for it. No code is deferred: the bundle runs at
 * once, in full. The file holds compiled code of our own bundle and nothing of the user's.
 */

/** Bump when the file's layout changes. */
const FORMAT = "terno-code-cache-1";
/** More than V8 makes of any bundle here: a bigger file isn't ours. */
const MAX_BYTES = 64 * 1024 * 1024;
const DEBUG_ID = /\/\/# debugId=([0-9a-f-]{36})\s*$/;

const PREFIX = "(function (exports, require, module, __filename, __dirname) { ";

/** The file for this exact source, or nothing. V8 checks its own version and flags and the source's length, never its content. */
function readCache(path: string, header: Buffer): Buffer | undefined {
  try {
    if (statSync(path).size > MAX_BYTES) return undefined;
    const file = readFileSync(path);
    return file.subarray(0, header.length).equals(header) ? file.subarray(header.length) : undefined;
  } catch {
    return undefined;
  }
}

/** One whole file or none: a window can't read half of it, and two writers can't mix. */
function writeCache(path: string, header: Buffer, data: Buffer): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, Buffer.concat([header, data]), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    rmSync(temp, { force: true });
  }
}

export type CacheOutcome = "accepted" | "rejected" | "none";

/**
 * Runs `file`, with a cache at `cachePath` when there is one. Only the cache's own steps may fail quietly; the bundle
 * runs once, outside them, so its errors stay its own. Written `writeAfterMs` later, once what the first screen needs
 * is compiled too, and only when no valid cache was used.
 */
export function runBundle(file: string, cachePath?: string, writeAfterMs = 2000): CacheOutcome {
  const source = readFileSync(file, "utf8");
  // from this read: what's compiled and what names it can't come from two builds, even if an update replaces the file
  const id = DEBUG_ID.exec(source.slice(-120))?.[1];
  const header = id ? Buffer.from(`${FORMAT}\n${id}\n`) : undefined;
  const cachedData = cachePath && header ? readCache(cachePath, header) : undefined;
  const script = new Script(PREFIX + source + "\n})", {
    filename: file,
    // the wrapper isn't in the file: its first line keeps its own columns, for stack traces and source maps
    columnOffset: -PREFIX.length,
    cachedData,
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const outcome: CacheOutcome = !cachedData ? "none" : script.cachedDataRejected === false ? "accepted" : "rejected";
  if (outcome !== "accepted" && cachePath && header) {
    setTimeout(() => {
      try {
        writeCache(cachePath, header, script.createCachedData());
      } catch {
        // the next launch compiles, as this one did
      }
    }, writeAfterMs).unref();
  }
  const run = script.runInThisContext() as (e: unknown, r: NodeJS.Require, m: { exports: unknown }, f: string, d: string) => void;
  const module = { exports: {} };
  run.call(module.exports, module.exports, createRequire(file), module, file, dirname(file));
  return outcome;
}

/**
 * Main's side: the path a backend gets. A backend that dies without being asked to starts again with none, and so does
 * every later one this session (a Retry too, and however long it ran: the restart policy's count resets), so bad
 * bytecode can't keep the mail engine down. The next launch writes a new one.
 */
export class EngineCache {
  private off = false;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  args(): string[] {
    return this.off ? [] : [this.path];
  }
  crashed(): void {
    this.off = true;
    try {
      rmSync(this.path, { force: true });
    } catch {
      // off for this session anyway; a new launch that fails on it ends up here again
    }
  }
}
