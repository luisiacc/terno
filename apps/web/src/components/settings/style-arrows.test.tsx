// @vitest-environment jsdom
/**
 * Codex code review, second pass #3 (plan 125): with Lumen chosen, arrowing to Atelier while its faces load and back to
 * Lumen must leave Lumen. Base UI chooses an arrowed-to radio through its hidden input (no click on the card), and the
 * still-checked Lumen reports no change: the group's reselection has to reach updateAppearance all the same.
 */
import type { AppSettings } from "@terno/core/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));
const calls = vi.hoisted(() => [] as { method: string; params: Record<string, unknown> }[]);
/** the backend's settings: settings.update answers with them, patched */
const server = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
vi.mock("~/rpc/connection", () => ({
  client: {
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "settings.update") server.settings = { ...server.settings, ...params };
      return server.settings;
    }),
  },
}));
/** a design's faces load when the test says so (document.fonts, which loadDesignFaces waits on) */
const faces = vi.hoisted(() => ({ release: [] as (() => void)[] }));
Object.defineProperty(document, "fonts", { configurable: true, value: { load: () => new Promise<void>((resolve) => faces.release.push(resolve)) } });
vi.mock("../first-run-preview", () => ({ FirstRunPreview: () => null }));
vi.mock("../add-account-dialog", () => ({ AddAccountForm: () => null, EMPTY_ACCOUNT_DRAFT: {} }));

const { AppearanceTab } = await import("./appearance-tab");
const { FirstRun } = await import("../first-run");
const { getApp, setApp, useApp } = await import("~/state/app");

const SETTINGS = {
  theme: "light",
  design: "lumen",
  lightTheme: "design",
  darkTheme: "design",
  previousLightTheme: null,
  previousDarkTheme: null,
  designPalettes: {},
  customThemes: [],
  motionMs: 75,
  htmlMailAppearance: "auto",
  senderIcons: false,
  googlePhotos: {},
  googlePhotosPending: [],
  density: "comfortable",
  layout: "split",
} as unknown as AppSettings;

function Appearance() {
  const settings = useApp((s) => s.settings);
  return settings && <AppearanceTab settings={settings} update={async () => {}} />;
}

let cleanup: (() => void) | null = null;
beforeEach(() => {
  calls.length = 0;
  faces.release = [];
  server.settings = { ...SETTINGS };
  setApp({ settings: SETTINGS });
});
afterEach(() => cleanup?.());

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
}

const key = (k: string) => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
const card = (id: string) => document.querySelector<HTMLElement>(`[data-testid=${id}]`)!;

async function arrowAwayAndBack(first: string, second: string) {
  await act(async () => card(first).focus());
  await key("ArrowRight");
  expect(document.activeElement).toBe(card(second));
  // the switch waits for the second style's faces; Lumen is still the chosen one
  expect(faces.release.length).toBeGreaterThan(0);
  expect(card(first).getAttribute("aria-checked")).toBe("true");
  await key("ArrowLeft");
  expect(document.activeElement).toBe(card(first));
  await act(async () => faces.release.forEach((go) => go()));
  await act(async () => {});
  expect(getApp().settings!.design).toBe("lumen");
  expect(calls.filter((c) => c.method === "settings.update" && c.params.design === "atelier")).toEqual([]);
}

describe("arrowing away from the chosen style and back cancels the switch", () => {
  it("in Settings → Appearance", async () => {
    await render(<Appearance />);
    await arrowAwayAndBack("design-card-lumen", "design-card-atelier");
  });

  it("in first run", async () => {
    localStorage.setItem("terno:first-run", "look");
    await render(<FirstRun />);
    await arrowAwayAndBack("first-run-design-lumen", "first-run-design-atelier");
  });
});
