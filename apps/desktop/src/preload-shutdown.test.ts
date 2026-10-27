import { afterAll, expect, it, vi } from "vitest";
const { expose, events, send } = vi.hoisted(() => ({
  expose: vi.fn<(name: string, api: { onFlushDrafts(flush: () => Promise<boolean>, acquire?: () => (() => void) | null): () => void }) => void>(),
  events: new Map<string, Set<(...args: unknown[]) => void>>(), send: vi.fn(),
}));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: {
  send, sendSync: vi.fn(() => "synthetic"), invoke: vi.fn(),
  on: (name: string, fn: (...args: unknown[]) => void) => { const set = events.get(name) ?? new Set(); set.add(fn); events.set(name, set); },
  removeListener: (name: string, fn: (...args: unknown[]) => void) => events.get(name)?.delete(fn),
} }));
vi.stubGlobal("window", new EventTarget());
await import("./preload");
afterAll(() => vi.unstubAllGlobals());
const bridge = expose.mock.calls[0]![1];
const emit = (name: string, ...args: unknown[]) => { for (const fn of events.get(name) ?? []) fn({}, ...args); };

it("preload holds synchronously before ACK and only matching release can finish each request", async () => {
  const order: string[] = [], held = new Set<number>(), answers: ((saved: boolean) => void)[] = [];
  let token = 0;
  const stop = bridge.onFlushDrafts(() => { order.push("flush"); return new Promise((r) => answers.push(r)); }, () => {
    const id = ++token; held.add(id); order.push("hold"); return () => { held.delete(id); };
  });
  emit("terno:flush-drafts", 10, true); expect(order).toEqual(["hold", "flush"]); expect(held.size).toBe(1);
  emit("terno:flush-release", 10); emit("terno:flush-drafts", 11, true); emit("terno:flush-release", 10);
  expect([...held]).toEqual([2]); answers[0]!(true); await Promise.resolve(); await Promise.resolve();
  expect([...held]).toEqual([2]); expect(send).toHaveBeenCalledWith("terno:flush-done", 10, true);
  emit("terno:flush-release", 11); expect(held.size).toBe(0); answers[1]!(false); stop();
});

it("unavailable admission refuses before flush; forced quit still uses the bounded ordinary flush", async () => {
  const flush = vi.fn(async () => true);
  const stop = bridge.onFlushDrafts(flush, () => null);
  emit("terno:flush-drafts", 20, true); expect(flush).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledWith("terno:flush-done", 20, false);
  emit("terno:flush-drafts", 21, false); await Promise.resolve(); await Promise.resolve();
  expect(flush).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledWith("terno:flush-done", 21, true); stop();
});
