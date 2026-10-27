// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const gate = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
});
vi.mock("./rich", async (original) => { await gate.ready; return original<typeof import("./rich")>(); });
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

it("hands a requested reopen focus from the lazy stand-in to the real editor", async () => {
  const { DraftSlot } = await import("../inline-draft");
  const { loadComposer } = await import("./lazy");
  const { controllerFor } = await import("./controller");
  const { createDraft, forgetDraft, setDraftUi } = await import("~/lib/drafts");
  const { newFields } = await import("~/lib/compose-fields");
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), key = createDraft(newFields(1)); setDraftUi(key, "collapsed");
  try {
    await act(async () => root.render(<StrictMode><DraftSlot threadId={7} draftKey={key} replyTo="Sender" account={undefined} /></StrictMode>));
    await act(async () => (host.querySelector('[data-testid="draft-collapsed"]') as HTMLButtonElement).click());
    await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); });
    const standIn = host.querySelector('[data-testid="compose-body-loading"]');
    expect(standIn).not.toBeNull(); expect(document.activeElement).toBe(standIn); expect(controllerFor(key)).toBeNull();
    await act(async () => { gate.release(); await loadComposer(); });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="compose-body"]'));
  } finally { gate.release(); await act(async () => { await loadComposer(); root.unmount(); }); forgetDraft(key); host.remove(); raf.mockRestore(); cancel.mockRestore(); }
});
