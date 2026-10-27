// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

const fault = vi.hoisted(() => ({ branch: "" }));
vi.mock("./new-message", async (original) => {
  const actual = await original<typeof import("./new-message")>();
  return { ...actual, NewMessage: () => { if (fault.branch === "compose") throw new Error("compose render failure"); return <actual.NewMessage />; } };
});

it("retires a gated Reply started before the failed pane commits its Reader branch", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup("split", true), waiting = deferred<ThreadDetail>();
  const { showNewDraft, openCompose, composeFocusPending } = await import("~/lib/compose");
  const { pressRow } = await import("~/lib/select");
  let opening: Promise<void> | undefined;
  try {
    fault.branch = "compose"; await act(async () => showNewDraft(h.key));
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    await act(async () => h.drafts.forgetDraft(h.key));
    fault.branch = ""; gate.load.mockReturnValue(waiting.promise); h.other.focus();
    await act(async () => { pressRow(7, { meta: false, ctrl: false, shift: false }); opening = openCompose("reply", 7); });
    await act(async () => { waiting.resolve(h.detail); await opening; });
    for (let i = 0; i < 3; i++) await h.flush();
    expect(composeFocusPending(7)).toBe(false); expect(h.app.getApp().draftFocus).toBeNull();
    expect(document.activeElement).toBe(h.other);
  } finally { fault.branch = ""; waiting.resolve(h.detail); if (opening) await opening; await h.cleanup(); error.mockRestore(); }
});
vi.mock("./selection-bar", async (original) => {
  const actual = await original<typeof import("./selection-bar")>();
  return { ...actual, SelectionBar: (props: Parameters<typeof actual.SelectionBar>[0]) => { if (fault.branch === "selection" && props.variant !== "toolbar") throw new Error("selection render failure"); return <actual.SelectionBar {...props} />; } };
});

it.each(["compose", "selection"] as const)("does not strand Reply after a failed %s branch returns to the same Reader", async (branch) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup("split", true);
  const { showNewDraft, composeFocusPending } = await import("~/lib/compose");
  const { pressRow, clearSelection } = await import("~/lib/select");
  const saved = h.drafts.useDrafts.getState().drafts[h.key]!;
  try {
    fault.branch = branch;
    await act(async () => {
      if (branch === "compose") showNewDraft(h.key);
      else h.app.setApp({ checked: new Set([7, 8]) });
    });
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    await act(async () => { await Promise.resolve(); });
    fault.branch = "";
    await act(async () => {
      if (branch === "compose") pressRow(7, { meta: false, ctrl: false, shift: false });
      else clearSelection();
    });
    expect(h.app.getApp().selectedId).toBe(7);
    expect(h.app.getApp().compose).toBeNull();
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    expect(h.host.querySelector('[data-testid="reader"]')).toBeNull();
    h.other.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
    for (let i = 0; i < 4; i++) await h.flush();
    expect(composeFocusPending(7)).toBe(false);
    expect(h.app.getApp().draftFocus).toBeNull();
    expect(document.activeElement).toBe(h.other);
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ id: saved.id, generation: saved.generation, bodyText: saved.bodyText });
  } finally { fault.branch = ""; await h.cleanup(); error.mockRestore(); }
});

it.each(["compose", "selection"] as const)("focuses Reply after a healthy %s branch returns to Reader", async (branch) => {
  const h = await setup("split", true);
  const { showNewDraft, composeFocusPending } = await import("~/lib/compose");
  const { pressRow, clearSelection } = await import("~/lib/select");
  try {
    await act(async () => {
      if (branch === "compose") showNewDraft(h.key);
      else h.app.setApp({ checked: new Set([7, 8]) });
    });
    await act(async () => {
      if (branch === "compose") pressRow(7, { meta: false, ctrl: false, shift: false });
      else clearSelection();
    });
    expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
    h.other.focus(); await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
    for (let i = 0; i < 4; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
    expect(composeFocusPending(7)).toBe(false);
  } finally { fault.branch = ""; await h.cleanup(); }
});
