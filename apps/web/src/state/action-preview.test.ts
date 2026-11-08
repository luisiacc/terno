import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("document", { querySelector: () => null });
vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
const call = vi.fn(async (..._a: unknown[]) => ({ items: [], nextCursor: null, total: 0, unticked: [] }));
vi.mock("~/rpc/connection", () => ({ client: { call, on: () => () => {}, connectionVersion: 1 } }));
const { closePreviewRow, enterPreview, focusWhenReady, leavePreview, useActionRows } = await import("./action-preview");
const { focusIntent } = await import("~/lib/focus-intent");
const { navigate, getApp, setApp, useApp } = await import("./app");
const { useList } = await import("./list");

describe("what a preview keeps to come back to (plan 143)", () => {
  beforeEach(() => {
    call.mockClear();
    setApp({ actionPreview: null, view: "inbox" });
  });

  it("goes when the list goes elsewhere, and the backend lets go too", () => {
    enterPreview("p1");
    expect(useActionRows.getState().from).not.toBeNull();
    navigate({ view: "sent" });
    expect(getApp().actionPreview).toBeNull();
    expect(useActionRows.getState().from).toBeNull();
    expect(call).toHaveBeenCalledWith("ai.actionCancel", { previewId: "p1" });
  });

  it("an open conversation closes back to the rule, everything kept; only then does the preview end (plan 161, pass 2)", () => {
    enterPreview("p8", "inbox");
    useActionRows.setState({ unticked: new Set([5]) });
    setApp({ selectedId: 4, readerOpen: true });
    expect(closePreviewRow()).toBe(true);
    expect(getApp()).toMatchObject({ actionPreview: "p8", selectedId: null, readerOpen: false });
    expect([...useActionRows.getState().unticked]).toEqual([5]);
    expect(call).not.toHaveBeenCalledWith("ai.actionCancel", expect.anything());
    // nothing open: Esc's next step is the preview's end
    expect(closePreviewRow()).toBe(false);
    leavePreview();
    expect(closePreviewRow()).toBe(false);
  });

  it("Cancel goes back where it was", () => {
    enterPreview("p2");
    expect(getApp().view).toBe("all");
    leavePreview();
    expect(getApp()).toMatchObject({ view: "inbox", actionPreview: null });
    expect(useActionRows.getState().from).toBeNull();
  });

  it("draws none of the mailbox you were in: its rows go at once, the skeleton until the preview's own (plan 161)", () => {
    useList.setState({ items: [{ id: 7 } as never], index: new Map([[7, 0]]), loading: false });
    enterPreview("p3", "inbox");
    expect(useList.getState()).toMatchObject({ items: [], loading: true });
    // and they come back, as they were, on Cancel
    leavePreview();
    expect(useList.getState().items.map((t) => t.id)).toEqual([7]);
  });

  it("the sidebar shows where the rule looks, and another place still ends it (plan 161)", () => {
    setApp({ view: "sent" });
    enterPreview("p4", "inbox");
    expect(getApp()).toMatchObject({ view: "inbox", actionPreview: "p4" });
    // the Inbox in the sidebar is a place of its own: it leaves the preview
    navigate({ view: "inbox" });
    expect(getApp().actionPreview).toBeNull();
    enterPreview("p5", "inbox");
    setApp({ view: "all" });
    expect(getApp().actionPreview).toBeNull();
    enterPreview("p6", "all");
    expect(getApp().view).toBe("all");
    setApp({ selectedId: 3 });
    expect(getApp().actionPreview).toBe("p6");
  });

  it("the keys are the list's when the preview opens, and again after it ends (plan 161)", () => {
    const list = { scrollTop: 0, focus: vi.fn(), isConnected: true };
    const body = { closest: () => null };
    vi.stubGlobal("document", { querySelector: () => list, activeElement: body, body });
    try {
      enterPreview("p7");
      expect(list.focus).toHaveBeenCalledTimes(1);
      leavePreview();
      expect(list.focus).toHaveBeenCalledTimes(2);
      // somewhere the user chose since (a reply being written) keeps it
      const field = { closest: () => null, isConnected: true };
      vi.stubGlobal("document", { querySelector: () => list, activeElement: field, body });
      enterPreview("p8");
      leavePreview();
      expect(list.focus).toHaveBeenCalledTimes(3);
    } finally {
      vi.stubGlobal("document", { querySelector: () => null });
    }
  });

  it("the list remembers the place it leaves before its rows go (Codex review #2)", () => {
    useList.setState({ key: JSON.stringify(["inbox"]), itemsKey: JSON.stringify(["inbox"]), items: [{ id: 7 } as never], index: new Map([[7, 0]]), loading: false });
    let rowsWhenLeft = -1;
    const stop = useApp.subscribe((s, prev) => {
      if (s.actionPreview !== prev.actionPreview) rowsWhenLeft = useList.getState().items.length;
    });
    enterPreview("p9", "inbox");
    stop();
    expect(rowsWhenLeft).toBe(1);
    expect(useList.getState().items).toEqual([]);
    leavePreview();
  });

  it("ready, the keys go to the list, unless the user moved since it opened (Codex review #3)", () => {
    const list = { scrollTop: 0, focus: vi.fn(), isConnected: true };
    const body = { closest: () => null };
    vi.stubGlobal("document", { querySelector: (q: string) => (q === "[role=dialog]" ? null : list), activeElement: body, body });
    try {
      enterPreview("p10");
      list.focus.mockClear();
      focusWhenReady("p10");
      expect(list.focus).toHaveBeenCalledTimes(1);
      // once only
      focusWhenReady("p10");
      expect(list.focus).toHaveBeenCalledTimes(1);
      leavePreview();
      enterPreview("p11");
      list.focus.mockClear();
      // a Tab to Cancel while the check ran
      focusIntent.seq++;
      focusWhenReady("p11");
      expect(list.focus).not.toHaveBeenCalled();
      leavePreview();
    } finally {
      vi.stubGlobal("document", { querySelector: () => null });
    }
  });

  it("a palette still closing is waited for, not given up on (Codex review, second pass)", () => {
    const list = { scrollTop: 0, focus: vi.fn(), isConnected: true };
    let dialog: object | null = { role: "dialog" };
    const input = { closest: (q: string) => (q.includes("input") ? input : null) };
    const body = { closest: () => null };
    const doc = { querySelector: (q: string) => (q === "[role=dialog]" ? dialog : list), activeElement: input as unknown, body };
    let changed: (() => void) | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("MutationObserver", class { constructor(run: () => void) { changed = run; } observe() {} disconnect() { disconnect(); } });
    try {
      enterPreview("p12");
      list.focus.mockClear();
      focusWhenReady("p12");
      expect(list.focus).not.toHaveBeenCalled();
      // the palette goes, handing focus back to the page
      dialog = null;
      doc.activeElement = body;
      changed!();
      expect(list.focus).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalled();
      leavePreview();
    } finally {
      vi.stubGlobal("document", { querySelector: () => null });
      vi.unstubAllGlobals();
      vi.stubGlobal("document", { querySelector: () => null });
      vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
    }
  });
});

