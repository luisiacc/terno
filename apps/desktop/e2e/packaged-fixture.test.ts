import assert from "node:assert/strict";
import childProcess, { execFileSync, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { test } from "node:test";
import type { ElectronApplication } from "@playwright/test";
import { cleanupOwned, closePackaged } from "./packaged-fixture";

test("a failed Electron close still joins the captured owned process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await once(child, "spawn");
  const app = { process: () => child, close: async () => { throw new Error("close failed"); } } as unknown as ElectronApplication;
  try {
    await assert.rejects(closePackaged(app), /close failed/);
    assert.notEqual(child.signalCode, null);
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
  }
});

test("cleanup joins later resources and reports the original failure", async () => {
  const joined: string[] = [];
  await assert.rejects(cleanupOwned([
    () => { throw new Error("app failed"); },
    async () => { joined.push("imap"); },
    async () => { joined.push("smtp"); },
  ]), (error: unknown) => error instanceof AggregateError && error.errors[0].message === "app failed");
  assert.deepEqual(joined, ["imap", "smtp"]);
});

test("a process disappearing before its signal does not interrupt the remaining joins", async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await once(child, "spawn");
  const signal = process.kill.bind(process);
  let raced = false;
  t.mock.method(process, "kill", (pid: number, how: NodeJS.Signals | number = "SIGTERM") => {
    if (pid === child.pid && how === "SIGTERM" && !raced) {
      raced = true;
      signal(pid, how);
      throw Object.assign(new Error("process exited before signal"), { code: "ESRCH" });
    }
    return signal(pid, how);
  });
  const app = { process: () => child, close: async () => { throw new Error("close failed"); } } as unknown as ElectronApplication;
  try {
    await assert.rejects(closePackaged(app), /close failed/);
    assert.equal(raced, true);
    assert.notEqual(child.signalCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      signal(child.pid!, "SIGKILL");
      await exit;
    }
  }
});

test("a reused PID is never signalled as the captured process", async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await once(child, "spawn");
  const signal = process.kill.bind(process);
  const original = execFileSync("ps", ["-p", String(child.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
  let signalCalls = 0;
  const ps = childProcess.execFileSync;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(process, "kill", (pid: number, how: NodeJS.Signals | number = "SIGTERM") => {
    if (pid === child.pid && how !== 0) signalCalls++;
    return signal(pid, how);
  });
  // Capture the real child, then expose a different birth identity after close.
  const app = { process: () => child, close: async () => {
    const exit = once(child, "exit"); signal(child.pid!, "SIGTERM"); await exit;
    t.mock.method(childProcess, "execFileSync", (...args: Parameters<typeof execFileSync>) => {
      const [file, options] = args;
      if (file === "ps" && Array.isArray(options) && options[0] === "-p" && options[1] === String(child.pid)) return "Fri Jan  1 00:00:00 2100\n";
      return Reflect.apply(ps, childProcess, args);
    });
    syncBuiltinESMExports();
    t.mock.method(process, "kill", (pid: number, how: NodeJS.Signals | number = "SIGTERM") => {
      if (pid === child.pid) { if (how !== 0) signalCalls++; return true; }
      return signal(pid, how);
    });
  } } as unknown as ElectronApplication;
  assert.ok(original);
  await closePackaged(app);
  assert.equal(signalCalls, 0);
});
