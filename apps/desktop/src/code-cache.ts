import { createHash } from "node:crypto";
import { type Dirent, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { constants, Script } from "node:vm";

/**
 * Plan 156: runs a CommonJS bundle through V8's code cache. Compiling `backend.cjs` takes about 350 ms in Electron's
 * utility process and 8 ms with the cache, and the whole launch waits for it. No code is deferred: the bundle runs at
 * once, in full. The file holds compiled code of our own bundle and nothing of the user's.
 *
 * Which cache a build may use is one rule: **a cache's file name says what it was compiled for**, this version of the app
 * and a hash of the code V8 compiles, `<version>-<sha256>.v8cache`, and its folder holds nothing else. So after an update:
 *   1. the new version looks for its own name, which the old one never wrote, so it can't read the old one's code,
 *      even if the bundle's bytes didn't change;
 *   2. everything else in the folder is deleted, before anything is compiled;
 *   3. it compiles, as a first launch does, and writes the one file of its own.
 * The version is what makes an update start clean. The hash is for two builds of one version (a local rebuild): V8
 * checks only its own version and flags and the source's length, never its content.
 *
 * The file starts with a SHA-256 of what follows, checked before V8 sees it: a release V8 doesn't check its data, and one
 * flipped byte on disk would take the whole process down rather than be refused.
 */

/** More than V8 makes of any bundle here: a bigger file isn't ours. */
const MAX_BYTES = 64 * 1024 * 1024;
const CHECKSUM_BYTES = 32;
const checksum = (data: Buffer): Buffer => createHash("sha256").update(data).digest();

const PREFIX = "(function (exports, require, module, __filename, __dirname) { ";
const SUFFIX = "\n})";

/** Only ever this folder's own entries: a link goes, and what it points to stays. What can't go is harmless: nothing reads another name. */
function deleteAllBut(dir: string, name: string): void {
  let entries: Dirent[];
  try {
    if (!lstatSync(dir).isDirectory()) {
      rmSync(dir, { force: true });
      return;
    }
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === name && entry.isFile()) continue;
    try {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
    } catch {
      // the next launch tries again
    }
  }
}

function readCache(path: string): Buffer | "damaged" | undefined {
  try {
    if (statSync(path).size > MAX_BYTES) return "damaged";
    const file = readFileSync(path);
    const data = file.subarray(CHECKSUM_BYTES);
    return file.subarray(0, CHECKSUM_BYTES).equals(checksum(data)) ? data : "damaged";
  } catch {
    return undefined;
  }
}

/** One whole file or none: a window can't read half of it, and two writers can't mix. */
function writeCache(path: string, data: Buffer): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, Buffer.concat([checksum(data), data]), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    rmSync(temp, { force: true });
  }
}

export type CacheOutcome = "accepted" | "rejected" | "none";

/**
 * Runs `file`, through the cache for its own build when `cache` says where those live and which version this is. Only
 * the cache's own steps may fail quietly; the bundle runs once, outside them, so its errors stay its own. Written
 * `writeAfterMs` later, once what the first screen needs is compiled too, and only when no valid cache was used.
 */
export function runBundle(file: string, cache?: { dir: string; version: string }, writeAfterMs = 2000): CacheOutcome {
  // one read: what's compiled and what names it can't come from two builds, even if an update replaces the file
  const code = PREFIX + readFileSync(file, "utf8") + SUFFIX;
  const name = cache && `${cache.version}-${createHash("sha256").update(code).digest("hex")}.v8cache`;
  const path = cache && name ? join(cache.dir, name) : undefined;
  if (cache && name) deleteAllBut(cache.dir, name);
  const read = path ? readCache(path) : undefined;
  const cachedData = read === "damaged" ? undefined : read;
  const script = new Script(code, {
    filename: file,
    // the wrapper isn't in the file: its first line keeps its own columns, for stack traces and source maps
    columnOffset: -PREFIX.length,
    cachedData,
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const outcome: CacheOutcome = read === "damaged" ? "rejected" : !cachedData ? "none" : script.cachedDataRejected === false ? "accepted" : "rejected";
  if (outcome !== "accepted" && path) {
    setTimeout(() => {
      try {
        writeCache(path, script.createCachedData());
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
 * Main's side: where a backend's cache lives, and this app's version. A backend that dies without being asked starts
 * again with none, and so does every later one this session (a Retry too, and however long it ran: the restart policy's
 * count resets), so bad bytecode can't keep the mail engine down. The next launch writes a new one.
 */
export class EngineCache {
  private off = false;
  private readonly dir: string;
  private readonly version: string;
  constructor(dir: string, version: string) {
    this.dir = dir;
    this.version = version;
  }
  args(): string[] {
    return this.off ? [] : [this.dir, this.version];
  }
  crashed(): void {
    this.off = true;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // off for this session anyway; a new launch that fails on it ends up here again
    }
  }
}
