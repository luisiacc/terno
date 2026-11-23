// @vitest-environment jsdom
/**
 * Plan 236: the list's column keeps a width for each thing that fills it. The mail list's and What matters' feed's are
 * stored apart; the one edge reads and writes the one showing; a switch writes the other's to the variable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listVar = () => document.documentElement.style.getPropertyValue("--pane-list");
const stored = () => JSON.parse(localStorage.getItem("terno:panes") ?? "null") as unknown;

describe("the list's column, a width per view (plan 236)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    vi.resetModules();
  });

  it("the feed's edge stores the feed's width; the mail list keeps its own, and each comes back with its view", async () => {
    localStorage.setItem("terno:panes", JSON.stringify({ v: 1, sidebar: null, list: 420 }));
    const { commitWidth, showColumn, storedWidth } = await import("./panes");
    // at load, the column is the mail list's
    expect(listVar()).toBe("420px");
    // What matters: never stored, the design's (no variable)
    showColumn("feed");
    expect(listVar()).toBe("");
    expect(storedWidth("list")).toBeNull();
    commitWidth("list", 560);
    expect(listVar()).toBe("560px");
    expect(stored()).toEqual({ v: 1, sidebar: null, list: 420, feed: 560 });
    // back to the mail list: its width, untouched
    showColumn("list");
    expect(listVar()).toBe("420px");
    expect(storedWidth("list")).toBe(420);
    commitWidth("list", 380);
    expect(stored()).toEqual({ v: 1, sidebar: null, list: 380, feed: 560 });
    showColumn("feed");
    expect(listVar()).toBe("560px");
    // a reset is the feed's alone; the sidebar's edge is the sidebar's in either view
    commitWidth("list", null);
    commitWidth("sidebar", 260);
    expect(listVar()).toBe("");
    expect(stored()).toEqual({ v: 1, sidebar: 260, list: 380, feed: null });
  });

  it("showing the view already shown writes nothing", async () => {
    const { previewWidth, showColumn } = await import("./panes");
    previewWidth("list", 333);
    showColumn("list");
    expect(listVar()).toBe("333px");
  });
});
