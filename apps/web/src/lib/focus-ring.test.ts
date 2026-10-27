// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { installFocusRing } from "./focus-ring";

const flagged = () => document.documentElement.hasAttribute("data-focus-ring");
const key = (key: string, init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));

describe("focus rings only while moving with Tab (plan 54)", () => {
  beforeAll(() => installFocusRing(window));

  it("Tab and Shift+Tab turn them on; navigating keys keep them", () => {
    key("Tab");
    expect(flagged()).toBe(true);
    for (const k of ["ArrowDown", "Enter", " ", "Escape", "Shift", "Home", "PageDown"]) key(k);
    expect(flagged()).toBe(true);
    key("Escape");
    key("Tab", { shiftKey: true });
    expect(flagged()).toBe(true);
  });

  it("a shortcut or a typed character turns them off", () => {
    for (const k of ["r", "#", "j", "Backspace", "Delete", "/"]) {
      key("Tab");
      key(k);
      expect(flagged(), k).toBe(false);
    }
  });

  it("a pointer press turns them off", () => {
    key("Tab");
    window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(flagged()).toBe(false);
  });

  it("modified Tab (app or window switching) does not turn them on", () => {
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      key("Tab", init);
      expect(flagged()).toBe(false);
    }
  });

  it("sees keys another handler stops, since it listens in capture", () => {
    const stop = (e: Event) => e.stopPropagation();
    document.addEventListener("keydown", stop, true);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(flagged()).toBe(true);
    document.removeEventListener("keydown", stop, true);
  });
});
