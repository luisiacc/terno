import { describe, expect, it } from "vitest";
import { parseAppearance, windowVibrancy } from "./appearance";

describe("main: native vibrancy", () => {
  it("follows the renderer's theme on macOS, defaulting to on", () => {
    expect(windowVibrancy(true, null, false)).toBe(true);
    expect(windowVibrancy(true, { vibrancy: false }, false)).toBe(false);
    expect(windowVibrancy(false, { vibrancy: true }, false)).toBe(false);
  });

  it("is off whenever the OS asks for reduced transparency, whatever the renderer sent", () => {
    expect(windowVibrancy(true, { vibrancy: true }, true)).toBe(false);
    expect(windowVibrancy(true, null, true)).toBe(false);
  });
});

describe("main: appearance messages", () => {
  it("accepts an opaque background and normalizes case", () => {
    expect(parseAppearance({ themeSource: "dark", background: "#2E3440", vibrancy: false })).toEqual({ themeSource: "dark", background: "#2e3440", vibrancy: false });
  });

  it("keeps a message whose background is translucent: the alpha is dropped, not the message", () => {
    expect(parseAppearance({ themeSource: "light", background: "#aabbcc80", vibrancy: false })).toEqual({ themeSource: "light", background: "#aabbcc", vibrancy: false });
    expect(parseAppearance({ themeSource: "light", background: "#abc8", vibrancy: true })).toEqual({ themeSource: "light", background: "#aabbcc", vibrancy: true });
  });

  it("refuses anything else", () => {
    for (const bad of [null, "x", { themeSource: "sepia", background: "#000000", vibrancy: true }, { themeSource: "dark", background: "red", vibrancy: true }, { themeSource: "dark", background: "#00000", vibrancy: true }, { themeSource: "dark", background: "#000000", vibrancy: "yes" }]) {
      expect(parseAppearance(bad)).toBeNull();
    }
  });
});
