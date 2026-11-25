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

describe("plan 271: rows that move", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("the feed's rows reflow for a window, and a window armed for nothing stops at once", async () => {
    const { armReflow, reflowing, stopReflow } = await import("./flash");
    // (jsdom runs no animations)
    HTMLElement.prototype.getAnimations = () => [];
    document.body.innerHTML = `<div data-feed-rows></div><div role="listbox"></div>`;
    const feed = document.querySelector("[data-feed-rows]")!;
    armReflow("feed");
    expect(reflowing(feed)).toBe(true);
    expect(document.querySelector("[role=listbox]")!.hasAttribute("data-reflow")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(reflowing(feed)).toBe(false);
    armReflow("feed");
    stopReflow("feed");
    expect(reflowing(feed)).toBe(false);
  });

  it("a leaving row's copy fades where it's painted, found by nothing (no ids, keys or names), inert, and goes when its fade ends", async () => {
    const { leaveCopy } = await import("./flash");
    document.body.innerHTML = `<div data-feed-rows><div data-index="3" style="transform: translateY(40px)"><div data-row-id="r1" data-thread-id="9" data-testid="wm-item"><button id="b">Done</button></div></div></div>`;
    const animations: { finish: () => void }[] = [];
    HTMLElement.prototype.animate = function () {
      const a = { onfinish: null as null | (() => void), oncancel: null, finish: () => a.onfinish?.() };
      animations.push(a);
      return a as unknown as Animation;
    };
    const row = document.querySelector<HTMLElement>("[data-index]")!;
    leaveCopy(row);
    const copy = row.parentElement!.lastElementChild as HTMLElement;
    expect(copy).not.toBe(row);
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    expect(copy.inert).toBe(true);
    expect(copy.style.transform).toBe("translateY(40px)");
    expect(copy.querySelectorAll("[data-row-id], [data-thread-id], [data-testid], [data-index], [id]")).toHaveLength(0);
    expect(copy.hasAttribute("data-index")).toBe(false);
    animations[0]!.finish();
    expect(copy.isConnected).toBe(false);
  });
});
