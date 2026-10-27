/**
 * Concurrent appearance changes: persisted one at a time, and every answer or
 * refusal reconciled against what is still pending, so an older snapshot never
 * paints over a newer choice. Runs in Node with a minimal fake <html>.
 */
import type { AppSettings } from "@terno/core/rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const html = {
    classList: { contains: (c: string) => classes.has(c), toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
    dataset: {} as Record<string, string>,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    style: { colorScheme: "", setProperty: () => {}, removeProperty: () => "" },
  };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const stored = new Map<string, string>();
  g.localStorage = { setItem: (k: string, v: string) => void stored.set(k, v), getItem: (k: string) => stored.get(k) ?? null };
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => {};
  /** settings.update calls, answered by hand in the order the test chooses */
  const calls: { patch: Record<string, unknown>; resolve(v: unknown): void; reject(e: unknown): void }[] = [];
  return { html, calls, stored };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (_method: string, patch: Record<string, unknown>) => new Promise((resolve, reject) => fake.calls.push({ patch, resolve, reject })),
  },
}));
vi.mock("~/lib/snack", () => ({ snack: Object.assign(() => "", { error: vi.fn(), success: () => "" }) }));

const { reconcileSettings, resolveTheme, sidebarVibrancy, updateAppearance, useAppearance, APPEARANCE_KEY } = await import("./appearance");
const { getApp, setApp } = await import("~/state/app");
const { snack } = await import("~/lib/snack");

const SERVER: AppSettings = {
  localMode: true,
  composeSuggestions: true,
  senderIcons: false,
  googlePhotos: {},
  dockBadge: true,
  notifications: true,
  notificationPreview: true,
  theme: "dark",
  design: "macos",
  lightTheme: "terno-light",
  darkTheme: "terno-dark",
  previousLightTheme: null,
  previousDarkTheme: null,
  motionMs: 75,
  htmlMailAppearance: "auto",
  customThemes: [],
  density: "comfortable",
  layout: "split",
  remoteImages: "ask",
  allowAgentSend: false,
  gmailClientId: "",
  gmailClientSecretSet: false,
  gmailClientSecretUnreadable: false,
  syncWindowDays: 90,
  autoCategorize: "auto",
  aiCategorize: false,
  errorReports: "ask",
  language: "system",
  ai: { provider: "none", model: "", baseURL: null, preset: null, hasKey: false, keyUnreadable: false, keyHint: null, keyOrigin: null, keyConfirmed: true, local: true, capabilities: null, profiles: {} },
};
/** The backend's state, as each answer would report it. */
let server: AppSettings;
const tick = () => new Promise((r) => setTimeout(r, 0));
const painted = () => fake.html.dataset.theme;

beforeEach(() => {
  fake.calls.length = 0;
  server = { ...SERVER };
  setApp({ settings: reconcileSettings(server) });
});

/** Answers the oldest outstanding call as the backend would (applying it first). */
async function answer(ok = true) {
  await tick();
  const c = fake.calls.shift()!;
  if (ok) {
    server = { ...server, ...c.patch } as AppSettings;
    c.resolve(server);
  } else c.reject(new Error("refused"));
  await tick();
}

describe("sidebar vibrancy", () => {
  it("needs macOS desktop and a theme that allows it, and goes when the OS asks for reduced transparency", () => {
    expect(sidebarVibrancy(true, true, false)).toBe(true);
    expect(sidebarVibrancy(true, true, true)).toBe(false);
    expect(sidebarVibrancy(true, false, false)).toBe(false);
    expect(sidebarVibrancy(false, true, false)).toBe(false);
  });
});

describe("designs (plan 15)", () => {
  it("Style colors are the design's own palette; an unknown or wrong-mode id falls back to them", () => {
    const a = { design: "lumen" as const, lightTheme: "design", darkTheme: "design", customThemes: [] };
    expect(resolveTheme(a, "light").id).toBe("lumen-light");
    expect(resolveTheme(a, "dark").id).toBe("lumen-dark");
    expect(resolveTheme({ ...a, design: "atelier" }, "dark").id).toBe("atelier-dark");
    expect(resolveTheme({ ...a, design: "macos" }, "light").id).toBe("terno-light");
    expect(resolveTheme({ ...a, lightTheme: "dracula" }, "light").id).toBe("lumen-light");
    expect(resolveTheme({ ...a, lightTheme: "github-light" }, "light").id).toBe("github-light");
  });

  it("paints the design and its colors, and caches both (v2) for theme.js", async () => {
    void updateAppearance({ design: "atelier", darkTheme: "design" });
    await tick();
    expect(fake.html.dataset.design).toBe("atelier");
    expect(painted()).toBe("atelier-dark");
    expect(useAppearance.getState().design).toBe("atelier");
    expect(JSON.parse(fake.stored.get(APPEARANCE_KEY)!)).toMatchObject({ v: 2, design: "atelier", dark: "atelier-dark", light: "terno-light", vibrancy: { light: false, dark: false } });
    await answer();
  });

  it("plan 24: the layout is painted on <html> and cached for theme.js, so a List user's first frame is List", async () => {
    void updateAppearance({ layout: "list" });
    await tick();
    expect(fake.html.dataset.layout).toBe("list");
    expect(useAppearance.getState().layout).toBe("list");
    expect(JSON.parse(fake.stored.get(APPEARANCE_KEY)!)).toMatchObject({ v: 2, layout: "list" });
    await answer();
    void updateAppearance({ layout: "split" });
    await tick();
    expect(fake.html.dataset.layout).toBe("split");
    await answer();
  });

  it("quick design choices: only the latest is applied and saved (a slower font wait is dropped)", async () => {
    void updateAppearance({ design: "atelier" });
    void updateAppearance({ design: "lumen" });
    await tick();
    expect(fake.calls.map((c) => c.patch)).toEqual([{ design: "lumen" }]);
    expect(fake.html.dataset.design).toBe("lumen");
    await answer();
    expect(server.design).toBe("lumen");
  });

  it("going back to the current design cancels a switch still waiting for its faces (Codex review #2)", async () => {
    void updateAppearance({ design: "atelier" });
    void updateAppearance({ design: "macos" });
    await tick();
    await tick();
    expect(fake.calls.map((c) => c.patch)).toEqual([{ design: "macos" }]);
    expect(fake.html.dataset.design).toBe("macos");
    await answer();
    expect(server.design).toBe("macos");
  });

  it("the sidebar's vibrancy also needs a design that allows it", async () => {
    void updateAppearance({ design: "macos" });
    await tick();
    expect(JSON.parse(fake.stored.get(APPEARANCE_KEY)!).vibrancy).toEqual({ light: true, dark: true });
    await answer();
  });
});

describe("concurrent appearance changes", () => {
  it("persists one change at a time, in order", async () => {
    void updateAppearance({ darkTheme: "dracula" });
    void updateAppearance({ darkTheme: "nord" });
    await tick();
    expect(fake.calls.map((c) => c.patch)).toEqual([{ darkTheme: "dracula" }]);
    await answer();
    expect(fake.calls.map((c) => c.patch)).toEqual([{ darkTheme: "nord" }]);
    await answer();
    expect(server.darkTheme).toBe("nord");
  });

  it("an earlier answer (an older snapshot) never paints over a newer choice", async () => {
    void updateAppearance({ darkTheme: "dracula" });
    void updateAppearance({ darkTheme: "nord" });
    expect(painted()).toBe("nord");
    await answer(); // the backend says dracula: nord is still pending
    expect(painted()).toBe("nord");
    expect(getApp().settings?.darkTheme).toBe("nord");
    await answer();
    expect(painted()).toBe("nord");
  });

  it("a snapshot from an unrelated change keeps the pending choice too", async () => {
    void updateAppearance({ motionMs: 0 });
    void updateAppearance({ darkTheme: "monokai" });
    await answer(); // motion's answer still has darkTheme terno-dark
    expect(painted()).toBe("monokai");
    expect(getApp().settings?.motionMs).toBe(0);
    // any other settings answer (General, IA…) is reconciled the same way
    setApp({ settings: reconcileSettings({ ...server, density: "compact" }) });
    expect(getApp().settings).toMatchObject({ darkTheme: "monokai", density: "compact" });
    await answer();
  });

  it("a refused change drops only itself; later pending choices stay", async () => {
    void updateAppearance({ darkTheme: "dracula" });
    void updateAppearance({ motionMs: 50 });
    await answer(false);
    expect(snack.error).toHaveBeenCalledWith("Couldn’t change the appearance: refused");
    expect(painted()).toBe("terno-dark");
    expect(getApp().settings).toMatchObject({ darkTheme: "terno-dark", motionMs: 50 });
    await answer();
    expect(getApp().settings).toMatchObject({ darkTheme: "terno-dark", motionMs: 50 });
  });

  it("a refused change behind a newer one of the same field doesn't revert it", async () => {
    void updateAppearance({ darkTheme: "dracula" });
    void updateAppearance({ darkTheme: "nord" });
    await answer(false);
    expect(painted()).toBe("nord");
    await answer();
    expect(painted()).toBe("nord");
  });
});
