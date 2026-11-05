// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import { closeHistory, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";

// The delayed real editor against what was typed and focused meanwhile. Each test needs the composer chunk
// still unloaded and its own module state, so modules reset per test; the factories are registered with
// doMock because a reset keeps a vi.mock factory's first result, and with it an already released gate.
const gate = { ready: Promise.resolve(), release: () => {}, fail: false, views: [] as unknown[] };
const probe = { fail: false, reads: 0, get views() { return gate.views; } };
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

beforeEach(() => {
  vi.resetModules();
  gate.ready = new Promise<void>((resolve) => { gate.release = resolve; }); gate.fail = false; gate.views = []; probe.fail = false; probe.reads = 0;
  vi.doMock("./rich", async (original) => { await gate.ready; return original<typeof import("./rich")>(); });
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

describe("the lazy stand-in", () => {
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
});

describe("collapsing a focused stand-in", () => {
  it("keeps later user focus after a focused lazy draft is collapsed and reopened", async () => {
    const { DraftSlot } = await import("../inline-draft");
    const { loadComposer } = await import("./lazy");
    const { controllerFor } = await import("./controller");
    const { createDraft, forgetDraft, setDraftTransport } = await import("~/lib/drafts");
    const { newFields } = await import("~/lib/compose-fields");
    const { useAppearance } = await import("~/lib/appearance");
    const frames = new Map<number, FrameRequestCallback>(); let next = 0;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const flush = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); });
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
      await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(host.querySelector('[data-testid="compose-body-loading"]')).toBeNull();
      await flush();
      const collapsed = host.querySelector<HTMLButtonElement>('[data-testid="draft-collapsed"]')!;
      expect(document.activeElement).toBe(collapsed);
      await act(async () => collapsed.click());
      expect(host.querySelector('[data-testid="compose-body-loading"]')).not.toBeNull();
      await act(async () => other.focus()); await flush(); expect(document.activeElement).toBe(other);
      await act(async () => { gate.release(); await loadComposer(); });
      expect(controllerFor(key)).not.toBeNull();
      expect(controllerFor(key)?.dom.textContent).toBe("early typed");
      expect(document.activeElement).toBe(other);
    } finally { gate.release(); await act(async () => { await loadComposer(); root.unmount(); }); forgetDraft(key); host.remove(); other.remove(); raf.mockRestore(); cancel.mockRestore(); }
  });
});

describe("reopening hands off early text", () => {
  it("preserves a newly focused stand-in and early text after reopening", async () => {
    const { DraftSlot } = await import("../inline-draft");
    const { loadComposer } = await import("./lazy");
    const { controllerFor } = await import("./controller");
    const { createDraft, forgetDraft, setDraftTransport } = await import("~/lib/drafts");
    const { newFields } = await import("~/lib/compose-fields");
    const { useAppearance } = await import("~/lib/appearance");
    const frames = new Map<number, FrameRequestCallback>(); let next = 0;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const flush = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); });
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
      await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(host.querySelector('[data-testid="compose-body-loading"]')).toBeNull();
      await flush();
      const collapsed = host.querySelector<HTMLButtonElement>('[data-testid="draft-collapsed"]')!;
      expect(document.activeElement).toBe(collapsed);
      await act(async () => collapsed.click());
      expect(host.querySelector('[data-testid="compose-body-loading"]')).not.toBeNull();
      await flush();
      const reopened = host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]')!;
      expect(document.activeElement).toBe(reopened);
      await act(async () => { gate.release(); await loadComposer(); });
      expect(controllerFor(key)).not.toBeNull();
      expect(controllerFor(key)?.dom.textContent).toBe("early typed");
      expect(document.activeElement).toBe(controllerFor(key)?.dom);
    } finally { gate.release(); await act(async () => { await loadComposer(); root.unmount(); }); forgetDraft(key); host.remove(); other.remove(); raf.mockRestore(); cancel.mockRestore(); }
  });
});

describe("collapsing an untouched stand-in", () => {
  it("keeps later user focus after an untouched lazy draft is collapsed and reopened", async () => {
    const { DraftSlot } = await import("../inline-draft");
    const { loadComposer } = await import("./lazy");
    const { controllerFor } = await import("./controller");
    const { createDraft, forgetDraft, setDraftTransport } = await import("~/lib/drafts");
    const { newFields } = await import("~/lib/compose-fields");
    const { useAppearance } = await import("~/lib/appearance");
    const frames = new Map<number, FrameRequestCallback>(); let next = 0;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const flush = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); });
    const host = document.createElement("div"), other = document.createElement("button"); document.body.append(host, other);
    const root = createRoot(host), key = createDraft({ ...newFields(1), mode: "reply" });
    useAppearance.setState({ motionMs: 0 });
    setDraftTransport(async (_method, params) => ({ ...(params as object), id: 1, generation: "test", revision: 1 }));
    try {
      await act(async () => root.render(<StrictMode><DraftSlot threadId={7} draftKey={key} replyTo="Sender" account={undefined} /></StrictMode>));
      const first = host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]')!;
      expect(first).not.toBeNull(); expect(controllerFor(key)).toBeNull();
      await act(async () => first.focus());
      expect(document.activeElement).toBe(first);
      await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(host.querySelector('[data-testid="compose-body-loading"]')).toBeNull();
      await flush();
      const collapsed = host.querySelector<HTMLButtonElement>('[data-testid="draft-collapsed"]')!;
      expect(document.activeElement).toBe(collapsed);
      await act(async () => collapsed.click());
      expect(host.querySelector('[data-testid="compose-body-loading"]')).not.toBeNull();
      await act(async () => other.focus()); await flush(); expect(document.activeElement).toBe(other);
      await act(async () => { gate.release(); await loadComposer(); });
      expect(controllerFor(key)).not.toBeNull();
      expect(controllerFor(key)?.dom.textContent).toBe("");
      expect(document.activeElement).toBe(other);
    } finally { gate.release(); await act(async () => { await loadComposer(); root.unmount(); }); forgetDraft(key); host.remove(); other.remove(); raf.mockRestore(); cancel.mockRestore(); }
  });
});

describe("a remount with the body focused", () => {
  it("does not revive an old mount token when the same key returns with body focused", async () => {
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
      expect(document.activeElement).toBe(document.body);
      await act(async () => root.render(<StrictMode><DraftSlot threadId={7} draftKey={key} replyTo="Sender" account={undefined} /></StrictMode>));
      expect(host.querySelector('[data-testid="compose-body-loading"]')).not.toBeNull();
      expect(document.activeElement).toBe(document.body);
      await act(async () => { gate.release(); await loadComposer(); });
      expect(controllerFor(key)).not.toBeNull();
      expect(controllerFor(key)?.dom.textContent).toBe("early typed");
      expect(document.activeElement).toBe(document.body);
    } finally { gate.release(); await act(async () => { await loadComposer(); root.unmount(); }); forgetDraft(key); host.remove(); other.remove(); raf.mockRestore(); cancel.mockRestore(); }
  });
});

describe("an unmounted draft", () => {
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
});

describe("reopening a collapsed checkpoint", () => {
  beforeEach(() => { gate.release(); });
  it.each(["button", "later header"] as const)("keeps the latest focus when explicitly reopening a collapsed checkpoint: %s", async (scenario) => {
    const { schema } = await import("@terno/richtext");
    const { DraftSlot } = await import("../inline-draft"), { AppBoundary } = await import("../diag/error-boundary"), { loadComposer } = await import("./lazy"), { controllerFor } = await import("./controller"), drafts = await import("~/lib/drafts"), { useDraftRecovery } = await import("~/lib/draft-recovery-ui"), { newFields } = await import("~/lib/compose-fields"), { sendDraft } = await import("~/lib/compose"), { client } = await import("~/rpc/connection");
    const { useAppearance } = await import("~/lib/appearance"), app = await import("~/state/app");
    const previousApp = app.getApp();
    app.setApp({ selectedId: 7, readerOpen: true });
    useAppearance.setState({ motionMs: 0 });
    await loadComposer(); await import("../diag/recovery-workspace");
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
  beforeEach(() => { gate.release(); });
  it("opens a valid collapsed checkpoint while its serializer still fails", async () => {
    const { schema } = await import("@terno/richtext");
    const { DraftSlot } = await import("../inline-draft"), { AppBoundary } = await import("../diag/error-boundary"), { loadComposer } = await import("./lazy"), { controllerFor } = await import("./controller"), drafts = await import("~/lib/drafts"), { useDraftRecovery } = await import("~/lib/draft-recovery-ui"), { newFields } = await import("~/lib/compose-fields"), { sendDraft } = await import("~/lib/compose"), { client } = await import("~/rpc/connection");
    const { useAppearance } = await import("~/lib/appearance"), app = await import("~/state/app");
    const previousApp = app.getApp();
    app.setApp({ selectedId: 7, readerOpen: true });
    useAppearance.setState({ motionMs: 0 });
    await loadComposer(); await import("../diag/recovery-workspace");
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

describe("a checkpoint recovery control", () => {
  it("keeps focus on a checkpoint recovery control selected after the stand-in", async () => {
    const { schema } = await import("@terno/richtext");
    const { RichBody } = await vi.importActual<typeof import("./rich")>("../composer/rich");
    const { RecoveryWorkspace } = await import("../diag/recovery-workspace");
    const { loadComposer } = await import("./lazy");
    const { controllerFor } = await import("./controller");
    const { createDraft, forgetDraft, bodyCheckpoint } = await import("~/lib/drafts");
    const { newFields } = await import("~/lib/compose-fields");
    const { useDraftRecovery } = await import("~/lib/draft-recovery-ui");
    const key = createDraft(newFields(1));
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<StrictMode><RichBody draftKey={key} placeholder="Body" /></StrictMode>));
      const view = gate.views.at(-1) as EditorView;
      await act(async () => { const tr = view.state.tr.insertText("authored rich"); tr.addMark(1, 9, schema.marks.bold!.create()); view.dispatch(tr); });
      await act(async () => { view.dispatch(closeHistory(view.state.tr).insertText("!", 14)); undo(view.state, view.dispatch); });
      await act(async () => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9, 3)).setStoredMarks([schema.marks.italic!.create()])));
      const doc = view.state.doc.toJSON(), selection = view.state.selection.toJSON(), marks = view.state.storedMarks?.map((m) => m.toJSON()), history = undoDepth(view.state), redoHistory = redoDepth(view.state);
      expect(history).toBeGreaterThan(0); expect(redoHistory).toBeGreaterThan(0);
      gate.fail = true; await act(async () => root.render(null));
      const checkpoint = bodyCheckpoint(key); expect(checkpoint).toBeDefined();
      useDraftRecovery.setState({ open: true, key, reason: "error", checkpoint });
      await act(async () => root.render(<StrictMode><RecoveryWorkspace /></StrictMode>));
      const standIn = host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]')!;
      expect(standIn).not.toBeNull(); expect(controllerFor(key)).toBeNull();
      await act(async () => standIn.focus()); expect(document.activeElement).toBe(standIn);
      const control = host.querySelector<HTMLButtonElement>('[data-testid="recovery-details"]')!;
      await act(async () => control.focus()); expect(document.activeElement).toBe(control);
      await act(async () => { gate.release(); await loadComposer(); });
      const restored = gate.views.at(-1) as EditorView;
      expect(document.activeElement).toBe(control);
      expect(restored.state.doc.toJSON()).toEqual(doc); expect(restored.state.selection.toJSON()).toEqual(selection);
      expect(restored.state.storedMarks?.map((m) => m.toJSON())).toEqual(marks);
      expect(undoDepth(restored.state)).toBe(history); expect(redoDepth(restored.state)).toBe(redoHistory);
      await act(async () => { expect(redo(restored.state, restored.dispatch)).toBe(true); expect(undo(restored.state, restored.dispatch)).toBe(true); });
      expect(restored.state.doc.toJSON()).toEqual(doc);
    } finally {
      gate.fail = false; gate.release(); await act(async () => { await loadComposer(); root.unmount(); });
      useDraftRecovery.setState({ open: false, key: null, checkpoint: undefined }); forgetDraft(key); host.remove();
    }
  });
});

describe("a focused checkpoint stand-in", () => {
  it("hands a focused checkpoint stand-in to the editor without changing its retained state", async () => {
    const { schema } = await import("@terno/richtext");
    const { RichBody } = await vi.importActual<typeof import("./rich")>("../composer/rich");
    const { RecoveryWorkspace } = await import("../diag/recovery-workspace");
    const { loadComposer } = await import("./lazy");
    const { controllerFor } = await import("./controller");
    const { createDraft, forgetDraft, bodyCheckpoint } = await import("~/lib/drafts");
    const { newFields } = await import("~/lib/compose-fields");
    const { useDraftRecovery } = await import("~/lib/draft-recovery-ui");
    const key = createDraft(newFields(1));
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<StrictMode><RichBody draftKey={key} placeholder="Body" /></StrictMode>));
      const view = gate.views.at(-1) as EditorView;
      await act(async () => { const tr = view.state.tr.insertText("authored rich"); tr.addMark(1, 9, schema.marks.bold!.create()); view.dispatch(tr); });
      await act(async () => { view.dispatch(closeHistory(view.state.tr).insertText("!", 14)); undo(view.state, view.dispatch); });
      await act(async () => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9, 3)).setStoredMarks([schema.marks.italic!.create()])));
      const doc = view.state.doc.toJSON(), selection = view.state.selection.toJSON(), marks = view.state.storedMarks?.map((m) => m.toJSON()), history = undoDepth(view.state), redoHistory = redoDepth(view.state);
      expect(history).toBeGreaterThan(0); expect(redoHistory).toBeGreaterThan(0);
      gate.fail = true; await act(async () => root.render(null));
      const checkpoint = bodyCheckpoint(key); expect(checkpoint).toBeDefined();
      useDraftRecovery.setState({ open: true, key, reason: "error", checkpoint });
      await act(async () => root.render(<StrictMode><RecoveryWorkspace /></StrictMode>));
      const standIn = host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]')!;
      expect(standIn).not.toBeNull(); expect(controllerFor(key)).toBeNull();
      await act(async () => standIn.focus()); expect(document.activeElement).toBe(standIn);
      await act(async () => { gate.release(); await loadComposer(); });
      const restored = gate.views.at(-1) as EditorView;
      expect(document.activeElement).toBe(restored.dom);
      expect(restored.state.doc.toJSON()).toEqual(doc); expect(restored.state.selection.toJSON()).toEqual(selection);
      expect(restored.state.storedMarks?.map((m) => m.toJSON())).toEqual(marks);
      expect(undoDepth(restored.state)).toBe(history); expect(redoDepth(restored.state)).toBe(redoHistory);
      await act(async () => { expect(redo(restored.state, restored.dispatch)).toBe(true); expect(undo(restored.state, restored.dispatch)).toBe(true); });
      expect(restored.state.doc.toJSON()).toEqual(doc);
    } finally {
      gate.fail = false; gate.release(); await act(async () => { await loadComposer(); root.unmount(); });
      useDraftRecovery.setState({ open: false, key: null, checkpoint: undefined }); forgetDraft(key); host.remove();
    }
  });
});

describe("recovery focus", () => {
  it("does not take focus from a recovery control when the delayed real editor registers", async () => {
    const { RecoveryWorkspace } = await import("../diag/recovery-workspace");
    const { loadComposer } = await import("./lazy");
    const { controllerFor, registerController } = await import("./controller");
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
      const unregister = registerController(key, { focus: oldFocus } as unknown as import("./controller").ComposerController);
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

describe("the selector hands off", () => {
  it("hands the second draft stand-in focus to its delayed real editor", async () => {
    const { RecoveryWorkspace } = await import("../diag/recovery-workspace");
    const { loadComposer } = await import("./lazy");
    const { controllerFor } = await import("./controller");
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
});

describe("the selector returns", () => {
  it("preserves selector focus when returning from the second draft stand-in", async () => {
    const { RecoveryWorkspace } = await import("../diag/recovery-workspace");
    const { loadComposer } = await import("./lazy");
    const { controllerFor } = await import("./controller");
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
      await act(async () => selector.focus()); expect(document.activeElement).toBe(selector);
      await act(async () => { gate.release(); await loadComposer(); });
      expect(controllerFor(second)).not.toBeNull();
      expect(document.activeElement).toBe(selector);
    } finally {
      gate.release(); await act(async () => { await loadComposer(); root.unmount(); });
      useDraftRecovery.setState({ open: false, key: null, checkpoint: undefined }); forgetDraft(first); forgetDraft(second); host.remove();
    }
  });
});

describe("inline draft focus", () => {
  beforeEach(() => { gate.release(); });
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
      const { loadComposer } = await import("./lazy");
      await act(async () => { await loadComposer(); });
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
  beforeEach(() => { gate.release(); });
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
