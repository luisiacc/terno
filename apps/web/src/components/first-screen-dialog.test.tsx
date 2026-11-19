// @vitest-environment jsdom
/**
 * Plan 207: the first-screen question's answer, while it saves: another dialog opened meanwhile keeps the stage (Codex
 * code review #3), and a save that fails leaves the question open and says so. The flow itself is first-screen.spec.ts.
 */
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));

const call = vi.fn();
vi.mock("~/rpc/connection", () => ({ client: { call: (...a: unknown[]) => call(...a) } }));
vi.mock("~/lib/appearance", () => ({ reconcileSettings: (s: unknown) => s }));
vi.mock("~/lib/ai", () => ({ todayOffered: () => true }));

const { FirstScreenDialog } = await import("./first-screen-dialog");
const { getApp, setApp } = await import("~/state/app");

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  setLocale("en", en);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  setApp({ dialog: "firstScreen", today: false, settings: { firstScreen: null } as never });
  act(() => root.render(<FirstScreenDialog />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  call.mockReset();
});

describe("the first-screen question's answer", () => {
  it("Settings opened while Yes saves: the choice lands, Settings and where you are stay", async () => {
    let answer!: (v: unknown) => void;
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    act(() => q("first-screen-choose-what-matters")!.click());
    expect(call).toHaveBeenCalledWith("settings.update", { firstScreen: "whatMatters" });
    act(() => setApp({ dialog: "settings" }));
    await act(async () => answer({ firstScreen: "whatMatters" }));
    expect(getApp().settings?.firstScreen).toBe("whatMatters");
    expect(getApp().dialog).toBe("settings");
    expect(getApp().today).toBe(false);
  });

  it("Yes saved with the question still up: it closes and What matters opens", async () => {
    call.mockResolvedValue({ firstScreen: "whatMatters" });
    await act(async () => q("first-screen-choose-what-matters")!.click());
    expect(getApp().dialog).toBe(null);
    expect(getApp().today).toBe(true);
  });

  it("a save that fails: the question stays, says so, and can be answered again", async () => {
    call.mockRejectedValueOnce(new Error("down"));
    await act(async () => q("first-screen-keep-inbox")!.click());
    expect(getApp().dialog).toBe("firstScreen");
    expect(q("first-screen-error")?.textContent).toBe("Your choice wasn't saved. Try again.");
    expect((q("first-screen-keep-inbox") as HTMLButtonElement).disabled).toBe(false);
  });
});
