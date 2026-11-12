// @vitest-environment jsdom
/**
 * Plan 190: Settings → About in a shell without the updater (the web) and the status row's focus. The desktop flow
 * through main's states is the e2e (updates.spec.ts); these are the branches a stand-in for main can't reach.
 */
import { initialUpdateState, type UpdateState } from "@terno/core/updates";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));

const { AboutTab } = await import("./about-tab");
const { UpdateStatusRow } = await import("./updates-section");
const { useUpdates } = await import("~/lib/updates");
const { useWeb } = await import("~/web/lifecycle");

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  setLocale("en", en);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useWeb.setState({ update: null });
  useUpdates.setState({ state: null, available: false, checkFailed: false });
});

describe("Settings → About", () => {
  it("without the updater (web): the version and the links, no update preferences; a waiting deployment offers Reload", () => {
    useUpdates.setState({ available: false, state: null });
    act(() => root.render(<AboutTab />));
    expect(q("about-version")?.textContent).toMatch(/^Version \d+\.\d+\.\d+/);
    expect(q("updates-status-row")).toBeNull();
    expect(q("updates-section")).toBeNull();
    expect(q("about-web-update")).toBeNull();
    for (const id of ["about-release-notes", "about-source", "about-license"]) expect(q(id)).not.toBeNull();

    const apply = vi.fn();
    act(() => useWeb.setState({ update: { apply } }));
    expect(q("about-web-update")?.textContent).toContain("A new version of Terno is ready");
    act(() => q("about-web-reload")!.click());
    expect(apply).toHaveBeenCalledOnce();
  });

  it("a link opens in a new tab (no shell to hand it to), never in the app", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    act(() => root.render(<AboutTab />));
    act(() => q("about-source")!.click());
    expect(open).toHaveBeenCalledWith("https://github.com/luisiacc/terno", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("when the state takes the focused action away (Download → the bar), focus stays on the row's words", () => {
    const base = initialUpdateState({ current: "0.1.0", mode: "manual", channel: "stable" });
    const update = { version: "0.2.0", notes: "", size: null, releaseDate: null };
    const available: UpdateState = { ...base, status: "available", available: update };
    act(() => root.render(<UpdateStatusRow state={available} lead="w-10" />));
    act(() => q("updates-download")!.focus());
    expect(document.activeElement).toBe(q("updates-download"));
    act(() => root.render(<UpdateStatusRow state={{ ...available, status: "downloading", target: update, percent: 3 }} lead="w-10" />));
    expect(q("updates-download")).toBeNull();
    expect(document.activeElement).toBe(q("updates-status"));
  });

  it("so does What's New when a background check takes the offer's link away", () => {
    const base = initialUpdateState({ current: "0.1.0", mode: "auto", channel: "stable" });
    const update = { version: "0.2.0", notes: "", size: null, releaseDate: null };
    const available: UpdateState = { ...base, status: "available", available: update };
    act(() => root.render(<UpdateStatusRow state={available} lead="w-10" />));
    act(() => q("updates-whats-new")!.focus());
    act(() => root.render(<UpdateStatusRow state={{ ...available, status: "checking" }} lead="w-10" />));
    expect(q("updates-whats-new")).toBeNull();
    expect(document.activeElement).toBe(q("updates-status"));
  });
});
