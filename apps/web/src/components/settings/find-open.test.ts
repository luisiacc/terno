// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApp } from "~/state/app";
import { endFind, openFound } from "./find-open";
import type { FindTarget } from "./search-index";

/** Plan 203 (Codex code review): opening a result waits for what's still loading, and stands down when the person goes elsewhere. */
vi.mock("./writing-style", () => ({ leaveStyleEditors: (then: () => void) => then() }));

let pane: HTMLDivElement;
const target = (over: Partial<FindTarget>): FindTarget => ({ id: "ai.instructions", tab: "ai", page: null, scope: null, under: null, ...over }) as FindTarget;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Element.prototype.scrollIntoView = vi.fn();
  pane = document.createElement("div");
  pane.dataset.testid = "settings-scroller";
  document.body.append(pane);
  setApp({ dialog: "settings", settingsTab: "general" });
});
afterEach(() => {
  endFind();
  pane.remove();
  vi.useRealTimers();
});

describe("openFound", () => {
  it("doesn't open a row in a group still loading; once it has loaded, the row that's there", async () => {
    // drafting's preferences unloaded: its details show as if on, then go when the preferences say drafting is off
    pane.innerHTML = `<section aria-busy="true"><div data-setting="ai.drafting"><button role="switch">on</button></div><div data-setting="ai.instructions"><textarea></textarea></div></section>`;
    openFound(target({ id: "ai.instructions", under: "ai.drafting" }));
    await vi.advanceTimersByTimeAsync(10);
    expect(pane.querySelector("[data-found]")).toBeNull();
    pane.querySelector("[data-setting='ai.instructions']")!.remove();
    pane.querySelector("section")!.removeAttribute("aria-busy");
    await vi.advanceTimersByTimeAsync(10);
    // not there after all: after the wait, the switch that shows it
    expect(pane.querySelector("[data-found]")).toBeNull();
    await vi.advanceTimersByTimeAsync(1600);
    expect(pane.querySelector("[data-found]")?.getAttribute("data-setting")).toBe("ai.drafting");
  });

  it("opens a row that is itself its account's (Appearance's photos from Google)", async () => {
    pane.innerHTML = `<div data-setting="appearance.googlePhotos" data-setting-scope="account:1"><button role="switch"></button></div><div data-setting="appearance.googlePhotos" data-setting-scope="account:2"><button role="switch"></button></div>`;
    openFound(target({ id: "appearance.googlePhotos", tab: "appearance", scope: { kind: "account", id: 2 } }));
    await vi.advanceTimersByTimeAsync(10);
    expect(pane.querySelector("[data-found]")?.getAttribute("data-setting-scope")).toBe("account:2");
  });

  it("stands down when the person goes to another section before the setting came", async () => {
    pane.innerHTML = `<div data-setting="general.language"></div>`;
    pane.scrollTop = 0;
    const scrollTo = vi.fn();
    pane.scrollTo = scrollTo as never;
    openFound(target({ id: "ai.nudge", under: "ai.followups" }));
    setApp({ settingsTab: "appearance" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(pane.querySelector("[data-found]")).toBeNull();
  });
});
