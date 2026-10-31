import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the desktop host joins physical exit before releasing backend ownership", () => {
  const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  const stop = source.slice(source.indexOf("function stopBackend("), source.indexOf("async function shutdown(force"));
  expect(stop).not.toContain("backend = null");
  expect(stop).toContain("retirement.retire()");
  expect(source).toContain("await stopBackend()");
});

// The process adapter is exercised independently of the host's Electron imports.

import { EventEmitter } from "node:events";
import { afterEach, vi } from "vitest";
import { BackendRetirement } from "./backend-retirement";
import { BACKEND_GRACE_MS } from "./shutdown";

afterEach(() => vi.useRealTimers());

function utility(kill = vi.fn(() => true)) {
  const child = new EventEmitter();
  return { child, owned: Object.assign(child, { kill }) };
}

it("ACK/kill and observer expiry never prove exit, and concurrent retirement shares ownership", async () => {
  vi.useFakeTimers();
  const { child, owned } = utility();
  const retirement = new BackendRetirement(owned);
  const first = retirement.retire();
  expect(retirement.retire()).toBe(first);
  child.emit("message", { type: "shutdown-result", outcome: "closed" });
  expect(retirement.exited).toBe(false);
  await vi.advanceTimersByTimeAsync(BACKEND_GRACE_MS);
  expect(await first).toBe(false);
  expect(retirement.retiring).toBe(true);
  expect(retirement.exited).toBe(false);
  expect(owned.kill).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  child.emit("exit", 0);
  expect(retirement.exited).toBe(true);
  expect(await retirement.retire()).toBe(true);
});

it.each(["false", "throw"])("failed kill (%s) retains ownership until a late exit", async (mode) => {
  vi.useFakeTimers();
  const { child, owned } = utility(vi.fn(() => { if (mode === "throw") throw new Error("synthetic"); return false; }));
  const retirement = new BackendRetirement(owned);
  const done = retirement.retire();
  await vi.advanceTimersByTimeAsync(BACKEND_GRACE_MS);
  expect(await done).toBe(false);
  expect(retirement.exited).toBe(false);
  child.emit("exit");
  expect(await retirement.retire()).toBe(true);
});

it("observes synchronous kill exit and spontaneous exit without leftover timers or extra signals", async () => {
  vi.useFakeTimers();
  const { child, owned } = utility(vi.fn(() => { child.emit("exit"); return true; }));
  const retirement = new BackendRetirement(owned);
  expect(await retirement.retire()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  const spontaneous = utility();
  const alreadyGone = new BackendRetirement(spontaneous.owned);
  spontaneous.child.emit("exit");
  expect(await alreadyGone.retire()).toBe(true);
  expect(spontaneous.owned.kill).not.toHaveBeenCalled();
});

import { transformSync } from "esbuild";

// Execute the actual host functions with finite Electron boundaries, without booting the app.
function host(names: string[], deps: Record<string, unknown>, result: string) {
  const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  const functions = names.map((name) => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
    if (!match) throw new Error(`Missing host function ${name}`);
    return match[0];
  }).join("\n");
  return new Function(...Object.keys(deps), transformSync(functions, { loader: "ts" }).code + `\nreturn ${result};`)(...Object.values(deps));
}

it("actual stopBackend keeps the process owned while kill is pending, including timeout", async () => {
  vi.useFakeTimers();
  const { child, owned } = utility();
  const retirement = new BackendRetirement(owned);
  const h = host(["stopBackend"], { backend: owned, backendRetirement: retirement }, "{ stop: stopBackend, owner: () => backend }");
  const stopped = h.stop();
  expect(h.owner()).toBe(owned);
  await vi.advanceTimersByTimeAsync(BACKEND_GRACE_MS);
  expect(await stopped).toBe(false);
  expect(h.owner()).toBe(owned);
  child.emit("exit");
});

it("actual shutdown defers installation and releases draft holds when physical exit stalls", async () => {
  const release = vi.fn(), commit = vi.fn();
  const h = host(["shutdown"], {
    coordinateShutdown: async () => ({ outcome: "closed", draftsTimedOut: 0 }),
    flushWindows: vi.fn(), releaseWindows: vi.fn(), shutdownBackend: vi.fn(),
    releaseFlushWindows: release, stopBackend: async () => false,
    shutdownFlushes: [{ commit }], shutdownWaiters: new Map(),
    diagLog: { info: vi.fn(), warn: vi.fn() },
  }, "shutdown");
  expect(await h(false, "restart")).toBe("timeout");
  expect(commit).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it("actual install entry cannot report closed for another in-progress shutdown", async () => {
  const h = host(["shutdownForInstall"], { quitState: "stopping" }, "shutdownForInstall");
  expect(await h()).toBe("timeout");
});

it("failed forced retirement forgets logical shutdown waiters while retaining physical ownership", async () => {
  const waiters = new Map([[7, vi.fn()]]);
  const h = host(["shutdown"], {
    coordinateShutdown: async () => ({ outcome: "timeout", draftsTimedOut: 0 }),
    flushWindows: vi.fn(), shutdownBackend: vi.fn(), releaseFlushWindows: vi.fn(),
    stopBackend: async () => false, shutdownFlushes: [], shutdownWaiters: waiters,
    diagLog: { info: vi.fn(), warn: vi.fn() },
  }, "shutdown");
  for (let attempt = 0; attempt < 3; attempt++) {
    waiters.set(attempt, vi.fn());
    expect(await h(true, "quit")).toBe("timeout");
    expect(waiters.size).toBe(0);
  }
});

function hostBlock(start: string, end: string, deps: Record<string, unknown>, result: string) {
  const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  return new Function(...Object.keys(deps), transformSync(block, { loader: "ts" }).code + `\nreturn ${result};`)(...Object.values(deps));
}

it.each(["stale", "retiring"])("actual message callback ignores %s generation readiness/ACK/side effects", (mode) => {
  const child = new EventEmitter();
  hostBlock('  child.on("message", (msg:', '  child.on("exit",', {
    child, backend: mode === "stale" ? {} : child, retirement: { retiring: mode === "retiring" },
  }, "undefined");
  // Missing effect dependencies make any incorrectly admitted message fail loudly.
  child.emit("message", { type: "ready" });
  child.emit("message", { type: "shutdown-result", id: 1, outcome: "closed" });
  child.emit("message", { type: "policy", localMode: false });
});

function exitHost(o: { stale?: boolean; stopping?: boolean; retiring?: boolean }) {
  const { child, owned } = utility();
  const retirement = new BackendRetirement(owned);
  const restart = vi.fn(), start = vi.fn(), resolveReady = vi.fn();
  const timers: (() => void)[] = [];
  const h = hostBlock('  child.on("exit", (code)', '  child.postMessage({\n    type: "init",', {
    child, backend: o.stale ? {} : child, backendRetirement: retirement,
    retirement, resolveReady, releaseReadyWaiters: vi.fn(),
    shutdownWaiters: new Map(), sendsIdleWaiters: [], quitState: o.stopping ? "stopping" : "running",
    restartEngine: restart, startBackend: start, instance: 3, backendInstance: 3,
    mainDiag: { backendExited: vi.fn(), setEngine: vi.fn() }, restarts: { attempt: 1, exited: () => 500 },
    diagLog: { info: vi.fn(), error: vi.fn() }, windows: [],
    setTimeout: (fn: () => void) => timers.push(fn),
  }, "{ owner: () => backend, stopping: () => { quitState = 'stopping'; }, replaceGeneration: () => { backendInstance++; } }");
  return { ...h, child, retirement, restart, start, resolveReady, timers };
}

it("actual exit callback ignores stale exits and late retirement exit restarts exactly once", async () => {
  vi.useFakeTimers();
  const stale = exitHost({ stale: true });
  stale.child.emit("exit", 0);
  expect(stale.resolveReady).not.toHaveBeenCalled();
  expect(stale.restart).not.toHaveBeenCalled();
  const h = exitHost({});
  const done = h.retirement.retire();
  await vi.advanceTimersByTimeAsync(BACKEND_GRACE_MS);
  expect(await done).toBe(false);
  expect(h.owner()).toBe(h.child);
  expect(h.restart).not.toHaveBeenCalled();
  h.child.emit("exit", 0);
  h.child.emit("exit", 0);
  expect(h.owner()).toBeNull();
  expect(h.resolveReady).toHaveBeenCalledTimes(1);
  expect(h.restart).toHaveBeenCalledTimes(1);
});

it.each(["shutdown", "generation"])("actual crash restart timer refuses after %s changes", (mode) => {
  const h = exitHost({});
  h.child.emit("exit", 1);
  expect(h.timers).toHaveLength(1);
  if (mode === "shutdown") h.stopping(); else h.replaceGeneration();
  h.timers[0]!();
  expect(h.start).not.toHaveBeenCalled();
});

it("actual deliberate exit during shutdown never restarts", async () => {
  const h = exitHost({ stopping: true });
  const done = h.retirement.retire();
  h.child.emit("exit", 0);
  expect(await done).toBe(true);
  expect(h.restart).not.toHaveBeenCalled();
  expect(h.timers).toHaveLength(0);
});

it.each(["generation", "document", "retirement"])("actual renderer readiness rejects a changed %s", async (mode) => {
  let ready!: () => void;
  const backendReady = new Promise<void>((r) => { ready = r; });
  const child = {}, retirement = { retiring: false }, webContents = { mainFrame: {}, postMessage: vi.fn() };
  const h = host(["connectWindow"], { backend: child, backendRetirement: retirement, backendReady }, "{ connect: connectWindow, replace: () => { backend = {}; } }");
  const done = h.connect({ webContents, isDestroyed: () => false });
  if (mode === "generation") h.replace();
  if (mode === "document") webContents.mainFrame = {};
  if (mode === "retirement") retirement.retiring = true;
  ready(); await done;
  expect(webContents.postMessage).not.toHaveBeenCalled();
});

it("actual failed quit restores windows and retains the single-instance owner", async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const window = { isDestroyed: () => false, hide: vi.fn(), show: vi.fn() };
  const quitting = vi.fn();
  const h = hostBlock('  app.on("before-quit",', '\n}\n', {
    app, quitState: "running", windows: [window], shutdown: async () => "timeout", backend: {},
    enableReload: vi.fn(), updates: { quitting },
  }, "{ state: () => quitState }");
  app.emit("before-quit", { preventDefault: vi.fn() });
  await Promise.resolve(); await Promise.resolve();
  expect(window.hide).toHaveBeenCalledTimes(1);
  expect(window.show).toHaveBeenCalledTimes(1);
  expect(h.state()).toBe("running");
  expect(app.quit).not.toHaveBeenCalled();
  expect(quitting).not.toHaveBeenCalled();
});
