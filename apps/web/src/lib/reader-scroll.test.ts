// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} })));
const { useAppearance } = await import("./appearance");
const { cancelReaderScroll, keepInView } = await import("./reader-scroll");

const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

describe("keepInView", () => {
  let frames: FrameRequestCallback[], now: number, scroller: HTMLDivElement, el: HTMLDivElement, input: HTMLInputElement;
  const frame = () => frames.splice(0).forEach((cb) => cb(now));
  beforeEach(() => {
    frames = []; now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => { frames.length = 0; });
    useAppearance.setState({ motionMs: 80, reducedMotion: false });
    scroller = document.createElement("div"); el = document.createElement("div"); input = document.createElement("input");
    scroller.append(el, input); document.body.append(scroller);
    scroller.getBoundingClientRect = () => rect(0, 900);
    el.getBoundingClientRect = () => rect(800 - scroller.scrollTop, 600);
  });
  afterEach(() => { cancelReaderScroll(); scroller.remove(); vi.restoreAllMocks(); });

  it("a key typed into a field doesn't call off the opening scroll; one that scrolls the reader does", () => {
    keepInView(el, scroller);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    frame();
    expect(scroller.scrollTop).toBeGreaterThan(0);
    const after = scroller.scrollTop;
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    frame();
    expect(frames).toHaveLength(0);
    expect(scroller.scrollTop).toBe(after);
  });

  it("scrolls only as far as what's wanted shows: a composer's foot sticks, so the subject above it needn't go", () => {
    keepInView(el, scroller, 16, () => 200);
    frame();
    // its top 200 px end at 1000, the view (less the 16 of padding) at 884
    expect(scroller.scrollTop).toBe(116);
  });

  it("with motion off it does the same, once", () => {
    useAppearance.setState({ motionMs: 0 });
    keepInView(el, scroller, 16, () => 200);
    frame();
    expect(scroller.scrollTop).toBe(116);
    expect(frames).toHaveLength(0);
  });
});
