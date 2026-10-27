import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const sourceApp = fileURLToPath(new URL("../release/mac-arm64/Terno.app", import.meta.url));

test("the signed copied app executes its shipped incoming worker inside a utility process", async () => {
  test.skip(!existsSync(sourceApp), "run `pnpm dist:mac` first");
  const work = mkdtempSync("/tmp/terno-incoming-packaged-");
  let application: ElectronApplication | undefined;
  try {
    const copied = join(work, "Terno.app");
    execFileSync("ditto", [sourceApp, copied]);
    execFileSync("codesign", ["--verify", "--deep", "--strict", copied]);
    const host = join(work, "incoming-host.cjs");
    writeFileSync(host, `
      const { Worker } = require('node:worker_threads');
      const workerPath = process.argv[2];
      const workerSha256 = require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(workerPath)).digest('hex');
      const report = value => process.parentPort.postMessage({value, workerSha256, fromAsar:workerPath.includes('.asar/')});
      const worker = new Worker(workerPath, {execArgv:[], env:{}, resourceLimits:{maxOldGenerationSizeMb:512}});
      const header = 'Subject: packaged incoming\\r\\nContent-Type: application/octet-stream\\r\\nContent-Disposition: attachment; filename="binary.bin"\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n';
      const source = new TextEncoder().encode(header + ('paWl'.repeat(19)+'\\r\\n').repeat(16384));
      worker.on('error', () => report({ok:false, code:'worker-fault'}));
      worker.on('messageerror', () => report({ok:false, code:'worker-fault'}));
      worker.on('message', async reply => {
        let summary = {ok:false, code:reply.code || 'worker-fault'};
        if (reply.type === 'result') {
          const part = reply.result.message.attachments[0];
          summary = {ok:true, subject:reply.result.message.subject, detached:source.byteLength===0, size:part.bytes.byteLength, exact:part.bytes.every(byte=>byte===165)};
        }
        await worker.terminate();
        report(summary);
      });
      worker.postMessage({type:'process',incarnation:1,job:1,input:{kind:'mime',chunks:[source]}},[source.buffer]);
    `);
    const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: join(work, "profile") };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ cwd: work, executablePath: join(copied, "Contents/MacOS/Terno"), env });
    await application.firstWindow();
    const summary = await application.evaluate(({ app, utilityProcess }, hostPath) => {
      const workerPath = `${app.getAppPath()}/dist/incoming.worker.cjs`;
      return new Promise<{ value: unknown; workerSha256: string; version: string; fromAsar: boolean; helperPid: number }>((resolve, reject) => {
        const child = utilityProcess.fork(hostPath, [workerPath], { serviceName: "Terno incoming smoke", stdio: "pipe" });
        let pid = child.pid;
        child.once("spawn", () => { pid = child.pid; });
        let settled = false;
        let answer: { value: unknown; workerSha256: string; fromAsar: boolean } | undefined;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (pid && child.pid === pid) child.kill();
          reject(new Error("Packaged incoming worker did not answer"));
        }, 20_000);
        child.once("message", (value) => {
          if (settled) return;
          answer = value;
          if (pid && child.pid === pid) child.kill();
        });
        child.once("exit", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (answer && pid) resolve({ ...answer, version: app.getVersion(), helperPid: pid });
          else reject(new Error("Packaged incoming worker exited before answering"));
        });
      });
    }, host);
    expect(summary.fromAsar).toBe(true);
    expect(summary.helperPid).toBeGreaterThan(0);
    expect(summary.workerSha256).toMatch(/^[a-f0-9]{64}$/);
    console.log("Packaged incoming loader pin:", JSON.stringify({ version: summary.version, workerSha256: summary.workerSha256, reapedHelperPid: summary.helperPid }));
    expect(summary.value).toEqual({ ok: true, subject: "packaged incoming", detached: true, size: 16384 * 57, exact: true });
  } finally {
    await application?.close();
    rmSync(work, { recursive: true, force: true });
  }
});
