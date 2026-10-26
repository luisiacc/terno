/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESIGNS } from "@terno/ui/designs/index";
import { BIG_STEP, clampWidth, keyWidth, LIMITS, loadPanes, maxWidth, PANES_KEY, parsePanes, savePanes, STEP } from "./panes";

describe("stored widths (plan 21)", () => {
  it("reads each pane on its own; anything unreadable or out of range is that pane's default", () => {
    expect(parsePanes(null)).toEqual({ sidebar: null, list: null });
    expect(parsePanes("{nope")).toEqual({ sidebar: null, list: null });
    expect(parsePanes("[]")).toEqual({ sidebar: null, list: null });
    expect(parsePanes(JSON.stringify({ v: 2, sidebar: 260, list: 420 }))).toEqual({ sidebar: null, list: null });
    expect(parsePanes(JSON.stringify({ v: 1, sidebar: 260.4, list: 420 }))).toEqual({ sidebar: 260, list: 420 });
    expect(parsePanes(JSON.stringify({ v: 1, sidebar: 120, list: "420" }))).toEqual({ sidebar: null, list: null });
    expect(parsePanes(JSON.stringify({ v: 1, sidebar: 9999, list: 640 }))).toEqual({ sidebar: null, list: 640 });
    // a huge exponent parses as Infinity
    expect(parsePanes(`{"v":1,"sidebar":null,"list":1e999}`)).toEqual({ sidebar: null, list: null });
  });

  it("round-trips through storage; both defaults remove the key; a storage that throws changes nothing", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    savePanes({ sidebar: 280, list: null }, storage);
    expect(loadPanes(storage)).toEqual({ sidebar: 280, list: null });
    savePanes({ sidebar: null, list: null }, storage);
    expect(m.has(PANES_KEY)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => savePanes({ sidebar: 280, list: 400 }, broken)).not.toThrow();
    expect(loadPanes(broken)).toEqual({ sidebar: null, list: null });
  });
});

describe("how wide a pane may be", () => {
  const readerMin = 340;
  it("its own limits in a wide window", () => {
    expect(maxWidth("sidebar", 1440, 232, readerMin)).toBe(LIMITS.sidebar.max);
    expect(maxWidth("list", 1440, 232, readerMin)).toBe(LIMITS.list.max);
    expect(clampWidth("sidebar", 50, 1440, 232, readerMin)).toBe(LIMITS.sidebar.min);
    expect(clampWidth("list", 5000, 1440, 232, readerMin)).toBe(LIMITS.list.max);
  });

  it("the reader keeps its room: the sidebar leaves the list its min, the list leaves the reader its min", () => {
    // 980: the sidebar can take what the list (at 300) and the reader (340) leave
    expect(maxWidth("sidebar", 980, 232, readerMin)).toBe(980 - 340 - 300);
    expect(maxWidth("list", 980, 232, readerMin)).toBe(980 - 340 - 232);
    expect(maxWidth("list", 980, 232, 380)).toBe(980 - 380 - 232);
    // narrower than the three mins: never below a pane's own min
    expect(maxWidth("list", 700, 232, readerMin)).toBe(LIMITS.list.min);
    expect(clampWidth("sidebar", 300, 700, 232, readerMin)).toBe(LIMITS.sidebar.min);
  });

  it("keys: ← → by a step, Shift by a big one, Home and End, Enter resets; others aren't ours", () => {
    expect(keyWidth("ArrowRight", false, 240, 360, "sidebar")).toBe(240 + STEP);
    expect(keyWidth("ArrowRight", true, 240, 360, "sidebar")).toBe(240 + BIG_STEP);
    expect(keyWidth("ArrowRight", true, 350, 360, "sidebar")).toBe(360);
    expect(keyWidth("ArrowLeft", false, 240, 360, "sidebar")).toBe(240 - STEP);
    expect(keyWidth("ArrowLeft", true, 210, 360, "sidebar")).toBe(LIMITS.sidebar.min);
    expect(keyWidth("Home", false, 400, 640, "list")).toBe(LIMITS.list.min);
    expect(keyWidth("End", false, 400, 520, "list")).toBe(520);
    expect(keyWidth("Enter", false, 400, 520, "list")).toBe("reset");
    expect(keyWidth("j", false, 400, 520, "list")).toBeNull();
  });
});

describe("the layout and the math agree", () => {
  const css = readFileSync(join(import.meta.dirname, "../../../../packages/ui/src/styles/globals.css"), "utf8");
  const rule = css.slice(css.indexOf("@utility app-panes"), css.indexOf("}", css.indexOf("@utility app-panes")));
  it("globals.css clamps with the same limits", () => {
    expect(rule).toContain(`clamp(${LIMITS.sidebar.min}px, min(${LIMITS.sidebar.max}px,`);
    expect(rule).toContain(`100vw - var(--reader-min) - ${LIMITS.list.min}px)`);
    expect(rule).toContain(`clamp(${LIMITS.list.min}px, min(${LIMITS.list.max}px,`);
  });
  it("every design's defaults sit inside the limits, and at the minimum window (980) nothing changes from before", () => {
    for (const d of DESIGNS) {
      const sidebar = parseFloat(d.layout.sidebar);
      expect(sidebar, d.id).toBeGreaterThanOrEqual(LIMITS.sidebar.min);
      expect(sidebar, d.id).toBeLessThanOrEqual(LIMITS.sidebar.max);
      expect(parseFloat(d.layout.listMin), d.id).toBeGreaterThanOrEqual(LIMITS.list.min);
      // the default list at 980 (max(listMin, listMax), listMax possibly 32vw) still leaves the reader its min
      const listMax = d.layout.listMax.includes("vw") ? Math.min(parseFloat(d.layout.listMax.replace("min(", "")), 0.32 * 980) : parseFloat(d.layout.listMax);
      const list = Math.max(parseFloat(d.layout.listMin), listMax);
      expect(980 - sidebar - list, d.id).toBeGreaterThanOrEqual(d.layout.readerMin);
    }
  });
});
