import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EngineCache } from "./code-cache";

// Each load in a process of its own: in one, V8's compilation cache answers and a bad cache looks accepted.
const LOADER = join(import.meta.dirname, "code-cache.ts");
let dir: string, bundle: string, cache: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "terno-code-cache-"));
  bundle = join(dir, "bundle.cjs");
  cache = join(dir, "engine.v8cache");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const write = (code: string, id = ID_A) => writeFileSync(bundle, `${code}\n//# debugId=${id}\n`);
const script = (cachePath: string | undefined) => `
  import { runBundle } from ${JSON.stringify(LOADER)};
  console.log("outcome:" + runBundle(${JSON.stringify(bundle)}, ${JSON.stringify(cachePath)}, 5));
  setTimeout(() => {}, 200);`;
function load(cachePath: string | undefined = cache) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script(cachePath)], { encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status, outcome: /outcome:(\w+)/.exec(r.stdout)?.[1] };
}

it("runs the bundle as CommonJS, writes a cache, and the next process uses it and leaves it alone", () => {
  write(`console.log("args", typeof exports, typeof module.exports, require("node:path").basename(__filename), __dirname === require("node:path").dirname(__filename), this === module.exports);`);
  const first = load();
  expect(first.outcome).toBe("none");
  expect(first.out).toContain("args object object bundle.cjs true true");
  expect(existsSync(cache)).toBe(true);
  const bytes = readFileSync(cache), time = statSync(cache).mtimeMs;
  const second = load();
  expect(second.outcome).toBe("accepted");
  expect(second.out).toContain("args object object bundle.cjs true true");
  expect(statSync(cache).mtimeMs).toBe(time);
  expect(readFileSync(cache).equals(bytes)).toBe(true);
});

it("a build of the same length never runs another's code: V8 alone would accept it", () => {
  write(`console.log("build-one");`);
  load();
  write(`console.log("build-two");`, ID_B);
  const next = load();
  expect(next.outcome).toBe("none");
  expect(next.out).toContain("build-two");
  expect(next.out).not.toContain("build-one");
  expect(load().outcome).toBe("accepted");
});

it.each([["garbage after a valid header", (f: Buffer) => Buffer.concat([f.subarray(0, 60), Buffer.alloc(4096, 7)])], ["a torn write", (f: Buffer) => f.subarray(0, Math.floor(f.length / 2))]])("%s compiles normally and is replaced", (_name, damage) => {
  write(`console.log("still-runs");`);
  load();
  writeFileSync(cache, damage(readFileSync(cache)));
  const damaged = load();
  expect(damaged.outcome).toBe("rejected");
  expect(damaged.out).toContain("still-runs");
  expect(load().outcome).toBe("accepted");
});

it("a cache that can't be read or written doesn't get in the way of the launch", () => {
  write(`console.log("still-runs");`);
  mkdirSync(cache);
  const asDirectory = load();
  expect(asDirectory.outcome).toBe("none");
  expect(asDirectory.out).toContain("still-runs");
  expect(asDirectory.status).toBe(0);
  const nowhere = load(join(dir, "no", "such", "dir", "cache"));
  expect(nowhere.out).toContain("still-runs");
  expect(nowhere.status).toBe(0);
  expect(load(undefined).out).toContain("still-runs");
  // no debug id: nothing to name a cache by
  writeFileSync(bundle, `console.log("no-id");\n`);
  rmSync(cache, { recursive: true });
  expect(load().out).toContain("no-id");
  expect(existsSync(cache)).toBe(false);
});

it("a bundle's own failure is the process's, once: never swallowed, and never run again", () => {
  write(`console.log("evaluated"); throw new Error("boom");`);
  const r = load();
  expect(r.status).not.toBe(0);
  expect(r.err).toContain("boom");
  expect(r.out.match(/evaluated/g)).toHaveLength(1);
});

it("a stack trace has the file's own lines and columns, with and without the cache", () => {
  // the first line is where the wrapper sits
  write(`try { throw new Error("one"); } catch (e) { console.log(e.stack.split("\\n")[1]); }\n  try { throw new Error("two"); } catch (e) { console.log(e.stack.split("\\n")[1]); }`);
  for (const outcome of ["none", "accepted"]) {
    const r = load();
    expect(r.outcome).toBe(outcome);
    expect(r.out).toContain(`${bundle}:1:13`);
    expect(r.out).toContain(`${bundle}:2:15`);
  }
});

it("main: a backend that crashed gets no cache for the rest of the session, and the file goes", () => {
  writeFileSync(cache, "x");
  const engine = new EngineCache(cache);
  expect(engine.args()).toEqual([cache]);
  engine.crashed();
  expect(existsSync(cache)).toBe(false);
  expect(engine.args()).toEqual([]);
  expect(engine.args()).toEqual([]);
});

it("main: failing to delete it still leaves it off, and doesn't throw", () => {
  mkdirSync(cache);
  const engine = new EngineCache(cache);
  expect(() => engine.crashed()).not.toThrow();
  expect(engine.args()).toEqual([]);
});

it("the loader runs under plain Node's type stripping (what these tests rely on)", () => {
  expect(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `import(${JSON.stringify(LOADER)}).then((m) => console.log(typeof m.runBundle))`], { encoding: "utf8" })).toContain("function");
});
