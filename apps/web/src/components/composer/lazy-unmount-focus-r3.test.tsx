// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const gate = vi.hoisted(() => { let release!: () => void; const ready = new Promise<void>((r) => { release = r; }); return { ready, release }; });
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.mock("./rich", async (original) => { await gate.ready; return original<typeof import("./rich")>(); });
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

it("does not revive focus from an unmounted draft when the same key mounts again", async () => {
  const { DraftSlot } = await import("../inline-draft");
  const { loadComposer } = await import("./lazy");
  const { controllerFor } = await import("./controller");
  const { createDraft, forgetDraft, setDraftTransport } = await import("~/lib/drafts");
  const { newFields } = await import("~/lib/compose-fields");
  const { useAppearance } = await import("~/lib/appearance");
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const host = document.createElement("div"), other = document.createElement("button"); document.body.append(host, other);
  const root = createRoot(host), key = createDraft({ ...newFields(1), mode: "reply" });
  useAppearance.setState({ motionMs: 0 });
  setDraftTransport(async (_method, params) => ({ ...(params as object), id: 1, generation: "test", revision: 1 }));
  try {
    await act(async () => root.render(<StrictMode><DraftSlot threadId={7} draftKey={key} replyTo="Sender" account={undefined} /></StrictMode>));
    const first = host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]')!;
    expect(first).not.toBeNull(); expect(controllerFor(key)).toBeNull();
    await act(async () => { first.focus(); first.innerText = "early typed"; first.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(document.activeElement).toBe(first);
    await act(async () => root.render(null));
    expect(host.querySelector('[data-testid="compose-body-loading"]')).toBeNull();
    await act(async () => other.focus());
    await act(async () => root.render(<StrictMode><DraftSlot threadId={7} draftKey={key} replyTo="Sender" account={undefined} /></StrictMode>));
    expect(host.querySelector('[data-testid="compose-body-loading"]')).not.toBeNull();
    expect(document.activeElement).toBe(other);
    await act(async () => { gate.release(); await loadComposer(); });
    expect(controllerFor(key)).not.toBeNull();
    expect(controllerFor(key)?.dom.textContent).toBe("early typed");
    expect(document.activeElement).toBe(other);
  } finally { gate.release(); await act(async () => { await loadComposer(); root.unmount(); }); forgetDraft(key); host.remove(); other.remove(); raf.mockRestore(); cancel.mockRestore(); }
});
