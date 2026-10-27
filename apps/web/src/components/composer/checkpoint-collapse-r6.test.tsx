// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import { schema } from "@terno/richtext";
import { closeHistory, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";

const probe = vi.hoisted(() => ({ fail: false, reads: 0, views: [] as unknown[] }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.mock("./editor", async (original) => {
  const editor = await original<typeof import("./editor")>();
  return { ...editor, serialize: (doc: Parameters<typeof editor.serialize>[0]) => { if (probe.fail && doc.textContent.includes("authored")) { probe.reads++; throw new Error("read failed"); } return editor.serialize(doc); }, createEditor: (...args: Parameters<typeof editor.createEditor>) => { const value = editor.createEditor(...args); probe.views.push(value.view); return value; } };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

it("opens a valid collapsed checkpoint while its serializer still fails", async () => {
  const { DraftSlot } = await import("../inline-draft"), { AppBoundary } = await import("../diag/error-boundary"), { loadComposer } = await import("./lazy"), { controllerFor } = await import("./controller"), drafts = await import("~/lib/drafts"), { useDraftRecovery } = await import("~/lib/draft-recovery-ui"), { newFields } = await import("~/lib/compose-fields"), { sendDraft } = await import("~/lib/compose"), { client } = await import("~/rpc/connection");
  const { useAppearance } = await import("~/lib/appearance");
  useAppearance.setState({ motionMs: 0 });
  await loadComposer(); await import("../diag/recovery-workspace");
  const host = document.createElement("div"); host.id = "root"; document.body.append(host); const root = createRoot(host);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const key = drafts.createDraft({ ...newFields(1), mode: "reply", toText: "unfinished@", attachments: [{ assetId: "asset", filename: "exact.bin", mime: "application/octet-stream", size: 3 }] });
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
  } finally { probe.fail = false; await act(async () => root.unmount()); useDraftRecovery.setState({ open: false, key: null, reason: "error", checkpoint: undefined }); drafts.forgetDraft(key); host.remove(); error.mockRestore(); }
});
