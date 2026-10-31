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
