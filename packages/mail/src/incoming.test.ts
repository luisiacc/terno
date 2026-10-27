import { describe, expect, it, vi } from "vitest";
import { IncomingCapacityError, IncomingReads } from "./incoming";

const signal = () => new AbortController().signal;
const turn = () => Promise.resolve();

describe("incoming read admission", () => {
  it("keeps six active readers and releases each lease once", async () => {
    const reads = new IncomingReads();
    const leases = await Promise.all(Array.from({ length: 6 }, () => reads.acquire(1, signal())));
    const admitted: number[] = [];
    const waiting = reads.acquire(2, signal()).then((release) => { admitted.push(2); return release; });
    await turn(); expect(admitted).toEqual([]);
    leases[0]!(); leases[0]!();
    const release = await waiting;
    expect(admitted).toEqual([2]);
    const another = reads.acquire(3, signal()).then((next) => { admitted.push(3); return next; });
    await turn(); expect(admitted).toEqual([2]);
    release(); (await another)();
    for (const lease of leases) lease();
    reads.close();
  });

  it("rotates waiting accounts without letting new jobs jump the queue", async () => {
    const reads = new IncomingReads(1);
    const first = await reads.acquire(1, signal());
    const order: string[] = [];
    const wait = (account: number, label: string) => reads.acquire(account, signal()).then((release) => { order.push(label); return release; });
    const a1 = wait(1, "a1"), a2 = wait(1, "a2"), b = wait(2, "b"), c = wait(3, "c");
    first(); (await a1)(); await turn();
    expect(order).toEqual(["a1", "b"]);
    const late = wait(1, "late");
    (await b)(); (await c)(); (await a2)(); (await late)();
    expect(order).toEqual(["a1", "b", "c", "a2", "late"]);
    reads.close();
  });

  it("removes canceled waiters and their listeners, preserving sibling admission", async () => {
    const reads = new IncomingReads(1), abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const first = await reads.acquire(1, signal());
    const reason = new DOMException("Synthetic cancellation", "AbortError");
    const canceled = expect(reads.acquire(1, abort.signal)).rejects.toBe(reason);
    const sibling = reads.acquire(2, signal());
    abort.abort(reason); await canceled;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    first(); (await sibling)(); reads.close();
  });

  it("bounds queued descriptors and does not classify local pressure as offline or auth", async () => {
    const reads = new IncomingReads(1, 1);
    const first = await reads.acquire(1, signal());
    const queued = reads.acquire(2, signal());
    await expect(reads.acquire(3, signal())).rejects.toMatchObject({ name: "IncomingCapacityError", retryable: false, network: false, ambiguous: false, expected: true, i18n: { key: "errors.mail.processingBusy" } });
    const error = new IncomingCapacityError();
    expect(error.message).not.toMatch(/token|subject|account/);
    first(); (await queued)(); reads.close();
  });

  it("closes idle and queued work without timers and refuses later admission", async () => {
    vi.useFakeTimers();
    try {
      const reads = new IncomingReads(1), ctl = new AbortController();
      const first = await reads.acquire(1, signal());
      const remove = vi.spyOn(ctl.signal, "removeEventListener");
      const queued = expect(reads.acquire(2, ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
      reads.close(); reads.close(); await queued;
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      first();
      await expect(reads.acquire(3, signal())).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("honors already-canceled admission without taking a lease", async () => {
    const reads = new IncomingReads(1), ctl = new AbortController();
    ctl.abort();
    await expect(reads.acquire(1, ctl.signal)).rejects.toBe(ctl.signal.reason);
    (await reads.acquire(2, signal()))(); reads.close();
  });
});
