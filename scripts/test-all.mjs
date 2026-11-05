#!/usr/bin/env node
/**
 * Plan 139: every gate, in at most ten minutes. Stages run one after another and the suites of a
 * stage run together; perf and UI perf have theirs alone, so nothing competes with their timings.
 * Over budget is a failure too: that's how the time doesn't grow back unnoticed.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_S = 600;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logs = join(root, "test-results", "all");
mkdirSync(logs, { recursive: true });

const env = { ...process.env, TERNO_TEST_BACKGROUND: "1" };
delete env.ELECTRON_RUN_AS_NODE;

/** each suite is its commands in order; the first to fail ends the suite */
const STAGES = [
  {
    typecheck: ["pnpm typecheck"],
    lint: ["pnpm lint"],
    unit: ["pnpm exec vitest run --project unit"],
    "db-wasm": ["pnpm exec vitest run --project db-wasm"],
  },
  {
    e2e: ["pnpm test:e2e"],
    web: ["pnpm test:web"],
    smoke: ["pnpm dist:mac", "pnpm test:smoke"],
  },
  { perf: ["pnpm test:perf"] },
  { "ui-perf": ["pnpm test:ui-perf"] },
];

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

async function suite(name, commands) {
  const started = Date.now();
  const log = createWriteStream(join(logs, `${name}.log`));
  let code = 0;
  for (const command of commands) {
    code = await run(command, log);
    if (code !== 0) break;
  }
  log.end();
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${code === 0 ? "ok  " : "FAIL"} ${name.padEnd(10)} ${String(seconds).padStart(4)} s`);
  return { name, code, seconds };
}

const started = Date.now();
const results = [];
for (const stage of STAGES) {
  results.push(...(await Promise.all(Object.entries(stage).map(([name, commands]) => suite(name, commands)))));
}
const total = Math.round((Date.now() - started) / 1000);
const failed = results.filter((r) => r.code !== 0);

console.log(`\n${total} s of a ${BUDGET_S} s budget; logs in test-results/all/`);
if (failed.length) console.log(`failed: ${failed.map((r) => r.name).join(", ")}`);
if (total > BUDGET_S) console.log(`over budget by ${total - BUDGET_S} s: find what grew before adding more (plan 139)`);
process.exit(failed.length || total > BUDGET_S ? 1 : 0);
