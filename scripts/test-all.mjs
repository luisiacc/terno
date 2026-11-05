#!/usr/bin/env node
/**
 * Plan 139: every gate, in at most ten minutes. Over budget is a failure too: that's how the time doesn't grow back
 * unnoticed. What doesn't time anything runs first: the quick suites and the packaged smoke together, then e2e, once unit
 * has left it the machine (beside unit it finishes no sooner and flakes). The gates that time something wait for all of
 * that, and have the machine to themselves.
 *
 * A machine this full can fail a test that's fine, so what fails runs again alone. A regression fails both times, which
 * fails the run; a test that only failed the first time passes it, and is named as flaky here, to be looked at.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_S = 600;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logs = join(root, "test-results", "all");
mkdirSync(logs, { recursive: true });

const e2eDir = process.env.E2E_PORT ? `dist-e2e-${process.env.E2E_PORT}` : "dist-e2e";
const env = { ...process.env, TERNO_TEST_BACKGROUND: "1", E2E_PREBUILT: "1" };
delete env.ELECTRON_RUN_AS_NODE;

/** vitest writes what failed where `again` can read it */
const vitest = (project, flags = "") => {
  const report = join(logs, `${project}.json`);
  return {
    commands: [`pnpm exec vitest run --project ${project} ${flags} --reporter=default --reporter=json --outputFile.json=${report}`],
    again() {
      // no report: it died. An unhandled error isn't in the report, and a retry of the files that are wouldn't see it again
      if (!existsSync(report) || readFileSync(join(logs, `${project}.log`), "utf8").includes("Unhandled Error")) return null;
      const failed = JSON.parse(readFileSync(report, "utf8")).testResults.filter((file) => file.status === "failed").map((file) => relative(root, file.name));
      return failed.length ? `pnpm exec vitest run --project ${project} --maxWorkers=1 ${failed.join(" ")}` : null;
    },
  };
};
/** Playwright remembers what failed in its output directory, so this runs before another suite shares that directory; a run that died has no such record, and `--last-failed` then runs everything */
const playwright = (command, results) => ({ commands: [command], results, again: () => `${command} --last-failed` });

const SUITES = {
  typecheck: { commands: ["pnpm typecheck"] },
  lint: { commands: ["pnpm lint"] },
  build: { commands: [`VITE_RENDER_PROBE=1 pnpm --filter @terno/web exec vite build --outDir ${e2eDir}`] },
  unit: vitest("unit"),
  // beside unit, which takes the machine: more workers than this only trade places
  "db-wasm": vitest("db-wasm", "--maxWorkers=4"),
  web: playwright("pnpm test:web", "e2e-web"),
  e2e: playwright("pnpm test:e2e", "e2e"),
  // no DMG: smoke runs the .app, and a release checks its DMG as it makes it. Niced: it ends well before e2e does, so what
  // it gives up it can spare, and nothing in it is timed (what is runs in `startup`)
  smoke: { commands: ["TERNO_PACKAGE_DMG=0 nice -n 10 pnpm dist:mac", "nice -n 10 pnpm test:smoke"], results: "desktop-smoke", again: () => "pnpm test:smoke --last-failed" },
  perf: vitest("perf"),
  "ui-perf": playwright("pnpm test:ui-perf", "e2e"),
  // a packaged app's start, with nothing else running (it needs the build smoke made)
  startup: { commands: ["pnpm --filter @terno/desktop test:startup"] },
};

/** its exit code (a signal counts as a failure), with the output in the suite's log */
function run(command, log) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: root, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const results = new Map();

async function suite(name) {
  const started = Date.now();
  rmSync(join(logs, `${name}.json`), { force: true });
  // no record left from an earlier run for `again` to take for this one's
  if (SUITES[name].results) rmSync(join(root, "test-results", SUITES[name].results, ".last-run.json"), { force: true });
  const log = createWriteStream(join(logs, `${name}.log`));
  const { commands } = SUITES[name];
  let code = 0;
  let last = true;
  for (const [i, command] of commands.entries()) {
    code = await run(command, log);
    if (code !== 0) {
      // only the last command is the tests: a build that failed isn't what a retry of them would answer
      last = i === commands.length - 1;
      break;
    }
  }
  await new Promise((resolve) => log.end(resolve));
  results.set(name, { code, flaky: false, retry: last });
  console.log(`${code === 0 ? "ok  " : "FAIL"} ${name.padEnd(10)} ${String(Math.round((Date.now() - started) / 1000)).padStart(4)} s`);
}

/** what failed in `names`, once more, one suite at a time */
async function again(names) {
  for (const name of names) {
    if (results.get(name).code === 0 || !results.get(name).retry) continue;
    const command = SUITES[name].again?.();
    if (!command) continue;
    const log = createWriteStream(join(logs, `${name}.again.log`));
    const code = await run(command, log);
    log.end();
    results.set(name, { code, flaky: code === 0 });
    console.log(`${code === 0 ? "ok  " : "FAIL"} ${name} again, alone (${name}.log has what failed the first time)`);
  }
}

const started = Date.now();
const smoke = suite("smoke");
await Promise.all(["typecheck", "lint", "build", "unit", "db-wasm", "web"].map(suite));
await suite("e2e");
await smoke;
await again(["typecheck", "lint", "build", "unit", "db-wasm", "web", "e2e", "smoke"]);
await Promise.all([suite("perf"), suite("ui-perf")]);
await again(["perf", "ui-perf"]);
await suite("startup");

const total = Math.round((Date.now() - started) / 1000);
const failed = [...results].filter(([, r]) => r.code !== 0).map(([name]) => name);
const flaky = [...results].filter(([, r]) => r.flaky).map(([name]) => name);

console.log(`\n${total} s of a ${BUDGET_S} s budget; logs in test-results/all/`);
if (flaky.length) console.log(`flaky, failed only the first time: ${flaky.join(", ")}`);
if (failed.length) console.log(`failed: ${failed.join(", ")}`);
if (total > BUDGET_S) console.log(`over budget by ${total - BUDGET_S} s: find what grew before adding more (plan 139)`);
process.exit(failed.length || total > BUDGET_S ? 1 : 0);
