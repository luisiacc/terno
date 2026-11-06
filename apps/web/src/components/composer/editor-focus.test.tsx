// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import { closeHistory, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";

// Each test needs its own module state, so modules reset per test; the factory is registered with doMock because a
// reset keeps a vi.mock factory's first result.
const gate = { fail: false, views: [] as unknown[] };
const probe = { fail: false, reads: 0, get views() { return gate.views; } };
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

// transforms once, outside any test's timeout; each reset only evaluates again
beforeAll(async () => { await import("./rich"); await import("../inline-draft"); }, 120_000);
beforeEach(() => {
  vi.resetModules();
  gate.fail = false; gate.views = []; probe.fail = false; probe.reads = 0;
  vi.doMock("./editor", async (original) => {
    const actual = await original<typeof import("./editor")>();
    return { ...actual,
      serialize: (doc: Parameters<typeof actual.serialize>[0]) => {
        if (gate.fail) throw new Error("read failed");
        if (probe.fail && doc.textContent.includes("authored")) { probe.reads++; throw new Error("read failed"); }
        return actual.serialize(doc);
      },
      createEditor: (...args: Parameters<typeof actual.createEditor>) => { const editor = actual.createEditor(...args); gate.views.push(editor.view); return editor; },
    };
  });
});

describe("reopening a collapsed checkpoint", () => {
  it.each(["button", "later header"] as const)("keeps the latest focus when explicitly reopening a collapsed checkpoint: %s", async (scenario) => {
    const { schema } = await import("@terno/richtext");
    const { DraftSlot } = await import("../inline-draft"), { AppBoundary } = await import("../diag/error-boundary"), { controllerFor } = await import("./controller"), drafts = await import("~/lib/drafts"), { useDraftRecovery } = await import("~/lib/draft-recovery-ui"), { newFields } = await import("~/lib/compose-fields"), { sendDraft } = await import("~/lib/compose"), { client } = await import("~/rpc/connection");
    const { useAppearance } = await import("~/lib/appearance"), app = await import("~/state/app");
    const previousApp = app.getApp();
    app.setApp({ selectedId: 7, readerOpen: true });
    useAppearance.setState({ motionMs: 0 });
    const host = document.createElement("div"); host.id = "root"; document.body.append(host); const root = createRoot(host);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const key = drafts.createDraft({ ...newFields(1), mode: "reply", threadId: 7, toText: "unfinished@", attachments: [{ assetId: "asset", filename: "exact.bin", mime: "application/octet-stream", size: 3 }] });
    drafts.setDraftTransport(async (_method, params) => ({ ...(params as object), id: 1, generation: "test", revision: 1 }));
    function Screen({ fatal }: { fatal: boolean }) { if (fatal) throw new Error("synthetic fatal render"); return <DraftSlot threadId={7} draftKey={key} replyTo="" account={undefined} />; }
    try {
      await act(async () => root.render(<StrictMode><AppBoundary><Screen fatal={false} /></AppBoundary></StrictMode>));
      const view = probe.views.at(-1) as EditorView;
      await act(async () => { const tr = view.state.tr.insertText("authored rich"); tr.addMark(1, 9, schema.marks.bold!.create()); view.dispatch(tr); view.dispatch(closeHistory(view.state.tr).insertText("!", 14)); undo(view.state, view.dispatch); view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9, 3)).setStoredMarks([schema.marks.italic!.create()])); });
      const doc = view.state.doc.toJSON(), selection = view.state.selection.toJSON(), marks = view.state.storedMarks?.map((m) => m.toJSON()), history = undoDepth(view.state), redoHistory = redoDepth(view.state), version = drafts.useDrafts.getState().drafts[key]!.bodyVersion;
      probe.fail = true;
      await act(async () => view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      const checkpoint = drafts.bodyCheckpoint(key); expect(checkpoint).toBeDefined(); expect(drafts.validBodyCheckpoint(checkpoint!)).toBe(true); expect(controllerFor(key)).toBeNull();
      await act(async () => root.render(<StrictMode><AppBoundary><Screen fatal /></AppBoundary></StrictMode>));
      await act(async () => (host.querySelector('[data-testid="app-boundary-reload"]') as HTMLButtonElement).click());
      await act(async () => (host.querySelector('[data-testid="recovery-review"]') as HTMLButtonElement).click());
      expect(host.querySelector('[data-testid="recovery-workspace"]')).not.toBeNull();
      const button = host.querySelector<HTMLButtonElement>('[data-testid="draft-collapsed"]'); expect(button).not.toBeNull();
      const header = host.querySelector<HTMLButtonElement>('[data-testid="recovery-details"]')!;
      const off = drafts.useDrafts.subscribe((state, previous) => { if (scenario === "later header" && previous.drafts[key]?.uiState === "collapsed" && state.drafts[key]?.uiState === "open") header.focus(); });
      try { await act(async () => { button!.focus(); button!.click(); }); } finally { off(); }
      expect(host.querySelector('[data-testid="compose-body"]')).not.toBeNull();
      const restored = probe.views.at(-1) as EditorView;
      expect(document.activeElement).toBe(scenario === "button" ? restored.dom : header);
      expect(restored.state.doc.toJSON()).toEqual(doc); expect(restored.state.selection.toJSON()).toEqual(selection); expect(restored.state.storedMarks?.map((m) => m.toJSON())).toEqual(marks);
      expect(undoDepth(restored.state)).toBe(history); expect(redoDepth(restored.state)).toBe(redoHistory);
      await act(async () => { expect(redo(restored.state, restored.dispatch)).toBe(true); expect(undo(restored.state, restored.dispatch)).toBe(true); });
      expect(drafts.useDrafts.getState().drafts[key]).toMatchObject({ key, bodyVersion: version, toText: "unfinished@", attachments: [{ assetId: "asset", filename: "exact.bin", mime: "application/octet-stream", size: 3 }] });
      expect(await sendDraft(key)).toBe(false); expect(vi.mocked(client.call).mock.calls.some(([method]) => method === "compose.send")).toBe(false);
    } finally { probe.fail = false; await act(async () => root.unmount()); useDraftRecovery.setState({ open: false, key: null, reason: "error", checkpoint: undefined }); drafts.forgetDraft(key); app.setApp(previousApp, true); host.remove(); error.mockRestore(); }
  });
});

describe("a checkpoint whose serializer fails", () => {
  it("opens a valid collapsed checkpoint while its serializer still fails", async () => {
    const { schema } = await import("@terno/richtext");
    const { DraftSlot } = await import("../inline-draft"), { AppBoundary } = await import("../diag/error-boundary"), { controllerFor } = await import("./controller"), drafts = await import("~/lib/drafts"), { useDraftRecovery } = await import("~/lib/draft-recovery-ui"), { newFields } = await import("~/lib/compose-fields"), { sendDraft } = await import("~/lib/compose"), { client } = await import("~/rpc/connection");
    const { useAppearance } = await import("~/lib/appearance"), app = await import("~/state/app");
    const previousApp = app.getApp();
    app.setApp({ selectedId: 7, readerOpen: true });
    useAppearance.setState({ motionMs: 0 });
    const host = document.createElement("div"); host.id = "root"; document.body.append(host); const root = createRoot(host);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const key = drafts.createDraft({ ...newFields(1), mode: "reply", threadId: 7, toText: "unfinished@", attachments: [{ assetId: "asset", filename: "exact.bin", mime: "application/octet-stream", size: 3 }] });
    drafts.setDraftTransport(async (_method, params) => ({ ...(params as object), id: 1, generation: "test", revision: 1 }));
    function Screen({ fatal }: { fatal: boolean }) { if (fatal) throw new Error("synthetic fatal render"); return <DraftSlot threadId={7} draftKey={key} replyTo="" account={undefined} />; }
    try {
      await act(async () => root.render(<StrictMode><AppBoundary><Screen fatal={false} /></AppBoundary></StrictMode>));
      const view = probe.views.at(-1) as EditorView;
      await act(async () => { const tr = view.state.tr.insertText("authored rich"); tr.addMark(1, 9, schema.marks.bold!.create()); view.dispatch(tr); view.dispatch(closeHistory(view.state.tr).insertText("!", 14)); undo(view.state, view.dispatch); view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9, 3)).setStoredMarks([schema.marks.italic!.create()])); });
      const doc = view.state.doc.toJSON(), selection = view.state.selection.toJSON(), marks = view.state.storedMarks?.map((m) => m.toJSON()), history = undoDepth(view.state), redoHistory = redoDepth(view.state), version = drafts.useDrafts.getState().drafts[key]!.bodyVersion;
      probe.fail = true;
      await act(async () => view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      const checkpoint = drafts.bodyCheckpoint(key); expect(checkpoint).toBeDefined(); expect(drafts.validBodyCheckpoint(checkpoint!)).toBe(true); expect(controllerFor(key)).toBeNull();
      await act(async () => root.render(<StrictMode><AppBoundary><Screen fatal /></AppBoundary></StrictMode>));
      await act(async () => (host.querySelector('[data-testid="app-boundary-reload"]') as HTMLButtonElement).click());
      await act(async () => (host.querySelector('[data-testid="recovery-review"]') as HTMLButtonElement).click());
      expect(host.querySelector('[data-testid="recovery-workspace"]')).not.toBeNull();
      const button = host.querySelector<HTMLButtonElement>('[data-testid="draft-collapsed"]'); expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(host.querySelector('[data-testid="compose-body"]')).not.toBeNull();
      const restored = probe.views.at(-1) as EditorView;
      expect(restored.state.doc.toJSON()).toEqual(doc); expect(restored.state.selection.toJSON()).toEqual(selection); expect(restored.state.storedMarks?.map((m) => m.toJSON())).toEqual(marks);
      expect(undoDepth(restored.state)).toBe(history); expect(redoDepth(restored.state)).toBe(redoHistory);
      await act(async () => { expect(redo(restored.state, restored.dispatch)).toBe(true); expect(undo(restored.state, restored.dispatch)).toBe(true); });
      expect(drafts.useDrafts.getState().drafts[key]).toMatchObject({ key, bodyVersion: version, toText: "unfinished@", attachments: [{ assetId: "asset", filename: "exact.bin", mime: "application/octet-stream", size: 3 }] });
      expect(await sendDraft(key)).toBe(false); expect(vi.mocked(client.call).mock.calls.some(([method]) => method === "compose.send")).toBe(false);
    } finally { probe.fail = false; await act(async () => root.unmount()); useDraftRecovery.setState({ open: false, key: null, reason: "error", checkpoint: undefined }); drafts.forgetDraft(key); app.setApp(previousApp, true); host.remove(); error.mockRestore(); }
  });
});

describe("recovery focus", () => {
  it("cancels only its own queued request and retains a failed live request", async () => {
    const { focusBody, registerController } = await import("./controller");
    const key = "recovery-focus-token";
    const old = focusBody(key, "end"), current = focusBody(key, "keep");
    old();
    const bad = { focus: () => { throw new Error("focus failed"); } } as unknown as import("./controller").ComposerController;
    expect(() => registerController(key, bad)).toThrow("focus failed");
    const focus = vi.fn();
    const good = { focus } as unknown as import("./controller").ComposerController;
    const unregister = registerController(key, good);
    expect(focus).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledWith("keep");
    current(); unregister();
  });
});

describe("inline draft focus", () => {
  it("does not steal focus after reopening when the user moves to another control before the frame", async () => {
    const { DraftSlot } = await import("../inline-draft");
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
    } finally {
      await act(async () => root.unmount()); forgetDraft(key); host.remove(); other.remove(); raf.mockRestore(); cancel.mockRestore();
    }
  });

  it("gives the latest draft move ownership and releases an ineligible target after its last frame", async () => {
    const { focusSoon } = await import("../inline-draft");
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
});

describe("a reentrant focus move", () => {
  it("keeps a focus move started while completing the previous move", async () => {
    const { focusSoon } = await import("../inline-draft");
    const frames = new Map<number, FrameRequestCallback>(); let next = 0, started = false;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const host = document.createElement("div");
    host.innerHTML = '<button data-first></button><button data-old></button><button data-new></button>';
    document.body.append(host);
    try {
      focusSoon("[data-first]", host, 1, () => { started = true; focusSoon("[data-new]", host); const immediate = [...frames.values()]; frames.clear(); immediate.forEach((fn) => fn(0)); });
      focusSoon("[data-old]", host);
      expect(started).toBe(true);
      const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn(0));
      expect(document.activeElement).toBe(host.querySelector("[data-new]"));
    } finally { host.remove(); raf.mockRestore(); cancel.mockRestore(); }
  });
});
