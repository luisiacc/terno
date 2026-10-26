import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connectivity, FOCUS_RETRY_EVERY_MS, OFFLINE_RETRY_MS, RETRY_DELAYS_MS, SETTLE_MS, type NetReason } from "./connectivity";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** a Connectivity on fake timers whose sync fails or succeeds as the test says */
function rig(o: { online?: boolean; random?: number; healthy?: () => boolean } = {}) {
  const syncs: { id: number; at: number }[] = [];
  const reconnects: NetReason[] = [];
  let offline = 0;
  const c: Connectivity = new Connectivity(
    {
      sync: (id) => {
        syncs.push({ id, at: Date.now() });
        // the pass ends on the spot: a failure schedules the next try, a success clears it
        if (o.healthy?.()) c.succeeded(id);
        else c.failed(id, c.epoch);
      },
      reconnect: (reason) => reconnects.push(reason),
      offline: () => offline++,
    },
    { online: o.online, random: () => o.random ?? 0.5 },
  );
  return { c, syncs, reconnects, offlineCalls: () => offline };
}

describe("Connectivity (plan 20)", () => {
  it("retries a failing account on the schedule (2 s, 5 s, 15 s … then every 5 min), ±20 % jitter", () => {
    const { c, syncs } = rig();
    c.track(1);
    const t0 = Date.now();
    c.failed(1, c.epoch);
    vi.advanceTimersByTime(40 * 60_000);
    const gaps = syncs.map((s, i) => s.at - (i ? syncs[i - 1]!.at : t0));
    expect(gaps.slice(0, RETRY_DELAYS_MS.length)).toEqual([...RETRY_DELAYS_MS]);
    expect(gaps.slice(RETRY_DELAYS_MS.length).every((g) => g === OFFLINE_RETRY_MS)).toBe(true);
    // the jitter's bounds
    for (const random of [0, 0.999]) {
      const r = rig({ random });
      r.c.track(1);
      const at = r.c.failed(1, r.c.epoch)!.at - Date.now();
      expect(at).toBeGreaterThanOrEqual(1600);
      expect(at).toBeLessThanOrEqual(2400);
    }
  });

  it("a success starts the schedule over", () => {
    let healthy = false;
    const { c, syncs } = rig({ healthy: () => healthy });
    c.track(1);
    c.failed(1, c.epoch);
    vi.advanceTimersByTime(2000 + 5000);
    expect(syncs).toHaveLength(2);
    healthy = true;
    vi.advanceTimersByTime(15_000);
    expect(syncs).toHaveLength(3);
    expect(c.failures(1)).toBe(0);
    expect(c.pending(1)).toBe(false);
    expect(c.timers).toBe(0);
    healthy = false;
    expect(c.failed(1, c.epoch)!.at - Date.now()).toBe(2000);
  });

  it("a network change settles, reconnects once, starts every schedule over and syncs every account, jittered", () => {
    const { c, syncs, reconnects } = rig({ healthy: () => true });
    for (const id of [1, 2, 3]) c.track(id);
    c.failed(1, c.epoch);
    for (let i = 0; i < 6; i++) c.failed(2, c.epoch);
    // a VPN connect is a burst: route, DNS, interface, then a wake from another source
    c.network(true, "network");
    vi.advanceTimersByTime(100);
    c.network(true, "online");
    vi.advanceTimersByTime(100);
    c.network(true, "wake");
    expect(reconnects).toEqual([]);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(reconnects).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reconnects).toEqual(["wake"]);
    expect([c.failures(1), c.failures(2)]).toEqual([0, 0]);
    vi.advanceTimersByTime(250);
    expect(syncs.map((s) => s.id).sort()).toEqual([1, 2, 3]);
    expect(c.timers).toBe(0);
  });

  it("a pass that started before a reconnect doesn't count its failure", () => {
    const { c } = rig();
    c.track(1);
    const epoch = c.epoch;
    c.network(true, "network");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(c.failed(1, epoch)).toBeNull();
    expect(c.failures(1)).toBe(0);
  });

  it("offline: one probe per account every 5 min, no reconnect; online cuts it short", () => {
    const { c, syncs, reconnects, offlineCalls } = rig();
    for (const id of [1, 2]) c.track(id);
    c.failed(1, c.epoch);
    c.network(false, "offline");
    c.network(false, "offline");
    expect(offlineCalls()).toBe(1);
    expect(c.online).toBe(false);
    vi.advanceTimersByTime(OFFLINE_RETRY_MS - 1);
    expect(syncs).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(syncs.map((s) => s.id).sort()).toEqual([1, 2]);
    // still offline: their failures wait for the cap again
    expect(c.retryAt(1)! - Date.now()).toBeGreaterThanOrEqual(OFFLINE_RETRY_MS * 0.8);
    c.network(true, "online");
    vi.advanceTimersByTime(SETTLE_MS + 250);
    expect(reconnects).toEqual(["online"]);
    expect(c.online).toBe(true);
    expect(syncs.length).toBe(4);
  });

  it("offline right after an online event: the settle is cancelled (no reconnect on a dead network)", () => {
    const { c, reconnects } = rig();
    c.track(1);
    c.network(true, "online");
    c.network(false, "offline");
    vi.advanceTimersByTime(10_000);
    expect(reconnects).toEqual([]);
    expect(c.online).toBe(false);
  });

  it("a simulated hour offline: ≤ 12 attempts an account, ≤ 1 timer an account", () => {
    const { c, syncs } = rig({ online: false });
    for (const id of [1, 2, 3]) c.track(id);
    for (const id of [1, 2, 3]) c.failed(id, c.epoch);
    let maxTimers = 0;
    for (let s = 0; s < 3600; s++) {
      vi.advanceTimersByTime(1000);
      maxTimers = Math.max(maxTimers, c.timers, vi.getTimerCount());
    }
    for (const id of [1, 2, 3]) expect(syncs.filter((x) => x.id === id).length).toBeLessThanOrEqual(12);
    expect(maxTimers).toBeLessThanOrEqual(3);
  });

  it("a simulated hour online with the server down: the schedule's attempts, nothing more", () => {
    const { c, syncs } = rig();
    c.track(1);
    c.failed(1, c.epoch);
    vi.advanceTimersByTime(3_600_000);
    // 2+5+15+30+60+120 s ≈ 4 min, then every 5 min: 6 + 11
    expect(syncs.length).toBe(17);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("focus retries offline accounts at most every 15 s, and nothing when all is well", () => {
    const { c } = rig();
    for (const id of [1, 2]) c.track(id);
    expect(c.retryNow(null, "focus")).toEqual([]);
    c.failed(2, c.epoch);
    expect(c.retryNow(null, "focus")).toEqual([2]);
    expect(c.pending(2)).toBe(false);
    c.failed(2, c.epoch);
    expect(c.retryNow(null, "focus")).toEqual([]);
    vi.advanceTimersByTime(FOCUS_RETRY_EVERY_MS);
    expect(c.retryNow(null, "focus")).toEqual([2]);
  });

  it("the user retries any account at once, the schedule starting over", () => {
    const { c } = rig();
    for (const id of [1, 2]) c.track(id);
    for (let i = 0; i < 5; i++) c.failed(1, c.epoch);
    expect(c.retryNow(1, "user")).toEqual([1]);
    expect(c.failures(1)).toBe(0);
    expect(c.retryNow(null, "user").sort()).toEqual([1, 2]);
    expect(c.retryNow(9, "user")).toEqual([]);
  });

  it("an op's network failure is an outage while offline, while its account fails, or just after a change", () => {
    const { c } = rig({ healthy: () => true });
    c.track(1);
    expect(c.inOutage(1)).toBe(false);
    c.failed(1, c.epoch);
    expect(c.inOutage(1)).toBe(true);
    c.succeeded(1);
    c.network(true, "network");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(c.inOutage(1)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(c.inOutage(1)).toBe(false);
    c.network(false, "offline");
    expect(c.inOutage(1)).toBe(true);
  });

  it("untrack and stop leave nothing that fires later", () => {
    const { c, syncs } = rig();
    for (const id of [1, 2]) c.track(id);
    c.failed(1, c.epoch);
    c.failed(2, c.epoch);
    c.untrack(1);
    c.network(true, "network");
    vi.advanceTimersByTime(SETTLE_MS);
    c.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    expect(syncs).toEqual([]);
    c.network(true, "online");
    expect(vi.getTimerCount()).toBe(0);
  });
});
