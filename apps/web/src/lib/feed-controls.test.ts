// @vitest-environment jsdom
/**
 * Plan 210 (iteration 1, Codex code review): Done and Later's width is measured by the first item with them that's drawn,
 * whenever that is (the feed may open on items with none), once for the language and design the feed is drawn in.
 */
import { describe, expect, it } from "vitest";
import { measureControls } from "./feed-controls";

function feed(key: string): HTMLElement {
  const el = document.createElement("section");
  el.dataset.testid = "wm-feed";
  el.dataset.controlsKey = key;
  document.body.append(el);
  return el;
}

function controls(parent: HTMLElement, width: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { get: () => width });
  parent.append(el);
  return el;
}

describe("the feed's controls width", () => {
  it("is taken from the first drawn, once for a language and design; again when they change; never zero", () => {
    const f = feed("es|lumen");
    measureControls(controls(f, 0));
    expect(f.style.getPropertyValue("--wm-controls")).toBe("");
    // scrolled to the first item with a task: measured then
    measureControls(controls(f, 152));
    expect(f.style.getPropertyValue("--wm-controls")).toBe("152px");
    // the next ones drawn aren't read again
    measureControls(controls(f, 99));
    expect(f.style.getPropertyValue("--wm-controls")).toBe("152px");
    // another language: measured again
    f.dataset.controlsKey = "en|lumen";
    measureControls(controls(f, 120));
    expect(f.style.getPropertyValue("--wm-controls")).toBe("120px");
    // asked to (the feed's own effect when the language or design changes), whatever was measured
    measureControls(controls(f, 124), true);
    expect(f.style.getPropertyValue("--wm-controls")).toBe("124px");
    // outside the feed, or none: nothing
    measureControls(null);
    measureControls(controls(document.body, 300));
    expect(f.style.getPropertyValue("--wm-controls")).toBe("124px");
  });
});
