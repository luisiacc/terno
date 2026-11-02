import { describe, expect, it } from "vitest";
import { Preparation } from "./preparing";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

describe("the backup as a shutdown sees it (plan 112, Codex code review #1)", () => {
  it("a shutdown during the backup ends it, waits for it, and the mailbox isn't opened after", async () => {
    const p = new Preparation();
    const work = deferred<string>();
    const run = p.run(work.promise);
    let cancelled = 0;
    let stoppedAt = 0;
    const stop = p.stop(() => cancelled++).then(() => (stoppedAt = Date.now()));
    await Promise.resolve();
    expect(cancelled).toBe(1);
    expect(stoppedAt).toBe(0);
    // the lock and checkpoint can't be cut short: the backup still ends (here, well) and only then does stop answer
    work.resolve("plan");
    await expect(run).resolves.toBe("plan");
    await stop;
    expect(stoppedAt).toBeGreaterThan(0);
    expect(p.stopped).toBe(true);
  });

  it("a backup the cancel ends (cp killed) rejects its run, and the stop still answers", async () => {
    const p = new Preparation();
    const work = deferred<string>();
    const run = p.run(work.promise);
    const stop = p.stop(() => work.reject(new Error("cp killed")));
    await expect(run).rejects.toThrow("cp killed");
    await stop;
    expect(p.stopped).toBe(true);
  });

  it("a shutdown with no backup running changes nothing", async () => {
    const p = new Preparation();
    let cancelled = 0;
    await p.stop(() => cancelled++);
    expect(cancelled).toBe(0);
    expect(p.stopped).toBe(false);
    await expect(p.run(Promise.resolve(1))).resolves.toBe(1);
    await p.stop(() => cancelled++);
    expect(p.stopped).toBe(false);
  });
});
