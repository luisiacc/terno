// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import { schema } from "@terno/richtext";
import { closeHistory, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";

const gate = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release, fail: false, views: [] as unknown[] };
});
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.mock("../composer/rich", async (original) => { await gate.ready; return original<typeof import("../composer/rich")>(); });
vi.mock("../composer/editor", async (original) => {
  const actual = await original<typeof import("../composer/editor")>();
  return { ...actual,
    serialize: (doc: Parameters<typeof actual.serialize>[0]) => { if (gate.fail) throw new Error("read failed"); return actual.serialize(doc); },
    createEditor: (...args: Parameters<typeof actual.createEditor>) => { const editor = actual.createEditor(...args); gate.views.push(editor.view); return editor; },
  };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

it("hands a focused checkpoint stand-in to the editor without changing its retained state", async () => {
  const { RichBody } = await vi.importActual<typeof import("../composer/rich")>("../composer/rich");
  const { RecoveryWorkspace } = await import("./recovery-workspace");
  const { loadComposer } = await import("../composer/lazy");
  const { controllerFor } = await import("../composer/controller");
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
