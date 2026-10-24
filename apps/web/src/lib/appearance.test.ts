/**
 * Concurrent appearance changes: persisted one at a time, and every answer or
 * refusal reconciled against what is still pending, so an older snapshot never
 * paints over a newer choice. Runs in Node with a minimal fake <html>.
 */
import type { AppSettings } from "@unica/core/rpc";
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
  g.localStorage = { setItem() {}, getItem: () => null };
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => {};
  /** settings.update calls, answered by hand in the order the test chooses */
  const calls: { patch: Record<string, unknown>; resolve(v: unknown): void; reject(e: unknown): void }[] = [];
  return { html, calls };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (_method: string, patch: Record<string, unknown>) => new Promise((resolve, reject) => fake.calls.push({ patch, resolve, reject })),
  },
}));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: vi.fn(), success: () => {} }) }));

const { reconcileSettings, sidebarVibrancy, updateAppearance } = await import("./appearance");
const { getApp, setApp } = await import("~/state/app");
const { toast } = await import("sonner");

const SERVER: AppSettings = {
  localMode: true,
  theme: "dark",
  lightTheme: "unica-light",
  darkTheme: "unica-dark",
  motionMs: 75,
  htmlMailAppearance: "auto",
  customThemes: [],
  density: "comfortable",
  remoteImages: "ask",
  allowAgentSend: false,
  gmailClientId: "",
  gmailClientSecretSet: false,
  syncWindowDays: 90,
  autoCategorize: "auto",
  aiCategorize: false,
  ai: { provider: "none", model: "", baseURL: null, preset: null, hasKey: false, keyHint: null, keyOrigin: null, keyConfirmed: true, local: true, capabilities: null, profiles: {} },
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
    await answer(); // motion's answer still has darkTheme unica-dark
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
    expect(toast.error).toHaveBeenCalled();
    expect(painted()).toBe("unica-dark");
    expect(getApp().settings).toMatchObject({ darkTheme: "unica-dark", motionMs: 50 });
    await answer();
    expect(getApp().settings).toMatchObject({ darkTheme: "unica-dark", motionMs: 50 });
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
