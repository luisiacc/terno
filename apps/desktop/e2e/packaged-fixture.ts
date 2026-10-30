import { nativeLifecycle } from "./native-lifecycle";
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
interface OwnedProcess { pid: number; birth: string }

function descendants(parent: number): OwnedProcess[] {
  const pairs = execFileSync("ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8" }).trim().split("\n").map((line) => { const [pid, ppid, ...birth] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), birth: birth.join(" ") }; });
  const owned = new Set([parent]);
  for (let size = 0; size !== owned.size;) {
    size = owned.size;
    for (const { pid, ppid } of pairs) if (pid && ppid && owned.has(ppid)) owned.add(pid);
  }
  return pairs.filter((row) => owned.has(row.pid)).map(({ pid, birth }) => ({ pid, birth }));
}

function alive(owned: OwnedProcess): boolean {
  try {
    return execFileSync("ps", ["-p", String(owned.pid), "-o", "lstart="], { encoding: "utf8" }).trim().replace(/\s+/g, " ") === owned.birth;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

async function joinOwned(child: ChildProcess, owned: OwnedProcess[]): Promise<void> {
  const exit = child.exitCode === null && child.signalCode === null ? once(child, "exit").then(() => {}) : Promise.resolve();
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const ownedProcess of owned) {
      if (!alive(ownedProcess)) continue;
      try { nativeLifecycle("cleanup-signal", { ...ownedProcess, signal }); process.kill(ownedProcess.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
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
  nativeLifecycle("closePackaged-entry", { pid: child.pid, owned, code: child.exitCode, signal: child.signalCode });
  try { nativeLifecycle("app.close-call", { pid: child.pid }); await within(app.close(), 5000, "Electron close"); nativeLifecycle("app.close-resolved", { pid: child.pid }); }
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
