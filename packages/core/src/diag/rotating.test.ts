import { describe, expect, it } from "vitest";
import { RotatingLog, type RotatingFs } from "./rotating";

declare const TextEncoder: { new (): { encode(s: string): Uint8Array } };

describe("RotatingLog", () => {
  function memFs(failAppend = false) {
    const files = new Map<string, string>();
    const fs: RotatingFs = {
      appendFile: async (p, d) => {
        if (failAppend) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        files.set(p, (files.get(p) ?? "") + d);
      },
      appendFileSync: (p, d) => void files.set(p, (files.get(p) ?? "") + d),
      size: async (p) => files.get(p)?.length ?? 0,
      sizeSync: (p) => files.get(p)?.length ?? 0,
      rename: async (a, b) => {
        if (!files.has(a)) throw new Error("ENOENT");
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      renameSync: (a, b) => {
        if (!files.has(a)) throw new Error("ENOENT");
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      remove: async (p) => void files.delete(p),
      removeSync: (p) => void files.delete(p),
    };
    return { fs, files };
  }

  it("rotates at the cap and keeps N files", async () => {
    const { fs, files } = memFs();
    const logFile = new RotatingLog("main.jsonl", fs, { maxBytes: 100, maxFiles: 3, delayMs: 0 });
    for (let i = 0; i < 20; i++) {
      logFile.write(`{"i":${i},"pad":"${"x".repeat(20)}"}`);
      await logFile.flush();
    }
    expect([...files.keys()].sort()).toEqual(["main.jsonl", "main.jsonl.1", "main.jsonl.2"]);
    for (const v of files.values()) expect(v.length).toBeLessThanOrEqual(100);
    expect(files.get("main.jsonl")).toContain('"i":19');
  });

  it("no file ever passes the byte cap, counted in UTF-8 (review finding 7)", async () => {
    const { fs, files } = memFs();
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    const logFile = new RotatingLog("big.jsonl", fs, { maxBytes: 2 * 1024 * 1024, maxFiles: 5, maxQueued: 10_000 });
    // 5,000 lines of 1,000 characters, half of them two bytes each: one batch, ~7.5 MB
    for (let i = 0; i < 5000; i++) logFile.write(`{"i":${i},"t":"${"ñ".repeat(500)}${"x".repeat(480)}"}`);
    // and one line too long to keep at all
    logFile.write(`{"t":"${"x".repeat(100_000)}"}`);
    await logFile.flush();
    expect(files.size).toBeLessThanOrEqual(5);
    for (const [name, content] of files) expect(bytes(content), name).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(logFile.dropped).toBe(1);
    // the newest lines are the ones kept
    expect(files.get("big.jsonl")).toContain('"i":4999');
    const sync = new RotatingLog("sync.jsonl", fs, { maxBytes: 4096, maxFiles: 3, delayMs: 10_000 });
    for (let i = 0; i < 200; i++) sync.write(`{"i":${i},"t":"${"é".repeat(40)}"}`);
    sync.flushSync();
    for (const [name, content] of files) if (name.startsWith("sync")) expect(bytes(content), name).toBeLessThanOrEqual(4096);
  });

  it("flushSync writes what is queued at once", () => {
    const { fs, files } = memFs();
    const logFile = new RotatingLog("b.jsonl", fs, { delayMs: 10_000 });
    logFile.write("a");
    logFile.write("b");
    logFile.flushSync();
    expect(files.get("b.jsonl")).toBe("a\nb\n");
  });

  it("a full disk drops the batch silently", async () => {
    const { fs } = memFs(true);
    const errors: unknown[] = [];
    const logFile = new RotatingLog("c.jsonl", fs, { delayMs: 0, onError: (e) => errors.push(e) });
    logFile.write("x");
    await expect(logFile.flush()).resolves.toBeUndefined();
    expect(logFile.dropped).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
