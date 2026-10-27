// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

it("hands a requested reopen focus from the lazy stand-in to the real editor", async () => {
  const { DraftSlot } = await import("../inline-draft");
  const { loadComposer } = await import("./lazy");
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
    expect(document.activeElement).toBe(host.querySelector('[data-testid="compose-body-loading"]') ?? host.querySelector('[data-testid="compose-body"]'));
    await act(async () => { await loadComposer(); });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="compose-body"]'));
  } finally { await act(async () => root.unmount()); forgetDraft(key); host.remove(); raf.mockRestore(); cancel.mockRestore(); }
});
