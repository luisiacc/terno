import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { build } from "esbuild";

it.each([false, true])("installed Electron utility joins native body retirement or pre-ACK failure (preACK=%s)", async (preACK) => {
  const electron = process.env.TERNO_TEST_ELECTRON;
  if (!electron) throw new Error("TERNO_TEST_ELECTRON must name the installed Electron 45 executable");
  const directory = await mkdtemp(join(tmpdir(), "terno-retirement-"));
  try {
    const fixture = fileURLToPath(new URL("./test-fixtures/", import.meta.url));
    // Compile only the lifecycle helper into the fixture; never build the application.
    await build({ entryPoints: [fileURLToPath(new URL("./backend-retirement.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", outfile: join(directory, "retirement.cjs") });
    for (const name of ["retirement-main.cjs", "retirement-utility.cjs"]) await copyFile(join(fixture, name), join(directory, name));
    const env: NodeJS.ProcessEnv = { ...process.env, TERNO_RETIREMENT_PREACK: preACK ? "1" : "0" }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [join(directory, "retirement-main.cjs"), join(directory, "retirement.cjs"), join(directory, "profile")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout = (stdout + b.toString()).slice(-32000); });
    child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-32000); });
    const captured = new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => { try { resolve(execFileSync("ps", ["-p", String(child.pid), "-o", "pid=,lstart=,command="], { encoding: "utf8" }).trim()); } catch (error) { reject(error); } });
    });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const identity = await captured.catch(async (error: unknown) => { await closed.catch(() => {}); throw error; });
    const deadline = setTimeout(() => {
      // Only this launch's recorded identities may be signalled on fixture failure.
      for (const line of stdout.split("\n")) {
        if (!line.startsWith('{"utility":')) continue;
        const owned = (JSON.parse(line) as { utility: { pid: number; birth: string; argv: string } }).utility;
        try {
          const birth = execFileSync("ps", ["-p", String(owned.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
          const argv = execFileSync("ps", ["-p", String(owned.pid), "-o", "command="], { encoding: "utf8" }).trim();
          if (birth === owned.birth && argv === owned.argv) process.kill(owned.pid, "SIGKILL");
        } catch { /* Already exited. */ }
      }
      try {
        if (execFileSync("ps", ["-p", String(child.pid), "-o", "pid=,lstart=,command="], { encoding: "utf8" }).trim() === identity) child.kill("SIGTERM");
      } catch { /* Already exited. */ }
    }, 12_000);
    let code: number | null;
    try { code = await closed; } finally { clearTimeout(deadline); }
    await mkdir("/tmp/terno-w05-desktop", { recursive: true });
    await writeFile(`/tmp/terno-w05-desktop/native-witness-${preACK ? "preack" : "body"}.json`, JSON.stringify({ identity, code, stdout, stderr }, null, 2));
    expect(code, stderr).toBe(preACK ? 2 : 0);
    expect(stdout).toContain('"utility":');
    if (!preACK) expect(stdout).toContain('"sawBody":true,"exited":true,"socketTerminal":true,"retirement":true');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
