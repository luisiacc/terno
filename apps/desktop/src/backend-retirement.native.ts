import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { build } from "esbuild";

it.each(["body", "preack", "capture-failure"])("installed Electron utility joins native body retirement or pre-ACK failure (mode=%s)", async (mode) => {
  const preACK = mode === "preack";
  const electron = process.env.TERNO_TEST_ELECTRON;
  if (!electron) throw new Error("TERNO_TEST_ELECTRON must name the installed Electron 45 executable");
  const directory = await mkdtemp(join(tmpdir(), "terno-retirement-"));
  try {
    const fixture = fileURLToPath(new URL("./test-fixtures/", import.meta.url));
    // Compile only the lifecycle helper into the fixture; never build the application.
    await build({ entryPoints: [fileURLToPath(new URL("./backend-retirement.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", outfile: join(directory, "retirement.cjs") });
    for (const name of ["retirement-main.cjs", "retirement-utility.cjs"]) await copyFile(join(fixture, name), join(directory, name));
    const env: NodeJS.ProcessEnv = { ...process.env, TERNO_RETIREMENT_PREACK: preACK ? "1" : "0" }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [join(directory, "retirement-main.cjs"), join(directory, "retirement.cjs"), join(directory, "profile")], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout = (stdout + b.toString()).slice(-32000); });
    child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-32000); });
    child.stdin.on("error", (error: Error) => { stderr = (stderr + error.message).slice(-32000); });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const pid = child.pid;
    let identity: string | undefined;
    let captureFailed = false;
    let captureError = "";
    const signals: number[] = [];
    const deadline = setTimeout(() => {
      // Only this launch's recorded identities may be signalled on fixture failure.
      for (const line of stdout.split("\n")) {
        if (!line.startsWith('{"utility":')) continue;
        try {
          const owned = (JSON.parse(line) as { utility: { pid: number; birth: string; argv: string } }).utility;
          const birth = execFileSync("ps", ["-p", String(owned.pid), "-o", "lstart="], { encoding: "utf8", timeout: 1000 }).trim();
          const argv = execFileSync("ps", ["-p", String(owned.pid), "-o", "command="], { encoding: "utf8", timeout: 1000 }).trim();
          if (birth === owned.birth && argv === owned.argv) { signals.push(owned.pid); process.kill(owned.pid, "SIGKILL"); }
        } catch { /* Already exited. */ }
      }
      try {
        if (identity && execFileSync("ps", ["-p", String(pid), "-o", "pid=,lstart=,command="], { encoding: "utf8", timeout: 1000 }).trim() === identity) { signals.push(pid!); child.kill("SIGTERM"); }
      } catch { /* Already exited. */ }
    }, 12_000);
    let code: number | null;
    try {
      // No child work starts until its launch identity has been captured.
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => {
          try {
            if (mode === "capture-failure") execFileSync("ps", ["--terno-injected-capture-failure"], { stdio: "pipe", timeout: 1000 });
            identity = execFileSync("ps", ["-p", String(pid), "-o", "pid=,lstart=,command="], { encoding: "utf8", timeout: 1000 }).trim();
            child.stdin.end("go");
          } catch (error) { captureFailed = true; captureError = String(error); child.stdin.end(); }
          resolve();
        });
      });
      code = await closed;
    } finally {
      child.stdin.end();
      await closed.catch(() => {});
      clearTimeout(deadline);
    }
    await mkdir("/tmp/terno-w05-desktop-r2-followup", { recursive: true });
    await writeFile(`/tmp/terno-w05-desktop-r2-followup/native-witness-${mode}.json`, JSON.stringify({ pid, identity, code, captureFailed, captureError, signals, directory, stdout, stderr }, null, 2));
    expect(code, stderr).toBe(preACK || mode === "capture-failure" ? 2 : 0);
    expect(captureFailed).toBe(mode === "capture-failure");
    expect(signals).toEqual([]);
    if (mode === "capture-failure") {
      expect(captureError).toContain("ps --terno-injected-capture-failure");
      expect(stdout).not.toContain('"sawBody":true');
      expect(identity).toBeUndefined();
    }
    expect(stdout).toContain('"utility":');
    if (mode === "body") expect(stdout).toContain('"sawBody":true,"exited":true,"socketTerminal":true,"retirement":true');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
