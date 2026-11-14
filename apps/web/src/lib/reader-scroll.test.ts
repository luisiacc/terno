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

  it("never stops with the subject cut by the reader's top, and never short of what's wanted: past the subject (plan 158)", () => {
    const subject = document.createElement("h2");
    subject.id = "reader-subject";
    subject.toggleAttribute("data-reader-head", true);
    scroller.prepend(subject);
    for (const motionMs of [80, 0]) {
      useAppearance.setState({ motionMs });
      // 116 wanted (as above); a subject from 100 to 140 would keep 24 px: it goes on to 140, never back to 100, which
      // left a short window's Send row under its edge
      scroller.scrollTop = 0;
      subject.getBoundingClientRect = () => rect(100 - scroller.scrollTop, 40);
      keepInView(el, scroller, 16, () => 200);
      frame();
      expect(scroller.scrollTop).toBe(140);
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

  describe("plan 205: no head left half under the context line", () => {
    // the context line: 32 px (the scroller's scroll-padding-top). 116 wanted, as above: el's top 200 at 800, the view's
    // foot at 884; room to 800 - 16 - 32
    const motions = [{ motionMs: 80, reducedMotion: false }, { motionMs: 80, reducedMotion: true }];
    const head = (top: number, height: number, subject = false) => {
      const h = document.createElement(subject ? "h2" : "button");
      if (subject) h.id = "reader-subject";
      h.toggleAttribute("data-reader-head", true);
      h.getBoundingClientRect = () => rect(top - scroller.scrollTop, height);
      el.before(h);
      return h;
    };
    const open = (motion: (typeof motions)[number]) => {
      useAppearance.setState(motion);
      scroller.scrollTop = 0;
      keepInView(el, scroller, 16, () => 200);
      frame();
      return scroller.scrollTop;
    };
    beforeEach(() => { scroller.style.scrollPaddingTop = "32px"; });

    it("a message's header the scroll would leave straddling the line goes past it, in either motion", () => {
      // 130 to 170 would sit at 14 to 54: its top under the line, its name cut. Past it: its foot on the line
      head(130, 40);
      for (const motion of motions) expect(open(motion), JSON.stringify(motion)).toBe(170 - 32);
    });

    it("a head already clear of the line, or wholly under it, changes nothing", () => {
      const h = head(150, 40);
      // at 34 to 74: whole below the line
      for (const motion of motions) expect(open(motion)).toBe(116);
      // at -16 to 24: all under the line
      h.getBoundingClientRect = () => rect(100 - scroller.scrollTop, 40);
      for (const motion of motions) expect(open(motion)).toBe(116);
    });

    it("never short of what's wanted: with too little room the scroll stops where it would have", () => {
      // el's top at 170: room for 170 - 48 = 122, and going past 130 to 170 takes 138
      el.getBoundingClientRect = () => rect(170 - scroller.scrollTop, 900);
      head(130, 40);
      for (const motion of motions) {
        useAppearance.setState(motion);
        scroller.scrollTop = 0;
        keepInView(el, scroller, 16, () => 830);
        frame();
        expect(scroller.scrollTop).toBe(116);
      }
    });

    it("the subject is cut only once its top has gone, and then goes wholly past the pane's top (plan 158)", () => {
      // at 4 to 54: its top still in view, so no line covers it
      const subject = head(120, 50, true);
      for (const motion of motions) expect(open(motion)).toBe(116);
      // at -6 to 44: its top gone: past all of it, as plan 158 has it (compose.spec: "a subject not whole is wholly gone")
      subject.getBoundingClientRect = () => rect(110 - scroller.scrollTop, 50);
      for (const motion of motions) expect(open(motion)).toBe(160);
    });
  });
});
