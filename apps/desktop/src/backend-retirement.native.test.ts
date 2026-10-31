import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { build } from "esbuild";

it("installed Electron utility exit physically terminates an ACKed but nonterminal native body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terno-retirement-"));
  const fixture = fileURLToPath(new URL("./test-fixtures/", import.meta.url));
  // Compile only the lifecycle helper into the fixture; never build the application.
  await build({ entryPoints: [fileURLToPath(new URL("./backend-retirement.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", outfile: join(directory, "retirement.cjs") });
  for (const name of ["retirement-main.cjs", "retirement-utility.cjs"]) await copyFile(join(fixture, name), join(directory, name));
  const electron = process.env.TERNO_TEST_ELECTRON;
  if (!electron) throw new Error("TERNO_TEST_ELECTRON must name the installed Electron 45 executable");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(directory, "retirement-main.cjs"), join(directory, "retirement.cjs"), join(directory, "profile")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b: Buffer) => { stdout = (stdout + b.toString()).slice(-32000); });
  child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-32000); });
  const captured = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => resolve(execFileSync("ps", ["-p", String(child.pid), "-o", "pid=,lstart=,command="], { encoding: "utf8" }).trim()));
  });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const identity = await captured;
  const code = await closed;
  await writeFile("/tmp/terno-w05-desktop/native-witness.json", JSON.stringify({ identity, code, stdout, stderr }, null, 2));
  await rm(directory, { recursive: true, force: true });
  expect(code, stderr).toBe(0);
  expect(stdout).toContain('"utility":');
  expect(stdout).toContain('"sawBody":true,"exited":true,"socketTerminal":true,"retirement":true');
});
