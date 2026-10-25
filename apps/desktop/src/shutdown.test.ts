import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinateShutdown, DRAFTS_DEADLINE_MS, SEND_DEADLINE_MS, type BackendOutcome, type ShutdownDeps } from "./shutdown";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

function deps(o: { windows: (() => Promise<void>)[]; backend: ((force: boolean, deadlineMs: number) => Promise<BackendOutcome>) | null; order?: string[] }): ShutdownDeps {
  return {
    flushWindows: () => o.windows.map((w) => w()),
    shutdownBackend: ({ force, deadlineMs }) => {
      o.order?.push("backend");
      return o.backend ? o.backend(force, deadlineMs) : null;
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

describe("main: the coordinated shutdown", () => {
  it("flushes every window's drafts before asking the backend to close (it saves them)", async () => {
    const order: string[] = [];
    const flush = (name: string, ms: number) => () => later(ms, undefined).then(() => void order.push(name));
    const done = coordinateShutdown(deps({ windows: [flush("w1", 50), flush("w2", 200)], backend: async () => "closed", order }), { force: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(await done).toEqual({ outcome: "closed", draftsTimedOut: 0 });
    expect(order).toEqual(["w1", "w2", "backend"]);
  });

  it("a slow window holds the quit for at most the drafts deadline, and is counted", async () => {
    const order: string[] = [];
    const done = coordinateShutdown(deps({ windows: [() => later(60_000, undefined), () => Promise.resolve()], backend: async () => "closed", order }), { force: true });
    await vi.advanceTimersByTimeAsync(DRAFTS_DEADLINE_MS - 1);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toEqual({ outcome: "closed", draftsTimedOut: 1 });
    expect(order).toEqual(["backend"]);
    // no timer left behind (an idle app spins nothing)
    expect(vi.getTimerCount()).toBe(1); // only the never-acking window's own timer from this test
  });

  it("a window whose flush fails still lets the quit go on", async () => {
    const done = coordinateShutdown(deps({ windows: [() => Promise.reject(new Error("gone"))], backend: async () => "closed" }), { force: true });
    expect(await done).toEqual({ outcome: "closed", draftsTimedOut: 0 });
  });

  it("an update's restart is not forced: a send past the deadline comes back as 'sending' (the install waits)", async () => {
    const seen: { force: boolean; deadlineMs: number }[] = [];
    const backend = (force: boolean, deadlineMs: number) => {
      seen.push({ force, deadlineMs });
      return later(deadlineMs, force ? ("forced" as const) : ("sending" as const));
    };
    const update = coordinateShutdown(deps({ windows: [], backend }), { force: false });
    await vi.advanceTimersByTimeAsync(SEND_DEADLINE_MS);
    expect((await update).outcome).toBe("sending");
    const quit = coordinateShutdown(deps({ windows: [], backend }), { force: true });
    await vi.advanceTimersByTimeAsync(SEND_DEADLINE_MS);
    expect((await quit).outcome).toBe("forced");
    expect(seen).toEqual([
      { force: false, deadlineMs: SEND_DEADLINE_MS },
      { force: true, deadlineMs: SEND_DEADLINE_MS },
    ]);
  });

  it("a backend that never answers is given up on after the deadline and the grace period", async () => {
    const done = coordinateShutdown(deps({ windows: [], backend: () => new Promise(() => {}) }), { force: true, sendDeadlineMs: 1000, graceMs: 500 });
    await vi.advanceTimersByTimeAsync(1499);
    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await done).outcome).toBe("timeout");
  });

  it("no backend running (it crashed, or stopped): nothing to wait for", async () => {
    expect(await coordinateShutdown(deps({ windows: [], backend: null }), { force: true })).toEqual({ outcome: "closed", draftsTimedOut: 0 });
  });
});
