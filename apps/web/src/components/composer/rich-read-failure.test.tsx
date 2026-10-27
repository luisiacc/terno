// @vitest-environment jsdom
import { act, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import { schema } from "@terno/richtext";
import { closeHistory, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";

const injection = vi.hoisted(() => ({ fail: false, failCreate: false, views: [] as unknown[] }));
vi.mock("~/rpc/connection", () => ({ client: {} }));
vi.mock("./editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./editor")>();
  return {
    ...actual,
    serialize: (doc: Parameters<typeof actual.serialize>[0]) => {
      if (injection.fail && doc.textContent.includes("authored")) throw new Error("read failed");
      return actual.serialize(doc);
    },
    createEditor: (...args: Parameters<typeof actual.createEditor>) => {
      if (injection.failCreate) throw new Error("editor construction failed");
      const editor = actual.createEditor(...args); injection.views.push(editor.view); return editor;
    },
  };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
const { RichBody } = await import("./rich");
const { createDraft, draftsSaved, editDraft, forgetDraft, flushDraft, materialize, retryDraft, setDraftTransport, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");
const { controllerFor } = await import("./controller");

afterEach(() => { injection.fail = false; injection.failCreate = false; injection.views.length = 0; for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); });

it.each(["persistent", "transient"] as const)("preserves real rich state after failed disposal and eviction (%s)", async (failure) => {
  setDraftTransport(async (_method, params) => ({ ...(params as object), id: 1, generation: "test", revision: 1 }));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const keys: string[] = [];
  const mount = async (key: string | null) => act(async () => root.render(key ? <RichBody draftKey={key} placeholder="Body" /> : null));
  try {
    const key = createDraft({ ...newFields(1), toText: "unfinished@", quotedText: "> exact quote", attachments: [{ assetId: "asset", filename: "exact.bin", mime: "application/octet-stream", size: 3 }] }); keys.push(key);
    await mount(key);
    const first = injection.views.at(-1) as EditorView;
    await act(async () => { const tr = first.state.tr.insertText("authored rich"); tr.addMark(1, 9, schema.marks.bold!.create()); first.dispatch(tr.setSelection(TextSelection.create(tr.doc, 5))); });
    await act(async () => { first.dispatch(closeHistory(first.state.tr).insertText("!", 14)); undo(first.state, first.dispatch); });
    await act(async () => first.dispatch(first.state.tr.setSelection(TextSelection.create(first.state.doc, 9, 3)).setStoredMarks([schema.marks.italic!.create()])));
    const doc = first.state.doc.toJSON(), selection = first.state.selection.toJSON(), marks = first.state.storedMarks?.map((mark) => mark.toJSON()), history = undoDepth(first.state), redoHistory = redoDepth(first.state);
    expect(history).toBeGreaterThan(0); expect(redoHistory).toBeGreaterThan(0);
    injection.fail = true;
    await mount(null);
    expect(controllerFor(key)).toBeNull();
    expect(await draftsSaved()).toBe(false);
    for (let i = 0; i < 9; i++) {
      const other = createDraft(newFields(1)); keys.push(other);
      await mount(other); await mount(null);
    }
    if (failure === "transient") {
      injection.fail = false;
      expect(materialize(key)?.bodyText).toBe("authored rich");
      retryDraft(key); await flushDraft(key);
      expect(useDrafts.getState().drafts[key]?.status).toBe("saved");
    }
    const before = useDrafts.getState().drafts[key]!;
    await mount(key);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ localRev: before.localRev, savedRev: before.savedRev, status: before.status, bodyVersion: before.bodyVersion });
    const remounted = injection.views.at(-1) as EditorView;
    expect(remounted.state.doc.toJSON()).toEqual(doc);
    expect(remounted.state.selection.toJSON()).toEqual(selection);
    expect(remounted.state.storedMarks?.map((mark) => mark.toJSON())).toEqual(marks);
    expect(undoDepth(remounted.state)).toBe(history); expect(redoDepth(remounted.state)).toBe(redoHistory);
    await act(async () => { expect(redo(remounted.state, remounted.dispatch)).toBe(true); expect(remounted.state.doc.textContent).toBe("authored rich!"); expect(undo(remounted.state, remounted.dispatch)).toBe(true); });
    expect(remounted.state.doc.toJSON()).toEqual(doc);
    if (failure === "persistent") {
      await act(async () => remounted.dispatch(remounted.state.tr.insertText(" latest", 14)));
      injection.fail = false;
      expect(materialize(key)?.bodyText).toBe("authored rich latest");
    }
    expect(controllerFor(key)?.dom).toBe(remounted.dom);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ toText: "unfinished@", quotedText: "> exact quote", attachments: [{ assetId: "asset", filename: "exact.bin", mime: "application/octet-stream", size: 3 }] });
  } finally {
    injection.fail = false; await act(async () => root.unmount()); host.remove(); for (const key of keys) forgetDraft(key);
  }
});


it("a deliberate body replacement invalidates the retained editor state", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const key = createDraft(newFields(1));
  try {
    await act(async () => root.render(<RichBody draftKey={key} placeholder="Body" />));
    const first = injection.views.at(-1) as EditorView;
    await act(async () => first.dispatch(first.state.tr.insertText("authored rich")));
    injection.fail = true; await act(async () => root.render(null));
    injection.fail = false;
    editDraft(key, { bodyText: "replacement", bodyHtml: "<div>replacement</div>" });
    await act(async () => root.render(<RichBody draftKey={key} placeholder="Body" />));
    expect((injection.views.at(-1) as EditorView).state.doc.textContent).toBe("replacement");
  } finally { injection.fail = false; await act(async () => root.unmount()); host.remove(); forgetDraft(key); }
});

it("keeps independently unread editor states until each draft is discarded or reopened", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const keys: string[] = [];
  try {
    for (let i = 0; i < 9; i++) {
      const key = createDraft(newFields(1)); keys.push(key);
      await act(async () => root.render(<RichBody draftKey={key} placeholder="Body" />));
      const view = injection.views.at(-1) as EditorView;
      await act(async () => view.dispatch(view.state.tr.insertText(`authored ${i}`)));
      injection.fail = true; await act(async () => root.render(null));
    }
    await act(async () => root.render(<RichBody draftKey={keys[0]!} placeholder="Body" />));
    expect((injection.views.at(-1) as EditorView).state.doc.textContent).toBe("authored 0");
    expect(await draftsSaved()).toBe(false);
  } finally { injection.fail = false; await act(async () => root.unmount()); host.remove(); for (const key of keys) forgetDraft(key); }
});


class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? null : this.props.children; }
}

it("leaves the checkpoint intact when replacement editor construction fails", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const key = createDraft(newFields(1)); const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await act(async () => root.render(<Boundary><RichBody draftKey={key} placeholder="Body" /></Boundary>));
    const first = injection.views.at(-1) as EditorView;
    await act(async () => first.dispatch(first.state.tr.insertText("authored rich")));
    injection.fail = true; await act(async () => root.render(null));
    injection.failCreate = true;
    await act(async () => root.render(<Boundary key="failed"><RichBody draftKey={key} placeholder="Body" /></Boundary>));
    injection.failCreate = false;
    await act(async () => root.render(<Boundary key="retry"><RichBody draftKey={key} placeholder="Body" /></Boundary>));
    expect((injection.views.at(-1) as EditorView).state.doc.textContent).toBe("authored rich");
  } finally { error.mockRestore(); injection.fail = false; injection.failCreate = false; await act(async () => root.unmount()); host.remove(); forgetDraft(key); }
});
