// @vitest-environment jsdom
/**
 * Plan 210 (iteration 4): a snack's Undo shows one key, the one the shortcuts help names first (Z), while single keys are
 * on; off, the platform's undo, which always works. Both are named for a screen reader whenever they work.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => null), on: () => () => {}, connectionVersion: 1 } }));

const { CountdownPill } = await import("./countdown-pill");
const { useApp, getApp } = await import("~/state/app");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const pill = () => host.querySelector<HTMLButtonElement>("[data-testid=pill]")!;

async function show(characterKeys: boolean) {
  await act(async () => {
    useApp.setState({ settings: { ...getApp().settings, characterKeys } as never });
    root.render(<CountdownPill label="Undo" onClick={() => {}} shortcut="z" testId="pill" countdown={{ duration: 0, elapsed: () => 0, paused: true, sync: "" }} />);
  });
}

it("the keycap is Z while single keys are on, the platform's undo when they're off; both named while they work", async () => {
  await show(true);
  expect(pill().querySelector("[data-key]")!.getAttribute("data-key")).toBe("Z");
  expect(pill().getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+Z Z$/);
  await show(false);
  expect(pill().querySelector("[data-key]")!.getAttribute("data-key")).toMatch(/^(⌘Z|Ctrl\+Z)$/);
  expect(pill().getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+Z$/);
});
