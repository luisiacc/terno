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

it("hands the second draft stand-in focus to its delayed real editor", async () => {
  const { RecoveryWorkspace } = await import("./recovery-workspace");
  const { loadComposer } = await import("../composer/lazy");
  const { controllerFor } = await import("../composer/controller");
  const { createDraft, forgetDraft } = await import("~/lib/drafts");
  const { newFields } = await import("~/lib/compose-fields");
  const { useDraftRecovery } = await import("~/lib/draft-recovery-ui");
  const first = createDraft({ ...newFields(1), subject: "First" });
  const second = createDraft({ ...newFields(1), subject: "Second" });
  useDraftRecovery.setState({ open: true, key: first, reason: "error", checkpoint: undefined });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<StrictMode><RecoveryWorkspace /></StrictMode>));
    const selector = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { selector.focus(); selector.value = second; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(selector.value).toBe(second); expect(document.activeElement).toBe(selector);
    const standIn = host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]')!;
    expect(standIn).not.toBeNull(); expect(controllerFor(second)).toBeNull();
    await act(async () => standIn.focus()); expect(document.activeElement).toBe(standIn);

    await act(async () => { gate.release(); await loadComposer(); });
    expect(controllerFor(second)).not.toBeNull();
    expect(document.activeElement).toBe(controllerFor(second)?.dom);
  } finally {
    gate.release(); await act(async () => { await loadComposer(); root.unmount(); });
    useDraftRecovery.setState({ open: false, key: null, checkpoint: undefined }); forgetDraft(first); forgetDraft(second); host.remove();
  }
});
