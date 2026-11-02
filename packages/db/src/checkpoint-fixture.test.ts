import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

interface FixtureResult {
  numTotalTests: number; numFailedTests: number; numPassedTests: number;
  testResults: { message: string; assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
}
interface Lifecycle { nodeOptionsHash: string; finalizerCompleted: boolean }

async function runFixture(failSafety = false): Promise<{ result: FixtureResult; lifecycle: Lifecycle }> {
  const dir = mkdtempSync(join(tmpdir(), "terno-checkpoint-runner-"));
  const report = join(dir, "report.json");
  const config = join(dir, "config.mjs");
  const lifecycle = join(dir, "lifecycle.json");
  const evidence = process.env.TERNO_CHECKPOINT_PARENT_EVIDENCE && `${process.env.TERNO_CHECKPOINT_PARENT_EVIDENCE}${failSafety ? "-safety" : ""}`;
  const root = resolve(import.meta.dirname, "../../..");
  writeFileSync(config, `export default ${JSON.stringify({
    root, cacheDir: join(dir, "cache"),
    test: {
      include: ["packages/db/src/test/checkpoint-fixture.fixture.ts"],
      environment: "node", pool: "threads", maxWorkers: 1, fileParallelism: false,
      testTimeout: 10000, hookTimeout: 10000,
    },
  })};`);
  const env: NodeJS.ProcessEnv = { ...process.env, TERNO_CHECKPOINT_EVIDENCE: lifecycle, TERNO_CHECKPOINT_FAIL_SAFETY: failSafety ? "1" : "" };
  delete env.ELECTRON_RUN_AS_NODE;
  const cli = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
  const argv = [cli, "run", "--config", config, "--reporter=json", "--outputFile", report];
  let output = "";
  const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  const signals: string[] = [];
  const signal = (name: NodeJS.Signals) => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      signals.push(name);
      child.kill(name);
    }
  };
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; signal("SIGTERM"); }, 45000);
  const forced = setTimeout(() => signal("SIGKILL"), 48000);
  child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-262144); });
  child.stderr.on("data", (chunk) => { output = (output + String(chunk)).slice(-262144); });
  try {
    const identity = execFileSync("ps", ["-p", String(child.pid), "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8" }).trim();
    const code = await closed;
    clearTimeout(deadline);
    clearTimeout(forced);
    if (evidence) {
      writeFileSync(`${evidence}.process.json`, JSON.stringify({ pid: child.pid, identity, argv, code, timedOut, signals, joined: true, output }));
      writeFileSync(`${evidence}.report.json`, readFileSync(report));
      writeFileSync(`${evidence}.lifecycle.json`, readFileSync(lifecycle));
    }
    expect(timedOut, output).toBe(false);
    expect(code, output).toBe(1);
    return {
      result: JSON.parse(readFileSync(report, "utf8")) as FixtureResult,
      lifecycle: JSON.parse(readFileSync(lifecycle, "utf8")) as Lifecycle,
    };
  } finally {
    signal("SIGTERM");
    await closed;
    clearTimeout(deadline);
    clearTimeout(forced);
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertFixture({ result, lifecycle }: { result: FixtureResult; lifecycle: Lifecycle }) {
  expect(result.testResults.map((file) => file.message), "suite-level errors").toEqual([""]);
  expect(lifecycle.finalizerCompleted, "safety finalizer completion").toBe(true);
  expect(result.numTotalTests).toBe(10);
  expect(result.numFailedTests).toBe(4);
  expect(result.numPassedTests).toBe(6);
  expect(result.testResults).toHaveLength(1);
  const tests = result.testResults.flatMap((file) => file.assertionResults);
  const expected = ["operation", "assertion", "success", "body-cleanup", "cleanup-only"];
  expect(tests.map((test) => test.title)).toEqual(expected.flatMap((name) => [`body ${name}`, `witness ${name}`]));
  for (const name of expected) {
    const body = tests.find((test) => test.title === `body ${name}`)!;
    expect(body.status).toBe(name === "success" ? "passed" : "failed");
    expect(tests.find((test) => test.title === `witness ${name}`)!.status).toBe("passed");
    const errors = body.failureMessages.join("\n");
    if (name === "operation" || name === "body-cleanup") expect(errors).toContain("no such table: checkpoint_missing_operation");
    if (name === "assertion") expect(errors).toContain("assertion sentinel");
    if (name.includes("cleanup")) expect(errors).toContain(`cleanup sentinel ${name}`);
  }
}

it("joins the native fixture worker and restores the writer after failure or success, retaining cleanup errors", async () => {
  const receipt = await runFixture();
  assertFixture(receipt);
  expect(receipt.lifecycle.nodeOptionsHash).toBe(createHash("sha256").update(process.env.NODE_OPTIONS ?? "").digest("hex"));
}, 60000);

it("rejects a failed safety finalizer even with the expected test outcomes", async () => {
  const receipt = await runFixture(true);
  expect(receipt.result.testResults[0]!.message).toContain("safety finalizer failures");
  expect(() => assertFixture(receipt)).toThrow(/suite-level errors|safety finalizer completion/);
}, 60000);
