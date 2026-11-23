// @vitest-environment jsdom
/** Plan 246: Settings comes back to the section, scroll and open rows it was left at; a link starts its section at the top. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsTab } from "~/state/app";

vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => null), on: () => () => {}, connectionVersion: 1 } }));

/** ResizeObservers alive now, to grow their content by hand */
const observers = new Set<{ cb: () => void; targets: Element[] }>();
vi.stubGlobal(
  "ResizeObserver",
  class {
    private entry: { cb: () => void; targets: Element[] };
    constructor(cb: () => void) {
      this.entry = { cb, targets: [] };
      observers.add(this.entry);
    }
    observe(el: Element) {
      this.entry.targets.push(el);
    }
    disconnect() {
      observers.delete(this.entry);
    }
  },
);

const { openSettings, reopenedRows, endReturn, trackSettingsPane, resetSettingsPlace, RETURN_WAIT_MS } = await import("./settings-place");
const { getApp, setApp } = await import("~/state/app");

/** A pane 400 px tall whose scroll clamps to its content, as a browser's does; scroll events are sent by hand. */
function pane(content: number) {
  const el = document.createElement("div");
  el.appendChild(document.createElement("div"));
  const size = { content, top: 0 };
  Object.defineProperty(el, "scrollTop", {
    get: () => size.top,
    set: (v: number) => {
      size.top = Math.max(0, Math.min(v, size.content - 400));
    },
  });
  document.body.appendChild(el);
  const scroll = (top: number) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  };
  /** the section's rows came: the content grows and its observers hear it */
  const grow = (to: number) => {
    size.content = to;
    for (const o of observers) if (o.targets.some((t) => el.contains(t))) o.cb();
  };
  return { el, scroll, grow };
}

const state = { tab: "general" as SettingsTab, page: false, open: true };
/** the pane mounts for the section the app shows */
function mount(content = 2000) {
  const p = pane(content);
  state.tab = getApp().settingsTab;
  const tracker = trackSettingsPane(p.el, () => ({ ...state }));
  return { ...p, tracker };
}
/** Settings closes: the pane unmounts, then the app's dialog goes */
function close(t: { tracker: { dispose(): void } }) {
  t.tracker.dispose();
  setApp({ dialog: null, settingsAccount: null });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSettingsPlace();
  Object.assign(state, { tab: "general", page: false, open: true });
  setApp({ dialog: null, settingsTab: "general", settingsAccount: null });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("where Settings opens", () => {
  it("opens on General at the top the first time", () => {
    openSettings();
    expect(getApp()).toMatchObject({ dialog: "settings", settingsTab: "general" });
    const p = mount();
    expect(p.el.scrollTop).toBe(0);
  });

  it("comes back to the section and scroll it was left at", () => {
    openSettings("ai");
    const first = mount();
    first.scroll(600);
    close(first);
    openSettings();
    expect(getApp().settingsTab).toBe("ai");
    expect(mount().el.scrollTop).toBe(600);
  });

  it("a section switched to inside Settings is the place, also without a scroll", () => {
    openSettings();
    const p = mount();
    p.scroll(300);
    setApp({ settingsTab: "storage" });
    state.tab = "storage";
    p.tracker.sectionChanged();
    close(p);
    openSettings();
    expect(getApp().settingsTab).toBe("storage");
    expect(mount().el.scrollTop).toBe(300);
  });

  it("a link opens its section at the top, with nothing reopened, and is then the place", () => {
    openSettings("accounts");
    const left = mount();
    left.el.innerHTML = `<div data-setting-scope="account:7"><button data-setting-open aria-expanded="true"></button></div>`;
    left.scroll(500);
    close(left);
    openSettings("accounts");
    expect(reopenedRows().size).toBe(0);
    const linked = mount();
    expect(linked.el.scrollTop).toBe(0);
    close(linked);
    openSettings();
    expect(getApp().settingsTab).toBe("accounts");
  });

  it("the account menu's open names its account", () => {
    openSettings("accounts", 3);
    expect(getApp()).toMatchObject({ settingsTab: "accounts", settingsAccount: 3 });
  });

  it("already open: a plain open changes nothing, a link switches section", () => {
    openSettings("ai");
    mount().scroll(200);
    openSettings();
    expect(getApp().settingsTab).toBe("ai");
    openSettings("storage");
    expect(getApp()).toMatchObject({ dialog: "settings", settingsTab: "storage" });
  });
});

describe("the rows open when Settings was left", () => {
  it("open again on a return only, and only while the pane mounts", () => {
    openSettings("accounts");
    const left = mount();
    left.el.innerHTML = `
      <div data-setting-scope="account:1"><button data-setting-open aria-expanded="true"></button></div>
      <div data-setting-scope="account:2"><button data-setting-open aria-expanded="false"></button></div>
      <div data-setting-scope="category:5"><div><button data-setting-open aria-expanded="true"></button></div></div>`;
    close(left);
    openSettings();
    // the sections read them as they render, before the pane's effect
    expect([...reopenedRows()].sort()).toEqual(["account:1", "category:5"]);
    mount();
    // a later visit to the section within this open starts closed, as before
    expect(reopenedRows().size).toBe(0);
  });
});

describe("a return waits for its section's rows", () => {
  it("puts the pane back as the content grows, without writing the clamped scroll, and stops there", () => {
    openSettings("filters");
    const left = mount();
    left.scroll(900);
    close(left);
    openSettings();
    const p = mount(600);
    expect(p.el.scrollTop).toBe(200);
    // the clamp's own scroll event isn't the place
    p.el.dispatchEvent(new Event("scroll"));
    p.grow(1000);
    expect(p.el.scrollTop).toBe(600);
    p.grow(2000);
    expect(p.el.scrollTop).toBe(900);
    expect(observers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // from here the pane's own scrolls are written
    p.scroll(950);
    close(p);
    openSettings();
    expect(mount().el.scrollTop).toBe(950);
  });

  it("gives up after a second and keeps where the content let it", () => {
    openSettings("storage");
    const left = mount();
    left.scroll(900);
    close(left);
    openSettings();
    const p = mount(700);
    vi.advanceTimersByTime(RETURN_WAIT_MS);
    expect(observers.size).toBe(0);
    // later rows don't move it
    p.grow(3000);
    expect(p.el.scrollTop).toBe(300);
    close(p);
    openSettings();
    expect(mount().el.scrollTop).toBe(300);
  });

  it("closed before the rows came, the place is still the target", () => {
    openSettings("storage");
    const left = mount();
    left.scroll(900);
    close(left);
    openSettings();
    close(mount(500));
    expect(observers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    openSettings();
    expect(mount().el.scrollTop).toBe(900);
  });

  it("the person's own wheel, pointer or key in the pane ends it, and leaves nothing listening", () => {
    for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) {
      resetSettingsPlace();
      setApp({ dialog: null, settingsTab: "general" });
      const left = mount();
      left.scroll(900);
      close(left);
      openSettings();
      const p = mount(600);
      const removed = vi.spyOn(p.el, "removeEventListener");
      p.el.dispatchEvent(new Event(type));
      expect(observers.size, type).toBe(0);
      expect(vi.getTimerCount(), type).toBe(0);
      p.grow(2000);
      expect(p.el.scrollTop, type).toBe(200);
      expect(removed.mock.calls.map((c) => c[0]).sort(), type).toEqual(["keydown", "pointerdown", "touchstart", "wheel"]);
      close(p);
    }
  });

  it("Find takes the scroll: the return stops and the pane's scrolls are written again", () => {
    openSettings("filters");
    const left = mount();
    left.scroll(900);
    close(left);
    openSettings();
    const p = mount(600);
    endReturn();
    expect(observers.size).toBe(0);
    p.grow(2000);
    expect(p.el.scrollTop).toBe(200);
    p.scroll(40);
    close(p);
    openSettings();
    expect(mount().el.scrollTop).toBe(40);
  });

  it("a section switch ends it, and the new section is the place", () => {
    openSettings("filters");
    const left = mount();
    left.scroll(900);
    close(left);
    openSettings();
    const p = mount(600);
    setApp({ settingsTab: "general" });
    state.tab = "general";
    p.tracker.sectionChanged();
    expect(observers.size).toBe(0);
    close(p);
    openSettings();
    expect(getApp().settingsTab).toBe("general");
  });

  it("pane gone, nothing is left: its scroll listener goes too", () => {
    openSettings();
    const p = mount();
    const added = vi.spyOn(p.el, "addEventListener");
    const removed = vi.spyOn(p.el, "removeEventListener");
    close(p);
    expect(added).not.toHaveBeenCalled();
    expect(removed.mock.calls.map((c) => c[0])).toEqual(["scroll"]);
    // scrolls after it don't count
    p.scroll(700);
    openSettings();
    expect(mount().el.scrollTop).toBe(0);
  });
});

describe("what isn't the place", () => {
  it("a page inside the section keeps the section where its button was", () => {
    openSettings("ai");
    const p = mount();
    p.scroll(450);
    state.page = true;
    p.scroll(1200);
    close(p);
    // (the page closes with Settings)
    state.page = false;
    openSettings();
    expect(mount().el.scrollTop).toBe(450);
  });

  it("a section first shown on a page (New snippet) is its top", () => {
    openSettings("ai");
    const first = mount();
    first.scroll(450);
    close(first);
    openSettings("snippets");
    state.page = true;
    const p = mount();
    p.scroll(800);
    close(p);
    state.page = false;
    openSettings();
    expect(getApp().settingsTab).toBe("snippets");
    expect(mount().el.scrollTop).toBe(0);
  });

  it("while the sheet hides under the fatal modal nothing is written, and it comes back where it was", () => {
    openSettings("ai");
    const p = mount();
    p.scroll(500);
    state.open = false;
    p.scroll(0);
    p.tracker.dispose();
    state.open = true;
    // the sheet shows again on its own: no new open asked for
    expect(mount().el.scrollTop).toBe(500);
  });
});
