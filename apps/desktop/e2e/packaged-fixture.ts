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

async function joinOwned(child: ChildProcess, owned: OwnedProcess[], signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGKILL"]): Promise<void> {
  const exit = child.exitCode === null && child.signalCode === null ? once(child, "exit").then(() => {}) : Promise.resolve();
  for (const signal of signals) {
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

/** What main itself allows a quit (DRAFTS_DEADLINE_MS + SEND_DEADLINE_MS + BACKEND_GRACE_MS). */
const QUIT_MS = 40_000;
const QUIT_MARK = "terno-smoke-quit-event";

/**
 * A quit as the user makes it, up to Terno's own last act: its "quit" event, with drafts flushed and the backend closed.
 * What's left is Chromium's native teardown. Three apps side by side, on a machine at a load of 100, took up to 110 s
 * there while their "quit" came at 0.1 s; nothing of Terno's runs in it and no window is left, so it's cut short.
 */
export async function closePackaged(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const owned = child.pid ? descendants(child.pid) : [];
  nativeLifecycle("closePackaged-entry", { pid: child.pid, owned, code: child.exitCode, signal: child.signalCode });
  try {
    const quit = new Promise<void>((resolve) => {
      child.stderr?.on("data", (data: Buffer) => { if (data.toString().includes(QUIT_MARK)) resolve(); });
      child.once("exit", () => resolve());
    });
    await app.evaluate(({ app: a }, mark) => { a.once("quit", () => process.stderr.write(`${mark}\n`)); }, QUIT_MARK);
    nativeLifecycle("app.close-call", { pid: child.pid });
    const closing = app.close();
    await within(quit, QUIT_MS, "Electron quit");
    nativeLifecycle("app.close-resolved", { pid: child.pid });
    await joinOwned(child, owned, ["SIGKILL"]);
    await within(closing, 10_000, "Electron close");
  } finally { await joinOwned(child, owned); }
}

/** All resource joins run even when an earlier cleanup fails. */
export async function cleanupOwned(steps: (() => Promise<unknown> | void)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await within(Promise.resolve().then(step), QUIT_MS + 15_000, "Fixture cleanup"); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Packaged fixture cleanup failed");
}

/** An instant copy where the disk clones (APFS, 0.15 s against ditto's 2 s): the same bytes, so the same signature. */
export function copyTree(source: string, target: string): void {
  try { execFileSync("cp", ["-c", "-Rp", source, target], { stdio: "ignore" }); }
  catch { execFileSync("ditto", [source, target]); }
}

/** The run's 300-thread mailbox (global-setup.ts) as a profile of its own. */
export function seededProfile(target: string): void {
  copyTree(process.env.TERNO_SMOKE_SEED!, target);
}

export async function blockExternal(app: ElectronApplication): Promise<void> {
  await app.context().route(/^https?:\/\//, (route) => {
    const host = new URL(route.request().url()).hostname;
    return ["127.0.0.1", "localhost", "[::1]"].includes(host) ? route.continue() : route.abort("blockedbyclient");
  });
}
