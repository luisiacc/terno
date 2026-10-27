// @vitest-environment jsdom
import { act, Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import { schema } from "@terno/richtext";
import { closeHistory, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";

const injection = vi.hoisted(() => ({ fail: false, failCreate: false, reads: 0, views: [] as unknown[] }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.mock("./editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./editor")>();
  return {
    ...actual,
    serialize: (doc: Parameters<typeof actual.serialize>[0]) => {
      if (doc.textContent.includes("authored")) injection.reads++;
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
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
const { RichBody } = await import("./rich");
const { createDraft, draftsSaved, editDraft, forgetDraft, flushDraft, materialize, retryDraft, setDraftTransport, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");
const { controllerFor } = await import("./controller");

afterEach(() => { injection.fail = false; injection.failCreate = false; injection.reads = 0; injection.views.length = 0; for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); });

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

function FatalSwitch({ fatal, draftKey }: { fatal: boolean; draftKey: string }) {
  if (fatal) throw new Error("synthetic fatal render");
  return <RichBody draftKey={draftKey} placeholder="Body" />;
}

it("fatal Review hands the unread real editor checkpoint into the recovery workspace", async () => {
  const { AppBoundary } = await import("~/components/diag/error-boundary");
  const { loadComposer } = await import("./lazy");
  const { useDraftRecovery } = await import("~/lib/draft-recovery-ui");
  const { sendDraft } = await import("~/lib/compose");
  const { whenDraftsSaved } = await import("~/web/reload");
  const { client } = await import("~/rpc/connection");
  await loadComposer();
  await import("~/components/diag/recovery-workspace");
  const rootEl = document.createElement("div"), evictEl = document.createElement("div");
  rootEl.id = "root"; document.body.append(rootEl, evictEl);
  const root = createRoot(rootEl), evictRoot = createRoot(evictEl), keys: string[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const transport = vi.fn(async (_method: string, params: unknown) => ({ ...(params as object), id: 1, generation: "test", revision: 1 }));
  setDraftTransport(transport);
  try {
    const key = createDraft({ ...newFields(1), toText: "unfinished@", quotedText: "> exact quote", attachments: [{ assetId: "asset", filename: "exact.bin", mime: "application/octet-stream", size: 3 }] }); keys.push(key);
    await act(async () => root.render(<StrictMode><AppBoundary><FatalSwitch fatal={false} draftKey={key} /></AppBoundary></StrictMode>));
    const first = injection.views.at(-1) as EditorView;
    await act(async () => { const tr = first.state.tr.insertText("authored rich"); tr.addMark(1, 9, schema.marks.bold!.create()); first.dispatch(tr); });
    await act(async () => { first.dispatch(closeHistory(first.state.tr).insertText("!", 14)); undo(first.state, first.dispatch); });
    await act(async () => first.dispatch(first.state.tr.setSelection(TextSelection.create(first.state.doc, 9, 3)).setStoredMarks([schema.marks.italic!.create()])));
    const doc = first.state.doc.toJSON(), selection = first.state.selection.toJSON(), marks = first.state.storedMarks?.map((mark) => mark.toJSON()), history = undoDepth(first.state), redoHistory = redoDepth(first.state), version = useDrafts.getState().drafts[key]!.bodyVersion;
    injection.fail = true;
    await act(async () => root.render(<StrictMode><AppBoundary><FatalSwitch fatal draftKey={key} /></AppBoundary></StrictMode>));
    expect(rootEl.querySelector('[data-testid="app-boundary"]')).not.toBeNull(); expect(controllerFor(key)).toBeNull();
    for (let i = 0; i < 9; i++) {
      const other = createDraft(newFields(1)); keys.push(other);
      await act(async () => evictRoot.render(<RichBody draftKey={other} placeholder="Body" />));
      await act(async () => evictRoot.render(null));
    }
    await act(async () => (rootEl.querySelector('[data-testid="app-boundary-reload"]') as HTMLButtonElement).click());
    expect(rootEl.querySelector('[data-testid="recovery-reload-warning"]')).not.toBeNull();
    await act(async () => (rootEl.querySelector('[data-testid="recovery-review"]') as HTMLButtonElement).click());
    await act(async () => { await Promise.resolve(); });
    expect(rootEl.querySelector('[data-testid="recovery-workspace"]')).not.toBeNull();
    const remounted = injection.views.at(-1) as EditorView;
    expect(remounted.state.doc.toJSON()).toEqual(doc); expect(remounted.state.selection.toJSON()).toEqual(selection);
    expect(remounted.state.storedMarks?.map((m) => m.toJSON())).toEqual(marks);
    expect(undoDepth(remounted.state)).toBe(history); expect(redoDepth(remounted.state)).toBe(redoHistory);
    const beforeUndoReads = injection.reads;
    await act(async () => { expect(redo(remounted.state, remounted.dispatch)).toBe(true); expect(undo(remounted.state, remounted.dispatch)).toBe(true); });
    expect(remounted.state.doc.toJSON()).toEqual(doc); expect(injection.reads).toBe(beforeUndoReads);
    expect(rootEl.querySelectorAll('[data-testid="compose-body"]')).toHaveLength(1);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ key, bodyVersion: version, toText: "unfinished@", quotedText: "> exact quote", attachments: [{ assetId: "asset", filename: "exact.bin", mime: "application/octet-stream", size: 3 }] });
    expect(await draftsSaved()).toBe(false); expect(transport).not.toHaveBeenCalled();
    expect(await sendDraft(key)).toBe(false);
    expect(vi.mocked(client.call).mock.calls.some(([method]) => method === "compose.send")).toBe(false);
    const go = vi.fn(); expect(await whenDraftsSaved(go)).toBe(false); expect(go).not.toHaveBeenCalled();
    const reads = injection.reads;
    await act(async () => (rootEl.querySelector('[data-testid="recovery-details"]') as HTMLButtonElement).click());
    expect(injection.reads).toBe(reads);
    expect(rootEl.querySelector('[data-testid="app-boundary"]')).not.toBeNull();
  } finally {
    injection.fail = false; await act(async () => { root.unmount(); evictRoot.unmount(); });
    useDraftRecovery.setState({ open: false, key: null, reason: "error" }); for (const key of keys) forgetDraft(key);
    rootEl.remove(); evictEl.remove(); consoleError.mockRestore();
  }
});

it("fatal Review returns to the error screen if checkpoint editor construction fails", async () => {
  const { AppBoundary } = await import("~/components/diag/error-boundary");
  const { loadComposer } = await import("./lazy");
  const { useDraftRecovery } = await import("~/lib/draft-recovery-ui");
  const { bodyCheckpoint } = await import("~/lib/drafts");
  await loadComposer(); await import("~/components/diag/recovery-workspace");
  const host = document.createElement("div"); host.id = "root"; document.body.append(host); const root = createRoot(host);
  const error = vi.spyOn(console, "error").mockImplementation(() => {}); const key = createDraft(newFields(1));
  try {
    await act(async () => root.render(<AppBoundary><FatalSwitch fatal={false} draftKey={key} /></AppBoundary>));
    const view = injection.views.at(-1) as EditorView;
    await act(async () => view.dispatch(view.state.tr.insertText("authored rich")));
    injection.fail = true; await act(async () => root.render(<AppBoundary><FatalSwitch fatal draftKey={key} /></AppBoundary>));
    await act(async () => (host.querySelector('[data-testid="app-boundary-reload"]') as HTMLButtonElement).click());
    injection.failCreate = true;
    await act(async () => (host.querySelector('[data-testid="recovery-review"]') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="recovery-unavailable"]')).not.toBeNull();
    expect(bodyCheckpoint(key)).toBeDefined(); expect(controllerFor(key)).toBeNull();
    await act(async () => (host.querySelector('[data-testid="recovery-unavailable"] button') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="app-boundary"]')).not.toBeNull();
    expect(useDraftRecovery.getState().open).toBe(false);
  } finally {
    injection.fail = false; injection.failCreate = false; await act(async () => root.unmount());
    useDraftRecovery.setState({ open: false, key: null, reason: "error", checkpoint: undefined }); forgetDraft(key); host.remove(); error.mockRestore();
  }
});

it.each(["forget", "replace"] as const)("refuses a %s checkpoint before the recovery workspace mounts", async (change) => {
  const { RecoveryWorkspace } = await import("~/components/diag/recovery-workspace");
  const { reviewDrafts, useDraftRecovery } = await import("~/lib/draft-recovery-ui");
  const { attachBody } = await import("~/lib/drafts");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const key = createDraft(newFields(1)); const other = createDraft(newFields(1));
  try {
    await act(async () => root.render(<RichBody draftKey={key} placeholder="Body" />));
    const view = injection.views.at(-1) as EditorView;
    await act(async () => view.dispatch(view.state.tr.insertText("authored rich")));
    injection.fail = true; await act(async () => root.render(null));
    reviewDrafts(); expect(useDraftRecovery.getState().checkpoint).toBeDefined();
    if (change === "forget") forgetDraft(key);
    else attachBody(key, () => ({ html: "<p>other</p>", text: "other" }));
    await act(async () => root.render(<RecoveryWorkspace />));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="compose-body"]')).toBeNull();
    expect(controllerFor(other)).toBeNull();
  } finally {
    injection.fail = false; await act(async () => root.unmount());
    useDraftRecovery.setState({ open: false, key: null, reason: "error", checkpoint: undefined }); forgetDraft(key); forgetDraft(other); host.remove();
  }
});

it("does not leave a registered controller if pending focus throws during setup", async () => {
  const { focusBody, registerController, cancelFocusBody } = await import("./controller");
  const key = "pending-focus-failure";
  focusBody(key, "keep");
  const controller = { focus: () => { throw new Error("focus failed"); } } as unknown as import("./controller").ComposerController;
  try {
    expect(() => registerController(key, controller)).toThrow("focus failed");
    expect(controllerFor(key)).toBeNull();
  } finally { cancelFocusBody(key); }
});

it("fatal Review keeps its warning when the unread source has no detached checkpoint", async () => {
  const { AppBoundary } = await import("~/components/diag/error-boundary");
  const { useDraftRecovery } = await import("~/lib/draft-recovery-ui");
  const { attachBody } = await import("~/lib/drafts");
  const host = document.createElement("div"); host.id = "root"; document.body.append(host); const root = createRoot(host);
  const key = createDraft(newFields(1)); const source = attachBody(key, () => { throw new Error("read failed"); }); source.changed();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await act(async () => root.render(<AppBoundary><FatalSwitch fatal draftKey={key} /></AppBoundary>));
    await act(async () => (host.querySelector('[data-testid="app-boundary-reload"]') as HTMLButtonElement).click());
    await act(async () => (host.querySelector('[data-testid="recovery-review"]') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="recovery-reload-warning"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="recovery-workspace"]')).toBeNull();
    expect(useDraftRecovery.getState().open).toBe(false);
    expect(error.mock.calls.length).toBe(1);
  } finally {
    await act(async () => root.unmount()); useDraftRecovery.setState({ open: false, key: null, reason: "error", checkpoint: undefined });
    forgetDraft(key); source.dispose(); host.remove(); error.mockRestore();
  }
});
