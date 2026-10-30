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

it("does not steal focus after reopening when the user moves to another control before the frame", async () => {
  const { DraftSlot } = await import("./inline-draft");
  const { createDraft, forgetDraft, setDraftUi } = await import("~/lib/drafts");
  const { newFields } = await import("~/lib/compose-fields");
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const host = document.createElement("div"), other = document.createElement("button"); document.body.append(host, other);
  const root = createRoot(host), key = createDraft(newFields(1)); setDraftUi(key, "collapsed");
  try {
    await act(async () => root.render(<StrictMode><DraftSlot threadId={7} draftKey={key} replyTo="Sender" account={undefined} /></StrictMode>));
    const collapsed = host.querySelector<HTMLButtonElement>('[data-testid="draft-collapsed"]')!;
    expect(collapsed).not.toBeNull();
    await act(async () => { collapsed.focus(); collapsed.click(); });
    await act(async () => { other.focus(); const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); });
    expect(document.activeElement).toBe(other);
    const { loadComposer } = await import("./composer/lazy");
    await act(async () => { await loadComposer(); });
    expect(document.activeElement).toBe(other);
  } finally {
    await act(async () => root.unmount()); forgetDraft(key); host.remove(); other.remove(); raf.mockRestore(); cancel.mockRestore();
  }
});

it("gives the latest draft move ownership and releases an ineligible target after its last frame", async () => {
  const { focusSoon } = await import("./inline-draft");
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const first = document.createElement("div"), second = document.createElement("div"), outside = document.createElement("button");
  first.innerHTML = '<button data-testid="first">First</button>'; second.innerHTML = '<button data-testid="second">Second</button>';
  document.body.append(first, second, outside);
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); };
  try {
    focusSoon('[data-testid="first"]', first);
    focusSoon('[data-testid="second"]', second);
    flush(); expect(document.activeElement).toBe(second.firstElementChild);
    outside.focus();
    second.setAttribute("inert", "");
    const focus = vi.spyOn(second.firstElementChild as HTMLElement, "focus");
    focusSoon('[data-testid="second"]', second, 1);
    flush(); flush();
    expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(outside); expect(frames.size).toBe(0);
    second.removeAttribute("inert");
    focusSoon('[data-testid="second"]', second);
    second.remove(); flush();
    expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(outside); expect(frames.size).toBe(0);
  } finally { first.remove(); second.remove(); outside.remove(); raf.mockRestore(); cancel.mockRestore(); }
});


it("a rejected completion or a newer move cannot focus the old draft", async () => {
  const { focusSoon } = await import("~/lib/compose-focus-move");
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const host = document.createElement("div"); host.innerHTML = '<textarea data-testid="old"></textarea><textarea data-testid="new"></textarea>';
  document.body.append(host);
  const old = host.firstElementChild as HTMLTextAreaElement;
  const focus = vi.spyOn(old, "focus");
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((cb) => cb(0)); };
  try {
    focusSoon('[data-testid="old"]', host, 1, () => false, () => true);
    flush(); expect(focus).not.toHaveBeenCalled();
    focusSoon('[data-testid="old"]', host, 1, () => { focusSoon('[data-testid="new"]', host); return true; }, () => true);
    flush(); expect(focus).not.toHaveBeenCalled();
    flush(); expect(document.activeElement).toBe(host.lastElementChild);
  } finally { host.remove(); raf.mockRestore(); cancel.mockRestore(); }
});
