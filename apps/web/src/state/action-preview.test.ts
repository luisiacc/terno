import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("document", { querySelector: () => null });
vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
const call = vi.fn(async (..._a: unknown[]) => ({ items: [], nextCursor: null, total: 0, unticked: [] }));
vi.mock("~/rpc/connection", () => ({ client: { call, on: () => () => {}, connectionVersion: 1 } }));
const { enterPreview, leavePreview, useActionRows } = await import("./action-preview");
const { navigate, getApp, setApp } = await import("./app");
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
});

