// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import { schema } from "@terno/richtext";
import * as editor from "./editor";
import { ghostKey } from "./ghost";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
const { RichBody } = await import("./rich");
const { createDraft, forgetDraft, setDraftTransport, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");

it("ghost-only updates do not repeat huge-draft toolbar scans or dirty the body", async () => {
  let view: EditorView | undefined;
  const create = editor.createEditor;
  const capture = vi.spyOn(editor, "createEditor").mockImplementation((...args) => {
    const result = create(...args); view = result.view; return result;
  });
  const format = vi.spyOn(editor, "formatState");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const key = createDraft({ ...newFields(1), bodyText: Array.from({ length: 3000 }, (_, i) => `${i} authored line`).join("\n") });
  setDraftTransport(async () => null);
  const frame = () => act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
  try {
    await act(async () => root.render(<RichBody draftKey={key} placeholder="Body" />));
    await frame();
    const before = useDrafts.getState().drafts[key]!;
    const doc = view!.state.doc;
    format.mockClear();
    await act(async () => view!.dispatch(view!.state.tr.setMeta(ghostKey, { set: { text: " suggestion", pos: view!.state.selection.from } }).setMeta("addToHistory", false)));
    await frame();
    await act(async () => view!.dispatch(view!.state.tr.setMeta(ghostKey, { clear: true }).setMeta("addToHistory", false)));
    await frame();
    expect(format).toHaveBeenCalledTimes(0);
    expect(view!.state.doc).toBe(doc);
    expect(useDrafts.getState().drafts[key]).toBe(before);
    await act(async () => view!.dispatch(view!.state.tr.insertText("!")));
    await frame();
    expect(format).toHaveBeenCalledTimes(1);
    expect(useDrafts.getState().drafts[key]!.bodyVersion).toBe(before.bodyVersion);
    expect(useDrafts.getState().drafts[key]).not.toBe(before);
    format.mockClear();
    await act(async () => view!.dispatch(view!.state.tr.setSelection(TextSelection.create(view!.state.doc, 2))));
    await frame();
    expect(format).toHaveBeenCalledTimes(1);
    format.mockClear();
    await act(async () => view!.dispatch(view!.state.tr.addStoredMark(schema.marks.bold.create())));
    await frame();
    expect(format).toHaveBeenCalledTimes(1);
    expect(format.mock.results[0]!.value.bold).toBe(true);
    format.mockClear();
    await act(async () => { undo(view!.state, view!.dispatch); });
    await frame();
    expect(format).toHaveBeenCalledTimes(1);
    expect(format.mock.results[0]!.value.canRedo).toBe(true);
    format.mockClear();
    await act(async () => { redo(view!.state, view!.dispatch); });
    await frame();
    expect(format).toHaveBeenCalledTimes(1);
    expect(format.mock.results[0]!.value.canRedo).toBe(false);
    format.mockClear();
    await act(async () => useDrafts.setState(state => ({ drafts: { ...state.drafts, [key]: { ...state.drafts[key]!, sending: true } } })));
    await frame();
    expect(format).toHaveBeenCalledTimes(1);
    expect(format.mock.results[0]!.value.editable).toBe(false);
    format.mockClear();
    await act(async () => useDrafts.setState(state => ({ drafts: { ...state.drafts, [key]: { ...state.drafts[key]!, sending: false } } })));
    await frame();
    expect(format).toHaveBeenCalledTimes(1);
    expect(format.mock.results[0]!.value.editable).toBe(true);
  } finally {
    await act(async () => root.unmount()); forgetDraft(key); host.remove(); capture.mockRestore(); format.mockRestore();
  }
});
