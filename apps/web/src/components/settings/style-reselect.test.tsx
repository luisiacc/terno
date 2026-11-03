// @vitest-environment jsdom
/**
 * Codex code review #2 (plan 125): the style cards are radios, and a radio reports no change for its own value. The
 * chosen card clicked again must still reach updateAppearance: that choice is what cancels a switch to another style
 * still waiting for its faces.
 */
import type { AppSettings } from "@terno/core/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})) } }));
const updateAppearance = vi.hoisted(() => vi.fn(async () => null));
vi.mock("~/lib/appearance", async (load) => ({ ...(await load<object>()), updateAppearance }));

const { AppearanceTab } = await import("./appearance-tab");

const SETTINGS = {
  theme: "light",
  design: "lumen",
  lightTheme: "design",
  darkTheme: "design",
  previousLightTheme: null,
  previousDarkTheme: null,
  customThemes: [],
  motionMs: 75,
  htmlMailAppearance: "auto",
  senderIcons: false,
  googlePhotos: {},
  googlePhotosPending: [],
  density: "comfortable",
  layout: "split",
} as unknown as AppSettings;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  updateAppearance.mockClear();
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

describe("Settings → Appearance, Style", () => {
  it("another style is chosen by its card; the chosen card clicked again is a choice of its own", async () => {
    const host = await render(<AppearanceTab settings={SETTINGS} update={async () => {}} />);
    const card = (id: string) => host.querySelector<HTMLElement>(`[data-testid=design-card-${id}]`)!;
    await act(async () => card("atelier").click());
    expect(updateAppearance).toHaveBeenCalledTimes(1);
    expect(updateAppearance).toHaveBeenLastCalledWith({ design: "atelier" });
    // the settings haven't changed yet (atelier's faces are still loading): Lumen is still the checked radio
    expect(card("lumen").getAttribute("aria-checked")).toBe("true");
    await act(async () => card("lumen").click());
    expect(updateAppearance).toHaveBeenCalledTimes(2);
    expect(updateAppearance).toHaveBeenLastCalledWith({ design: "lumen" });
  });
});

vi.mock("../first-run-preview", () => ({ FirstRunPreview: ({ mode }: { mode: string }) => <div data-testid="preview" data-mode={mode} /> }));
vi.mock("../add-account-dialog", () => ({ AddAccountForm: () => null, EMPTY_ACCOUNT_DRAFT: {} }));
const { FirstRun } = await import("../first-run");
const { setApp } = await import("~/state/app");

describe("first run", () => {
  async function look(settings: Partial<AppSettings>) {
    localStorage.setItem("terno:first-run", "look");
    setApp({ settings: { ...SETTINGS, ...settings } as AppSettings });
    await render(<FirstRun />);
    return (id: string) => document.querySelector<HTMLElement>(`[data-testid=${id}]`)!;
  }

  it("the chosen style clicked again is a choice of its own (Codex code review #2)", async () => {
    const el = await look({});
    await act(async () => el("first-run-design-atelier").click());
    expect(updateAppearance).toHaveBeenLastCalledWith({ design: "atelier" });
    expect(el("first-run-design-lumen").getAttribute("aria-checked")).toBe("true");
    await act(async () => el("first-run-design-lumen").click());
    expect(updateAppearance).toHaveBeenCalledTimes(2);
    expect(updateAppearance).toHaveBeenLastCalledWith({ design: "lumen" });
  });

  it("following the system in a light window, the chosen dark palette clicked again previews dark (Codex code review #3)", async () => {
    const el = await look({ theme: "system" });
    expect(el("preview").dataset.mode).toBe("light");
    expect(el("theme-card-design-dark").getAttribute("aria-checked")).toBe("true");
    await act(async () => el("theme-card-design-dark").click());
    expect(el("preview").dataset.mode).toBe("dark");
  });
});
