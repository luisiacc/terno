import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUICK_CHECK_EVERY_MS, QUICK_CHECKS_FOR_MS, QuickChecks } from "./quick-checks";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** QuickChecks on fake timers, with the times of its checks (from the rig's start) */
function rig() {
  const t0 = Date.now();
  const checks: number[] = [];
  const q = new QuickChecks({ check: () => void checks.push(Date.now() - t0) });
  return { q, checks };
}

describe("QuickChecks (plan 176)", () => {
  it("a focus checks at once, then every 5 s for a minute, then nothing and no timer", () => {
    const { q, checks } = rig();
    q.focus("w", true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(checks).toEqual(Array.from({ length: QUICK_CHECKS_FOR_MS / QUICK_CHECK_EVERY_MS + 1 }, (_, i) => i * QUICK_CHECK_EVERY_MS));
    expect(q.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a blur stops it at once and leaves no timer", () => {
    const { q, checks } = rig();
    q.focus("w", true);
    vi.advanceTimersByTime(12_000);
    q.focus("w", false);
    vi.advanceTimersByTime(60_000);
    expect(checks).toEqual([0, 5_000, 10_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a refocus starts the minute over, and one within 5 s of the last check waits for its slot", () => {
    const { q, checks } = rig();
    q.focus("w", true);
    vi.advanceTimersByTime(6_000);
    q.focus("w", false);
    q.focus("w", true);
    vi.advanceTimersByTime(3_000);
    // the last check was at 5 s: the next is at 10 s, not at the refocus (6 s)
    expect(checks).toEqual([0, 5_000]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(checks.at(-1)).toBeLessThanOrEqual(6_000 + QUICK_CHECKS_FOR_MS);
    expect(checks.at(-1)).toBeGreaterThan(6_000 + QUICK_CHECKS_FOR_MS - QUICK_CHECK_EVERY_MS);
    expect(checks.slice(1).every((at, i) => at - checks[i]! === QUICK_CHECK_EVERY_MS)).toBe(true);
  });

  it("a focus while the checks run extends the minute without a second timer", () => {
    const { q, checks } = rig();
    q.focus("w", true);
    vi.advanceTimersByTime(30_000);
    q.focus("w", true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(checks.at(-1)).toBe(90_000);
  });

  it("two windows: one blurring while the other has focus goes on, in either order; the last blur stops it", () => {
    for (const order of [["a", "b"], ["b", "a"]] as const) {
      const { q, checks } = rig();
      q.focus("a", true);
      // window a hands focus to b: the two messages race
      if (order[0] === "a") { q.focus("a", false); q.focus("b", true); }
      else { q.focus("b", true); q.focus("a", false); }
      vi.advanceTimersByTime(20_000);
      expect(checks).toEqual([0, 5_000, 10_000, 15_000, 20_000]);
      q.focus("b", false);
      vi.advanceTimersByTime(60_000);
      expect(checks).toHaveLength(5);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("a disconnected client counts as a blur", () => {
    const { q, checks } = rig();
    q.focus("w", true);
    q.disconnected("w");
    vi.advanceTimersByTime(60_000);
    expect(checks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() clears it, and nothing starts after", () => {
    const { q, checks } = rig();
    q.focus("w", true);
    vi.advanceTimersByTime(1);
    q.stop();
    q.focus("w", true);
    vi.advanceTimersByTime(60_000);
    expect(checks).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
