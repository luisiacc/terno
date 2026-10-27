// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const gate = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
});
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.mock("../composer/rich", async (original) => { await gate.ready; return original<typeof import("../composer/rich")>(); });
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

it("does not take focus from a recovery control when the delayed real editor registers", async () => {
  const { RecoveryWorkspace } = await import("./recovery-workspace");
  const { loadComposer } = await import("../composer/lazy");
  const { controllerFor, registerController } = await import("../composer/controller");
  const { createDraft, forgetDraft } = await import("~/lib/drafts");
  const { newFields } = await import("~/lib/compose-fields");
  const { useDraftRecovery } = await import("~/lib/draft-recovery-ui");
  const key = createDraft(newFields(1)); useDraftRecovery.setState({ open: true, key, reason: "error", checkpoint: undefined });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<StrictMode><RecoveryWorkspace /></StrictMode>));
    const standIn = host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]');
    const control = host.querySelector<HTMLButtonElement>('[data-testid="recovery-details"]');
    expect(standIn).not.toBeNull(); expect(control).not.toBeNull(); expect(controllerFor(key)).toBeNull();
    await act(async () => root.render(null));
    const oldFocus = vi.fn();
    const unregister = registerController(key, { focus: oldFocus } as unknown as import("../composer/controller").ComposerController);
    expect(oldFocus).not.toHaveBeenCalled(); unregister();
    await act(async () => root.render(<StrictMode><RecoveryWorkspace /></StrictMode>));
    const reopened = host.querySelector<HTMLButtonElement>('[data-testid="recovery-details"]')!;
    const reopenedStandIn = host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]')!;
    await act(async () => reopenedStandIn.focus()); expect(document.activeElement).toBe(reopenedStandIn);
    await act(async () => reopened.focus()); expect(document.activeElement).toBe(reopened);
    await act(async () => { gate.release(); await loadComposer(); });
    expect(controllerFor(key)).not.toBeNull();
    expect(document.activeElement).toBe(reopened);
  } finally {
    gate.release(); await act(async () => { await loadComposer(); root.unmount(); });
    useDraftRecovery.setState({ open: false, key: null, checkpoint: undefined }); forgetDraft(key); host.remove();
  }
});

it("cancels only its own queued request and retains a failed live request", async () => {
  const { focusBody, registerController } = await import("../composer/controller");
  const key = "recovery-focus-token";
  const old = focusBody(key, "end"), current = focusBody(key, "keep");
  old();
  const bad = { focus: () => { throw new Error("focus failed"); } } as unknown as import("../composer/controller").ComposerController;
  expect(() => registerController(key, bad)).toThrow("focus failed");
  const focus = vi.fn();
  const good = { focus } as unknown as import("../composer/controller").ComposerController;
  const unregister = registerController(key, good);
  expect(focus).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledWith("keep");
  current(); unregister();
});
