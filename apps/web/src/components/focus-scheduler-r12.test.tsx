// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { expect, it, vi } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it("a successful public inline lease completion retires the exact lease", async () => {
  const h = await setup("split", true), { openCompose, composeFocusPending, finishComposeFocus, subscribeComposeFocus } = await import("~/lib/compose");
  let focusSeq: number | undefined, notifications = 0;
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    const offApp = h.app.useApp.subscribe((state) => { if (state.draftFocus?.key === h.key) focusSeq = state.draftFocus.seq; });
    const offLease = subscribeComposeFocus((thread, fallback) => { expect(thread).toBe(7); expect(fallback).toBe(false); notifications++; });
    try {
      await act(async () => { await openCompose("reply", 7); });
      expect(focusSeq).toBeDefined(); expect(composeFocusPending(7, h.key, focusSeq)).toBe(true);
      let completed = false;
      await act(async () => { completed = finishComposeFocus(h.key, focusSeq!, false); });
      expect(completed).toBe(true); expect(composeFocusPending(7, h.key, focusSeq)).toBe(false); expect(notifications).toBe(1);
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe(before.bodyText);
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.toText).toBe(before.toText);
    } finally { offApp(); offLease(); }
  } finally { await h.cleanup(); }
});

it("a reentrant ownerless successor retains its key listener after older preparation", async () => {
  const h = await setup("split", true), { openCompose, focusDraft, composeFocusPending, subscribeComposeFocus } = await import("~/lib/compose");
  const add = vi.spyOn(document, "addEventListener"), remove = vi.spyOn(document, "removeEventListener");
  let triggered = false, successorSeq: number | undefined;
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    await act(async () => { await openCompose("reply", 7); });
    expect(composeFocusPending(7)).toBe(true);
    const keyListeners = add.mock.calls.filter(([type, , capture]) => type === "keydown" && capture === true);
    expect(keyListeners.length).toBeGreaterThan(0);
    const handler = keyListeners.at(-1)![1];
    const offApp = h.app.useApp.subscribe((state) => { if (state.draftFocus?.key === h.key && state.draftFocus.target === "to") successorSeq = state.draftFocus.seq; });
    const offLease = subscribeComposeFocus(() => {
      if (triggered) return;
      triggered = true; focusDraft(h.key, "to"); flushSync(() => {});
    });
    try {
      await act(async () => { focusDraft(h.key, "body"); });
      expect(triggered).toBe(true); expect(successorSeq).toBeDefined(); expect(h.app.getApp().draftFocus).toBeNull();
      const changes = [
        ...add.mock.calls.map((call, i) => ({ call, order: add.mock.invocationCallOrder[i]!, active: true })),
        ...remove.mock.calls.map((call, i) => ({ call, order: remove.mock.invocationCallOrder[i]!, active: false })),
      ].filter(({ call }) => call[0] === "keydown" && call[1] === handler && call[2] === true).sort((a, b) => a.order - b.order);
      expect(changes.length).toBeGreaterThanOrEqual(3); expect(changes.at(-1)?.active).toBe(true);
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe(before.bodyText);
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.toText).toBe(before.toText);
      for (let i = 0; i < 4; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    } finally { offApp(); offLease(); }
  } finally { add.mockRestore(); remove.mockRestore(); await h.cleanup(); }
});
