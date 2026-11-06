import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("document", { querySelector: () => null });
vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
const call = vi.fn(async (..._a: unknown[]) => ({ items: [], nextCursor: null, total: 0, unticked: [] }));
vi.mock("~/rpc/connection", () => ({ client: { call, on: () => () => {}, connectionVersion: 1 } }));
const { enterPreview, leavePreview, useActionRows } = await import("./action-preview");
const { navigate, getApp, setApp } = await import("./app");

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
});
