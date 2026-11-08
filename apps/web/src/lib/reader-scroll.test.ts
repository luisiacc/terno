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

  it("stops short of what sticks at the top (its scroll padding), in either motion: the context line stays clear (plan 158)", () => {
    scroller.style.scrollPaddingTop = "40px";
    for (const motionMs of [80, 0]) {
      scroller.scrollTop = 0;
      useAppearance.setState({ motionMs });
      // all of it wanted (900 tall in a 900 pane): it goes up only until its top is 16 + 40 below the pane's
      el.getBoundingClientRect = () => rect(800 - scroller.scrollTop, 900);
      keepInView(el, scroller, 16, () => 900);
      frame();
      expect(scroller.scrollTop).toBe(800 - 56);
    }
  });

  it("never stops with the subject cut by the reader's top: short of it when some would stay, past it when all goes (plan 158)", () => {
    const subject = document.createElement("h2");
    subject.id = "reader-subject";
    scroller.prepend(subject);
    for (const motionMs of [80, 0]) {
      useAppearance.setState({ motionMs });
      // 116 wanted (as above); a subject from 100 to 140 would keep 24 px: it stops at 100, the subject whole at the top
      scroller.scrollTop = 0;
      subject.getBoundingClientRect = () => rect(100 - scroller.scrollTop, 40);
      keepInView(el, scroller, 16, () => 200);
      frame();
      expect(scroller.scrollTop).toBe(100);
      // one from 40 to 80 goes whole: the scroll goes on
      scroller.scrollTop = 0;
      subject.getBoundingClientRect = () => rect(40 - scroller.scrollTop, 40);
      keepInView(el, scroller, 16, () => 200);
      frame();
      expect(scroller.scrollTop).toBe(116);
      // one of several lines (10 to 150) would hold back 106 px of what's wanted: the scroll goes past all of it instead
      scroller.scrollTop = 0;
      subject.getBoundingClientRect = () => rect(10 - scroller.scrollTop, 140);
      keepInView(el, scroller, 16, () => 200);
      frame();
      expect(scroller.scrollTop).toBe(150);
      // a message opening (no `wanted`: no foot that sticks) gets all it asks for (Codex review; with motion off it's the
      // browser's scrollIntoView)
      if (!motionMs) continue;
      scroller.scrollTop = 0;
      subject.getBoundingClientRect = () => rect(8 - scroller.scrollTop, 72);
      el.getBoundingClientRect = () => rect(300 - scroller.scrollTop, 600);
      keepInView(el, scroller);
      frame();
      expect(scroller.scrollTop).toBe(16);
      el.getBoundingClientRect = () => rect(800 - scroller.scrollTop, 600);
    }
  });
});
