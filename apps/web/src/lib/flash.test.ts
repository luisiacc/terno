// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// the app's stores read the motion preference as they load
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
const { useAppearance } = await import("~/lib/appearance");
const { arrive, motionNow } = await import("~/lib/flash");

/** Element.animate as jsdom lacks it: what was asked, and the running ones getAnimations reports */
function recordAnimations() {
  const runs: { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean }[] = [];
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const run = { el: this, keyframes, options, cancelled: false };
    runs.push(run);
    return { id: options.id, cancel: () => (run.cancelled = true) } as unknown as Animation;
  } as typeof Element.prototype.animate;
  Element.prototype.getAnimations = function (this: Element) {
    return runs.filter((r) => r.el === this && !r.cancelled).map((r) => ({ id: r.options.id, cancel: () => (r.cancelled = true) }) as unknown as Animation);
  };
  return runs;
}

afterEach(() => {
  useAppearance.setState({ motionMs: 75, reducedMotion: false });
  document.documentElement.classList.remove("motion-paused");
});

describe("arrive (plans 195–199)", () => {
  it("rises 4 px into place at --motion-slow, one at a time per element; nothing with motion off, reduced or paused", () => {
    const runs = recordAnimations();
    const el = document.createElement("div");
    useAppearance.setState({ motionMs: 75, reducedMotion: false });
    arrive(el);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.keyframes).toEqual([{ opacity: 0, translate: "0 4px" }, { opacity: 1, translate: "0 0" }]);
    expect(runs[0]!.options).toMatchObject({ id: "arrive", duration: 100 });
    // again: the first gives way
    arrive(el);
    expect(runs[0]!.cancelled).toBe(true);
    useAppearance.setState({ motionMs: 50 });
    arrive(el);
    expect(runs[2]!.options.duration).toBe(67);
    for (const off of [() => useAppearance.setState({ motionMs: 0 }), () => useAppearance.setState({ motionMs: 75, reducedMotion: true }), () => { useAppearance.setState({ reducedMotion: false }); document.documentElement.classList.add("motion-paused"); }]) {
      off();
      expect(motionNow()).toBe(0);
      arrive(el);
    }
    expect(runs).toHaveLength(3);
  });
});
