// @vitest-environment jsdom
/**
 * A message the reader was sent to (the owner, 2026-11-19): its ring's rule holds for LOCATE_MS and goes; sent to it again
 * while it shows, the rule goes and comes back two frames later (its breaths start over), and holds a whole LOCATE_MS again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCATE_MS, locateMessage } from "./flash";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

const sheet = () => document.getElementById("terno-flash")?.textContent ?? "";
const ringed = (id: number) => sheet().includes(`article[data-message-id="${id}"]::after`);

describe("locateMessage", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] }));
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("rings the message for LOCATE_MS, two breaths of half that each, then drops the rule", () => {
    locateMessage(7);
    expect(ringed(7)).toBe(true);
    expect(sheet()).toContain(`animation-duration:${LOCATE_MS / 2}ms`);
    vi.advanceTimersByTime(LOCATE_MS);
    expect(ringed(7)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(ringed(7)).toBe(false);
  });

  it("again while it shows: off at once, back two frames later, and a whole LOCATE_MS from then", () => {
    locateMessage(7);
    vi.advanceTimersByTime(LOCATE_MS - 200);
    locateMessage(7);
    expect(ringed(7)).toBe(false);
    vi.advanceTimersToNextFrame();
    expect(ringed(7)).toBe(false);
    vi.advanceTimersToNextFrame();
    expect(ringed(7)).toBe(true);
    // the first one's timer is gone: it doesn't cut the new ring short
    vi.advanceTimersByTime(LOCATE_MS);
    expect(ringed(7)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(ringed(7)).toBe(false);
  });

  it("another message while one shows: only the new one is ringed", () => {
    locateMessage(7);
    locateMessage(9);
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(ringed(9)).toBe(true);
    expect(ringed(7)).toBe(false);
  });
});
