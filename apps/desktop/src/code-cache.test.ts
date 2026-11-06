import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EngineCache } from "./code-cache";

// Each load in a process of its own: in one, V8's compilation cache answers and a bad cache looks accepted.
const LOADER = join(import.meta.dirname, "code-cache.ts");
let dir: string, bundle: string, cacheDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "terno-code-cache-"));
  bundle = join(dir, "bundle.cjs");
  cacheDir = join(dir, "engine-cache");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (code: string) => writeFileSync(bundle, `${code}\n`);
const inFolder = () => (existsSync(cacheDir) ? readdirSync(cacheDir) : []);
const only = (version: string) => [expect.stringMatching(new RegExp(`^${version.replaceAll(".", "\\.")}-[0-9a-f]{64}\\.v8cache$`))];
const own = () => join(cacheDir, inFolder()[0]!);
type Load = { version?: string; at?: string | null; writeAfterMs?: number };
function load({ version = "1.0.0", at = cacheDir, writeAfterMs = 5 }: Load = {}) {
  const cache = at === null ? undefined : { dir: at, version };
  const script = `
    import { runBundle } from ${JSON.stringify(LOADER)};
    console.log("outcome:" + runBundle(${JSON.stringify(bundle)}, ${JSON.stringify(cache)}, ${writeAfterMs}));
    setTimeout(() => {}, 200);`;
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status, outcome: /outcome:(\w+)/.exec(r.stdout)?.[1] };
}

it("runs the bundle as CommonJS, writes the one file named for it, and the next process uses it and leaves it alone", () => {
  write(`console.log("args", typeof exports, typeof module.exports, require("node:path").basename(__filename), __dirname === require("node:path").dirname(__filename), this === module.exports);`);
  const first = load();
  expect(first.outcome).toBe("none");
  expect(first.out).toContain("args object object bundle.cjs true true");
  expect(inFolder()).toEqual(only("1.0.0"));
  const file = own(), bytes = readFileSync(file), time = statSync(file).mtimeMs;
  const second = load();
  expect(second.outcome).toBe("accepted");
  expect(second.out).toContain("args object object bundle.cjs true true");
  expect(statSync(file).mtimeMs).toBe(time);
  expect(readFileSync(file).equals(bytes)).toBe(true);
});

it("an update: the new version never uses the old one's cache, even with the same bytes, and writes its own", () => {
  write(`console.log("runs");`);
  load({ version: "1.0.0" });
  expect(load({ version: "1.0.0" }).outcome).toBe("accepted");
  // the same bundle: V8 would take the old file, and so would a check of the content alone
  const updated = load({ version: "1.0.1" });
  expect(updated.outcome).toBe("none");
  expect(updated.out).toContain("runs");
  expect(inFolder()).toEqual(only("1.0.1"));
  expect(load({ version: "1.0.1" }).outcome).toBe("accepted");
});

it("an update: the old version's cache is gone before anything is compiled or written", () => {
  write(`console.log("runs");`);
  load({ version: "1.0.0" });
  expect(inFolder()).toEqual(only("1.0.0"));
  // the process ends long before its own file would be written
  expect(load({ version: "1.0.1", writeAfterMs: 60_000 }).outcome).toBe("none");
  expect(inFolder()).toEqual([]);
});

it("going back to an older version is no different: it compiles, and the newer one's file goes", () => {
  write(`console.log("runs");`);
  load({ version: "1.0.1" });
  expect(load({ version: "1.0.0" }).outcome).toBe("none");
  expect(inFolder()).toEqual(only("1.0.0"));
});

it("two builds of one version, of one length, never run each other's code: V8 alone would accept it", () => {
  write(`console.log("build-one");`);
  load();
  const before = inFolder();
  write(`console.log("build-two");`);
  const next = load();
  expect(next.outcome).toBe("none");
  expect(next.out).toContain("build-two");
  expect(next.out).not.toContain("build-one");
  expect(inFolder()).toEqual(only("1.0.0"));
  expect(inFolder()).not.toEqual(before);
  expect(load().outcome).toBe("accepted");
});

it("whatever else is in the folder goes: a write that died, a folder, an old name", () => {
  write(`console.log("runs");`);
  load();
  const name = inFolder()[0]!;
  writeFileSync(join(cacheDir, `${name}.123.tmp`), "half");
  writeFileSync(join(cacheDir, "1.0.0-old.v8cache"), "x");
  mkdirSync(join(cacheDir, "a-folder"));
  expect(load().outcome).toBe("accepted");
  expect(inFolder()).toEqual([name]);
});

it("a folder under its own name doesn't turn the cache off for good: it goes, and the next launch has one", () => {
  write(`console.log("runs");`);
  load();
  const name = inFolder()[0]!;
  rmSync(join(cacheDir, name));
  mkdirSync(join(cacheDir, name));
  expect(load().outcome).toBe("none");
  expect(load().outcome).toBe("accepted");
});

it("nothing outside the folder is ever deleted: a link goes, and what it points to stays", () => {
  write(`console.log("runs");`);
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "keep"), "mine");
  // the folder itself a link
  symlinkSync(elsewhere, cacheDir);
  expect(load().outcome).toBe("none");
  expect(readdirSync(elsewhere)).toEqual(["keep"]);
  expect(lstatSync(cacheDir).isDirectory()).toBe(true);
  // a link in it, even under its own name
  const name = inFolder()[0]!;
  rmSync(join(cacheDir, name));
  symlinkSync(join(elsewhere, "keep"), join(cacheDir, name));
  symlinkSync(elsewhere, join(cacheDir, "a-link"));
  expect(load().outcome).toBe("none");
  expect(readFileSync(join(elsewhere, "keep"), "utf8")).toBe("mine");
  expect(inFolder()).toEqual([name]);
  expect(lstatSync(join(cacheDir, name)).isFile()).toBe(true);
  // main's side too
  rmSync(cacheDir, { recursive: true });
  symlinkSync(elsewhere, cacheDir);
  new EngineCache(cacheDir, "1.0.0").crashed();
  expect(existsSync(cacheDir)).toBe(false);
  expect(readdirSync(elsewhere)).toEqual(["keep"]);
});

const flipped = (f: Buffer) => {
  const copy = Buffer.from(f);
  copy[copy.length >> 1]! ^= 0xff;
  return copy;
};
it.each([["garbage", (f: Buffer) => Buffer.concat([f.subarray(0, 60), Buffer.alloc(4096, 7)])], ["a torn write", (f: Buffer) => f.subarray(0, Math.floor(f.length / 2))], ["one flipped byte, which takes a process down if V8 sees it", flipped], ["nothing at all", () => Buffer.alloc(0)]])("%s under its own name compiles normally and is replaced", (_name, damage) => {
  write(`console.log("still-runs");`);
  load();
  const file = own();
  writeFileSync(file, damage(readFileSync(file)));
  const damaged = load();
  expect(damaged.outcome).toBe("rejected");
  expect(damaged.out).toContain("still-runs");
  expect(load().outcome).toBe("accepted");
});

it("a cache that can't be read or written doesn't get in the way of the launch", () => {
  write(`console.log("still-runs");`);
  // the folder's place is a file: it goes
  writeFileSync(cacheDir, "");
  expect(load().out).toContain("still-runs");
  expect(inFolder()).toEqual(only("1.0.0"));
  // somewhere that can't be made
  writeFileSync(join(dir, "a-file"), "");
  const nowhere = load({ at: join(dir, "a-file", "engine-cache") });
  expect(nowhere.out).toContain("still-runs");
  expect(nowhere.status).toBe(0);
  expect(load({ at: null }).out).toContain("still-runs");
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

it("main: a backend gets the folder and the version, one that crashed gets none for the rest of the session, and the folder goes", () => {
  mkdirSync(cacheDir);
  writeFileSync(join(cacheDir, "1.0.0-x.v8cache"), "x");
  const engine = new EngineCache(cacheDir, "1.0.0");
  expect(engine.args()).toEqual([cacheDir, "1.0.0"]);
  engine.crashed();
  expect(existsSync(cacheDir)).toBe(false);
  expect(engine.args()).toEqual([]);
  expect(engine.args()).toEqual([]);
});

it("main: failing to delete it still leaves it off, and doesn't throw", () => {
  writeFileSync(join(dir, "a-file"), "");
  const engine = new EngineCache(join(dir, "a-file", "engine-cache"), "1.0.0");
  expect(() => engine.crashed()).not.toThrow();
  expect(engine.args()).toEqual([]);
});

it("the loader runs under plain Node's type stripping (what these tests rely on)", () => {
  expect(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `import(${JSON.stringify(LOADER)}).then((m) => console.log(typeof m.runBundle))`], { encoding: "utf8" })).toContain("function");
});
