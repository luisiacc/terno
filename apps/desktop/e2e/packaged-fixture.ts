import { execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { ElectronApplication } from "@playwright/test";

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish in ${ms}ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

/** Capture while parentage is observable, before Electron can orphan its helpers. */
function descendants(parent: number): number[] {
  const pairs = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([parent]);
  for (let size = 0; size !== owned.size;) {
    size = owned.size;
    for (const [pid, ppid] of pairs) if (pid && ppid && owned.has(ppid)) owned.add(pid);
  }
  return [...owned];
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function joinOwned(child: ChildProcess, owned: number[]): Promise<void> {
  const exit = child.exitCode === null && child.signalCode === null ? once(child, "exit").then(() => {}) : Promise.resolve();
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const pid of owned) if (alive(pid)) process.kill(pid, signal);
    const until = Date.now() + 3000;
    while (owned.some(alive) && Date.now() < until) await delay(50);
    if (!owned.some(alive)) break;
  }
  await within(exit, 3000, "Electron process exit");
  if (owned.some(alive)) throw new Error("Owned Electron helpers remain alive");
}

export async function closePackaged(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  const child = app.process();
  const owned = child.pid ? descendants(child.pid) : [];
  try { await within(app.close(), 5000, "Electron close"); }
  finally { await joinOwned(child, owned); }
}

/** All resource joins run even when an earlier cleanup fails. */
export async function cleanupOwned(steps: (() => Promise<unknown> | void)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await within(Promise.resolve().then(step), 10_000, "Fixture cleanup"); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Packaged fixture cleanup failed");
}

export async function blockExternal(app: ElectronApplication): Promise<void> {
  await app.context().route(/^https?:\/\//, (route) => {
    const host = new URL(route.request().url()).hostname;
    return ["127.0.0.1", "localhost", "[::1]"].includes(host) ? route.continue() : route.abort("blockedbyclient");
  });
}
